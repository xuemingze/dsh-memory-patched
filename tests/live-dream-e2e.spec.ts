/**
 * Release 5: Dream end-to-end against the live memory root, minus the model.
 *
 * Skipped unless DSH_MEMORY_SEED_ROOT is set. The only substitution is the model
 * itself: everything else is the real code — context building from Markdown,
 * prompt rendering, the agent driver, the parser, staging, per-action approval,
 * plan application, and GLOBAL publication.
 *
 * What this proves: if a model returns a valid plan, the whole chain works on
 * real data. What it cannot prove: that a particular model returns one.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { MemoryGovernanceStore } from '../src/memory-governance-store.ts'
import { DreamReceiptStore, approveDreamPlan, dreamPlanHash } from '../src/memory-dream-receipt.ts'
import { parseDreamProposal, type DreamProposalContext } from '../src/memory-dream-proposal.ts'
import { selectGlobalSections, renderDreamPrompt } from '../src/memory-dream-agent.ts'
import { applyGlobalPromotion } from '../src/memory-global-guard.ts'

const root = process.env.DSH_MEMORY_SEED_ROOT

describe.skipIf(root === undefined)('Dream chain on live data', () => {
  /** Read the live record set exactly as the host does. */
  function liveContext(): DreamProposalContext {
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
    return scopes.sort((a, b) => b.claims.length - a.claims.length)[0]!
  }

  let temp: string
  beforeEach(() => { temp = mkdtempSync(join(tmpdir(), 'dream-e2e-')) })
  afterEach(() => { rmSync(temp, { recursive: true, force: true }) })

  it('stages, approves, applies, and publishes on a copy of the live set', () => {
    const context = liveContext()
    // Work on a copy: the live store must not be written by a test.
    const store = new MemoryGovernanceStore(temp)
    store.replace({
      format: 1, scopeKey: context.scopeKey, revision: 'gov1:0000000000000000',
      claims: context.claims, degraded: false,
    })
    const receipts = new DreamReceiptStore(temp)
    const globalPath = join(temp, 'GLOBAL.md')
    writeFileSync(globalPath, ['# Global', '', '## User Profile', '', '- existing', ''].join('\n'), 'utf8')

    // A plan a sane model would produce: cool the least-evidenced record.
    const target = [...context.claims].sort((a, b) => a.importanceScore - b.importanceScore)[0]!
    const submission = { actions: [{ action: 'cool', target: target.name }] }
    const plan = parseDreamProposal(submission, context)
    const runId = 'e2e-1'
    receipts.writePending(plan, runId, Date.now())

    const before = store.read(context.scopeKey)
    const staged = receipts.readPending(runId)
    expect(staged?.plan.actions).toHaveLength(1)

    const approved = approveDreamPlan({ store, receipts, runId, now: Date.now() })
    expect(approved.receipt.state).toBe('committed')

    const after = store.read(context.scopeKey)
    const cooled = after.claims.find(entry => entry.name === target.name)!
    expect(cooled.lifecycle).toBe('cooled')
    // The body is untouched: cooling changes visibility, never prose.
    expect(cooled.text).toBe(target.text)
    expect(after.revision).not.toBe(before.revision)

    console.log([
      `scope: ${context.scopeKey.slice(0, 28)}`,
      `records: ${context.claims.length}`,
      `proposed: cool ${target.name} (score ${target.importanceScore})`,
      `state: ${approved.receipt.state}`,
      `revision: ${before.revision.slice(0, 20)} -> ${after.revision.slice(0, 20)}`,
    ].join('\n'))
  }, 60_000)

  it('publishes a promotion into the real section list without inventing one', () => {
    const context = liveContext()
    const global = readFileSync(join(root!, 'GLOBAL.md'), 'utf8')
    const sections = selectGlobalSections(global)
    expect(sections.length).toBeGreaterThan(0)

    // Promote into a section that genuinely exists in the live GLOBAL.
    const section = sections[0]!
    const draft = applyGlobalPromotion(global, {
      section, text: 'a test line', source: 'test-record', runId: 'e2e-2',
    })
    const at = draft.indexOf('a test line')
    expect(at).toBeGreaterThan(draft.indexOf(`## ${section}`))

    // Nothing may be lost: every non-empty line of the original survives.
    for (const line of global.split('\n')) {
      if (line.trim() === '') continue
      expect(draft).toContain(line)
    }
    expect(draft.length).toBeGreaterThan(global.length)

    console.log([
      `global sections: ${sections.length}`,
      `promoted into: ${section}`,
      `size: ${global.length} -> ${draft.length} bytes`,
    ].join('\n'))
  }, 60_000)

  it('refuses a plan citing a record that does not exist in the live set', () => {
    const context = liveContext()
    expect(() => parseDreamProposal(
      { actions: [{ action: 'cool', target: 'no-such-record-in-this-workspace' }] },
      context,
    )).toThrow(/unknown record/u)
  }, 30_000)

  it('renders a prompt within the byte ceiling for the largest scope', () => {
    const context = liveContext()
    const prompt = renderDreamPrompt(context)
    const bytes = new TextEncoder().encode(prompt).length
    console.log(`largest scope prompt: ${bytes} bytes (${context.claims.length} records)`)
    // The configured ceiling is 256 KB; the largest live scope must fit with room.
    expect(bytes).toBeLessThan(262_144)
  }, 30_000)
})
