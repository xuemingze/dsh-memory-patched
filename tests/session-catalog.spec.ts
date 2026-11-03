import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemorySessionSnapshot } from '../src/host-contracts.ts'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { SessionCatalog } from '../src/session-catalog.ts'
import type { ConsolidationReceiptStore } from '../src/consolidation-receipt.ts'
import { isConsolidationWorkspaceCwd } from '../src/consolidation-workspace.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function store(): MarkdownMemoryStore {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-session-catalog-'))
  roots.push(root)
  const value = new MarkdownMemoryStore(new Context(), join(root, 'memory'))
  value.initialize()
  return value
}

function snapshot(id: string, revision: string, createdAt: number, cwd?: string): MemorySessionSnapshot {
  return cwd === undefined
    ? { header: { id, createdAt }, revision }
    : { header: { id, createdAt, cwd }, revision }
}

describe('Session candidate catalog', () => {
  it('uses two backend-neutral snapshot reads and excludes live, cwd-less, and unstable Sessions', async () => {
    const memory = store()
    const first = [
      snapshot('eligible', 'source:a', 50, '/work/project-alpha'),
      snapshot('live', 'source:b', 40, '/work/project-beta'),
      snapshot('missing-cwd', 'source:c', 30),
      snapshot('changed', 'source:d1', 20, '/work/project-delta'),
      snapshot('relative', 'source:e', 10, 'relative/project'),
    ]
    const second = [
      snapshot('eligible', 'source:a', 50, '/work/project-alpha'),
      snapshot('live', 'source:b', 40, '/work/project-beta'),
      snapshot('missing-cwd', 'source:c', 30),
      snapshot('changed', 'source:d2', 20, '/work/project-delta'),
      snapshot('relative', 'source:e', 10, 'relative/project'),
    ]
    let calls = 0
    const catalog = new SessionCatalog(memory, {
      async listSnapshots() {
        calls += 1
        return calls === 1 ? first : second
      },
    }, {
      get(id) { return id === 'live' ? {} : undefined },
    })

    await expect(catalog.list()).resolves.toEqual({
      available: true,
      sessions: [
        { sessionId: 'eligible', title: null, createdAt: 50, workspaceId: memory.workspaceReferenceForCwd('/work/project-alpha').workspaceId, workspaceName: 'project-alpha', eligible: true, reason: null, latestReceipt: null, archived: false },
        { sessionId: 'live', title: null, createdAt: 40, workspaceId: memory.workspaceReferenceForCwd('/work/project-beta').workspaceId, workspaceName: 'project-beta', eligible: false, reason: 'live', latestReceipt: null, archived: false },
        { sessionId: 'missing-cwd', title: null, createdAt: 30, workspaceId: null, workspaceName: null, eligible: false, reason: 'missing-cwd', latestReceipt: null, archived: false },
        { sessionId: 'changed', title: null, createdAt: 20, workspaceId: memory.workspaceReferenceForCwd('/work/project-delta').workspaceId, workspaceName: 'project-delta', eligible: false, reason: 'unstable', latestReceipt: null, archived: false },
        { sessionId: 'relative', title: null, createdAt: 10, workspaceId: null, workspaceName: null, eligible: false, reason: 'workspace-unavailable', latestReceipt: null, archived: false },
      ],
    })
    expect(calls).toBe(2)
  })

  it('omits worker ids and every Session in the internal consolidation Workspace', async () => {
    const source = snapshot('source', 'source:a', 2, '/work/project-alpha')
    const worker = snapshot(
      `session-memory-review-${'a'.repeat(64)}-attempt-1`,
      'source:b',
      1,
      '/work/project-alpha',
    )
    const internalWorkspace = '/memory/consolidator-workspace'
    const internalOrdinarySession = snapshot('ordinary-id', 'source:c', 3, internalWorkspace)
    const catalog = new SessionCatalog(store(), {
      async listSnapshots() { return [source, worker, internalOrdinarySession] },
    }, { get() { return undefined } }, undefined, undefined, cwd =>
      isConsolidationWorkspaceCwd(cwd, internalWorkspace))

    await expect(catalog.list()).resolves.toMatchObject({
      sessions: [{ sessionId: 'source' }],
    })
  })

  it('presents archived Sessions as marked candidates instead of omitting them', async () => {
    const active = snapshot('active', 'source:a', 2, '/work/project-alpha')
    const archived = snapshot('archived', 'source:b', 1, '/work/project-alpha')
    const catalog = new SessionCatalog(store(), {
      async listSnapshots() { return [active, archived] },
    }, { get() { return undefined } }, undefined, undefined, undefined, id => id === 'archived')

    await expect(catalog.list()).resolves.toMatchObject({
      sessions: [
        { sessionId: 'active', archived: false },
        { sessionId: 'archived', archived: true },
      ],
    })
  })

  it('excludes subagent Sessions by header markers without loading events', async () => {
    const memory = store()
    const first = [
      { header: { id: 'spawn-sub', createdAt: 3, cwd: '/work/project-alpha', origin: 'subagent' as const }, revision: 'source:a' },
      { header: { id: 'fork-sub', createdAt: 2, cwd: '/work/project-alpha', delegationDepth: 1 }, revision: 'source:b' },
      snapshot('normal', 'source:c', 1, '/work/project-alpha'),
    ]
    const catalog = new SessionCatalog(memory, {
      async listSnapshots() { return first },
    }, { get() { return undefined } })

    await expect(catalog.list()).resolves.toMatchObject({ sessions: [
      { sessionId: 'spawn-sub', eligible: false, reason: 'subagent' },
      { sessionId: 'fork-sub', eligible: false, reason: 'subagent' },
      { sessionId: 'normal', eligible: true },
    ] })
  })

  it('does not mistake a real Session prefix for an empty shell', async () => {
    const memory = store()
    const target = snapshot('realish', 'source:a', 1, '/work/project-alpha')
    const prefix = [
      { seq: 0, type: 'session', data: {} },
      { seq: 1, type: 'permission/preset', data: {} },
      { seq: 2, type: 'sandbox/mode', data: {} },
      { seq: 3, type: 'approval/policy', data: {} },
      { seq: 4, type: 'agent/inbox/spliced', data: {} },
      { seq: 5, type: 'turn/start', data: {} },
      { seq: 6, type: 'agent/inbox/spliced', data: {} },
      { seq: 7, type: 'step/start', data: {} },
      { seq: 8, type: 'system/message', data: {} },
      { seq: 9, type: 'user/message', data: { source: { kind: 'user' }, content: 'real ask' } },
    ]
    const catalog = new SessionCatalog(memory, {
      async listSnapshots() { return [target] },
    }, { get() { return undefined } }, undefined, undefined, undefined, () => false, async () => prefix.slice(0, 8))

    await expect(catalog.list()).resolves.toMatchObject({ sessions: [
      { sessionId: 'realish', eligible: true },
    ] })
  })

  it('fails open when the probe window is saturated without a message', async () => {
    const memory = store()
    const target = snapshot('saturated', 'source:a', 1, '/work/project-alpha')
    const saturated = Array.from({ length: 32 }, (_, seq) => ({ seq, type: 'step/start', data: {} }))
    const catalog = new SessionCatalog(memory, {
      async listSnapshots() { return [target] },
    }, { get() { return undefined } }, undefined, undefined, undefined, () => false, async () => saturated)

    await expect(catalog.list()).resolves.toMatchObject({ sessions: [
      { sessionId: 'saturated', eligible: true },
    ] })
  })

  it('probes event-light Sessions once per revision to drop empty shells', async () => {
    const memory = store()
    const target = snapshot('mystery', 'source:a', 1, '/work/project-alpha')
    let probes = 0
    const catalog = new SessionCatalog(memory, {
      async listSnapshots() { return [target] },
    }, { get() { return undefined } }, undefined, undefined, undefined, () => false, async () => {
      probes += 1
      return [
        { seq: 0, type: 'session', data: {} },
        { seq: 1, type: 'permission/preset', data: {} },
        { seq: 2, type: 'sandbox/mode', data: {} },
        { seq: 3, type: 'approval/policy', data: {} },
      ]
    })

    await expect(catalog.list()).resolves.toMatchObject({ sessions: [] })
    await expect(catalog.list()).resolves.toMatchObject({ sessions: [] })
    expect(probes).toBe(1)
  })

  it('drops fork-injected subagents that the header cannot see and keeps probed real sessions', async () => {
    const memory = store()
    const forked = snapshot('forked-mid', 'source:a', 2, '/work/project-alpha')
    const real = snapshot('real', 'source:b', 1, '/work/project-alpha')
    const catalog = new SessionCatalog(memory, {
      async listSnapshots() { return [forked, real] },
    }, { get() { return undefined } }, undefined, undefined, undefined, () => false, async (id) => {
      if (id === 'forked-mid') {
        return [
          { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: 'start' } },
          { seq: 1, type: 'subagent/descriptor', data: { label: 'Mnemon idle checkpoint review' } },
        ]
      }
      return [
        { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: 'real work' } },
      ]
    })

    await expect(catalog.list()).resolves.toMatchObject({ sessions: [
      { sessionId: 'forked-mid', eligible: false, reason: 'subagent' },
      { sessionId: 'real', eligible: true },
    ] })
  })

  it('keeps Sessions when the probe is unavailable and retries on the next refresh', async () => {
    const memory = store()
    const target = snapshot('mystery', 'source:a', 1, '/work/project-alpha')
    let attempts = 0
    const catalog = new SessionCatalog(memory, {
      async listSnapshots() { return [target] },
    }, { get() { return undefined } }, undefined, undefined, undefined, () => false, async (_id, signal) => {
      expect(signal).toBeDefined()
      attempts += 1
      if (attempts === 1) throw new Error('transient I/O error')
      return [{ seq: 0, type: 'session', data: {} }]
    })

    const controller = new AbortController()
    await expect(catalog.list(controller.signal)).resolves.toMatchObject({ sessions: [
      { sessionId: 'mystery', eligible: true },
    ] })
    await expect(catalog.list(controller.signal)).resolves.toMatchObject({ sessions: [] })
    expect(attempts).toBe(2)
  })

  it('reads live and cold titles from projection cuts without loading Session logs', async () => {
    const memory = store()
    const live = snapshot('live', 'source:a', 2, '/work/project-alpha')
    const cold = snapshot('cold', 'source:b', 1, '/work/project-alpha')
    const liveSession = { id: 'live' }
    const catalog = new SessionCatalog(memory, {
      async listSnapshots() { return [live, cold] },
    }, {
      get(id) { return id === 'live' ? { session: liveSession } : undefined },
    }, undefined, () => ({
      live: {
        snapshot(session) {
          expect(session).toBe(liveSession)
          return { values: { title: 'Live memory architecture' } }
        },
      },
      cached: {
        cachedSnapshot(header) {
          expect(header).toBe(cold.header)
          return { values: { title: 'Cold memory architecture' } }
        },
      },
    }))

    await expect(catalog.list()).resolves.toMatchObject({ sessions: [
      { sessionId: 'live', title: 'Live memory architecture', reason: 'live' },
      { sessionId: 'cold', title: 'Cold memory architecture' },
    ] })
  })

  it('fails soft when a cached title projection is absent or invalid', async () => {
    const invalid = snapshot('invalid', 'source:a', 2, '/work/project-alpha')
    const failed = snapshot('failed', 'source:b', 1, '/work/project-alpha')
    const catalog = new SessionCatalog(store(), {
      async listSnapshots() { return [invalid, failed] },
    }, { get() { return undefined } }, undefined, () => ({
      cached: {
        cachedSnapshot(header) {
          if (header.id === 'failed') throw new Error('cache unavailable')
          return { values: { title: 'bad\ntitle' } }
        },
      },
    }))

    await expect(catalog.list()).resolves.toMatchObject({ sessions: [
      { sessionId: 'invalid', title: null },
      { sessionId: 'failed', title: null },
    ] })
  })

  it('marks a missing or duplicate second observation unstable', async () => {
    const first = [snapshot('missing', 'source:a', 2, '/work/missing'), snapshot('duplicate', 'source:b', 1, '/work/duplicate')]
    let calls = 0
    const catalog = new SessionCatalog(store(), {
      async listSnapshots() {
        calls += 1
        return calls === 1 ? first : [
          snapshot('duplicate', 'source:b', 1, '/work/duplicate'),
          snapshot('duplicate', 'source:b', 1, '/work/duplicate'),
        ]
      },
    }, { get() { return undefined } })
    const result = await catalog.list()
    expect(result.sessions.map(session => [session.sessionId, session.reason])).toEqual([
      ['missing', 'unstable'],
      ['duplicate', 'unstable'],
    ])
  })

  it('projects a receipt as current or older without exposing Host-only fields', async () => {
    const source = snapshot('eligible', 'source:new', 50, '/work/project-alpha')
    const receipts = {
      latestBySourceSessions() {
        return new Map([['eligible', {
          reviewId: `review-${'a'.repeat(64)}`,
          state: 'committed',
          sourceRevision: 'source:old',
          attempts: [{ attempt: 2 }],
          completedAt: '2026-08-31T00:00:00.000Z',
        }]])
      },
    } as unknown as ConsolidationReceiptStore
    const catalog = new SessionCatalog(store(), {
      async listSnapshots() { return [source] },
    }, { get() { return undefined } }, receipts)

    await expect(catalog.list()).resolves.toMatchObject({
      sessions: [{
        latestReceipt: {
          state: 'committed',
          attempt: 2,
          current: false,
          completedAt: '2026-08-31T00:00:00.000Z',
        },
      }],
    })
  })
})
