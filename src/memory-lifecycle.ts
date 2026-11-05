/**
 * Reversible forgetting.
 *
 * Forgetting is not deletion. A memory that stops being useful is cooled, then
 * archived: it leaves the default prompt and index but stays on disk and stays
 * restorable. Physical deletion is a separate act that requires the user to say
 * so explicitly, and nothing in this module can produce it.
 *
 * The asymmetry is deliberate: hiding a memory is cheap to undo, deleting one
 * is not. Every threshold below therefore errs toward keeping.
 */

import type { ImportanceClass, Lifecycle, Volatility } from './memory-governance-types.ts'

const DAY = 24 * 60 * 60 * 1000

/** Working memory cools after this long without evidence or use. */
export const WORKING_COOL_AFTER_MS = 60 * DAY
/** Cooled working memory archives after this much additional silence. */
export const WORKING_ARCHIVE_AFTER_MS = 120 * DAY
/** Transient memory cools quickly; it described a moment, not a rule. */
export const TRANSIENT_COOL_AFTER_MS = 7 * DAY
export const TRANSIENT_ARCHIVE_AFTER_MS = 30 * DAY
/** Durable memory is only ever flagged for review, never auto-archived. */
export const DURABLE_REVIEW_AFTER_MS = 180 * DAY
/** An incident's details can go once its lesson has been extracted. */
export const INCIDENT_ARCHIVE_AFTER_MS = 30 * DAY

/** Facts the lifecycle policy is allowed to consider. */
export interface LifecycleInput {
  readonly lifecycle: Lifecycle
  readonly importanceClass: ImportanceClass
  readonly volatility: Volatility
  /** Last time new evidence supported the claim. */
  readonly lastEvidenceAt: number
  /** Last time retrieval actually used it, if any provider reported so. */
  readonly lastUsedAt: number | null
  readonly superseded: boolean
  /** True when a reusable procedure has already been extracted from an incident. */
  readonly hasExtractedSop: boolean
  /**
   * True only for an incident record. Distinct from `volatility: 'transient'`,
   * which also covers ordinary short-lived state that has no lesson inside it.
   */
  readonly isIncident?: boolean
  readonly now: number
}

/** The policy's decision plus why it made it. */
export interface LifecycleDecision {
  readonly lifecycle: Lifecycle
  /** Whether the claim belongs in the default prompt and index. */
  readonly visible: boolean
  readonly reason:
    | 'protected'
    | 'fresh'
    | 'superseded'
    | 'cooled'
    | 'archived'
    | 'restored'
    | 'review'
    | 'awaiting-sop'
}

/** Decide the next lifecycle state for one claim. */
export function nextLifecycle(input: LifecycleInput): LifecycleDecision {
  // Critical claims are the user's own rules: never aged out, whatever the clock.
  if (input.importanceClass === 'critical') {
    return { lifecycle: 'active', visible: true, reason: 'protected' }
  }

  if (input.superseded) {
    return { lifecycle: 'superseded', visible: false, reason: 'superseded' }
  }

  const silence = input.now - lastActivity(input)

  // New evidence revives an archived claim. Restoring is always safe: it puts
  // back something the user once needed.
  if (input.lifecycle === 'archived' || input.lifecycle === 'cooled') {
    if (silence < coolThreshold(input)) {
      return { lifecycle: 'active', visible: true, reason: 'restored' }
    }
  }

  if (input.lifecycle === 'archived') {
    return { lifecycle: 'archived', visible: false, reason: 'archived' }
  }

  // An incident keeps its details until the lesson inside it has been lifted out;
  // archiving first would throw away the only record of what happened. This is
  // keyed on the incident kind, not on transience: ordinary short-lived state
  // carries no lesson and must still be able to archive on schedule.
  if (input.isIncident === true && !input.hasExtractedSop && input.lifecycle === 'cooled') {
    if (silence < INCIDENT_ARCHIVE_AFTER_MS * 2) {
      return { lifecycle: 'cooled', visible: true, reason: 'awaiting-sop' }
    }
  }

  if (input.lifecycle === 'cooled') {
    if (silence >= archiveThreshold(input)) {
      return { lifecycle: 'archived', visible: false, reason: 'archived' }
    }
    return { lifecycle: 'cooled', visible: true, reason: 'cooled' }
  }

  if (silence < coolThreshold(input)) {
    return { lifecycle: 'active', visible: true, reason: 'fresh' }
  }

  // Durable claims stop here: they are flagged for a human look, not aged out.
  if (input.importanceClass === 'durable') {
    return { lifecycle: 'active', visible: true, reason: 'review' }
  }

  return { lifecycle: 'cooled', visible: true, reason: 'cooled' }
}

/** Whether a durable claim has gone long enough without evidence to need a look. */
export function shouldReview(input: LifecycleInput): boolean {
  if (input.importanceClass !== 'durable') return false
  return input.now - lastActivity(input) >= DURABLE_REVIEW_AFTER_MS
}

/** Evidence or actual use, whichever is more recent. */
function lastActivity(input: LifecycleInput): number {
  if (input.lastUsedAt === null) return input.lastEvidenceAt
  return Math.max(input.lastEvidenceAt, input.lastUsedAt)
}

function coolThreshold(input: LifecycleInput): number {
  if (input.importanceClass === 'transient' || input.volatility === 'transient') {
    return TRANSIENT_COOL_AFTER_MS
  }
  return WORKING_COOL_AFTER_MS
}

function archiveThreshold(input: LifecycleInput): number {
  if (input.importanceClass === 'transient' || input.volatility === 'transient') {
    return TRANSIENT_ARCHIVE_AFTER_MS
  }
  return WORKING_ARCHIVE_AFTER_MS
}
