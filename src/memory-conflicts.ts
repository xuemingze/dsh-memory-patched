/**
 * Contradiction classification and intermittent-availability profiling.
 *
 * The hard part of memory governance is not finding disagreements; it is
 * refusing to "resolve" the ones that are not disagreements. A proxy that works
 * on Monday and fails on Tuesday is not a fact flipping between true and false,
 * and rewriting memory on each observation is how a memory store becomes
 * useless. Every verdict here therefore prefers "keep both / park" over
 * "overwrite", and only promotes to supersession on independent corroboration.
 */

import { createHash } from 'node:crypto'
import type { GovernanceClaim } from './memory-governance-types.ts'

/** One dated observation from a verifier. */
export interface VerificationObservation {
  readonly providerId: string
  readonly observedAt: number
  readonly environmentFingerprint: string
  readonly result: 'supports' | 'contradicts' | 'inconclusive' | 'unavailable'
  readonly confidence: 'authoritative' | 'strong' | 'weak'
  readonly expiresAt?: number
  readonly evidenceRef?: string
  readonly diagnostic?: string
}

/** Aggregated picture of one intermittent fact inside a time window. */
export interface AvailabilityProfile {
  readonly verdict:
    | 'unknown'
    | 'transient'
    | 'intermittent'
    | 'stable-failing'
    | 'stable-ok'
    | 'restored'
  readonly failures: number
  readonly successes: number
  /** Times the observation alternated between success and failure. */
  readonly switches: number
  readonly firstObservedAt: number | null
  readonly lastObservedAt: number | null
  readonly lastSuccessAt: number | null
  readonly lastFailureAt: number | null
}

/** How a pair of claims relates, and what the caller may do about it. */
export interface ConflictDecision {
  readonly kind:
    | 'none'
    | 'hard-conflict'
    | 'temporal-evolution'
    | 'environment-split'
    | 'intermittent'
    | 'needs-verification'
  readonly action: 'keep-both' | 'park' | 'supersede-older' | 'merge-intermittent'
  readonly reason: string
}

/** Rolling window used for availability statistics. */
export const AVAILABILITY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
/** A failure repeated inside this span is one incident, not a pattern. */
export const STABLE_FAILURE_SPREAD_MS = 30 * 60 * 1000
/** Recovery needs successes spread across this span, not a burst. */
export const RESTORED_SPREAD_MS = 24 * 60 * 60 * 1000

const MIN_FAILURES_FOR_INTERMITTENT = 3
const MIN_SUCCESSES_FOR_INTERMITTENT = 2
const MIN_SWITCHES_FOR_INTERMITTENT = 2
const MIN_FAILURES_FOR_STABLE = 3
const MIN_SUCCESSES_FOR_RESTORED = 3

/** Build the coarse environment key that keeps separate worlds separate. */
export function environmentFingerprint(input: {
  readonly profile?: string
  readonly platform?: string
  readonly version?: string
  readonly storage?: string
}): string {
  const parts = [
    input.profile ?? '',
    input.platform ?? '',
    input.version ?? '',
    input.storage ?? '',
  ]
  // Empty fields still participate, so "unspecified" is its own bucket rather
  // than silently matching every concrete environment.
  return parts.join('|')
}

/** Summarize availability observations inside the rolling window. */
export function summarizeAvailabilityWindow(
  observations: readonly VerificationObservation[],
  now: number,
): AvailabilityProfile {
  const from = now - AVAILABILITY_WINDOW_MS
  // Unavailable and inconclusive carry no information about the world: counting
  // them as failures would let a broken verifier fake an outage.
  const usable = observations
    .filter(entry => entry.result === 'supports' || entry.result === 'contradicts')
    .filter(entry => entry.observedAt >= from && entry.observedAt <= now)
    .sort((left, right) => left.observedAt - right.observedAt)

  if (usable.length === 0) {
    return {
      verdict: 'unknown',
      failures: 0,
      successes: 0,
      switches: 0,
      firstObservedAt: null,
      lastObservedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    }
  }

  let failures = 0
  let successes = 0
  let switches = 0
  let previous: 'supports' | 'contradicts' | undefined
  let lastSuccessAt: number | null = null
  let lastFailureAt: number | null = null
  const failureTimes: number[] = []
  const successTimes: number[] = []

  for (const entry of usable) {
    const outcome: 'supports' | 'contradicts' = entry.result === 'supports' ? 'supports' : 'contradicts'
    if (outcome === 'supports') {
      successes += 1
      lastSuccessAt = entry.observedAt
      successTimes.push(entry.observedAt)
    } else {
      failures += 1
      lastFailureAt = entry.observedAt
      failureTimes.push(entry.observedAt)
    }
    if (previous !== undefined && previous !== outcome) switches += 1
    previous = outcome
  }

  const flapping = failures >= MIN_FAILURES_FOR_INTERMITTENT
    && successes >= MIN_SUCCESSES_FOR_INTERMITTENT
    && switches >= MIN_SWITCHES_FOR_INTERMITTENT
  if (flapping) {
    return build('intermittent')
  }

  const spreadFailures = spread(failureTimes)
  const consecutiveFailures = trailingRun(usable, 'contradicts')
  if (failures >= MIN_FAILURES_FOR_STABLE
    && consecutiveFailures >= MIN_FAILURES_FOR_STABLE
    && spreadFailures >= STABLE_FAILURE_SPREAD_MS) {
    return build('stable-failing')
  }

  // Never failed at all: a healthy stretch, not a recovery from anything.
  if (failures === 0) return build('stable-ok')
  // Never succeeded at all, but too short/sparse to prove a stable outage.
  if (successes === 0) return build('transient')

  // Recovery needs repeated successes spread over days AND the last word to be a
  // success. A single success after a long outage stays `transient` on purpose:
  // that is exactly the observation that must not be allowed to rewrite memory.
  const spreadSuccesses = spread(successTimes)
  const trailingSuccesses = trailingRun(usable, 'supports')
  if (successes >= MIN_SUCCESSES_FOR_RESTORED
    && trailingSuccesses >= MIN_SUCCESSES_FOR_RESTORED
    && spreadSuccesses >= RESTORED_SPREAD_MS) {
    return build('restored')
  }

  // Mixed evidence that has not yet met the flapping threshold: still unreliable,
  // so refuse to promote it to a stable verdict either way.
  return build('transient')

  function build(verdict: AvailabilityProfile['verdict']): AvailabilityProfile {
    return {
      verdict,
      failures,
      successes,
      switches,
      firstObservedAt: usable[0]!.observedAt,
      lastObservedAt: usable[usable.length - 1]!.observedAt,
      lastSuccessAt,
      lastFailureAt,
    }
  }
}

/** Span between the first and last timestamp. */
function spread(times: readonly number[]): number {
  if (times.length < 2) return 0
  return Math.max(...times) - Math.min(...times)
}

/** Length of the trailing same-result run. */
function trailingRun(
  observations: readonly VerificationObservation[],
  result: VerificationObservation['result'],
): number {
  let run = 0
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    if (observations[index]!.result !== result) break
    run += 1
  }
  return run
}

/**
 * Decide how two claims relate.
 *
 * Order matters: environment differences are checked before content, because
 * two facts about different worlds are never in conflict no matter how
 * contradictory they read.
 */
export function classifyClaimConflict(
  left: GovernanceClaim,
  right: GovernanceClaim,
  observations: readonly VerificationObservation[],
  now: number,
): ConflictDecision {
  if (left.name === right.name) {
    return { kind: 'none', action: 'keep-both', reason: 'same-record' }
  }
  if (left.environmentFingerprint !== right.environmentFingerprint) {
    return {
      kind: 'environment-split',
      action: 'keep-both',
      reason: 'different-environment',
    }
  }
  if (left.kind !== right.kind) {
    return { kind: 'none', action: 'keep-both', reason: 'different-kind' }
  }

  // Availability is checked before content analysis on purpose. Two records that
  // say "the proxy works" and "the proxy fails" are not a contradiction to be
  // adjudicated; they are the two halves of one flapping fact. Deciding this
  // first is what stops a rewording of the same symptom from looking like a
  // conflict worth overwriting.
  if (left.kind === 'availability' && right.kind === 'availability') {
    const profile = summarizeAvailabilityWindow(
      observations.filter(entry => entry.environmentFingerprint === left.environmentFingerprint),
      now,
    )
    if (profile.verdict === 'intermittent') {
      return {
        kind: 'intermittent',
        action: 'merge-intermittent',
        reason: 'flapping-observations',
      }
    }
  }

  if (!statementsExclusive(left, right)) {
    return { kind: 'none', action: 'keep-both', reason: 'not-exclusive' }
  }

  // A later claim that describes a state change is evolution, not disagreement.
  const gap = right.lastEvidenceAt - left.lastEvidenceAt
  if (gap >= 0 && evolves(left, right)) {
    return {
      kind: 'temporal-evolution',
      action: 'supersede-older',
      reason: 'later-state',
    }
  }

  const corroboration = independentCorroboration(observations, now)
  if (corroboration >= 2) {
    return {
      kind: 'hard-conflict',
      action: 'supersede-older',
      reason: 'independent-corroboration',
    }
  }
  if (corroboration === 0 && observations.length > 0 && observations.every(isNonCommittal)) {
    return {
      kind: 'needs-verification',
      action: 'park',
      reason: 'verification-unavailable',
    }
  }
  return {
    kind: 'hard-conflict',
    action: 'park',
    reason: 'awaiting-second-source',
  }
}

/**
 * Count independent providers that actively contradict one side.
 *
 * Two observations from the same provider are one voice, no matter how many
 * times it repeats: counting them twice is how a single flaky check would be
 * allowed to rewrite memory.
 */
function independentCorroboration(
  observations: readonly VerificationObservation[],
  now: number,
): number {
  const providers = new Set<string>()
  for (const entry of observations) {
    if (entry.result === 'unavailable' || entry.result === 'inconclusive') continue
    if (entry.expiresAt !== undefined && entry.expiresAt < now) continue
    if (entry.confidence === 'weak') continue
    providers.add(entry.providerId)
  }
  return providers.size
}

function isNonCommittal(entry: VerificationObservation): boolean {
  return entry.result === 'unavailable' || entry.result === 'inconclusive'
}

/**
 * Decide whether two claims actually disagree.
 *
 * Exclusivity needs a shared subject *and* opposite polarity. Subject overlap
 * comes from the record name (the handle two records share when they talk about
 * the same thing) or from substantial text overlap; polarity is three-state so a
 * neutral phrasing cannot be forced into either side. Requiring both is what
 * stops "dsh-ops is installed" and "dsh-ops must be installed from npm" from
 * being read as a contradiction.
 */
function statementsExclusive(left: GovernanceClaim, right: GovernanceClaim): boolean {
  const leftPolarity = polarityOf(left.text)
  const rightPolarity = polarityOf(right.text)
  // Only an explicit positive against an explicit negative disagrees.
  if (leftPolarity === 'neutral' || rightPolarity === 'neutral') return false
  if (leftPolarity === rightPolarity) return false

  if (subjectTokens(left) === subjectTokens(right)) return true
  const leftTokens = tokenize(left.text)
  const rightTokens = tokenize(right.text)
  const shared = [...leftTokens].filter(token => rightTokens.has(token))
  return shared.length >= 2
}

/**
 * Reduce a record name to its subject by dropping the trailing state word, so
 * `dsh-ops-installed` and `dsh-ops-missing` share a subject.
 */
function subjectTokens(claim: GovernanceClaim): string {
  return claim.name
    .toLowerCase()
    .replace(/[-_ ]?(installed|removed|missing|absent|enabled|disabled|present|gone|ok|fail|fails|failing)$/u, '')
}

/**
 * Classify a statement's polarity.
 *
 * Three states matter, not two. A neutral statement ("dsh-ops must be installed
 * from npm") neither affirms nor denies, so pairing it with anything must not
 * produce a conflict. A negation wins over any positive word it modifies:
 * "the flag is not enabled" is a denial even though it contains "enabled".
 */
type Polarity = 'affirmative' | 'negative' | 'neutral'

const NEGATIVE = /\b(not|no|never|disabled|uninstalled|removed|missing|absent|fails?|failing|broken|gone)\b|不|未|没有|已删|已卸|不可用|失败/iu
const AFFIRMATIVE = /\b(enabled|installed|present|works?|working|available|ok|succeeds?)\b|可用|已装|已安装|正常|成功/iu

function polarityOf(text: string): Polarity {
  // Negation dominates: "not enabled" denies, it does not affirm.
  if (NEGATIVE.test(text)) return 'negative'
  if (AFFIRMATIVE.test(text)) return 'affirmative'
  return 'neutral'
}

function tokenize(text: string): Set<string> {
  const latin = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/gu) ?? []
  const cjk = text.match(/[\u4e00-\u9fff]{2,}/gu) ?? []
  return new Set([...latin, ...cjk])
}

/** True when the newer claim reads as a state change of the older one. */
function evolves(left: GovernanceClaim, right: GovernanceClaim): boolean {
  if (left.lifecycle === 'superseded') return false
  if (left.volatility === 'stable' && right.volatility === 'stable') {
    // Two immutable statements at different times are a genuine conflict, not
    // an evolution: a stable fact cannot "change".
    return false
  }
  return true
}

/** Stable digest for grouping claims that describe the same subject. */
export function claimKeyOf(scopeKey: string, name: string): string {
  return createHash('sha256').update(`${scopeKey}\u0000${name}`).digest('hex').slice(0, 16)
}
