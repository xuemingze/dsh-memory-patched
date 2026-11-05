/**
 * Per-action approval for Dream plans.
 *
 * Dream proposes a plan, but the user decides which actions run. Approving a
 * whole plan as one yes/no would force an all-or-nothing choice: one bad action
 * would mean rejecting the good ones with it, and users would learn to approve
 * blindly. So approval is per action.
 *
 * A rejection carries a reason code. That is not bookkeeping: the same snapshot
 * would otherwise be re-proposed on every run, and the user would keep dismissing
 * the same suggestion. The code lets the next run skip what was already declined.
 */

import type { DreamAction } from './memory-dream-proposal.ts'
import type { DreamMode } from './consolidation-settings.ts'

/** Why a user declined an action. */
export const REJECT_REASONS = [
  /** The merge would combine records that are not actually about the same thing. */
  'wrong-merge',
  /** The record is correct as it stands. */
  'disagree',
  /** True, but not worth keeping. */
  'not-important',
  /** The fact is already recorded elsewhere. */
  'already-known',
] as const
export type RejectReason = (typeof REJECT_REASONS)[number]

export function isRejectReason(value: unknown): value is RejectReason {
  return typeof value === 'string' && (REJECT_REASONS as readonly string[]).includes(value)
}

/** The minimum an action needs to be identified for approval. */
export interface ApprovableAction {
  readonly action: string
  readonly target: string
  readonly sources?: readonly string[]
  readonly rationale?: string
}

/**
 * A stable handle for one action inside a plan.
 *
 * Deliberately excludes array position: a plan can be re-rendered or re-ordered
 * between display and approval, and an index-based handle would then approve a
 * different action than the one the user ticked. Rationale is excluded for the
 * same reason it is excluded from the plan hash — it is a comment.
 */
export function planActionFingerprint(action: ApprovableAction): string {
  const sources = [...(action.sources ?? [])].sort()
  return `${action.action}\u0000${action.target}\u0000${sources.join(',')}`
}

/**
 * The actions the user actually ticked, in plan order.
 *
 * An unknown fingerprint is dropped rather than treated as an error: a stale tab
 * may reference an action from a plan that has since been replaced, and the safe
 * reading is "that action is no longer on offer".
 */
export function selectApprovedActions<T extends ApprovableAction>(
  actions: readonly T[],
  approved: readonly string[],
): T[] {
  const wanted = new Set(approved)
  return actions.filter(action => wanted.has(planActionFingerprint(action)))
}

/** Actions that can lose information, so no mode applies them without a yes. */
const CONTENT_ACTIONS: ReadonlySet<string> = new Set([
  'merge', 'supersede', 'extract-sop', 'promote-global', 'archive',
])

/**
 * Whether this action needs an explicit click in the current mode.
 *
 * In `manual`, metadata-only actions may be committed directly — cooling or
 * re-ranking is undone by another metadata action, so the cost of a wrong call
 * is low. Content actions always need a click, in every mode, because a wrong
 * merge cannot be reconstructed from what is left.
 */
export function requiresExplicitApproval(action: ApprovableAction, mode: DreamMode): boolean {
  if (mode === 'shadow') return true
  if (mode === 'off') return true
  return CONTENT_ACTIONS.has(action.action)
}

/** True when every action in the plan may be applied without further clicks. */
export function planNeedsNoApproval(actions: readonly DreamAction[], mode: DreamMode): boolean {
  return actions.every(action => !requiresExplicitApproval(toApprovable(action), mode))
}

/** Narrow a validated action to the fields approval reasons about. */
export function toApprovable(action: DreamAction): ApprovableAction {
  switch (action.action) {
    case 'merge':
      return { action: action.action, target: action.target, sources: action.sources }
    case 'extract-sop':
      return { action: action.action, target: action.target, sources: [action.source] }
    case 'supersede':
      return { action: action.action, target: action.newer, sources: [action.older] }
    case 'promote-global':
      return { action: action.action, target: action.section, sources: [action.source] }
    default:
      return { action: action.action, target: action.target }
  }
}
