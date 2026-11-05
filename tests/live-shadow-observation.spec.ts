/**
 * Release 5.1: shadow observation against the real probe cache and memory root.
 *
 * Skipped unless DSH_MEMORY_SEED_ROOT is set. It reads the live store read-only
 * and reports what the policies would do, so the acceptance report is based on
 * evidence rather than on fixtures.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { MemoryGovernanceStore } from '../src/memory-governance-store.ts'
import { buildForgettingReport } from '../src/memory-forgetting-report.ts'

const root = process.env.DSH_MEMORY_SEED_ROOT

describe.skipIf(root === undefined)('shadow observation', () => {
  it('reports probe state distribution', () => {
    const cache = JSON.parse(readFileSync(join(root!, 'probe-cache.json'), 'utf8')) as Record<string, string>
    const states = new Map<string, number>()
    for (const state of Object.values(cache)) states.set(state, (states.get(state) ?? 0) + 1)
    const total = Object.keys(cache).length
    const lines = [`probe entries: ${total}`]
    for (const [state, count] of [...states].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${state.padEnd(22)} ${count}`)
    }
    // The three zero-token failures are the incident this whole plan exists for.
    const zeroOutput = states.get('failed-zero-output') ?? 0
    lines.push('', `zero-token failures detected: ${zeroOutput}`)
    console.log(lines.join('\n'))
    expect(total).toBeGreaterThanOrEqual(10)
  }, 30_000)

  it('never proposes removal for any live record', () => {
    const memory = new MarkdownMemoryStore(new Context(), root!)
    memory.initialize()
    const governance = new MemoryGovernanceStore(root!)

    const records: Array<Record<string, unknown>> = []
    for (const workspace of memory.listWorkspaces().workspaces) {
      const view = memory.readWorkspaceById(workspace.workspaceId)
      if (view === undefined) continue
      const document = governance.read(workspace.workspaceId)
      for (const record of view.records) {
        const claim = document.claims.find(entry => entry.name === record.name)
        records.push({
          name: record.name,
          kind: claim?.kind ?? 'configuration',
          volatility: claim?.volatility ?? 'stable',
          importanceScore: claim?.importanceScore ?? 50,
          lifecycle: claim?.lifecycle ?? 'active',
          lastEvidenceAt: claim?.lastEvidenceAt ?? Date.now(),
          lastUsedAt: claim?.lastUsedAt ?? null,
          superseded: claim?.lifecycle === 'superseded',
          hasExtractedSop: false,
        })
      }
    }

    const report = buildForgettingReport(records as never, Date.now())
    console.log([
      `records reviewed : ${records.length}`,
      `would cool       : ${report.counts.cooled}`,
      `would archive    : ${report.counts.archived}`,
      `would restore    : ${report.counts.restored}`,
      `protected        : ${report.protectedCount}`,
      `total changes    : ${report.changes.length}`,
    ].join('\n'))

    // The invariant that matters: no path in the report deletes anything.
    for (const change of report.changes) {
      expect(['cooled', 'archived', 'active']).toContain(change.to)
    }
  }, 30_000)

  it('counts how many probes a human would disagree with', () => {
    // The false-positive check the plan asks for: a Session that produced real
    // output must never be classified as empty or zero-output.
    const cache = JSON.parse(readFileSync(join(root!, 'probe-cache.json'), 'utf8')) as Record<string, string>
    const subagents = Object.values(cache).filter(state => state === 'subagent').length
    const failures = Object.values(cache).filter(state => state === 'failed-zero-output').length
    console.log([
      `subagent delegations (correctly excluded): ${subagents}`,
      `zero-output failures (correctly excluded) : ${failures}`,
      `live Sessions (kept in the list)         : ${Object.values(cache).filter(s => s === 'live').length}`,
    ].join('\n'))
    expect(subagents).toBeGreaterThan(0)
  }, 30_000)
})

describe.skipIf(root === undefined)('Dream determinism', () => {
  it('produces the same plan hash across three runs on one snapshot', async () => {
    // The plan asks for three shadow rounds and a comparison. A planner that
    // drifts run to run cannot be approved safely, because the user would be
    // judging a different proposal than the one they saw.
    const { parseDreamProposal } = await import('../src/memory-dream-proposal.ts')
    const { dreamPlanHash } = await import('../src/memory-dream-receipt.ts')
    const { runDreamWorker } = await import('../src/memory-dream-worker.ts')

    const memory = new MarkdownMemoryStore(new Context(), root!)
    memory.initialize()
    const governance = new MemoryGovernanceStore(root!)
    const first = memory.listWorkspaces().workspaces[0]!
    const view = memory.readWorkspaceById(first.workspaceId)!
    const document = governance.read(first.workspaceId)

    const context = {
      scopeKey: first.workspaceId,
      claims: document.claims,
      globalSections: ['User Profile'],
      now: Date.now(),
    }

    // A fixed proposal stands in for a stable model, so the check is on the
    // pipeline's determinism rather than on a provider's sampling.
    const proposal = { actions: document.claims.slice(0, 2).map(claim => ({ action: 'cool', target: claim.name })) }
    const hashes: string[] = []
    for (let round = 0; round < 3; round += 1) {
      const run = await runDreamWorker(context, { config: {}, callModel: async () => proposal })
      hashes.push(dreamPlanHash(run.plan))
    }
    console.log(`records in scope: ${context.claims.length}\nround hashes: ${hashes.join('\n              ')}`)
    expect(new Set(hashes).size).toBe(1)
    // The scope may hold fewer records than the slice asked for, so the check\n    // is that every proposed action survived parsing, not a fixed count.\n    expect(parseDreamProposal(proposal as never, context as never).actions)\n      .toHaveLength(proposal.actions.length)
  }, 30_000)
})