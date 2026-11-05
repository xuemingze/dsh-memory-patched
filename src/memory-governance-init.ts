/**
 * Seed governance metadata for records that have none.
 *
 * Records written before governance existed have no claim entry, which means the
 * lifecycle policy cannot reason about them at all. This initializer derives the
 * facts it needs from what the record itself says, so the forgetting report has
 * something real to work with.
 *
 * It only ever creates metadata. Markdown is never touched, an existing claim is
 * never overwritten, and running it twice produces the same result.
 */

import type { MemoryGovernanceStore } from './memory-governance-store.ts'
import type { ClaimKind, GovernanceClaim, Volatility } from './memory-governance-types.ts'
import { scoreImportance, type ImportanceSignals } from './memory-importance.ts'

/** One record as the initializer sees it. */
export interface InitializableRecord {
  readonly name: string
  readonly description: string
  readonly type: 'feedback' | 'project' | 'reference'
  readonly content: string
  readonly lastEvidenceTime?: number
}

export interface InitializeScopeInput {
  readonly scopeKey: string
  readonly records: readonly InitializableRecord[]
}

export interface InitializationSummary {
  readonly scopeKey: string
  /** Claims created by this run. */
  readonly created: number
  /** Claims left alone because they already existed. */
  readonly skipped: number
  readonly revision: string
}

const DAY = 24 * 60 * 60 * 1000

/**
 * Derive governance facts from a record's own text.
 *
 * These are deliberately conservative guesses, not judgements: anything that
 * looks durable is treated as durable, and only clear transient phrasing is
 * marked transient. A wrong guess costs ranking quality, never a record.
 */
export function inferClaimFacts(record: InitializableRecord): {
  readonly kind: ClaimKind
  readonly volatility: Volatility
  readonly signals: ImportanceSignals
} {
  const text = `${record.description}\n${record.content}`
  const userStated = record.type === 'feedback'
  const hasProcedure = /\b(steps?|procedure|sop|how to|步骤|流程|做法)\b/iu.test(text)
  const availability = /\b(network|proxy|connect|offline|timeout|网络|代理|连接|超时)\b/iu.test(text)
  const transient = /\b(today|temporary|one-off|for now|今天|临时|暂时|一次性)\b/iu.test(text)
  const superseded = /\b(superseded|deprecated|replaced by|已废弃|已被取代|不再使用)\b/iu.test(text)

  const kind: ClaimKind = availability
    ? 'availability'
    : userStated
      ? 'preference'
      : hasProcedure
        ? 'procedure'
        : 'configuration'

  const volatility: Volatility = transient
    ? 'transient'
    : availability
      ? 'intermittent'
      : 'stable'

  return {
    kind,
    volatility,
    signals: {
      kind,
      volatility,
      evidenceCount: 1,
      distinctSources: 1,
      workspaceCount: 1,
      sourcePlugins: [],
      userStated,
      hasProcedure,
      superseded,
    },
  }
}

/**
 * Create missing claims for one or more scopes.
 *
 * Each scope is committed under its current revision, so a concurrent write
 * during initialization fails loudly instead of being clobbered.
 */
export function initializeGovernance(
  store: MemoryGovernanceStore,
  scopes: readonly InitializeScopeInput[],
  now: number,
): InitializationSummary[] {
  const summaries: InitializationSummary[] = []
  for (const scope of scopes) {
    const document = store.read(scope.scopeKey)
    const known = new Set(document.claims.map(claim => claim.name))
    const upserts: GovernanceClaim[] = []
    let skipped = 0

    for (const record of scope.records) {
      if (known.has(record.name)) {
        skipped += 1
        continue
      }
      const { kind, volatility, signals } = inferClaimFacts(record)
      const score = scoreImportance(signals)
      upserts.push({
        name: record.name,
        scopeKey: scope.scopeKey,
        kind,
        volatility,
        lifecycle: 'active',
        importanceScore: score,
        // The class is derived, never trusted from input.
        importanceClass: importanceOf(score),
        text: `${record.description}\n${record.content}`.slice(0, 2_000),
        environmentFingerprint: '',
        evidenceCount: 1,
        // A record with no temporal stamp is treated as current, so the default
        // is "visible" rather than "candidate for hiding".
        lastEvidenceAt: record.lastEvidenceTime ?? now,
        lastVerifiedAt: null,
        lastUsedAt: null,
        supersedes: [],
        sourcePlugins: [],
      })
    }

    if (upserts.length === 0) {
      summaries.push({ scopeKey: scope.scopeKey, created: 0, skipped, revision: document.revision })
      continue
    }

    const result = store.commit({
      scopeKey: scope.scopeKey,
      expectedRevision: document.revision,
      upserts,
      removals: [],
    })
    summaries.push({ scopeKey: scope.scopeKey, created: upserts.length, skipped, revision: result.revision })
  }
  return summaries
}

function importanceOf(score: number): GovernanceClaim['importanceClass'] {
  if (score >= 80) return 'critical'
  if (score >= 55) return 'durable'
  if (score >= 30) return 'working'
  return 'transient'
}

/** Records whose evidence stamp is older than this are considered stale. */
export const STALE_EVIDENCE_MS = 90 * DAY
