/** Read-only Session eligibility projection for the Memory settings page. */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MarkdownMemoryStore } from './memory-store.ts'
import type { ConsolidationReceipt, ConsolidationReceiptStore } from './consolidation-receipt.ts'
import type {
  MemoryAgentRegistry,
  MemorySessionProjectionCache,
  MemorySessionProjections,
  MemorySessionSnapshot,
  MemorySessionSnapshotPersistence,
} from './host-contracts.ts'
import type { SessionIneligibleReason, SessionListResponse, SessionSummary } from './protocol.ts'
import { isConsolidationWorkerSessionId } from './consolidation-identity.ts'

/** Bounded probe fan-out: enough parallelism to hide I/O latency, few enough to stay polite. */
const PROBE_CONCURRENCY = 6

/** Repeated opens inside this window reuse the previous listing verbatim. */
const LIST_TTL_MS = 5_000

/** Durable verdicts live beside the store so a reload skips re-probing. */
const PROBE_CACHE_FILENAME = 'probe-cache.json'

/**
 * Persisted probe verdicts, keyed by `sessionId@revision`. `undefined` never
 * reaches the file: a failed probe is retried on the next refresh.
 */
class ProbeVerdictStore {
  private loaded = false

  constructor(private readonly path: string) {}

  read(key: string): SessionIneligibleReason | undefined {
    this.ensureLoaded()
    return this.entries.get(key)
  }

  known(key: string): boolean {
    this.ensureLoaded()
    return this.entries.has(key)
  }

  write(entries: ReadonlyArray<readonly [string, SessionIneligibleReason | undefined]>, knownKeys: ReadonlySet<string>): void {
    this.ensureLoaded()
    for (const [key, verdict] of entries) {
      if (verdict === undefined) this.entries.delete(key)
      else this.entries.set(key, verdict)
    }
    for (const key of [...this.entries.keys()]) {
      if (!knownKeys.has(key)) this.entries.delete(key)
    }
    try {
      writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.entries)), 'utf8')
    } catch {
      // A failed persist is harmless: the in-memory cache already short-circuits this run.
    }
  }

  private entries = new Map<string, SessionIneligibleReason>()

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>
      for (const [key, verdict] of Object.entries(raw)) {
        if (verdict === 'subagent' || verdict === 'empty') this.entries.set(key, verdict)
      }
    } catch {
      // Missing or unreadable file simply means "nothing persisted yet".
    }
  }
}

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
    private readonly probeEvents?: (sessionId: string, signal?: AbortSignal) => Promise<readonly unknown[] | undefined>,
  ) {}

  private readonly probeCache = new Map<string, SessionIneligibleReason | undefined>()
  private probeStore: ProbeVerdictStore | undefined
  private listCache: { at: number; response: SessionListResponse } | undefined

  private probeVerdictStore(): ProbeVerdictStore {
    // Lazy: store.root is only available after construction; the file is read
    // once on first use and rewritten after each probe batch.
    this.probeStore ??= new ProbeVerdictStore(join(this.store.root, PROBE_CACHE_FILENAME))
    return this.probeStore
  }

  /** Observe each snapshot twice and classify only unchanged, non-live Sessions as eligible. */
  async list(signal?: AbortSignal): Promise<SessionListResponse> {
    // A short TTL keeps repeated opens (tab switches, refreshes) instant; the
    // consolidation RPC invalidates it so fresh receipts show immediately.
    if (this.listCache !== undefined && Date.now() - this.listCache.at < LIST_TTL_MS) {
      return { ...this.listCache.response, sessions: [...this.listCache.response.sessions] }
    }
    // The two observations are independent: run them concurrently so the
    // stability check costs one host scan instead of two.
    const [first, second] = await Promise.all([
      this.persistence.listSnapshots(signal),
      this.persistence.listSnapshots(signal),
    ])
    signal?.throwIfAborted()

    const secondById = groupById(second)
    const duplicateFirstIds = duplicateIds(first)
    const unique = uniqueById(first).filter(snapshot => !isConsolidationWorkerSessionId(snapshot.header.id)
      && !this.excludeCwd(snapshot.header.cwd))
    const latestReceipts = this.receipts?.latestBySourceSessions(new Map(
      unique.map(snapshot => [snapshot.header.id, snapshot.revision]),
    ))
    // Static verdicts (live/missing-cwd/unstable) are known without opening any
    // Session log: never pay a probe for a Session they already exclude.
    const staticReason = (snapshot: MemorySessionSnapshot): SessionIneligibleReason | undefined => {
      if (headerSubagentMarker(snapshot.header) !== undefined) return 'subagent'
      if (this.agents.get(snapshot.header.id) !== undefined) return 'live'
      if (snapshot.header.cwd === undefined) return 'missing-cwd'
      if (workspaceReference(this.store, snapshot.header.cwd) === undefined) return 'workspace-unavailable'
      const matching = secondById.get(snapshot.header.id)
      if (duplicateFirstIds.has(snapshot.header.id)
        || matching?.length !== 1
        || matching[0]?.revision !== snapshot.revision) return 'unstable'
      return undefined
    }
    const verdicts = new Map<string, SessionIneligibleReason | undefined>()
    const toProbe: MemorySessionSnapshot[] = []
    const probeStore = this.probeVerdictStore()
    for (const snapshot of unique) {
      const key = `${snapshot.header.id}@${snapshot.revision}`
      const staticVerdict = staticReason(snapshot)
      if (staticVerdict !== undefined) {
        verdicts.set(snapshot.header.id, staticVerdict)
        continue
      }
      const cached = this.probeCache.get(key) ?? probeStore.read(key)
      if (cached !== undefined || probeStore.known(key)) {
        this.probeCache.set(key, cached)
        verdicts.set(snapshot.header.id, cached)
        continue
      }
      if (latestReceipts?.has(snapshot.header.id) && this.probeCache.has(key)) {
        verdicts.set(snapshot.header.id, this.probeCache.get(key))
        continue
      }
      toProbe.push(snapshot)
    }
    // Bounded-concurrency probing keeps the first list open fast even with
    // hundreds of uncached Sessions.
    const failedProbes = await this.probeAll(toProbe, signal, verdicts)
    // Persist the merged verdict set (fresh probes + inherited cache) so a
    // reload skips re-probing; stale keys for vanished sessions drop out.
    probeStore.write(
      [...verdicts].map(([id, verdict]) => [`${id}@${secondById.get(id)?.[0]?.revision ?? ''}`, verdict] as const),
      new Set(unique.map(snapshot => `${snapshot.header.id}@${snapshot.revision}`)),
    )
    const sessions = unique
      .map(snapshot => this.classify(
        snapshot,
        secondById,
        duplicateFirstIds,
        latestReceipts?.get(snapshot.header.id),
        this.readTitle(snapshot),
        verdicts.get(snapshot.header.id) ?? headerSubagentMarker(snapshot.header),
      ))
      // Empty shells are noise, not candidates: keep them out of the list entirely.
      .filter(session => session.reason !== 'empty')
      .sort((left, right) => right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId, 'en'))
    // A failed probe must not poison the TTL cache: the next refresh retries it.
    if (failedProbes > 0) return { available: true, sessions }
    const response: SessionListResponse = { available: true, sessions }
    this.listCache = { at: Date.now(), response }
    return { ...response, sessions: [...response.sessions] }
  }

  /** Drop the cached listing so the next open re-scans (used after consolidation commits). */
  invalidate(): void {
    this.listCache = undefined
  }

  private async probeAll(
    snapshots: readonly MemorySessionSnapshot[],
    signal: AbortSignal | undefined,
    verdicts: Map<string, SessionIneligibleReason | undefined>,
  ): Promise<number> {
    if (snapshots.length === 0 || this.probeEvents === undefined) return 0
    let cursor = 0
    let failed = 0
    const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, snapshots.length) }, async () => {
      while (cursor < snapshots.length) {
        signal?.throwIfAborted()
        const snapshot = snapshots[cursor]!
        cursor += 1
        const verdict = await this.probeSession(snapshot, signal)
        if (verdict === undefined) failed += 1
        verdicts.set(snapshot.header.id, verdict)
      }
    })
    await Promise.all(workers)
    return failed
  }

  private async probeSession(
    snapshot: MemorySessionSnapshot,
    signal?: AbortSignal,
  ): Promise<SessionIneligibleReason | undefined> {
    if (this.probeEvents === undefined) return undefined
    const key = `${snapshot.header.id}@${snapshot.revision}`
    if (this.probeCache.has(key)) return this.probeCache.get(key)
    let events: readonly unknown[] | undefined
    try {
      events = await this.probeEvents(snapshot.header.id, signal)
    } catch {
      signal?.throwIfAborted()
      events = undefined
    }
    signal?.throwIfAborted()
    // If probeEvents failed/returned undefined, fail open for this call without
    // permanently caching `undefined` so a transient read error can self-heal.
    if (events === undefined) return undefined
    let verdict: SessionIneligibleReason | undefined
    if (events.some(hasSubagentDescriptorEvent)) verdict = 'subagent'
    // A real Session opens with lifecycle and runtime events long before its first
    // user turn, so an empty-shell verdict needs both markers absent AND the window
    // to end before the limit; a saturated window proves nothing either way.
    else if (events.length < PROBE_EVENT_WINDOW
      && !events.some(isUserMessageEvent)
      && !events.some(isTurnStartEvent)) verdict = 'empty'
    if (this.probeCache.size >= PROBE_CACHE_LIMIT) this.probeCache.clear()
    this.probeCache.set(key, verdict)
    return verdict
  }

  private classify(
    snapshot: MemorySessionSnapshot,
    secondById: ReadonlyMap<string, readonly MemorySessionSnapshot[]>,
    duplicateFirstIds: ReadonlySet<string>,
    latestReceipt?: ConsolidationReceipt,
    title: string | null = null,
    probeReason?: SessionIneligibleReason,
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

    if (probeReason !== undefined) return { ...base, eligible: false, reason: probeReason }

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

function headerSubagentMarker(header: MemorySessionSnapshot['header']): SessionIneligibleReason | undefined {
  if (header.origin === 'subagent') return 'subagent'
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return 'subagent'
  return undefined
}

function hasSubagentDescriptorEvent(event: unknown): boolean {
  return event !== null && typeof event === 'object' && !Array.isArray(event)
    && (event as Record<string, unknown>).type === 'subagent/descriptor'
}

function isUserMessageEvent(event: unknown): boolean {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return false
  const record = event as Record<string, unknown>
  if (record.type !== 'user/message') return false
  const data = record.data
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    && (data as Record<string, unknown>).source !== undefined
}

function isTurnStartEvent(event: unknown): boolean {
  return event !== null && typeof event === 'object' && !Array.isArray(event)
    && (event as Record<string, unknown>).type === 'turn/start'
}

/** Real Sessions place their first user turn at index 9-18, so the window must clear that. */
const PROBE_EVENT_WINDOW = 32
const PROBE_CACHE_LIMIT = 4_096

function duplicateIds(snapshots: readonly MemorySessionSnapshot[]): Set<string> {
  return new Set([...groupById(snapshots)].filter(([, values]) => values.length !== 1).map(([id]) => id))
}

function uniqueById(snapshots: readonly MemorySessionSnapshot[]): MemorySessionSnapshot[] {
  const unique = new Map<string, MemorySessionSnapshot>()
  for (const snapshot of snapshots) if (!unique.has(snapshot.header.id)) unique.set(snapshot.header.id, snapshot)
  return [...unique.values()]
}
