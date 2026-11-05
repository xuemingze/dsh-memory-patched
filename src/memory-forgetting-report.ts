/**
 * Shadow forgetting report.
 *
 * This module only *describes* what the lifecycle policy would do. It never
 * writes anything, which is what makes it safe to show before the policy is
 * trusted: a reviewer sees the exact list of records that would cool or archive,
 * with the reason for each, and can enable the policy only after agreeing with it.
 */

import { nextLifecycle, type LifecycleInput } from './memory-lifecycle.ts'
import { importanceClassOf } from './memory-governance-types.ts'
import type { ClaimKind, Lifecycle, Volatility } from './memory-governance-types.ts'

/** One record as the report sees it. */
export interface ForgettingRecordInput {
  readonly name: string
  readonly kind: ClaimKind
  readonly volatility: Volatility
  readonly importanceScore: number
  readonly lifecycle: Lifecycle
  readonly lastEvidenceAt: number
  readonly lastUsedAt: number | null
  readonly superseded: boolean
  readonly hasExtractedSop: boolean
}

/** One proposed lifecycle transition. */
export interface ForgettingChange {
  readonly name: string
  readonly from: Lifecycle
  readonly to: Lifecycle
  readonly importanceScore: number
  readonly importanceClass: string
  readonly reason: string
}

export interface ForgettingReport {
  readonly changes: readonly ForgettingChange[]
  readonly counts: {
    readonly cooled: number
    readonly archived: number
    readonly restored: number
  }
  /** Records left alone because they are critical: the user's own rules. */
  readonly protectedCount: number
}

/** Describe what the lifecycle policy would change right now. */
export function buildForgettingReport(
  records: readonly ForgettingRecordInput[],
  now: number,
): ForgettingReport {
  const changes: ForgettingChange[] = []
  let protectedCount = 0
  let cooled = 0
  let archived = 0
  let restored = 0

  for (const record of records) {
    const input: LifecycleInput = {
      lifecycle: record.lifecycle,
      importanceClass: importanceClassOf(record.importanceScore),
      volatility: record.volatility,
      lastEvidenceAt: record.lastEvidenceAt,
      lastUsedAt: record.lastUsedAt,
      superseded: record.superseded,
      hasExtractedSop: record.hasExtractedSop,
      isIncident: record.kind === 'incident',
      now,
    }
    const decision = nextLifecycle(input)

    if (decision.reason === 'protected') {
      protectedCount += 1
      continue
    }
    if (decision.lifecycle === record.lifecycle) continue

    if (decision.lifecycle === 'cooled') cooled += 1
    else if (decision.lifecycle === 'archived') archived += 1
    else if (decision.lifecycle === 'active') restored += 1

    changes.push({
      name: record.name,
      from: record.lifecycle,
      to: decision.lifecycle,
      importanceScore: record.importanceScore,
      importanceClass: importanceClassOf(record.importanceScore),
      reason: decision.reason,
    })
  }

  // Least valuable first: that is the order a reviewer wants to judge them in.
  changes.sort((left, right) => left.importanceScore - right.importanceScore
    || left.name.localeCompare(right.name, 'en'))

  return { changes, counts: { cooled, archived, restored }, protectedCount }
}
