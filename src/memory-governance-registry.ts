/**
 * Optional, hot-swappable providers for memory governance.
 *
 * dsh-memory deliberately owns no network probing, no proxy control, no plugin
 * health checks, and no scheduler. Those belong to whichever plugin already
 * knows how to do them. This registry is the narrow seam: a provider supplies
 * dated observations, the registry validates and bounds them, and the core keeps
 * working when none is installed.
 *
 * Every failure mode here degrades to `unavailable`, never to "the claim is
 * false": a broken verifier must not be able to rewrite memory.
 */

import type { GovernanceClaim } from './memory-governance-types.ts'
import type { VerificationObservation } from './memory-conflicts.ts'

/** A verifier supplied by another plugin. */
export interface MemoryVerificationProvider {
  readonly id: string
  /** Only asked about claims this provider can actually judge. */
  supports(claim: GovernanceClaim): boolean
  verify(claim: GovernanceClaim, signal: AbortSignal): Promise<VerificationObservation>
}

/** One provider failure, retained for diagnostics rather than surfaced to models. */
export interface GovernanceProviderFailure {
  readonly providerId: string
  readonly reason: string
}

/** Aggregated verification result. */
export interface VerificationBatch {
  readonly observations: readonly VerificationObservation[]
  /** Claims for which no provider produced a usable observation. */
  readonly unavailable: number
  readonly failures: readonly GovernanceProviderFailure[]
}

export interface GovernanceRegistryOptions {
  readonly providerTimeoutMs?: number
  readonly maxConcurrency?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_CONCURRENCY = 4
const VALID_RESULTS = new Set(['supports', 'contradicts', 'inconclusive', 'unavailable'])
const VALID_CONFIDENCE = new Set(['authoritative', 'strong', 'weak'])

/** Holds optional governance providers and runs bounded verification. */
export class MemoryGovernanceRegistry {
  private readonly verificationProviders = new Map<string, MemoryVerificationProvider>()
  private readonly timeoutMs: number
  private readonly maxConcurrency: number

  constructor(options: GovernanceRegistryOptions = {}) {
    this.timeoutMs = options.providerTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_CONCURRENCY)
  }

  /** Register a verifier. The returned disposer detaches it immediately. */
  registerVerificationProvider(provider: MemoryVerificationProvider): () => void {
    if (this.verificationProviders.has(provider.id)) {
      throw new Error(`a verification provider is already registered as "${provider.id}"`)
    }
    this.verificationProviders.set(provider.id, provider)
    return () => {
      // Only drop the exact registration that was added: a provider re-registered
      // under the same id after disposal must survive an old disposer running.
      if (this.verificationProviders.get(provider.id) === provider) {
        this.verificationProviders.delete(provider.id)
      }
    }
  }

  /** Registered provider ids, in registration order. */
  verificationProviderIds(): string[] {
    return [...this.verificationProviders.keys()]
  }

  /**
   * Verify a set of claims.
   *
   * Never throws: a provider that hangs, rejects, or returns garbage becomes an
   * `unavailable` count. The caller then parks the conflict instead of deciding.
   */
  async verify(
    claims: readonly GovernanceClaim[],
    signal: AbortSignal,
  ): Promise<VerificationBatch> {
    if (signal.aborted) return { observations: [], unavailable: claims.length, failures: [] }

    const tasks: Array<() => Promise<{ claim: GovernanceClaim; observation: VerificationObservation } | undefined>> = []
    const failures: GovernanceProviderFailure[] = []

    for (const claim of claims) {
      for (const provider of this.verificationProviders.values()) {
        let supported: boolean
        try {
          supported = provider.supports(claim)
        } catch (error) {
          failures.push({ providerId: provider.id, reason: describe(error) })
          continue
        }
        if (!supported) continue
        tasks.push(() => this.runOne(provider, claim, signal, failures))
      }
    }

    const settled = await runBounded(tasks, this.maxConcurrency)
    const observations: VerificationObservation[] = []
    const covered = new Set<GovernanceClaim>()
    for (const entry of settled) {
      if (entry === undefined) continue
      observations.push(entry.observation)
      covered.add(entry.claim)
    }
    // A claim is unavailable when no provider produced a usable observation for
    // it. Upstream turns that into "needs verification", never into a verdict.
    return {
      observations,
      unavailable: claims.filter(claim => !covered.has(claim)).length,
      failures,
    }
  }

  private async runOne(
    provider: MemoryVerificationProvider,
    claim: GovernanceClaim,
    signal: AbortSignal,
    failures: GovernanceProviderFailure[],
  ): Promise<{ claim: GovernanceClaim; observation: VerificationObservation } | undefined> {
    try {
      const raw = await withTimeout(
        Promise.resolve().then(() => provider.verify(claim, signal)),
        this.timeoutMs,
        provider.id,
      )
      const parsed = parseObservation(raw, provider.id)
      if (parsed === undefined) {
        failures.push({ providerId: provider.id, reason: 'invalid observation shape' })
        return undefined
      }
      return { claim, observation: parsed }
    } catch (error) {
      failures.push({ providerId: provider.id, reason: describe(error) })
      return undefined
    }
  }
}

/** Validate one observation and force the registered provider id. */
function parseObservation(value: unknown, providerId: string): VerificationObservation | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.result !== 'string' || !VALID_RESULTS.has(record.result)) return undefined
  if (typeof record.confidence !== 'string' || !VALID_CONFIDENCE.has(record.confidence)) return undefined
  if (typeof record.observedAt !== 'number' || !Number.isFinite(record.observedAt)) return undefined
  if (typeof record.environmentFingerprint !== 'string') return undefined
  return {
    // The registered id wins: otherwise one provider could impersonate another
    // and manufacture independent corroboration.
    providerId,
    observedAt: record.observedAt,
    environmentFingerprint: record.environmentFingerprint,
    result: record.result as VerificationObservation['result'],
    confidence: record.confidence as VerificationObservation['confidence'],
    ...(typeof record.expiresAt === 'number' ? { expiresAt: record.expiresAt } : {}),
    ...(typeof record.evidenceRef === 'string' ? { evidenceRef: record.evidenceRef } : {}),
    ...(typeof record.diagnostic === 'string' ? { diagnostic: record.diagnostic.slice(0, 1_000) } : {}),
  }
}

/** Reject after `ms`, naming the provider so the failure is actionable. */
async function withTimeout<T>(promise: Promise<T>, ms: number, providerId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`provider timeout: ${providerId}`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Run thunks with a concurrency ceiling, preserving order. */
async function runBounded<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<Array<T | undefined>> {
  const results: Array<T | undefined> = Array.from({ length: tasks.length })
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor
      cursor += 1
      results[index] = await tasks[index]!()
    }
  })
  await Promise.all(workers)
  return results
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
