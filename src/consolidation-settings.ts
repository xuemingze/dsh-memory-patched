/** Persistent consolidation preferences and active DSH model catalog projection. */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { ConsolidationWorkerConfig } from './consolidation-worker.ts'
import { redactCredentials } from './redact.ts'
import type {
  ConsolidationModelCatalogResponse,
  ConsolidationModelSelection,
  MemoryRevision,
} from './protocol.ts'

const SETTINGS_FORMAT = 2

export interface MemoryLlmCatalog {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{
    provider: string
    id: string
    name: string
    description?: string
    inputModalities?: readonly string[]
  }>>
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ defaultMaxTokens?: number }>
}

export interface ConsolidationSettingsView {
  readonly selection: ConsolidationModelSelection
  readonly debugEnabled: boolean
  readonly revision: MemoryRevision
}

/** Plugin-owned settings file; memory Markdown remains the only authoritative memory data. */
export class ConsolidationSettingsStore {
  readonly path: string

  constructor(
    root: string,
    private readonly defaults: Pick<ConsolidationWorkerConfig, 'provider' | 'model'>,
  ) {
    this.path = join(root, 'settings.yml')
  }

  read(): ConsolidationSettingsView {
    let settings: Omit<ConsolidationSettingsView, 'revision'>
    if (!existsSync(this.path)) {
      settings = this.fallbackSettings()
    } else {
      try {
        settings = parseSettings(readFileSync(this.path, 'utf8'))
      } catch (error: unknown) {
        // A corrupt or hand-edited settings file must degrade to defaults with a
        // warning instead of taking down the consolidation runner effect.
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[dsh-memory] ignoring unreadable consolidation settings ${this.path}: ${message}`)
        settings = this.fallbackSettings()
      }
    }
    return { ...settings, revision: settingsRevision(settings) }
  }

  private fallbackSettings(): Omit<ConsolidationSettingsView, 'revision'> {
    return { selection: validateSelection(this.defaults), debugEnabled: false }
  }

  commit(input: {
    expectedRevision: MemoryRevision
    selection: ConsolidationModelSelection
    debugEnabled: boolean
  }): { status: 'committed'; revision: MemoryRevision } | { status: 'conflict'; currentRevision: MemoryRevision } {
    const current = this.read()
    if (current.revision !== input.expectedRevision) {
      return { status: 'conflict', currentRevision: current.revision }
    }
    const settings = {
      selection: validateSelection(input.selection),
      debugEnabled: validateDebugEnabled(input.debugEnabled),
    }
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`
    writeFileSync(temporary, serializeSettings(settings), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.path)
    return { status: 'committed', revision: settingsRevision(settings) }
  }
}

/** Read active adapters and their text-capable model catalogs from DSH. */
export async function readConsolidationModelCatalog(
  llm: MemoryLlmCatalog,
  settings: ConsolidationSettingsStore,
): Promise<ConsolidationModelCatalogResponse> {
  const current = settings.read()
  const results = await Promise.all(llm.listProviders().map(async (provider) => {
    try {
      const models = (await llm.listModels(provider.id))
        .filter(model => model.inputModalities === undefined || model.inputModalities.includes('text'))
        .map(model => ({
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
        }))
      return { provider: { id: provider.id, name: provider.name, models }, failure: undefined }
    } catch (error: unknown) {
      return {
        provider: undefined,
        failure: { provider: provider.id, message: safeDiagnosticMessage(error) },
      }
    }
  }))
  return {
    available: true,
    selection: current.selection,
    debugEnabled: current.debugEnabled,
    revision: current.revision,
    providers: results.flatMap(result => result.provider === undefined ? [] : [result.provider]),
    failures: results.flatMap(result => result.failure === undefined ? [] : [result.failure]),
  }
}

export function selectionIsAvailable(
  catalog: ConsolidationModelCatalogResponse,
  selection: ConsolidationModelSelection,
): boolean {
  return catalog.providers.some(provider => provider.id === selection.provider
    && provider.models.some(model => model.id === selection.model))
}

/** Respect the selected model's adapter-owned output cap while retaining a plugin cost ceiling. */
export async function resolveConsolidationOutputTokens(
  llm: MemoryLlmCatalog,
  selection: ConsolidationModelSelection,
  ceiling: number,
  signal?: AbortSignal,
): Promise<number> {
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) {
    throw new TypeError('consolidation output-token ceiling must be a positive safe integer')
  }
  const model = await llm.resolveModelInfo(selection.provider, selection.model, signal)
  const modelLimit = model.defaultMaxTokens
  if (modelLimit === undefined) return ceiling
  if (!Number.isSafeInteger(modelLimit) || modelLimit < 1) {
    throw new TypeError('DSH model output-token limit must be a positive safe integer')
  }
  return Math.min(ceiling, modelLimit)
}

function parseSettings(source: string): Omit<ConsolidationSettingsView, 'revision'> {
  let value: unknown
  try {
    value = parse(source)
  } catch (cause: unknown) {
    throw new TypeError('Memory consolidation settings are not valid YAML', { cause })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Memory consolidation settings must be an object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (record.format === 1 && keys === 'format,model,provider') {
    return { selection: validateSelection({ provider: record.provider, model: record.model }), debugEnabled: false }
  }
  if (record.format !== SETTINGS_FORMAT || keys !== 'debug,format,model,provider') {
    throw new TypeError('Memory consolidation settings have missing or unknown fields')
  }
  return {
    selection: validateSelection({ provider: record.provider, model: record.model }),
    debugEnabled: validateDebugEnabled(record.debug),
  }
}

function validateSelection(value: { provider: unknown; model: unknown }): ConsolidationModelSelection {
  if (typeof value.provider !== 'string' || value.provider.trim() === '' || /[\r\n]/u.test(value.provider)) {
    throw new TypeError('consolidation provider must be a non-empty single line')
  }
  if (typeof value.model !== 'string' || value.model.trim() === '' || /[\r\n]/u.test(value.model)) {
    throw new TypeError('consolidation model must be a non-empty single line')
  }
  return { provider: value.provider, model: value.model }
}

function validateDebugEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('consolidation debug must be a boolean')
  return value
}

function serializeSettings(settings: Omit<ConsolidationSettingsView, 'revision'>): string {
  return stringify({
    format: SETTINGS_FORMAT,
    provider: settings.selection.provider,
    model: settings.selection.model,
    debug: settings.debugEnabled,
  }, { lineWidth: 0 })
}

function settingsRevision(settings: Omit<ConsolidationSettingsView, 'revision'>): MemoryRevision {
  return `sha256:${createHash('sha256').update(serializeSettings(settings), 'utf8').digest('hex')}` as MemoryRevision
}

function safeDiagnosticMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactCredentials(message)
    .replace(/[\r\n]+/gu, ' ')
    .trim() || 'model catalog failed'
}
