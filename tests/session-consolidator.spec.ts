import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemorySessionInspection, MemorySessionSnapshot } from '../src/host-contracts.ts'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import {
  CONSOLIDATOR_VERSION,
  SessionConsolidator,
} from '../src/session-consolidator.ts'
import { isConsolidationWorkspaceCwd } from '../src/consolidation-workspace.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createStore(): MarkdownMemoryStore {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-consolidator-'))
  roots.push(root)
  const store = new MarkdownMemoryStore(new Context(), join(root, 'memory'))
  store.initialize()
  return store
}

function snapshot(revision = 'source:a', cwd = '/work/project-alpha'): MemorySessionSnapshot {
  return { header: { id: 'source-session', createdAt: 42, cwd }, revision }
}

function inspection(cwd = '/work/project-alpha'): MemorySessionInspection {
  return {
    meta: { id: 'source-session', createdAt: 42, cwd },
    events: [{ seq: 0, type: 'user/message', data: {
      content: [{ type: 'text', text: 'remember the constraint' }],
      source: { kind: 'user' },
    } }],
  }
}

describe('SessionConsolidator input preparation', () => {
  it('freezes complete logical events and the target Workspace generation between matching source observations', async () => {
    const store = createStore()
    const scope = store.scopeForCwd('/work/project-alpha')
    const empty = await store.readWorkspace(scope)
    await store.commitWorkspace({
      scope,
      expectedRevision: empty.revision,
      changes: [{ action: 'put', record: {
        name: 'existing-rule',
        description: 'Existing durable rule.',
        type: 'project',
        content: 'Keep this rule.\n',
      } }],
    })
    const source = snapshot()
    const logical = inspection()
    let listCalls = 0
    const consolidator = new SessionConsolidator(store, {
      async listSnapshots() {
        listCalls += 1
        return [source]
      },
      async inspect() { return logical },
    }, { get() { return undefined } })

    const prepared = await consolidator.prepare('source-session')

    expect(listCalls).toBe(2)
    expect(prepared).toMatchObject({
      reviewId: expect.stringMatching(/^review-[a-f0-9]{64}$/u),
      consolidatorVersion: 'm3-multistep-global-v6',
      source: { sessionId: 'source-session', revision: 'source:a', createdAt: 42 },
      workspace: { revision: expect.stringMatching(/^sha256:/u), records: [{ name: 'existing-rule' }] },
    })
    expect(prepared.source.events).toEqual(logical.events)
    expect(prepared.source.events).not.toBe(logical.events)
    expect(prepared.source.evidence).toMatchObject([{ fromSeq: 0, toSeq: 0, user: ['remember the constraint'] }])
    expect(consolidator.planProposal(prepared, {
      outcome: 'changes',
      changes: [{
        action: 'put',
        record: {
          name: 'new-rule',
          description: 'New durable rule.',
          type: 'project',
          content: 'Remember this rule.',
        },
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    })).toMatchObject({
      proposal: { outcome: 'changes', changes: [{ action: 'put', record: { name: 'new-rule' } }] },
      preview: { changed: true, records: [{ name: 'existing-rule' }, { name: 'new-rule' }] },
    })
    await expect(consolidator.prepare('source-session')).resolves.toHaveProperty('reviewId', prepared.reviewId)
  })

  it('rejects a live Session before loading its complete event log', async () => {
    let inspected = false
    const consolidator = new SessionConsolidator(createStore(), {
      async listSnapshots() { return [snapshot()] },
      async inspect() { inspected = true; return inspection() },
    }, { get() { return {} } })

    await expect(consolidator.prepare('source-session')).rejects.toMatchObject({ code: 'live' })
    expect(inspected).toBe(false)
  })

  it('rejects a subagent Session by header markers before loading events, and after inspection when unmarked', async () => {
    let headerInspected = false
    const byHeader = new SessionConsolidator(createStore(), {
      async listSnapshots() {
        return [{ header: { id: 'source-session', createdAt: 42, cwd: '/work/project-alpha', origin: 'subagent' }, revision: 'source:a' }]
      },
      async inspect() { headerInspected = true; return inspection() },
    }, { get() { return undefined } })
    await expect(byHeader.prepare('source-session')).rejects.toMatchObject({ code: 'subagent' })
    expect(headerInspected).toBe(false)

    const consolidator = new SessionConsolidator(createStore(), {
      async listSnapshots() { return [snapshot()] },
      async inspect() {
        return {
          meta: snapshot().header,
          events: [
            { seq: 0, type: 'subagent/descriptor', data: { label: '评审 memory-store 核心' } },
            { seq: 1, type: 'user/message', data: {
              content: [{ type: 'text', text: 'review this module' }],
              source: { kind: 'user' },
            } },
          ],
        }
      },
    }, { get() { return undefined } })

    await expect(consolidator.prepare('source-session')).rejects.toMatchObject({ code: 'subagent' })
  })

  it('rejects direct consolidation of a Session in the internal consolidation Workspace', async () => {
    const internalWorkspace = '/memory/consolidator-workspace'
    let inspected = false
    const consolidator = new SessionConsolidator(createStore(), {
      async listSnapshots() { return [snapshot('source:a', internalWorkspace)] },
      async inspect() { inspected = true; return inspection(internalWorkspace) },
    }, { get() { return undefined } }, CONSOLIDATOR_VERSION, cwd =>
      isConsolidationWorkspaceCwd(cwd, internalWorkspace))

    await expect(consolidator.prepare('source-session')).rejects.toMatchObject({
      code: 'workspace-unavailable',
      message: expect.stringContaining('internal consolidation Workspace'),
    })
    expect(inspected).toBe(false)
  })

  it('allows consolidation of an archived Session', async () => {
    const consolidator = new SessionConsolidator(createStore(), {
      async listSnapshots() { return [snapshot()] },
      async inspect() { return inspection() },
    }, { get() { return undefined } }, CONSOLIDATOR_VERSION, undefined)

    await expect(consolidator.prepare('source-session'))
      .resolves.toHaveProperty('source.sessionId', 'source-session')
  })

  it('allows a Session archived during preparation or before commit', async () => {
    let archived = false
    const duringPreparation = new SessionConsolidator(createStore(), {
      async listSnapshots() {
        return [snapshot()]
      },
      async inspect() { return inspection() },
    }, { get() { return undefined } }, CONSOLIDATOR_VERSION, undefined)

    archived = true
    await expect(duringPreparation.prepare('source-session')).resolves.toBeDefined()

    archived = false
    const beforeCommit = new SessionConsolidator(createStore(), {
      async listSnapshots() { return [snapshot()] },
      async inspect() { return inspection() },
    }, { get() { return undefined } }, CONSOLIDATOR_VERSION, undefined)
    const input = await beforeCommit.prepare('source-session')
    archived = true
    await expect(beforeCommit.assertSourceStable(input)).resolves.toBeUndefined()
  })

  it('rejects source revision drift after inspection', async () => {
    let calls = 0
    const consolidator = new SessionConsolidator(createStore(), {
      async listSnapshots() {
        calls += 1
        return [snapshot(calls === 1 ? 'source:a' : 'source:b')]
      },
      async inspect() { return inspection() },
    }, { get() { return undefined } })

    await expect(consolidator.prepare('source-session')).rejects.toMatchObject({ code: 'unstable' })
  })

  it('treats a missing second observation as source instability', async () => {
    let calls = 0
    const consolidator = new SessionConsolidator(createStore(), {
      async listSnapshots() {
        calls += 1
        return calls === 1 ? [snapshot()] : []
      },
      async inspect() { return inspection() },
    }, { get() { return undefined } })

    await expect(consolidator.prepare('source-session')).rejects.toMatchObject({ code: 'unstable' })
  })

  it('rejects persistence ambiguity and inspection metadata drift', async () => {
    const duplicate = new SessionConsolidator(createStore(), {
      async listSnapshots() { return [snapshot(), snapshot()] },
      async inspect() { return inspection() },
    }, { get() { return undefined } })
    await expect(duplicate.prepare('source-session')).rejects.toMatchObject({ code: 'ambiguous' })

    const mismatch = new SessionConsolidator(createStore(), {
      async listSnapshots() { return [snapshot()] },
      async inspect() { return inspection('/work/other') },
    }, { get() { return undefined } })
    await expect(mismatch.prepare('source-session')).rejects.toMatchObject({ code: 'inspection-mismatch' })
  })
})
