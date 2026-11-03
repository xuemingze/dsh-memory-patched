/** Read-only Session eligibility projection for the Memory settings page. */

import type { MarkdownMemoryStore } from './memory-store.ts'
import type { ConsolidationReceipt, ConsolidationReceiptStore } from './consolidation-receipt.ts'
import type {
  MemoryAgentRegistry,
  MemorySessionProjectionCache,
  MemorySessionProjections,
  MemorySessionSnapshot,
  MemorySessionSnapshotPersistence,
} from './host-contracts.ts'
import type { SessionListResponse, SessionSummary } from './protocol.ts'
import { isConsolidationWorkerSessionId } from './consolidation-identity.ts'

/** Builds a stable candidate list without loading complete Session event logs. */
export class SessionCatalog {
  constructor(
    private readonly store: MarkdownMemoryStore,
    private readonly persistence: MemorySessionSnapshotPersistence,
    private readonly agents: MemoryAgentRegistry,
    private readonly receipts?: ConsolidationReceiptStore,
    private readonly getProjections: () => {
      readonly live?: MemorySessionProjections
      readonly cached?: MemorySessionProjectionCache
    } = () => ({}),
    private readonly excludeCwd: (cwd: string | undefined) => boolean = () => false,
    private readonly isArchived: (sessionId: string) => boolean = () => false,
  ) {}

  /** Observe each snapshot twice and classify only unchanged, non-live Sessions as eligible. */
  async list(signal?: AbortSignal): Promise<SessionListResponse> {
    const first = await this.persistence.listSnapshots(signal)
    signal?.throwIfAborted()
    const second = await this.persistence.listSnapshots(signal)
    signal?.throwIfAborted()

    const secondById = groupById(second)
    const duplicateFirstIds = duplicateIds(first)
    const unique = uniqueById(first).filter(snapshot => !isConsolidationWorkerSessionId(snapshot.header.id)
      && !this.excludeCwd(snapshot.header.cwd))
    const latestReceipts = this.receipts?.latestBySourceSessions(new Map(
      unique.map(snapshot => [snapshot.header.id, snapshot.revision]),
    ))
    const sessions = unique
      .map(snapshot => this.classify(
        snapshot,
        secondById,
        duplicateFirstIds,
        latestReceipts?.get(snapshot.header.id),
        this.readTitle(snapshot),
      ))
      .sort((left, right) => right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId, 'en'))
    return { available: true, sessions }
  }

  private classify(
    snapshot: MemorySessionSnapshot,
    secondById: ReadonlyMap<string, readonly MemorySessionSnapshot[]>,
    duplicateFirstIds: ReadonlySet<string>,
    latestReceipt?: ConsolidationReceipt,
    title: string | null = null,
  ): SessionSummary {
    const workspace = workspaceReference(this.store, snapshot.header.cwd)
    const base = {
      sessionId: snapshot.header.id,
      title,
      createdAt: snapshot.header.createdAt,
      workspaceId: workspace?.workspaceId ?? null,
      workspaceName: workspace?.displayName ?? null,
      latestReceipt: this.receiptSummary(snapshot, latestReceipt),
      archived: this.isArchived(snapshot.header.id),
    } as const
    if (this.agents.get(snapshot.header.id) !== undefined) {
      return { ...base, eligible: false, reason: 'live' }
    }
    if (snapshot.header.cwd === undefined) {
      return { ...base, eligible: false, reason: 'missing-cwd' }
    }

    if (workspace === undefined) return { ...base, eligible: false, reason: 'workspace-unavailable' }

    const matching = secondById.get(snapshot.header.id)
    if (duplicateFirstIds.has(snapshot.header.id)
      || matching?.length !== 1
      || matching[0]?.revision !== snapshot.revision) {
      return { ...base, eligible: false, reason: 'unstable' }
    }
    return { ...base, eligible: true, reason: null }
  }

  private readTitle(snapshot: MemorySessionSnapshot): string | null {
    try {
      const projections = this.getProjections()
      const liveSession = this.agents.get(snapshot.header.id)?.session
      const cut = liveSession !== undefined
        ? projections.live?.snapshot(liveSession)
        : projections.cached?.cachedSnapshot(snapshot.header)
      const title = cut?.values.title
      return typeof title === 'string' && title.trim() !== '' && !/[\r\n]/u.test(title) ? title : null
    } catch {
      return null
    }
  }

  private receiptSummary(
    snapshot: MemorySessionSnapshot,
    receipt?: ConsolidationReceipt,
  ): SessionSummary['latestReceipt'] {
    if (receipt === undefined) return null
    return {
      reviewId: receipt.reviewId,
      state: receipt.state,
      attempt: receipt.attempts.at(-1)?.attempt ?? 0,
      current: receipt.sourceRevision === snapshot.revision,
      completedAt: receipt.completedAt ?? null,
    }
  }
}

function workspaceReference(
  store: MarkdownMemoryStore,
  cwd?: string,
): ReturnType<MarkdownMemoryStore['workspaceReferenceForCwd']> | undefined {
  if (cwd === undefined) return
  try {
    return store.workspaceReferenceForCwd(cwd)
  } catch {
    return
  }
}

function groupById(snapshots: readonly MemorySessionSnapshot[]): Map<string, MemorySessionSnapshot[]> {
  const grouped = new Map<string, MemorySessionSnapshot[]>()
  for (const snapshot of snapshots) {
    const values = grouped.get(snapshot.header.id) ?? []
    values.push(snapshot)
    grouped.set(snapshot.header.id, values)
  }
  return grouped
}

function duplicateIds(snapshots: readonly MemorySessionSnapshot[]): Set<string> {
  return new Set([...groupById(snapshots)].filter(([, values]) => values.length !== 1).map(([id]) => id))
}

function uniqueById(snapshots: readonly MemorySessionSnapshot[]): MemorySessionSnapshot[] {
  const unique = new Map<string, MemorySessionSnapshot>()
  for (const snapshot of snapshots) if (!unique.has(snapshot.header.id)) unique.set(snapshot.header.id, snapshot)
  return [...unique.values()]
}
