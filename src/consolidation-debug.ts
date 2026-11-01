/** Local append-only diagnostics for manual consolidation attempts. */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isConsolidationReviewId } from './consolidation-identity.ts'
import { redactCredentials as redact } from './redact.ts'

export interface ConsolidationDebugIdentity {
  readonly reviewId: string
  readonly attempt: number
}

/** JSONL diagnostics exclude evidence and memory bodies but retain error chains and stacks. */
export class ConsolidationDebugStore {
  constructor(
    readonly directory: string,
    private readonly now: () => Date = () => new Date(),
    private readonly warn: (message: string) => void = () => undefined,
    private readonly enabled: () => boolean = () => true,
  ) {}

  record(
    identity: ConsolidationDebugIdentity,
    stage: string,
    details: Readonly<Record<string, unknown>> = {},
  ): void {
    assertIdentity(identity)
    try {
      if (!this.enabled()) return
      const reviewDirectory = join(this.directory, identity.reviewId)
      mkdirSync(reviewDirectory, { recursive: true, mode: 0o700 })
      appendFileSync(
        join(reviewDirectory, `attempt-${identity.attempt}.jsonl`),
        `${JSON.stringify({ time: this.now().toISOString(), stage, ...sanitizeDetails(details) })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch (error: unknown) {
      this.warn(`dsh-memory: failed to write consolidation debug log: ${safeErrorMessage(error)}`)
    }
  }

  failure(identity: ConsolidationDebugIdentity, stage: string, error: unknown): void {
    this.record(identity, stage, { error: errorView(error) })
  }

  pathFor(identity: ConsolidationDebugIdentity): string {
    assertIdentity(identity)
    return join(this.directory, identity.reviewId, `attempt-${identity.attempt}.jsonl`)
  }
}

function assertIdentity(identity: ConsolidationDebugIdentity): void {
  if (!isConsolidationReviewId(identity.reviewId)) throw new TypeError('debug review id is invalid')
  if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1) throw new TypeError('debug attempt is invalid')
}

function errorView(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: typeof error, message: redact(String(error)) }
  const code = (error as Error & { code?: unknown }).code
  return {
    name: error.name,
    message: redact(error.message),
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    ...(error.stack === undefined ? {} : { stack: redact(error.stack) }),
    ...(error.cause === undefined || depth >= 4 ? {} : { cause: errorView(error.cause, depth + 1) }),
  }
}

function sanitizeDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, sanitizeValue(value)]))
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitizeValue(entry)]))
  }
  return String(value)
}

function safeErrorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error))
}
