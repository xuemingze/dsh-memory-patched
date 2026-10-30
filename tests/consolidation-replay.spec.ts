import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConsolidationReplayError,
  WorkerSessionPlanReplay,
} from '../src/consolidation-replay.ts'
import type { ConsolidationReceipt } from '../src/consolidation-receipt.ts'
import { CONSOLIDATION_PROPOSAL_TOOL, renderConsolidationWorkerInput } from '../src/consolidation-worker.ts'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { SessionConsolidator, type SessionConsolidationInput } from '../src/session-consolidator.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture(): Promise<{
  input: SessionConsolidationInput
  consolidator: SessionConsolidator
  events: unknown[]
}> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-replay-'))
  roots.push(root)
  const store = new MarkdownMemoryStore(new Context(), join(root, 'memory'))
  store.initialize()
  const snapshot = {
    header: { id: 'source-session', createdAt: 42, cwd: '/work/replay' },
    revision: 'source:a',
  }
  const consolidator = new SessionConsolidator(store, {
    async listSnapshots() { return [snapshot] },
    async inspect() {
      return {
        meta: snapshot.header,
        events: [{ seq: 0, type: 'user/message', data: {
          content: [{ type: 'text', text: 'Remember this.' }],
          source: { kind: 'user' },
        } }],
      }
    },
  }, { get() { return undefined } })
  const input = await consolidator.prepare('source-session')
  const proposal = {
    outcome: 'changes',
    changes: [{
      action: 'put',
      record: {
        name: 'replayed-rule',
        description: 'Recovered from the worker Session.',
        type: 'project',
        content: 'Replay the exact accepted proposal.',
      },
      evidence: [{ fromSeq: 0, toSeq: 0 }],
    }],
  }
  return {
    input,
    consolidator,
    events: [
      {
        type: 'user/message',
        seq: 0,
        data: {
          role: 'user',
          source: { kind: 'plugin:dsh-memory' },
          content: [{ type: 'text', text: renderConsolidationWorkerInput(input) }],
        },
      },
      {
        type: 'tool/call',
        seq: 1,
        data: { name: CONSOLIDATION_PROPOSAL_TOOL, arguments: JSON.stringify({ final: true, ...proposal }) },
      },
    ],
  }
}

describe('WorkerSessionPlanReplay', () => {
  it('rebuilds the validated plan from backend-neutral logical events', async () => {
    const { input, consolidator, events } = await fixture()
    const replay = new WorkerSessionPlanReplay({
      async listSnapshots() { return [] },
      async inspect() { return { meta: { id: 'worker', createdAt: 1 }, events } },
    }, consolidator)

    await expect(replay.loadPlan('worker', input)).resolves.toMatchObject({
      proposal: { outcome: 'changes', changes: [{ action: 'put', record: { name: 'replayed-rule' } }] },
      preview: { changed: true },
    })
    const receipt: ConsolidationReceipt = {
      format: 1,
      reviewId: input.reviewId,
      consolidatorVersion: input.consolidatorVersion,
      sourceSessionId: input.source.sessionId,
      sourceRevision: input.source.revision,
      coveredSeq: { from: 0, to: 0 },
      workspaceKey: input.workspace.scope.key,
      beforeRevision: input.workspace.revision,
      plannedAfterRevision: consolidator.planProposal(input, JSON.parse(
        (() => {
          const value = JSON.parse((events[1] as { data: { arguments: string } }).data.arguments)
          return JSON.stringify({ outcome: value.outcome, changes: value.changes })
        })(),
      )).preview.revision,
      state: 'committing',
      attempts: [{
        attempt: 1,
        workerSessionId: 'worker',
        provider: 'test',
        model: 'test',
        status: 'proposed',
      }],
      proposalHash: 'sha256:test',
      changes: [],
      createdAt: '2026-08-31T00:00:00.000Z',
    }
    await expect(replay.loadRecoveryPlan('worker', receipt, input.workspace)).resolves.toMatchObject({
      proposal: { outcome: 'changes' },
    })
    await expect(replay.loadRecoveryPlan('worker', { ...receipt, sourceSessionId: 'other' }, input.workspace))
      .rejects.toThrow(/does not match/)
  })

  it('rejects missing, repeated, malformed, or mismatched replay evidence', async () => {
    const { input, consolidator, events } = await fixture()
    const load = async (candidate: readonly unknown[]) => new WorkerSessionPlanReplay({
      async listSnapshots() { return [] },
      async inspect() { return { meta: { id: 'worker', createdAt: 1 }, events: candidate } },
    }, consolidator).loadPlan('worker', input)

    await expect(load(events.filter((_, index) => index !== 0))).rejects.toBeInstanceOf(ConsolidationReplayError)
    await expect(load([...events, events[1]])).rejects.toThrow(/exactly one final proposal/)
    const malformed = structuredClone(events) as Array<{ type: string; data: Record<string, unknown> }>
    malformed[1]!.data.arguments = '{'
    await expect(load(malformed)).rejects.toThrow(/valid JSON/)
    const mismatched = structuredClone(events) as Array<{ type: string; data: Record<string, unknown> }>
    const message = mismatched[0]!.data as { content: Array<{ text: string }> }
    message.content[0]!.text = message.content[0]!.text.replace(input.reviewId, `review-${'b'.repeat(64)}`)
    await expect(load(mismatched)).rejects.toThrow(/does not match/)
  })
})
