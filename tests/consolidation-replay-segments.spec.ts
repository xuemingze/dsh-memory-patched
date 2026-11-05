import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { workerSessionIdOf } from '../src/consolidation-identity.ts'
import { WorkerSessionPlanReplay } from '../src/consolidation-replay.ts'
import { CONSOLIDATION_PROPOSAL_TOOL, renderConsolidationWorkerInput } from '../src/consolidation-worker.ts'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { SessionConsolidator, type SessionConsolidationInput } from '../src/session-consolidator.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Build three evidence turns so the review can be sliced into segments, then
 * materialise one worker Session per segment the way a segmented run does.
 */
async function segmentedFixture(): Promise<{
  input: SessionConsolidationInput
  consolidator: SessionConsolidator
  sessionIds: string[]
  sessions: Map<string, unknown[]>
}> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-replay-seg-'))
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
        events: [0, 1, 2].map(seq => ({
          seq,
          type: 'user/message',
          data: {
            content: [{ type: 'text', text: `Remember fact ${seq}.` }],
            source: { kind: 'user' },
          },
        })),
      }
    },
  }, { get() { return undefined } })
  const input = await consolidator.prepare('source-session')

  const count = 3
  const sessions = new Map<string, unknown[]>()
  const sessionIds: string[] = []
  for (let index = 0; index < count; index += 1) {
    const id = workerSessionIdOf(input.reviewId, 1, index)
    sessionIds.push(id)
    const segmentInput: SessionConsolidationInput = {
      ...input,
      source: { ...input.source, evidence: [input.source.evidence[0]!] },
    }
    sessions.set(id, [
      {
        type: 'user/message',
        seq: 0,
        data: {
          role: 'user',
          source: { kind: 'plugin:dsh-memory' },
          content: [{
            type: 'text',
            text: renderConsolidationWorkerInput(segmentInput, { index, count }),
          }],
        },
      },
      {
        type: 'tool/call',
        seq: 1,
        data: {
          name: CONSOLIDATION_PROPOSAL_TOOL,
          arguments: JSON.stringify({
            final: true,
            outcome: 'changes',
            changes: [{
              action: 'put',
              record: {
                name: `rule-${index}`,
                description: `Rule from segment ${index}.`,
                type: 'project',
                content: `Content ${index}.`,
              },
              evidence: [{ fromSeq: 0, toSeq: 0 }],
            }],
          }),
        },
      },
    ])
  }
  return { input, consolidator, sessionIds, sessions }
}

describe('WorkerSessionPlanReplay with segmented runs', () => {
  it('merges every segment when the receipt stores the last segment id', async () => {
    const { input, consolidator, sessionIds, sessions } = await segmentedFixture()
    const lastId = sessionIds.at(-1)!
    const replay = new WorkerSessionPlanReplay({
      async listSnapshots() { return [] },
      async inspect(sessionId: string) {
        const events = sessions.get(sessionId)
        if (events === undefined) throw new Error(`unexpected session ${sessionId}`)
        return { meta: { id: sessionId, createdAt: 1 }, events }
      },
    }, consolidator)

    const plan = await replay.loadPlan(lastId, input)
    expect(plan.proposal.changes.map(change => (
      change.action === 'put' ? change.record.name : undefined
    ))).toEqual(['rule-0', 'rule-1', 'rule-2'])
  })

  it('merges every segment when the receipt stores segment 0 instead', async () => {
    const { input, consolidator, sessionIds, sessions } = await segmentedFixture()
    const replay = new WorkerSessionPlanReplay({
      async listSnapshots() { return [] },
      async inspect(sessionId: string) {
        const events = sessions.get(sessionId)
        if (events === undefined) throw new Error(`unexpected session ${sessionId}`)
        return { meta: { id: sessionId, createdAt: 1 }, events }
      },
    }, consolidator)

    const plan = await replay.loadPlan(sessionIds[0]!, input)
    expect(plan.proposal.changes).toHaveLength(3)
  })

  it('does not read siblings for a single-segment run', async () => {
    const { input, consolidator, sessionIds, sessions } = await segmentedFixture()
    const requested: string[] = []
    const replay = new WorkerSessionPlanReplay({
      async listSnapshots() { return [] },
      async inspect(sessionId: string) {
        requested.push(sessionId)
        const events = sessions.get(sessionId)
        if (events === undefined) throw new Error(`unexpected session ${sessionId}`)
        return { meta: { id: sessionId, createdAt: 1 }, events }
      },
    }, consolidator)

    // Segment 0 of a 1-segment run keeps the plain id and no segment metadata.
    const plainId = workerSessionIdOf(input.reviewId, 1)
    const plainEvents = [
      sessions.get(sessionIds[0]!)![0],
      sessions.get(sessionIds[0]!)![1],
    ] as unknown[]
    // Rewrite the rendered input without segment info.
    const rendered = renderConsolidationWorkerInput(input)
    ;(plainEvents[0] as { data: { content: { text: string }[] } }).data.content[0]!.text = rendered
    sessions.set(plainId, plainEvents)

    await replay.loadPlan(plainId, input)
    expect(requested).toEqual([plainId])
  })
})
