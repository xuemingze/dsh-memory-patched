/**
 * Deterministic importance scoring.
 *
 * The point of the score is not precision; it is *repeatability*. A model asked
 * twice about the same record gives two answers, and a memory system whose
 * priorities drift on every run cannot decide what to forget. So importance is a
 * pure function of observable facts, and the model may only supply the facts.
 *
 * Bands (see memory-governance-types):
 *   critical >= 80  never auto-cooled: user identity, stated rules
 *   durable  55-79  kept, periodically reviewed
 *   working  30-54  project memory, cools when evidence stops
 *   transient < 30  diagnostics and one-off states
 */

import type { ClaimKind, Volatility } from './memory-governance-types.ts'

/** Everything the scorer is allowed to look at. */
export interface ImportanceSignals {
  readonly kind: ClaimKind
  readonly volatility: Volatility
  /** How many times independent evidence supported this claim. */
  readonly evidenceCount: number
  /** Distinct evidence sources (Sessions, providers) behind it. */
  readonly distinctSources: number
  /** How many Workspaces the claim applies to. */
  readonly workspaceCount: number
  /** Plugins this claim is specific to; empty means plugin-agnostic. */
  readonly sourcePlugins: readonly string[]
  /** True when the user stated it directly rather than it being inferred. */
  readonly userStated: boolean
  /** True when the claim carries a reusable procedure. */
  readonly hasProcedure: boolean
  /** True when a newer claim has replaced this one. */
  readonly superseded: boolean
}

const BASE = 50

/** Evidence stops adding value past this many repeats. */
const EVIDENCE_SATURATION = 5
const EVIDENCE_BONUS_MAX = 10
const SOURCE_BONUS_MAX = 10
const WORKSPACE_BONUS_MAX = 25

/** Compute the 0-100 importance of one claim. */
export function scoreImportance(signals: ImportanceSignals): number {
  let score = BASE

  // A rule the user stated is the highest authority in the system: it outranks
  // anything the model inferred, and must survive automatic forgetting.
  // Any explicit statement carries the user's authority, not only identity and
  // preference claims: a rule about how a project must work is just as binding.
  if (signals.userStated) score += 40

  // Cross-Workspace applicability is the strongest signal of durable value: a
  // lesson that helps three projects is worth more than one that helped once.
  score += Math.min(WORKSPACE_BONUS_MAX, Math.max(0, signals.workspaceCount - 1) * 12)

  // Repeated evidence matters, but saturates: fifty sightings of the same fact
  // are not fifty times more important.
  score += Math.round(EVIDENCE_BONUS_MAX * Math.min(1, Math.max(0, signals.evidenceCount - 1) / EVIDENCE_SATURATION))

  // Independent sources are stronger than repeats of one voice.
  score += Math.round(SOURCE_BONUS_MAX * Math.min(1, Math.max(0, signals.distinctSources - 1) / 2))

  if (signals.hasProcedure) score += 10

  // Plugin-specific version detail decays: the plugin will be swapped, and the
  // detail will be wrong. A cross-plugin lesson does not pay this penalty.
  if (signals.sourcePlugins.length > 0) score -= 15

  // An intermittent profile is worth keeping, but it must not read as a
  // universal truth, so it ranks below stable claims.
  if (signals.volatility === 'environmental' || signals.volatility === 'intermittent') score -= 10

  if (signals.volatility === 'transient') score -= 30

  if (signals.superseded) score -= 40

  // Inferred knowledge never outranks what the user stated outright. Without
  // this cap a well-evidenced SOP reaches 100 and ties the user's own rules,
  // which would let an automatic pass treat them as interchangeable.
  if (!signals.userStated) score = Math.min(score, USER_STATED_FLOOR - 1)

  return clamp(Math.round(score))
}

/**
 * The lowest score an explicit user statement can receive. Inferred claims stay
 * just below it so "what the user told me" always sorts first.
 */
const USER_STATED_FLOOR = 90

function clamp(value: number): number {
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}
