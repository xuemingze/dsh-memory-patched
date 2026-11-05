import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { MemoryGovernanceStore } from '../src/memory-governance-store.ts'
import { buildForgettingReport } from '../src/memory-forgetting-report.ts'

const root = process.env.DSH_MEMORY_SEED_ROOT

describe.skipIf(root === undefined)('live forgetting report', () => {
  it('reports what the lifecycle policy would do', () => {
    const memory = new MarkdownMemoryStore(new Context(), root!)
    memory.initialize()
    const governance = new MemoryGovernanceStore(root!)

    const records = []
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
    const lines = [
      `mode: shadow (nothing is changed)`,
      `records reviewed : ${records.length}`,
      `would cool       : ${report.counts.cooled}`,
      `would archive    : ${report.counts.archived}`,
      `would restore    : ${report.counts.restored}`,
      `protected        : ${report.protectedCount}`,
    ]
    if (report.changes.length > 0) {
      lines.push('', 'proposed changes (least valuable first):')
      for (const change of report.changes.slice(0, 15)) {
        lines.push(`  ${String(change.importanceScore).padStart(3)} ${change.name}: ${change.from} -> ${change.to} (${change.reason})`)
      }
    }
    console.log(lines.join('\n'))
    expect(report.changes.every(change => change.to !== ('purge' as never))).toBe(true)
  }, 30_000)
})
