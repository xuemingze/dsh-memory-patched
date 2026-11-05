/** dsh-memory Browser Cordis entry. */

import { MemorySection, type MemoryApi } from './MemorySection.tsx'
import {
  parseGlobalMemoryView,
  parseGlobalReplaceResponse,
  parseMemoryStatus,
  parseSessionListResponse,
  parseForgettingReportResponse,
  parseDreamPanelResponse,
  parseSessionConsolidateResponse,
  parseConsolidationModelCatalogResponse,
  parseConsolidationModelSelectResponse,
  parseWorkspaceCommitResponse,
  parseWorkspaceListResponse,
  parseWorkspaceReadResponse,
  type MemoryRpcResult,
} from '../protocol.ts'
import { en, zh, type MemoryTranslate } from './locales.ts'

const LOCALE_NAMESPACE = 'settings.memory'

interface BrowserConnection {
  readonly isLoopback: boolean
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<MemoryRpcResult<unknown>>
  }
}

interface BrowserSlots {
  inject(name: string, callback: () => () => void): void
  register(options: {
    name: string
    id: string
    order: number
    label: () => string
    locale: string
    inject: () => { api: MemoryApi; loopback: boolean }
  }, component: unknown): () => void
}

interface BrowserLocale {
  register(namespace: string, dictionaries: {
    readonly zh: Readonly<Record<string, string>>
    readonly en: Readonly<Record<string, string>>
  }): () => void
  bind(namespace: string): MemoryTranslate
}

export interface BrowserContext {
  readonly connection: BrowserConnection
  readonly slots: BrowserSlots
  readonly locale: BrowserLocale
  effect(callback: () => void | (() => void), label?: string): void
}

/** Browser services required by the Settings contribution. */
export const inject = ['slots', 'locale', 'connection']

/** Register the independent Memory settings section. */
export function apply(ctx: BrowserContext): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }),
    'dsh-memory: settings dictionaries',
  )
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  const api = createMemoryApi(ctx.connection)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory',
    order: 30,
    label: () => t('nav'),
    locale: LOCALE_NAMESPACE,
    inject: () => ({ api, loopback: ctx.connection.isLoopback }),
  }, MemorySection))
}

function createMemoryApi(connection: BrowserConnection): MemoryApi {
  const call = async (endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    const result = await connection.rpc.call('/memory', endpoint, payload, signal)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
  return {
    status: async signal => parseMemoryStatus(await call('status', {}, signal)),
    readGlobal: async signal => parseGlobalMemoryView(await call('global/read', {}, signal)),
    replaceGlobal: async (input, signal) => parseGlobalReplaceResponse(await call('global/replace', input, signal)),
    listWorkspaces: async signal => parseWorkspaceListResponse(await call('workspaces/list', {}, signal)),
    readWorkspace: async (workspaceId, signal) => parseWorkspaceReadResponse(await call('workspace/read', { workspaceId }, signal)),
    commitWorkspace: async (input, signal) => parseWorkspaceCommitResponse(await call('workspace/commit', input, signal)),
    listSessions: async signal => parseSessionListResponse(await call('sessions/list', {}, signal)),
    forgettingReport: async signal => parseForgettingReportResponse(await call('governance/forgetting', {}, signal)),
    // Reading the panel never applies anything: status is read-only and a plan
    // only moves through proposal/approve or proposal/reject.
    dreamReport: async signal => parseDreamPanelResponse(await call('dream/status', {}, signal)),
    dreamApprove: async (runId, approved, signal) =>
      call('dream/proposal/approve', { runId, approved }, signal),
    dreamReject: async (runId, reason, signal) =>
      call('dream/proposal/reject', { runId, reason }, signal),
    dreamRun: async signal => call('dream/run', {}, signal),
    consolidateSession: async (sessionId, signal) => parseSessionConsolidateResponse(
      await call('sessions/consolidate', { sessionId }, signal),
    ),
    readModels: async signal => parseConsolidationModelCatalogResponse(await call('models/read', {}, signal)),
    selectModel: async (input, signal) => parseConsolidationModelSelectResponse(await call('models/select', input, signal)),
  }
}
