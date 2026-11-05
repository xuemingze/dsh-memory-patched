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
import type {
  SessionIneligibleReason,
  SessionListResponse,
  SessionSummary,
  SuppressedSessionGroup,
} from './protocol.ts'
import { isConsolidationWorkerSessionId } from './consolidation-identity.ts'
import { classifySessionQuality, sessionGroupFingerprint } from './session-quality.ts'

/** Bounded probe fan-out: enough parallelism to hide I/O latency, few enough to stay polite. */
const PROBE_CONCURRENCY = 6

/** Repeated opens inside this window reuse the previous listing verbatim. */
const LIST_TTL_MS = 5_000

/** Durable verdicts live beside the store so a reload skips re-probing. */
const PROBE_CACHE_FILENAME = 'probe-cache.json'

/**
 * Probe verdict plus the facts needed to describe a suppressed cluster.
 * `reason === undefined` means the Session looks consolidatable.
 */
interface ProbeOutcome {
  readonly reason: SessionIneligibleReason | undefined
  readonly detail?: {
    readonly firstUserText?: string | undefined
    readonly title?: string | null
    readonly errorCode?: string | undefined
  }
}

/** Adapt one persisted verdict into a probe outcome. */
function persistedOutcome(reason: SessionIneligibleReason | undefined): ProbeOutcome | undefined {
  return reason === undefined ? undefined : { reason }
}

/** Collapse per-Session suppression facts into one row per fingerprint. */
function clusterSuppressed(groups: readonly SuppressedSessionGroup[]): SuppressedSessionGroup[] {
  const merged = new Map<string, SuppressedSessionGroup>()
  for (const group of groups) {
    const existing = merged.get(group.fingerprint)
    if (existing === undefined) {
      merged.set(group.fingerprint, group)
      continue
    }
    merged.set(group.fingerprint, {
      ...existing,
      count: existing.count + group.count,
      firstCreatedAt: Math.min(existing.firstCreatedAt, group.firstCreatedAt),
      lastCreatedAt: Math.max(existing.lastCreatedAt, group.lastCreatedAt),
    })
  }
  return [...merged.values()].sort((left, right) => right.lastCreatedAt - left.lastCreatedAt)
}

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
        if (verdict === 'subagent' || verdict === 'empty' || verdict === 'failed-zero-output') {
          this.entries.set(key, verdict)
        }
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

  private readonly probeCache = new Map<string, ProbeOutcome>()
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
    const verdicts = new Map<string, ProbeOutcome>()
    const toProbe: MemorySessionSnapshot[] = []
    const probeStore = this.probeVerdictStore()
    for (const snapshot of unique) {
      const key = `${snapshot.header.id}@${snapshot.revision}`
      const staticVerdict = staticReason(snapshot)
      if (staticVerdict !== undefined) {
        verdicts.set(snapshot.header.id, { reason: staticVerdict })
        continue
      }
      // A persisted verdict only carries the reason; cluster details are
      // recomputed when the Session is probed again on a revision change.
      const cached = this.probeCache.get(key) ?? persistedOutcome(probeStore.read(key))
      if (cached !== undefined) {
        this.probeCache.set(key, cached)
        verdicts.set(snapshot.header.id, cached)
        continue
      }
      if (latestReceipts?.has(snapshot.header.id) && this.probeCache.has(key)) {
        verdicts.set(snapshot.header.id, this.probeCache.get(key)!)
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
      [...verdicts].map(([id, outcome]) => [
        `${id}@${secondById.get(id)?.[0]?.revision ?? ''}`,
        outcome.reason,
      ] as const),
      new Set(unique.map(snapshot => `${snapshot.header.id}@${snapshot.revision}`)),
    )

    const suppressed: SuppressedSessionGroup[] = []
    let failedZeroOutput = 0
    const sessions: SessionSummary[] = []
    for (const snapshot of unique) {
      const title = this.readTitle(snapshot)
      const outcome = verdicts.get(snapshot.header.id) ?? { reason: headerSubagentMarker(snapshot.header) }
      const summary = this.classify(
        snapshot,
        secondById,
        duplicateFirstIds,
        latestReceipts?.get(snapshot.header.id),
        title,
        outcome,
      )
      // Empty shells and zero-output failures are noise, not candidates: they
      // leave the list but stay auditable through the suppressed summary.
      if (summary.reason === 'empty') continue
      if (summary.reason === 'failed-zero-output') {
        failedZeroOutput += 1
        const workspace = workspaceReference(this.store, snapshot.header.cwd)
        suppressed.push({
          fingerprint: sessionGroupFingerprint({
            workspaceKey: workspace?.displayName ?? '',
            title,
            firstUserText: outcome.detail?.firstUserText,
            quality: 'failed-zero-output',
            errorCode: outcome.detail?.errorCode,
          }),
          title: title ?? outcome.detail?.firstUserText ?? null,
          count: 1,
          firstCreatedAt: summary.createdAt,
          lastCreatedAt: summary.createdAt,
          reason: 'failed-zero-output',
          ...(outcome.detail?.errorCode === undefined ? {} : { errorCode: outcome.detail.errorCode }),
        })
        continue
      }
      sessions.push(summary)
    }
    sessions.sort((left, right) => right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId, 'en'))

    const response: SessionListResponse = {
      available: true,
      sessions,
      suppressed: {
        failedZeroOutput,
        trivialAutomation: 0,
        groups: clusterSuppressed(suppressed),
      },
    }
    // A failed probe must not poison the TTL cache: the next refresh retries it.
    if (failedProbes > 0) {
      return { ...response, sessions: [...response.sessions], suppressed: { ...response.suppressed, groups: [...response.suppressed.groups] } }
    }
    this.listCache = { at: Date.now(), response }
    return { ...response, sessions: [...response.sessions], suppressed: { ...response.suppressed, groups: [...response.suppressed.groups] } }
  }

  /** Drop the cached listing so the next open re-scans (used after consolidation commits). */
  invalidate(): void {
    this.listCache = undefined
  }

  private async probeAll(
    snapshots: readonly MemorySessionSnapshot[],
    signal: AbortSignal | undefined,
    verdicts: Map<string, ProbeOutcome>,
  ): Promise<number> {
    if (snapshots.length === 0 || this.probeEvents === undefined) return 0
    let cursor = 0
    let failed = 0
    const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, snapshots.length) }, async () => {
      while (cursor < snapshots.length) {
        signal?.throwIfAborted()
        const snapshot = snapshots[cursor]!
        cursor += 1
        const outcome = await this.probeSession(snapshot, signal)
        if (outcome.reason === undefined) failed += 1
        verdicts.set(snapshot.header.id, outcome)
      }
    })
    await Promise.all(workers)
    return failed
  }

  private async probeSession(
    snapshot: MemorySessionSnapshot,
    signal?: AbortSignal,
  ): Promise<ProbeOutcome> {
    if (this.probeEvents === undefined) return { reason: undefined }
    const key = `${snapshot.header.id}@${snapshot.revision}`
    const cached = this.probeCache.get(key)
    if (cached !== undefined) return cached
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
    if (events === undefined) return { reason: undefined }
    const outcome = this.assess(events)
    if (this.probeCache.size >= PROBE_CACHE_LIMIT) this.probeCache.clear()
    this.probeCache.set(key, outcome)
    return outcome
  }

  /** Turn a bounded event window into one probe verdict. */
  private assess(events: readonly unknown[]): ProbeOutcome {
    if (events.some(hasSubagentDescriptorEvent)) return { reason: 'subagent' }

    // A saturated window may cut the Session before a later successful retry, so
    // it can never prove the Session produced nothing. Both the empty and the
    // zero-output verdicts need the whole log, not just its opening.
    const saturated = events.length >= PROBE_EVENT_WINDOW
    if (!saturated) {
      const quality = classifySessionQuality(events, { classifyTrivial: false })
      if (quality.class === 'failed-zero-output') {
        const first = quality.terminalErrors[0]
        return {
          reason: 'failed-zero-output',
          detail: {
            firstUserText: quality.firstUserText,
            title: null,
            errorCode: first?.code,
          },
        }
      }
    }

    // A real Session opens with lifecycle and runtime events long before its first
    // user turn, so an empty-shell verdict needs both markers absent AND the window
    // to end before the limit; a saturated window proves nothing either way.
    if (!saturated
      && !events.some(isUserMessageEvent)
      && !events.some(isTurnStartEvent)) return { reason: 'empty' }

    return { reason: undefined }
  }

  /** Classify one snapshot using static verdicts, probe results, and receipts. */
  private classify(
    snapshot: MemorySessionSnapshot,
    secondById: ReadonlyMap<string, readonly MemorySessionSnapshot[]>,
    duplicateFirstIds: ReadonlySet<string>,
    latestReceipt?: ConsolidationReceipt,
    title: string | null = null,
    probeOutcome: ProbeOutcome = { reason: undefined },
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

    if (probeOutcome.reason !== undefined) return { ...base, eligible: false, reason: probeOutcome.reason }

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
