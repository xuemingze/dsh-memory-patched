/**
 * Governance metadata for memory records.
 *
 * The Markdown files stay the single source of truth for what a memory *says*.
 * This layer only tracks how much that statement can be trusted, how durable it
 * is, and whether it is still visible — kept in a separate sidecar so the
 * `memory_update` wire format never has to grow.
 */

/** What a claim is about. Drives which contradictions actually matter. */
export type ClaimKind =
  | 'identity'
  | 'preference'
  | 'decision'
  | 'capability'
  | 'configuration'
  | 'incident'
  | 'availability'
  | 'procedure'
  | 'diagnostic'

/**
 * How fast the claim goes stale.
 *
 * `intermittent` is the important one: a fact that flips between working and
 * broken must never be rewritten as "works" or "broken" on each observation.
 */
export type Volatility = 'stable' | 'versioned' | 'environmental' | 'intermittent' | 'transient'

/** Where a claim sits in its lifecycle. Nothing here deletes Markdown. */
export type Lifecycle = 'active' | 'contested' | 'cooled' | 'superseded' | 'archived'

/** Coarse importance band derived from the deterministic score. */
export type ImportanceClass = 'critical' | 'durable' | 'working' | 'transient'

/** One governed memory record. */
export interface GovernanceClaim {
  readonly name: string
  readonly scopeKey: string
  readonly kind: ClaimKind
  readonly volatility: Volatility
  readonly lifecycle: Lifecycle
  readonly importanceClass: ImportanceClass
  readonly importanceScore: number
  readonly text: string
  readonly environmentFingerprint: string
  readonly evidenceCount: number
  readonly lastEvidenceAt: number
  readonly lastVerifiedAt: number | null
  readonly lastUsedAt: number | null
  /** Names of claims this one replaces, so the audit chain survives. */
  readonly supersedes: readonly string[]
  readonly sourcePlugins: readonly string[]
}

/** What a caller must supply; lifecycle and score are derived, never trusted. */
export interface GovernanceClaimInput {
  readonly name: string
  readonly scopeKey: string
  readonly kind: ClaimKind
  readonly volatility: Volatility
  readonly text: string
  readonly evidenceCount?: number
  readonly environmentFingerprint?: string
  readonly supersedes?: readonly string[]
  readonly sourcePlugins?: readonly string[]
  readonly lastEvidenceAt?: number
  /**
   * Explicit verdicts from a deterministic producer (the initializer, the
   * lifecycle policy). Omitted by ordinary callers, in which case the stored
   * values are preserved instead of being recomputed.
   */
  readonly importanceScore?: number
  readonly lifecycle?: Lifecycle
}

/** One scope's governance document as stored on disk. */
export interface GovernanceDocument {
  readonly format: 1
  readonly scopeKey: string
  readonly revision: string
  readonly claims: readonly GovernanceClaim[]
  /**
   * True when the stored sidecar could not be read or parsed. Callers must then
   * treat every Markdown record as active and visible: losing governance
   * metadata may cost ranking quality, but never memory itself.
   */
  readonly degraded: boolean
}

/** A commit to one scope. */
export interface GovernanceCommit {
  readonly scopeKey: string
  readonly expectedRevision: string
  readonly upserts: readonly GovernanceClaimInput[]
  readonly removals: readonly string[]
}

/** Result of a successful commit. */
export interface GovernanceCommitResult {
  readonly revision: string
  readonly claims: readonly GovernanceClaim[]
}

/** Importance score bands. */
export const IMPORTANCE_CRITICAL_MIN = 80
export const IMPORTANCE_DURABLE_MIN = 55
export const IMPORTANCE_WORKING_MIN = 30

/** Map a deterministic score onto its band. */
export function importanceClassOf(score: number): ImportanceClass {
  if (score >= IMPORTANCE_CRITICAL_MIN) return 'critical'
  if (score >= IMPORTANCE_DURABLE_MIN) return 'durable'
  if (score >= IMPORTANCE_WORKING_MIN) return 'working'
  return 'transient'
}
