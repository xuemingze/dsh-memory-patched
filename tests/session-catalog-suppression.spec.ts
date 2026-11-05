import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemorySessionSnapshot } from '../src/host-contracts.ts'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { SessionCatalog } from '../src/session-catalog.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function store(): MarkdownMemoryStore {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-suppression-'))
  roots.push(root)
  const value = new MarkdownMemoryStore(new Context(), join(root, 'memory'))
  value.initialize()
  return value
}

function snapshot(id: string, createdAt: number, cwd: string): MemorySessionSnapshot {
  return { header: { id, createdAt, cwd }, revision: `source:${id}` }
}

const NO_KEY = {
  kind: 'error',
  failure: { message: 'No API key for provider: minimax-direct', code: 'PI_AI_ERROR' },
}

/** A Session that ran, failed, and produced nothing. */
function zeroOutputFailure(prompt: string) {
  return [
    { type: 'session', seq: 0, data: {} },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: prompt }], source: { kind: 'user' } } },
    {
      type: 'assistant/attempt',
      seq: 3,
      data: {
        turn: 1,
        step: 1,
        stream: [
          { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
          { type: 'chunk', chunk: { type: 'finish', reason: NO_KEY } },
        ],
      },
    },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: NO_KEY } },
  ]
}

/** A Session that answered normally. */
function answered(prompt: string) {
  return [
    { type: 'session', seq: 0, data: {} },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: prompt }], source: { kind: 'user' } } },
    {
      type: 'assistant/attempt',
      seq: 3,
      data: {
        turn: 1,
        step: 1,
        stream: [
          { type: 'chunk', chunk: { type: 'text', text: 'Here is the full explanation you asked for.' } },
          { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 } } },
          { type: 'chunk', chunk: { kind: 'finish', reason: { kind: 'stop' } } },
        ],
      },
    },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'stop' } } },
  ]
}

function catalogWith(events: Map<string, readonly unknown[]>) {
  const memory = store()
  const catalog = new SessionCatalog(
    memory,
    { async listSnapshots() { return [...events.keys()].map((id, index) => snapshot(id, 100 - index, '/work/project-alpha')) } },
    { get() { return undefined } },
    undefined,
    undefined,
    () => false,
    () => false,
    async (id: string) => events.get(id),
  )
  return { catalog, memory }
}

describe('Session catalog zero-output suppression', () => {
  it('hides failed Sessions and reports them as suppressed groups', async () => {
    const { catalog } = catalogWith(new Map<string, readonly unknown[]>([
      ['failed-a', zeroOutputFailure('请只回复两个字：成功')],
      ['failed-b', zeroOutputFailure('请只回复两个字：成功')],
      ['real', answered('explain the design')],
    ]))

    const result = await catalog.list()
    expect(result.sessions.map(s => s.sessionId)).toEqual(['real'])
    expect(result.suppressed.failedZeroOutput).toBe(2)
    expect(result.suppressed.groups).toHaveLength(1)
    expect(result.suppressed.groups[0]).toMatchObject({
      count: 2,
      reason: 'failed-zero-output',
      title: '请只回复两个字：成功',
      errorCode: 'PI_AI_ERROR',
    })
  })

  it('does not suppress a Session that answered', async () => {
    const { catalog } = catalogWith(new Map([
      ['real', answered('explain the design')],
    ]))
    const result = await catalog.list()
    expect(result.sessions.map(s => s.sessionId)).toEqual(['real'])
    expect(result.suppressed.failedZeroOutput).toBe(0)
    expect(result.suppressed.groups).toEqual([])
  })

  it('keeps different error codes in separate groups', async () => {
    const noAdapter = {
      kind: 'error',
      failure: { message: 'no adapter registered for provider "raccoon"', code: 'NO_ADAPTER' },
    }
    const other = [
      { type: 'session', seq: 0, data: {} },
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } } },
      {
        type: 'assistant/attempt',
        seq: 3,
        data: {
          turn: 1,
          step: 1,
          stream: [
            { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
            { type: 'chunk', chunk: { type: 'finish', reason: noAdapter } },
          ],
        },
      },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: noAdapter } },
    ]

    const { catalog } = catalogWith(new Map([
      ['failed-a', zeroOutputFailure('请只回复两个字：成功')],
      ['failed-b', other],
    ]))
    const result = await catalog.list()
    expect(result.sessions).toEqual([])
    expect(result.suppressed.failedZeroOutput).toBe(2)
    expect(result.suppressed.groups).toHaveLength(2)
    expect(result.suppressed.groups.map(g => g.errorCode).sort()).toEqual(['NO_ADAPTER', 'PI_AI_ERROR'])
  })

  it('never suppresses when the probe cannot read the Session', async () => {
    const memory = store()
    const catalog = new SessionCatalog(
      memory,
      { async listSnapshots() { return [snapshot('unreadable', 100, '/work/project-alpha')] } },
      { get() { return undefined } },
      undefined,
      undefined,
      () => false,
      () => false,
      async () => undefined,
    )
    const result = await catalog.list()
    expect(result.sessions.map(s => s.sessionId)).toEqual(['unreadable'])
    expect(result.suppressed.failedZeroOutput).toBe(0)
  })

  it('never suppresses on a saturated window that may hide a later success', async () => {
    // A truncated window cannot prove the Session ended badly: the winning turn
    // may sit past the limit. Suppressing here would hide a real Session.
    const memory = store()
    const truncated = [
      ...zeroOutputFailure('long running task'),
      ...Array.from({ length: 40 }, (_, index) => ({
        type: 'tool/result',
        seq: 10 + index,
        data: { name: 'pwsh', ok: false },
      })),
    ]
    const catalog = new SessionCatalog(
      memory,
      { async listSnapshots() { return [snapshot('truncated', 100, '/work/project-alpha')] } },
      { get() { return undefined } },
      undefined,
      undefined,
      () => false,
      () => false,
      async () => truncated,
    )
    const result = await catalog.list()
    expect(result.sessions.map(s => s.sessionId)).toEqual(['truncated'])
    expect(result.suppressed.failedZeroOutput).toBe(0)
  })

  it('re-evaluates when the Session revision changes', async () => {
    const memory = store()
    let events: readonly unknown[] = zeroOutputFailure('ping')
    const catalog = new SessionCatalog(
      memory,
      { async listSnapshots() { return [snapshot('flaky', 100, '/work/project-alpha')] } },
      { get() { return undefined } },
      undefined,
      undefined,
      () => false,
      () => false,
      async () => events,
    )
    await expect(catalog.list()).resolves.toMatchObject({ sessions: [], suppressed: { failedZeroOutput: 1 } })

    // Same Session, but now it succeeded: it must come back.
    events = answered('ping')
    const fresh = new SessionCatalog(
      memory,
      { async listSnapshots() { return [{ header: { id: 'flaky', createdAt: 100, cwd: '/work/project-alpha' }, revision: 'source:new' }] } },
      { get() { return undefined } },
      undefined,
      undefined,
      () => false,
      () => false,
      async () => events,
    )
    const result = await fresh.list()
    expect(result.sessions.map(s => s.sessionId)).toEqual(['flaky'])
    expect(result.suppressed.failedZeroOutput).toBe(0)
  })
})
