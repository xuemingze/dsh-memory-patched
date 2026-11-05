import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { MemoryGovernanceStore } from '../src/memory-governance-store.ts'
import { initializeGovernance } from '../src/memory-governance-init.ts'

/**
 * One-off live seeding, driven through the real memory root.
 *
 * Guarded so a normal `pnpm test` run skips it: it writes to the live profile
 * only when DSH_MEMORY_SEED_ROOT is set. It uses the same store and initializer
 * the RPC endpoint uses, so the result is identical to pressing the button.
 */
const root = process.env.DSH_MEMORY_SEED_ROOT

describe.skipIf(root === undefined)('live governance seeding', () => {
  it('seeds every workspace and is idempotent', () => {
    const memory = new MarkdownMemoryStore(new Context(), root!)
    memory.initialize()

    const scopes: Array<{ scopeKey: string; records: readonly unknown[]; displayName: string }> = []
    for (const workspace of memory.listWorkspaces().workspaces) {
      const view = memory.readWorkspaceById(workspace.workspaceId)
      if (view === undefined) continue
      scopes.push({ scopeKey: workspace.workspaceId, records: view.records, displayName: workspace.displayName })
    }

    const governance = new MemoryGovernanceStore(root!)
    const summaries = initializeGovernance(governance, scopes as never, Date.now())

    const lines: string[] = []
    lines.push(`memory root: ${root}`)
    lines.push(`workspaces : ${scopes.length}`)
    lines.push(`records    : ${scopes.reduce((total, scope) => total + scope.records.length, 0)}`)
    for (const summary of summaries) {
      const name = scopes.find(entry => entry.scopeKey === summary.scopeKey)?.displayName ?? summary.scopeKey
      const document = governance.read(summary.scopeKey)
      const bands = new Map<string, number>()
      for (const claim of document.claims) {
        bands.set(claim.importanceClass, (bands.get(claim.importanceClass) ?? 0) + 1)
      }
      lines.push('')
      lines.push(`[${name}] created=${summary.created} skipped=${summary.skipped} total=${document.claims.length}`)
      lines.push(`  bands: ${[...bands].map(([band, count]) => `${band}=${count}`).join(' ')}`)
      for (const claim of [...document.claims].sort((a, b) => b.importanceScore - a.importanceScore).slice(0, 3)) {
        lines.push(`  ${String(claim.importanceScore).padStart(3)} ${claim.importanceClass.padEnd(9)} ${claim.kind.padEnd(13)} ${claim.name}`)
      }
    }

    console.log(lines.join('\n'))
    expect(summaries.length).toBeGreaterThan(0)

    // Running again must create nothing: the operation is idempotent.
    const second = initializeGovernance(governance, scopes as never, Date.now())
    expect(second.reduce((total, entry) => total + entry.created, 0)).toBe(0)
    console.log(`second run created=${second.reduce((t, e) => t + e.created, 0)} (expected 0)`)
  }, 60_000)
})
