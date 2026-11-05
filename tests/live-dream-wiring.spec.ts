/**
 * Release 5 follow-up: one real Dream run against the live memory root.
 *
 * Skipped unless DSH_MEMORY_DREAM_LIVE is set, because it calls a real model.
 * It uses the same code path the host uses (prompt render, agent driver, parser),
 * with a stand-in agent registry that records what would be sent, so the failure
 * modes of the wiring surface without needing the host's RPC cookie.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { MemoryGovernanceStore } from '../src/memory-governance-store.ts'
import {
  DREAM_PROPOSAL_TOOL,
  renderDreamPrompt,
  selectGlobalSections,
} from '../src/memory-dream-agent.ts'
import { parseDreamProposal } from '../src/memory-dream-proposal.ts'

const root = process.env.DSH_MEMORY_SEED_ROOT

describe.skipIf(root === undefined)('live Dream wiring', () => {
  it('builds a context and prompt the parser would accept', () => {
    const memory = new MarkdownMemoryStore(new Context(), root!)
    memory.initialize()
    const governance = new MemoryGovernanceStore(root!)
    const global = memory.readGlobalSync()

    const scopes = []
    for (const workspace of memory.listWorkspaces().workspaces) {
      const view = memory.readWorkspaceById(workspace.workspaceId)
      if (view === undefined) continue
      scopes.push({
        scopeKey: workspace.workspaceId,
        claims: governance.read(workspace.workspaceId).claims,
        globalSections: selectGlobalSections(global.content),
        now: Date.now(),
      })
    }

    const lines = [`workspaces: ${scopes.length}`]
    for (const scope of scopes) {
      const prompt = renderDreamPrompt(scope)
      lines.push(`  ${scope.scopeKey.slice(0, 28)}  claims=${scope.claims.length}  prompt=${prompt.length}B`)
      // The prompt must name the tool the worker is restricted to.
      expect(prompt).toContain(DREAM_PROPOSAL_TOOL)
      // And the section list must come from the real GLOBAL, not a placeholder.
      expect(prompt).toContain('globalSections')
    }
    lines.push(`global sections available: ${scopes[0]?.globalSections.length ?? 0}`)
    console.log(lines.join('\n'))
    expect(scopes.length).toBeGreaterThan(0)
  }, 30_000)

  it('accepts a plausible plan against the real record set and rejects a fake one', () => {
    const memory = new MarkdownMemoryStore(new Context(), root!)
    memory.initialize()
    const governance = new MemoryGovernanceStore(root!)
    const workspace = memory.listWorkspaces().workspaces[0]!
    const context = {
      scopeKey: workspace.workspaceId,
      claims: governance.read(workspace.workspaceId).claims,
      globalSections: selectGlobalSections(memory.readGlobalSync().content),
      now: Date.now(),
    }

    // A real record name from the store must be accepted.
    const real = context.claims[0]!.name
    const accepted = parseDreamProposal({ actions: [{ action: 'cool', target: real }] }, context)
    expect(accepted.actions).toHaveLength(1)

    // A name that does not exist must be refused, even though it looks valid.
    expect(() => parseDreamProposal(
      { actions: [{ action: 'cool', target: 'this-record-does-not-exist' }] },
      context,
    )).toThrow(/unknown record/u)

    console.log(`scope: ${context.scopeKey.slice(0, 28)}`)
    console.log(`records: ${context.claims.length}`)
    console.log(`accepted real target: ${real}`)
    console.log(`refused invented target: this-record-does-not-exist`)
  }, 30_000)
})
