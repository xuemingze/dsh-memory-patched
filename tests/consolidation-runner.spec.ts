import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { ConsolidationProposalError, parseConsolidationProposal } from '../src/consolidation-proposal.ts'
import {
  ConsolidationCommitCoordinator,
  ConsolidationReceiptStore,
} from '../src/consolidation-receipt.ts'
import type { ConsolidationPlanReplay } from '../src/consolidation-replay.ts'
import {
  SessionConsolidationRunError,
  SessionConsolidationRunner,
  type ConsolidationWorkerDriver,
} from '../src/consolidation-runner.ts'
import {
  ConsolidationEvidenceTooLargeError,
  ConsolidationProviderError,
} from '../src/consolidation-worker.ts'
import { workerSessionIdOf } from '../src/consolidation-identity.ts'
import type { MemorySessionSnapshot } from '../src/host-contracts.ts'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { SessionConsolidator, type SessionConsolidationInput } from '../src/session-consolidator.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type WorkerBehavior = (
  input: SessionConsolidationInput,
  attempt: number,
) => Promise<{ workerSessionId: string; plan: ReturnType<SessionConsolidator['planProposal']> }>

class FakeWorker implements ConsolidationWorkerDriver {
  readonly config = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    maxTokens: 8192,
    timeoutMs: 120000,
    maxInputBytes: 131072,
  }
  calls = 0

  constructor(private behavior: WorkerBehavior) {}

  run(input: SessionConsolidationInput, attempt: number): ReturnType<WorkerBehavior> {
    this.calls += 1
    return this.behavior(input, attempt)
  }

  setBehavior(behavior: WorkerBehavior): void {
    this.behavior = behavior
  }
}

async function setup(events: readonly unknown[] = [
  { seq: 0, type: 'user/message', data: {
    content: [{ type: 'text', text: 'Remember focused verification.' }],
    source: { kind: 'user' },
  } },
]): Promise<{
  store: MarkdownMemoryStore
  consolidator: SessionConsolidator
  receipts: ConsolidationReceiptStore
  commits: ConsolidationCommitCoordinator
  worker: FakeWorker
  runner: SessionConsolidationRunner
  replay: ConsolidationPlanReplay
  setSourceRevision(value: string): void
}> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-runner-'))
  roots.push(root)
  const store = new MarkdownMemoryStore(new Context(), join(root, 'memory'))
  store.initialize()
  let sourceRevision = 'source:a'
  const snapshot = (): MemorySessionSnapshot => ({
    header: { id: 'source-session', createdAt: 42, cwd: '/work/project' },
    revision: sourceRevision,
  })
  const consolidator = new SessionConsolidator(store, {
    async listSnapshots() { return [snapshot()] },
    async inspect() {
      return {
        meta: snapshot().header,
        events,
      }
    },
  }, { get() { return undefined } })
  const receipts = new ConsolidationReceiptStore(join(store.root, 'reviews'))
  const commits = new ConsolidationCommitCoordinator(store, consolidator, receipts)
  const worker = new FakeWorker(async (input, attempt) => ({
    workerSessionId: workerSessionIdOf(input.reviewId, attempt),
    plan: consolidator.planProposal(input, validProposal()),
  }))
  const replay: ConsolidationPlanReplay = {
    async loadPlan(_workerSessionId, input) {
      return consolidator.planProposal(input, validProposal())
    },
    async loadRecoveryPlan(_workerSessionId, _receipt, workspace) {
      return parseConsolidationProposal(validProposal(), {
        sourceEvidence: inputEvidence(events),
        global: await store.readGlobal(),
        workspace,
      })
    },
  }
  return {
    store,
    consolidator,
    receipts,
    commits,
    worker,
    runner: new SessionConsolidationRunner(consolidator, worker, receipts, commits, replay, store),
    replay,
    setSourceRevision(value) { sourceRevision = value },
  }
}

function inputEvidence(events: readonly unknown[]): SessionConsolidationInput['source']['evidence'] {
  return events.length === 0 ? [] : [{
    fromSeq: 0,
    toSeq: events.length - 1,
    user: ['Remember focused verification.'],
    summaries: [],
    assistantFinal: null,
    tools: [],
  }]
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

describe('SessionConsolidationRunner', () => {
  it('runs one worker attempt and commits its plan through the receipt barrier', async () => {
    const { runner, worker, store } = await setup()
    const result = await runner.run('source-session')

    expect(result).toMatchObject({ outcome: 'committed', recovered: false })
    expect(result.receipt.attempts).toMatchObject([{ attempt: 1, status: 'committed' }])
    expect(worker.calls).toBe(1)
    expect((await store.readWorkspace(store.scopeForCwd('/work/project'))).records)
      .toMatchObject([{ name: 'verification-rule' }])
  })

  it('records a strictly empty Session as no-change without creating a worker', async () => {
    const { runner, worker } = await setup([])
    const result = await runner.run('source-session')
    expect(result).toMatchObject({ outcome: 'no-change', recovered: false })
    expect(result.receipt.attempts).toMatchObject([{ workerSessionId: null, status: 'no-change' }])
    expect(worker.calls).toBe(0)
  })

  it('serializes concurrent triggers so a successful review calls the model once', async () => {
    const { runner, worker, consolidator } = await setup()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    worker.setBehavior(async (input, attempt) => {
      await gate
      return {
        workerSessionId: workerSessionIdOf(input.reviewId, attempt),
        plan: consolidator.planProposal(input, validProposal()),
      }
    })

    const first = runner.run('source-session')
    await Promise.resolve()
    const second = runner.run('source-session')
    await Promise.resolve()
    release?.()
    const results = await Promise.all([first, second])

    expect(results.map(result => result.outcome)).toEqual(['committed', 'committed'])
    expect(results.filter(result => result.recovered)).toHaveLength(1)
    expect(worker.calls).toBe(1)
  })

  it('records an invalid proposal and preserves it when a manual retry succeeds', async () => {
    const { runner, worker, consolidator } = await setup()
    worker.setBehavior(async () => { throw new ConsolidationProposalError('bad proposal') })
    const failed = await runner.run('source-session')
    expect(failed).toMatchObject({ outcome: 'invalid-proposal', recovered: false })
    expect(failed.receipt.attempts).toMatchObject([{ attempt: 1, status: 'invalid-proposal' }])

    worker.setBehavior(async (input, attempt) => ({
      workerSessionId: workerSessionIdOf(input.reviewId, attempt),
      plan: consolidator.planProposal(input, validProposal()),
    }))
    const retried = await runner.run('source-session')
    expect(retried.outcome).toBe('committed')
    expect(retried.receipt.attempts).toMatchObject([
      { attempt: 1, status: 'invalid-proposal' },
      { attempt: 2, status: 'committed' },
    ])
    expect(worker.calls).toBe(2)
  })

  it('classifies cancellation, Provider failure, oversized evidence, and a final source change', async () => {
    const cancelled = await setup()
    cancelled.worker.setBehavior(async () => { throw new DOMException('cancelled', 'AbortError') })
    expect(await cancelled.runner.run('source-session')).toMatchObject({ outcome: 'cancelled' })

    const provider = await setup()
    provider.worker.setBehavior(async () => { throw new ConsolidationProviderError('provider unavailable') })
    expect(await provider.runner.run('source-session')).toMatchObject({ outcome: 'provider-failed' })

    const oversized = await setup()
    oversized.worker.setBehavior(async () => { throw new ConsolidationEvidenceTooLargeError(2, 1) })
    expect(await oversized.runner.run('source-session')).toMatchObject({ outcome: 'evidence-too-large' })

    const changed = await setup()
    changed.worker.setBehavior(async (input, attempt) => {
      changed.setSourceRevision('source:b')
      return {
        workerSessionId: workerSessionIdOf(input.reviewId, attempt),
        plan: changed.consolidator.planProposal(input, validProposal()),
      }
    })
    expect(await changed.runner.run('source-session')).toMatchObject({ outcome: 'source-changed' })
  })

  it('records an unexpected worker identity as an internal error', async () => {
    const { runner, worker, consolidator } = await setup()
    worker.setBehavior(async (input) => ({
      workerSessionId: 'session-wrong',
      plan: consolidator.planProposal(input, validProposal()),
    }))
    const result = await runner.run('source-session')
    expect(result).toMatchObject({ outcome: 'internal-error' })
    expect(result.receipt.attempts).toMatchObject([{ status: 'internal-error' }])
  })

  it('recovers an older durable commit after the source revision grows without invoking the worker again', async () => {
    const { runner, worker, commits, consolidator, receipts, store, setSourceRevision } = await setup()
    const input = await consolidator.prepare('source-session')
    const plan = consolidator.planProposal(input, validProposal())
    const original = store.commitWorkspace.bind(store)
    store.commitWorkspace = async () => { throw new Error('simulated crash') }
    await expect(commits.commit({
      input,
      plan,
      attempt: 1,
      workerSessionId: workerSessionIdOf(input.reviewId, 1),
      workerConfig: worker.config,
    })).rejects.toThrow('simulated crash')
    store.commitWorkspace = original
    expect(receipts.read(input.reviewId)?.state).toBe('committing')
    setSourceRevision('source:b')

    await expect(runner.run('source-session')).resolves.toMatchObject({
      outcome: 'committed',
      recovered: true,
    })
    expect(worker.calls).toBe(0)
  })

  it('converges an unreplayable committing receipt to a terminal state instead of looping forever', async () => {
    const { runner, worker, commits, consolidator, receipts, store, replay } = await setup()
    const input = await consolidator.prepare('source-session')
    const plan = consolidator.planProposal(input, validProposal())
    const original = store.commitWorkspace.bind(store)
    store.commitWorkspace = async () => { throw new Error('simulated crash') }
    await expect(commits.commit({
      input,
      plan,
      attempt: 1,
      workerSessionId: workerSessionIdOf(input.reviewId, 1),
      workerConfig: worker.config,
    })).rejects.toThrow('simulated crash')
    store.commitWorkspace = original
    expect(receipts.read(input.reviewId)?.state).toBe('committing')

    replay.loadRecoveryPlan = async () => { throw new Error('worker session was lost') }
    const failed = await runner.run('source-session')
    expect(failed).toMatchObject({ outcome: 'internal-error', recovered: false })
    expect(failed.receipt.attempts).toMatchObject([{ attempt: 1, status: 'internal-error' }])

    const retried = await runner.run('source-session')
    expect(retried).toMatchObject({ outcome: 'committed', recovered: false })
    expect(retried.receipt.attempts).toMatchObject([
      { attempt: 1, status: 'internal-error' },
      { attempt: 2, status: 'committed' },
    ])
    expect(worker.calls).toBe(1)
  })
})
