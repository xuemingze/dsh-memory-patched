import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConsolidationCommitCoordinator,
  ConsolidationReceiptError,
  ConsolidationReceiptStore,
  type ConsolidationCommitInput,
} from '../src/consolidation-receipt.ts'
import type { MemorySessionSnapshot } from '../src/host-contracts.ts'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { SessionConsolidator } from '../src/session-consolidator.ts'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(proposal: unknown = validProposal()): Promise<{
  root: string
  store: MarkdownMemoryStore
  consolidator: SessionConsolidator
  receipts: ConsolidationReceiptStore
  coordinator: ConsolidationCommitCoordinator
  request: ConsolidationCommitInput
  setSourceRevision(value: string): void
}> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-receipt-'))
  roots.push(root)
  const store = new MarkdownMemoryStore(new Context(), join(root, 'memory'))
  store.initialize()
  let sourceRevision = 'source:a'
  const currentSnapshot = (): MemorySessionSnapshot => ({
    header: { id: 'source-session', createdAt: 42, cwd: '/work/project' },
    revision: sourceRevision,
  })
  const consolidator = new SessionConsolidator(store, {
    async listSnapshots() { return [currentSnapshot()] },
    async inspect() {
      return {
        meta: currentSnapshot().header,
        events: [{ seq: 0, type: 'user/message', data: {
          content: [{ type: 'text', text: 'Keep verification focused.' }],
          source: { kind: 'user' },
        } }],
      }
    },
  }, { get() { return undefined } })
  const input = await consolidator.prepare('source-session')
  const plan = consolidator.planProposal(input, proposal)
  const receipts = new ConsolidationReceiptStore(
    join(store.root, 'reviews'),
    () => new Date('2026-08-31T00:00:00.000Z'),
  )
  const coordinator = new ConsolidationCommitCoordinator(store, consolidator, receipts)
  return {
    root,
    store,
    consolidator,
    receipts,
    coordinator,
    request: {
      input,
      plan,
      attempt: 1,
      workerSessionId: 'session-worker-1',
      workerConfig: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    },
    setSourceRevision(value) { sourceRevision = value },
  }
}

function validProposal(): unknown {
  return {
    outcome: 'changes',
    changes: [{
      action: 'put',
      record: {
        name: 'verification-rule',
        description: 'Use focused verification.',
        type: 'feedback',
        content: 'Run the smallest relevant automated checks.',
      },
      evidence: [{ fromSeq: 0, toSeq: 0 }],
    }],
  }
}

describe('ConsolidationCommitCoordinator', () => {
  it('commits one proposal spanning Global and Workspace memory', async () => {
    const proposal = validProposal() as { outcome: string; changes: unknown[] }
    const setupResult = await setup({
      outcome: 'changes',
      changes: [{
        action: 'replace-global',
        content: '# Global Memory\n\n- Prefer concise answers.\n',
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }, ...proposal.changes],
    })

    const result = await setupResult.coordinator.commit(setupResult.request)
    expect(result).toMatchObject({ outcome: 'committed' })
    expect((await setupResult.store.readGlobal()).content).toContain('Prefer concise answers.')
    expect((await setupResult.store.readWorkspace(setupResult.request.input.workspace.scope)).records)
      .toMatchObject([{ name: 'verification-rule' }])
    expect(result.receipt.changes.map(change => change.action)).toEqual(['replace-global', 'put'])
  })

  it('skips one corrupt receipt file during batch scans while direct reads stay strict', async () => {
    const { receipts } = await setup()
    const corruptId = `review-${'b'.repeat(64)}`
    mkdirSync(receipts.directory, { recursive: true })
    writeFileSync(join(receipts.directory, `${corruptId}.md`), 'deliberately corrupt content\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(receipts.listCommittingBySourceSession('source-session')).toEqual([])
      expect([...receipts.latestBySourceSessions(new Map([['source-session', 'source:a']]))]).toEqual([])
      expect(() => receipts.read(corruptId)).toThrow(ConsolidationReceiptError)
    } finally {
      warn.mockRestore()
    }
  })

  it('parses receipts that a hand editor saved with CRLF line endings', async () => {
    const setupResult = await setup()
    const result = await setupResult.coordinator.commit(setupResult.request)
    const path = join(setupResult.receipts.directory, `${result.receipt.reviewId}.md`)
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\n/gu, '\r\n'))
    expect(setupResult.receipts.read(result.receipt.reviewId)?.state).toBe('committed')
  })

  it('resolves the recovery target from the receipt workspaceKey instead of the caller-presented scope', async () => {
    const { coordinator, receipts, request, store } = await setup()
    const commit = vi.spyOn(store, 'commitWorkspace')
    commit.mockRejectedValueOnce(new Error('simulated process crash'))
    await expect(coordinator.commit(request)).rejects.toThrow('simulated process crash')
    expect(receipts.read(request.input.reviewId)?.state).toBe('committing')

    // Two empty Workspaces share one revision, so a caller-presented scope of a
    // different Workspace passes assertPlanMatchesReceipt; the durable receipt
    // must own the target anyway.
    const scopeB = store.scopeForCwd('/work/other-project')
    const workspaceB = await store.readWorkspace(scopeB)
    const swapped: ConsolidationCommitInput = {
      ...request,
      input: {
        ...request.input,
        workspace: { ...request.input.workspace, scope: scopeB, revision: workspaceB.revision },
      },
    }
    await expect(coordinator.commit(swapped)).resolves.toMatchObject({ outcome: 'committed', recovered: true })
    expect((await store.readWorkspace(request.input.workspace.scope)).records)
      .toMatchObject([{ name: 'verification-rule' }])
    expect((await store.readWorkspace(scopeB)).records).toEqual([])
  })

  it('recovers when Global committed before a Workspace commit failure', async () => {
    const proposal = validProposal() as { outcome: string; changes: unknown[] }
    const setupResult = await setup({
      outcome: 'changes',
      changes: [{
        action: 'replace-global',
        content: '# Global Memory\n\n- Prefer concise answers.\n',
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }, ...proposal.changes],
    })
    const globalCommit = vi.spyOn(setupResult.store, 'commitGlobal')
    const workspaceCommit = vi.spyOn(setupResult.store, 'commitWorkspace')
    workspaceCommit.mockRejectedValueOnce(new Error('simulated Workspace crash'))

    await expect(setupResult.coordinator.commit(setupResult.request)).rejects.toThrow('simulated Workspace crash')
    expect((await setupResult.store.readGlobal()).content).toContain('Prefer concise answers.')
    expect(setupResult.receipts.read(setupResult.request.input.reviewId)?.state).toBe('committing')

    await expect(setupResult.coordinator.commit(setupResult.request)).resolves.toMatchObject({
      outcome: 'committed',
      recovered: true,
    })
    expect(globalCommit).toHaveBeenCalledTimes(1)
    expect(workspaceCommit).toHaveBeenCalledTimes(2)
  })

  it('writes a minimal committing intent before one CAS commit and completes the receipt', async () => {
    const { coordinator, receipts, request, store } = await setup()
    const result = await coordinator.commit(request)

    expect(result).toMatchObject({ outcome: 'committed', recovered: false })
    expect(receipts.read(request.input.reviewId)).toEqual(result.receipt)
    expect((await store.readWorkspace(request.input.workspace.scope)).records).toMatchObject([
      { name: 'verification-rule', type: 'feedback' },
    ])
    const source = readFileSync(join(store.root, 'reviews', `${request.input.reviewId}.md`), 'utf8')
    expect(source).toContain('state: committed')
    expect(source).toContain('contentHash: sha256:')
    expect(source).not.toContain('Run the smallest relevant automated checks.')
    expect(source).not.toContain('/work/project')
  })

  it('records a normalized no-change without publishing a Workspace generation', async () => {
    const { coordinator, request, store } = await setup({ outcome: 'no-change', changes: [] })
    const commit = vi.spyOn(store, 'commitWorkspace')
    const result = await coordinator.commit(request)

    expect(result).toMatchObject({ outcome: 'no-change', recovered: false })
    expect(result.receipt).toMatchObject({ state: 'no-change', changes: [], completedAt: expect.any(String) })
    expect(commit).not.toHaveBeenCalled()
  })

  it('recovers a crash after durable intent but before the Workspace commit', async () => {
    const { coordinator, receipts, request, store } = await setup()
    const commit = vi.spyOn(store, 'commitWorkspace')
    commit.mockRejectedValueOnce(new Error('simulated process crash'))

    await expect(coordinator.commit(request)).rejects.toThrow('simulated process crash')
    expect(receipts.read(request.input.reviewId)?.state).toBe('committing')
    expect(receipts.listCommittingBySourceSession(request.input.source.sessionId))
      .toMatchObject([{ reviewId: request.input.reviewId, state: 'committing' }])

    const recovered = await coordinator.commit(request)
    expect(recovered).toMatchObject({ outcome: 'committed', recovered: true })
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('refuses recovery when the supplied plan does not match the durable intent', async () => {
    const { coordinator, consolidator, receipts, request, store } = await setup()
    vi.spyOn(store, 'commitWorkspace').mockRejectedValueOnce(new Error('simulated process crash'))
    await expect(coordinator.commit(request)).rejects.toThrow()

    const differentPlan = consolidator.planProposal(request.input, {
      outcome: 'changes',
      changes: [{
        action: 'put',
        record: {
          name: 'verification-rule',
          description: 'Use focused verification.',
          type: 'feedback',
          content: 'A different unrecorded proposal body.',
        },
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    })
    await expect(coordinator.commit({ ...request, plan: differentPlan }))
      .rejects.toThrow(/does not match/)
    expect(receipts.read(request.input.reviewId)?.state).toBe('committing')
  })

  it('recovers a crash after the Workspace commit without writing it twice', async () => {
    const { coordinator, receipts, request, store } = await setup()
    const originalWrite = receipts.write.bind(receipts)
    let writes = 0
    vi.spyOn(receipts, 'write').mockImplementation((receipt) => {
      writes += 1
      if (writes === 2) throw new Error('simulated receipt completion crash')
      originalWrite(receipt)
    })
    const commit = vi.spyOn(store, 'commitWorkspace')

    await expect(coordinator.commit(request)).rejects.toThrow('simulated receipt completion crash')
    expect(receipts.read(request.input.reviewId)?.state).toBe('committing')
    expect(commit).toHaveBeenCalledTimes(1)

    vi.mocked(receipts.write).mockImplementation(originalWrite)
    const recovered = await coordinator.commit(request)
    expect(recovered).toMatchObject({ outcome: 'committed', recovered: true })
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('converges a changed recovery target to conflict without overwriting it', async () => {
    const { coordinator, receipts, request, store } = await setup()
    const commit = vi.spyOn(store, 'commitWorkspace')
    commit.mockRejectedValueOnce(new Error('simulated process crash'))
    await expect(coordinator.commit(request)).rejects.toThrow()
    commit.mockRestore()

    const current = await store.readWorkspace(request.input.workspace.scope)
    await store.commitWorkspace({
      scope: request.input.workspace.scope,
      expectedRevision: current.revision,
      changes: [{ action: 'put', record: {
        name: 'other-change',
        description: 'Concurrent durable change.',
        type: 'project',
        content: 'Do not overwrite this generation.',
      } }],
    })

    const recovered = await coordinator.commit(request)
    expect(recovered).toMatchObject({ outcome: 'target-conflict', recovered: true })
    expect(receipts.read(request.input.reviewId)?.state).toBe('target-conflict')
    expect((await store.readWorkspace(request.input.workspace.scope)).records).toMatchObject([
      { name: 'other-change' },
    ])
  })

  it('returns a completed review idempotently without another Workspace commit', async () => {
    const { coordinator, request, store } = await setup()
    const commit = vi.spyOn(store, 'commitWorkspace')
    await coordinator.commit(request)
    const repeated = await coordinator.commit(request)

    expect(repeated).toMatchObject({ outcome: 'committed', recovered: true })
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('rejects a changed source before writing a receipt', async () => {
    const { coordinator, receipts, request, setSourceRevision } = await setup()
    setSourceRevision('source:b')
    await expect(coordinator.commit(request)).rejects.toMatchObject({ code: 'unstable' })
    expect(receipts.read(request.input.reviewId)).toBeUndefined()
  })
})

describe('ConsolidationReceiptStore', () => {
  it('finds the current source revision before a newer receipt for an older revision', async () => {
    const { coordinator, receipts, request } = await setup()
    const committed = await coordinator.commit(request)
    expect(receipts.latestBySourceSession('source-session', 'source:a')).toEqual(committed.receipt)
    expect(receipts.latestBySourceSession('source-session', 'source:newer')).toEqual(committed.receipt)
    expect(receipts.latestBySourceSession('unknown', 'source:a')).toBeUndefined()
  })

  it('serializes concurrent work for the same review id', async () => {
    const { receipts, request } = await setup()
    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const first = receipts.withReviewLock(request.input.reviewId, async () => {
      order.push('first-enter')
      await gate
      order.push('first-exit')
    })
    await Promise.resolve()
    const second = receipts.withReviewLock(request.input.reviewId, async () => {
      order.push('second-enter')
    })
    await Promise.resolve()
    expect(order).toEqual(['first-enter'])
    releaseFirst?.()
    await Promise.all([first, second])
    expect(order).toEqual(['first-enter', 'first-exit', 'second-enter'])
  })

  it('rejects malformed or path-like receipt identities and unknown disk fields', async () => {
    const { receipts, request, store } = await setup()
    expect(() => receipts.read('../escape')).toThrow(ConsolidationReceiptError)
    const directory = join(store.root, 'reviews')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `${request.input.reviewId}.md`), `---\nreviewId: ${request.input.reviewId}\nunknown: true\n---\n`, 'utf8')
    expect(() => receipts.read(request.input.reviewId)).toThrow(/missing or unknown/)
  })

  it('returns no pending receipts when the review directory does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-memory-empty-receipts-'))
    roots.push(root)
    const receipts = new ConsolidationReceiptStore(join(root, 'missing'))
    expect(receipts.listCommittingBySourceSession('source-session')).toEqual([])
    expect(() => receipts.listCommittingBySourceSession(' ')).toThrow(/must not be empty/)
  })
})
