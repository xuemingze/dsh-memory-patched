/**
 * Deterministic Session quality classification for the Memory settings list.
 *
 * The goal is to keep noise out of consolidation candidates without deleting
 * anything: a Session that produced no output and only errors cannot yield
 * memory, and a burst of retries for the same failure is one fact, not N.
 *
 * Classification is deliberately conservative — anything unrecognized stays
 * `meaningful` — because a false `meaningful` only costs a wasted review while
 * a false suppression silently loses real knowledge.
 */

import { createHash } from 'node:crypto'

/** How much memory value a Session can plausibly carry. */
export type SessionQualityClass =
  | 'meaningful'
  | 'empty'
  | 'failed-zero-output'
  | 'trivial-automation'

/** One terminal model error observed in a Session. */
export interface SessionTerminalError {
  readonly code?: string
  readonly message?: string
}

/** Observable facts used to classify one Session. */
export interface SessionQualityResult {
  readonly class: SessionQualityClass
  readonly firstUserText?: string
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly assistantTextBytes: number
  readonly successfulToolCalls: number
  readonly terminalErrors: readonly SessionTerminalError[]
}

export interface SessionQualityOptions {
  /** Opt in to the shadow `trivial-automation` check (default off). */
  readonly classifyTrivial?: boolean
}

/** Below this much assistant text, a reply is "short" for trivial detection. */
const TRIVIAL_TEXT_BYTES = 32

/** Below this much user text, a request is "short" for trivial detection. */
const TRIVIAL_PROMPT_BYTES = 48

/**
 * Sources that are injected by the platform rather than typed by the user.
 * They must never become `firstUserText`, or every Session looks identical.
 */
const INJECTED_SOURCES = new Set([
  'runtime-context',
  'skill-catalog',
  'system',
  'hook',
])

/** Classify one Session from its raw persisted event log. */
export function classifySessionQuality(
  events: readonly unknown[],
  options: SessionQualityOptions = {},
): SessionQualityResult {
  let firstUserText: string | undefined
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let assistantTextBytes = 0
  let successfulToolCalls = 0
  let attempts = 0
  let sawTurnStart = false
  const terminalErrors: SessionTerminalError[] = []
  let terminatedWithError = 0
  let terminatedOtherwise = 0

  for (const event of events) {
    const record = asRecord(event)
    if (record === undefined) continue
    const type = record.type

    if (type === 'turn/start') {
      sawTurnStart = true
      continue
    }

    if (type === 'user/message') {
      if (firstUserText === undefined) {
        const source = asRecord(record.data)?.source
        const kind = asRecord(source)?.kind
        if (typeof kind !== 'string' || !INJECTED_SOURCES.has(kind)) {
          const text = textOf(record.data)
          if (text !== undefined && text.trim() !== '') firstUserText = text.trim()
        }
      }
      continue
    }

    if (type === 'assistant/attempt') {
      attempts += 1
      const stream = asRecord(record.data)?.stream
      if (Array.isArray(stream)) {
        for (const chunk of stream) {
          const inner = asRecord(asRecord(chunk)?.chunk)
          if (inner === undefined) continue
          if (inner.type === 'usage') {
            const usage = asRecord(inner.usage)
            totalInputTokens += numberOf(usage?.inputTokens)
            totalOutputTokens += numberOf(usage?.outputTokens)
          } else if (inner.type === 'text' && typeof inner.text === 'string') {
            assistantTextBytes += Buffer.byteLength(inner.text, 'utf8')
          }
        }
      }
      const message = asRecord(record.data)?.message
      if (message !== undefined) {
        const text = textOf(message)
        if (text !== undefined) assistantTextBytes += Buffer.byteLength(text, 'utf8')
      }
      continue
    }

    if (type === 'tool/result') {
      const data = asRecord(record.data)
      if (data !== undefined && data.ok !== false) successfulToolCalls += 1
      continue
    }

    if (type === 'turn/end') {
      const reason = asRecord(asRecord(record.data)?.reason)
      const kind = reason?.kind
      if (kind === 'error') {
        terminatedWithError += 1
        const failure = asRecord(reason?.failure) ?? asRecord(reason?.error)
        const entry: { code?: string; message?: string } = {}
        if (typeof failure?.code === 'string') entry.code = failure.code
        if (typeof failure?.message === 'string') entry.message = failure.message
        terminalErrors.push(entry)
      } else {
        terminatedOtherwise += 1
      }
    }
  }

  const base = {
    totalInputTokens,
    totalOutputTokens,
    assistantTextBytes,
    successfulToolCalls,
    terminalErrors,
    ...(firstUserText === undefined ? {} : { firstUserText }),
  } as const

  // No attempt at all means the model never ran; that is the existing `empty`
  // concern, not a zero-output failure.
  if (attempts === 0) {
    return { ...base, class: sawTurnStart ? 'meaningful' : 'empty' }
  }

  const producedNothing = totalOutputTokens === 0 && assistantTextBytes === 0 && successfulToolCalls === 0
  const endedOnlyInError = terminatedWithError > 0 && terminatedOtherwise === 0
  if (producedNothing && endedOnlyInError) {
    return { ...base, class: 'failed-zero-output' }
  }

  if (options.classifyTrivial === true && isTrivial(base, firstUserText)) {
    return { ...base, class: 'trivial-automation' }
  }

  return { ...base, class: 'meaningful' }
}

/**
 * Shadow heuristic for "automation that answered but taught nothing".
 * Kept behind an explicit opt-in until field data shows the false-positive rate.
 */
function isTrivial(
  facts: Omit<SessionQualityResult, 'class'>,
  firstUserText: string | undefined,
): boolean {
  if (facts.successfulToolCalls > 0) return false
  if (facts.assistantTextBytes > TRIVIAL_TEXT_BYTES) return false
  if (firstUserText === undefined) return false
  if (Buffer.byteLength(firstUserText, 'utf8') > TRIVIAL_PROMPT_BYTES) return false
  return !looksLikePreference(firstUserText)
}

/** Cheap guard so "always do X from now on" is never treated as trivial. */
function looksLikePreference(text: string): boolean {
  return /(remember|always|never|prefer|以后|记住|总是|不要|规则|约定)/iu.test(text)
}

/** Stable grouping key for repeated failures of the same kind. */
export function sessionGroupFingerprint(input: {
  readonly workspaceKey: string
  readonly title: string | null
  readonly firstUserText?: string | undefined
  readonly quality: SessionQualityClass
  readonly errorCode?: string | undefined
}): string {
  const parts = [
    input.workspaceKey,
    normalize(input.title ?? ''),
    normalize(input.firstUserText ?? ''),
    input.quality,
    input.errorCode ?? '',
  ]
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function textOf(value: unknown): string | undefined {
  const content = asRecord(value)?.content
  if (!Array.isArray(content)) return undefined
  const texts = content
    .map(part => asRecord(part))
    .filter((part): part is Record<string, unknown> => part !== undefined && part.type === 'text')
    .map(part => typeof part.text === 'string' ? part.text : '')
    .filter(text => text !== '')
  return texts.length === 0 ? undefined : texts.join('\n')
}
