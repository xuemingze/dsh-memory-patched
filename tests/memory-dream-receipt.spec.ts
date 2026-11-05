import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DREAM_RECEIPT_FORMAT,
  DreamReceiptStore,
  applyDreamPlan,
  dreamPlanHash,
  replayDreamReceipt,
} from '../src/memory-dream-receipt.ts'
import { MemoryGovernanceStore } from '../src/memory-governance-store.ts'
import { parseDreamProposal, type DreamProposalContext } from '../src/memory-dream-proposal.ts'
import type { GovernanceClaim } from '../src/memory-governance-types.ts'

const NOW = new Date('2026-11-05T12:00:00Z').getTime()

function claim(overrides: Partial<GovernanceClaim> = {}): GovernanceClaim {
  return {
    name: 'alpha',
    scopeKey: 'scope-a',
    kind: 'procedure',
    volatility: 'stable',
    lifecycle: 'active',
    importanceClass: 'working',
    importanceScore: 60,
    text: 'alpha summary',
    environmentFingerprint: '',
    evidenceCount: 1,
    lastEvidenceAt: NOW,
    lastVerifiedAt: null,
    lastUsedAt: null,
    supersedes: [],
    sourcePlugins: [],
    ...overrides,
  }
}

function context(claims: GovernanceClaim[] = [claim(), claim({ name: 'beta' })]): DreamProposalContext {
  return { scopeKey: 'scope-a', claims, globalSections: ['User Profile'], now: NOW }
}

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dream-receipt-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function seed(claims: GovernanceClaim[] = [claim(), claim({ name: 'beta' })]): MemoryGovernanceStore {
  const store = new MemoryGovernanceStore(root)
  store.replace({
    format: 1,
    scopeKey: 'scope-a',
    revision: 'gov1:0000000000000000',
    claims,
    degraded: false,
  })
  return store
}

describe('Dream receipt store', () => {
  it('writes one receipt per run and reads it back', () => {
    const store = new DreamReceiptStore(root)
    const record = store.write({
      runId: 'dream-1',
      scopeKey: 'scope-a',
      state: 'committed',
      attempt: 1,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      beforeRevision: 'gov1:0000000000000000',
      afterRevision: 'gov1:1111111111111111',
      proposalHash: 'abc',
      risk: 'metadata-only',
      changes: [{ action: 'cool', target: 'alpha' }],
      createdAt: new Date(NOW).toISOString(),
    })
    expect(record.format).toBe(DREAM_RECEIPT_FORMAT)
    const back = store.read('dream-1')
    expect(back?.proposalHash).toBe('abc')
    expect(back?.changes).toHaveLength(1)
  })

  it('never stores a memory body in the receipt', () => {
    // The receipt is an audit record. If it carried bodies it would become a
    // second source of truth that can drift from Markdown.
    const store = new DreamReceiptStore(root)
    store.write({
      runId: 'dream-2',
      scopeKey: 'scope-a',
      state: 'committed',
      attempt: 1,
      provider: 'p',
      model: 'm',
      beforeRevision: 'gov1:0000000000000000',
      afterRevision: 'gov1:1111111111111111',
      proposalHash: 'abc',
      risk: 'content-change',
      changes: [{ action: 'cool', target: 'alpha' }],
      createdAt: new Date(NOW).toISOString(),
    })
    const raw = readFileSync(join(root, 'dream', 'dream-2.json'), 'utf8')
    expect(raw).not.toContain('alpha summary')
    // Only the handle travels, never the prose.
    expect(raw).toContain('"target": "alpha"')
  })

  it('lists runs newest first so the panel shows the latest', () => {
    const store = new DreamReceiptStore(root)
    for (const [index, runId] of ['dream-a', 'dream-b'].entries()) {
      store.write({
        runId,
        scopeKey: 'scope-a',
        state: 'committed',
        attempt: 1,
        provider: 'p',
        model: 'm',
        beforeRevision: 'gov1:0000000000000000',
        afterRevision: 'gov1:1111111111111111',
        proposalHash: `hash-${index}`,
        risk: 'metadata-only',
        changes: [],
        createdAt: new Date(NOW + index * 1000).toISOString(),
      })
    }
    const runs = store.list()
    expect(runs.map(entry => entry.runId)).toEqual(['dream-b', 'dream-a'])
  })

  it('survives a corrupt receipt file instead of failing the listing', () => {
    // One bad file must not hide every other run from the panel.
    const store = new DreamReceiptStore(root)
    store.write({
      runId: 'dream-ok',
      scopeKey: 'scope-a',
      state: 'committed',
      attempt: 1,
      provider: 'p',
      model: 'm',
      beforeRevision: 'gov1:0000000000000000',
      afterRevision: 'gov1:1111111111111111',
      proposalHash: 'h',
      risk: 'metadata-only',
      changes: [],
      createdAt: new Date(NOW).toISOString(),
    })
    mkdirSync(join(root, 'dream'), { recursive: true })
    writeFileSync(join(root, 'dream', 'broken.json'), '{ not json')
    const runs = store.list()
    expect(runs.map(entry => entry.runId)).toEqual(['dream-ok'])
  })

  it('refuses a run id that would escape the store directory', () => {
    const store = new DreamReceiptStore(root)
    expect(() => store.read('../../etc/passwd')).toThrow()
  })
})

describe('Dream plan hashing', () => {
  it('is stable for the same plan', () => {
    const plan = parseDreamProposal({ actions: [{ action: 'cool', target: 'alpha' }] }, context())
    expect(dreamPlanHash(plan)).toBe(dreamPlanHash(plan))
  })

  it('differs when the plan differs', () => {
    const a = parseDreamProposal({ actions: [{ action: 'cool', target: 'alpha' }] }, context())
    const b = parseDreamProposal({ actions: [{ action: 'archive', target: 'alpha' }] }, context())
    expect(dreamPlanHash(a)).not.toBe(dreamPlanHash(b))
  })

  it('ignores rationale so a comment does not change the hash', () => {
    const withOut = parseDreamProposal({ actions: [{ action: 'cool', target: 'alpha' }] }, context())
    const withIn = parseDreamProposal(
      { actions: [{ action: 'cool', target: 'alpha', rationale: 'because' }] },
      context(),
    )
    expect(dreamPlanHash(withIn)).toBe(dreamPlanHash(withOut))
  })
})

describe('Applying a Dream plan', () => {
  it('applies metadata actions without touching any body', () => {
    const store = seed()
    const plan = parseDreamProposal({ actions: [{ action: 'cool', target: 'alpha' }] }, context())
    const result = applyDreamPlan(store, plan, NOW)
    expect(result.applied).toBe(1)
    const after = store.read('scope-a')
    const alpha = after.claims.find(entry => entry.name === 'alpha')!
    expect(alpha.lifecycle).toBe('cooled')
    // The body lives in Markdown; the sidecar only carries the handle.
    expect(alpha.text).toBe('alpha summary')
  })

  it('bumps the revision so a stale writer cannot clobber it', () => {
    const store = seed()
    const before = store.read('scope-a').revision
    const plan = parseDreamProposal({ actions: [{ action: 'cool', target: 'alpha' }] }, context())
    applyDreamPlan(store, plan, NOW)
    expect(store.read('scope-a').revision).not.toBe(before)
  })

  it('marks contested without deciding which record is right', () => {
    const store = seed()
    const plan = parseDreamProposal(
      { actions: [{ action: 'mark-contested', target: 'alpha', opposingRecords: ['beta'] }] },
      context(),
    )
    applyDreamPlan(store, plan, NOW)
    const alpha = store.read('scope-a').claims.find(entry => entry.name === 'alpha')!
    expect(alpha.lifecycle).toBe('contested')
  })

  it('archives without removing the record', () => {
    const store = seed()
    const plan = parseDreamProposal({ actions: [{ action: 'archive', target: 'beta' }] }, context())
    applyDreamPlan(store, plan, NOW)
    expect(store.read('scope-a').claims.map(entry => entry.name)).toContain('beta')
  })

  it('is a no-op for an empty plan', () => {
    const store = seed()
    const before = store.read('scope-a').revision
    const plan = parseDreamProposal({ actions: [] }, context())
    const result = applyDreamPlan(store, plan, NOW)
    expect(result.applied).toBe(0)
    expect(store.read('scope-a').revision).toBe(before)
  })

  it('refuses to apply when the record disappeared after planning', () => {
    // The model planned against a snapshot; if the store moved on, applying the
    // plan would silently target the wrong thing.
    const store = seed()
    const plan = parseDreamProposal({ actions: [{ action: 'cool', target: 'alpha' }] }, context())
    store.replace({
      format: 1,
      scopeKey: 'scope-a',
      revision: 'gov1:2222222222222222',
      claims: [claim({ name: 'gamma' })],
      degraded: false,
    })
    expect(() => applyDreamPlan(store, plan, NOW)).toThrow(/no longer exists/u)
  })
})

describe('Dream replay', () => {
  it('reconstructs what a run did from its receipt alone', () => {
    const store = seed()
    const plan = parseDreamProposal(
      { actions: [{ action: 'cool', target: 'alpha' }, { action: 'archive', target: 'beta' }] },
      context(),
    )
    applyDreamPlan(store, plan, NOW)
    const receipts = new DreamReceiptStore(root)
    receipts.write({
      runId: 'dream-run',
      scopeKey: 'scope-a',
      state: 'committed',
      attempt: 1,
      provider: 'p',
      model: 'm',
      beforeRevision: 'gov1:0000000000000000',
      afterRevision: store.read('scope-a').revision,
      proposalHash: dreamPlanHash(plan),
      risk: plan.risk,
      changes: plan.actions.map(action => ({ action: action.action, target: 'target' in action ? action.target : '' })),
      createdAt: new Date(NOW).toISOString(),
    })
    const replay = replayDreamReceipt(receipts.read('dream-run')!)
    expect(replay.actions).toHaveLength(2)
    expect(replay.actions.map(entry => entry.action)).toEqual(['cool', 'archive'])
    expect(replay.risk).toBe('metadata-only')
  })

  it('reports a receipt whose plan hash no longer matches', () => {
    const receipts = new DreamReceiptStore(root)
    receipts.write({
      runId: 'dream-mismatch',
      scopeKey: 'scope-a',
      state: 'committed',
      attempt: 1,
      provider: 'p',
      model: 'm',
      beforeRevision: 'gov1:0000000000000000',
      afterRevision: 'gov1:1111111111111111',
      proposalHash: 'expected',
      risk: 'metadata-only',
      changes: [],
      createdAt: new Date(NOW).toISOString(),
    })
    const replay = replayDreamReceipt(receipts.read('dream-mismatch')!, { expectedHash: 'different' })
    expect(replay.hashMatches).toBe(false)
  })
})

describe('Dream runner', () => {
  it('records a committed run with before and after revisions', async () => {
    const { runDreamSession } = await import('../src/memory-dream-receipt.ts')
    const store = seed()
    const receipts = new DreamReceiptStore(root)
    const before = store.read('scope-a').revision

    const result = await runDreamSession({
      store,
      receipts,
      context: context(),
      runId: 'run-ok',
      config: {},
      now: NOW,
      callModel: async () => ({ actions: [{ action: 'cool', target: 'alpha' }] }),
    })

    expect(result.receipt.state).toBe('committed')
    expect(result.receipt.beforeRevision).toBe(before)
    expect(result.receipt.afterRevision).toBe(store.read('scope-a').revision)
    expect(result.receipt.afterRevision).not.toBe(before)
  })

  it('records no-change without bumping the revision', async () => {
    const { runDreamSession } = await import('../src/memory-dream-receipt.ts')
    const store = seed()
    const receipts = new DreamReceiptStore(root)
    const before = store.read('scope-a').revision

    const result = await runDreamSession({
      store,
      receipts,
      context: context(),
      runId: 'run-noop',
      config: {},
      now: NOW,
      callModel: async () => ({ actions: [] }),
    })

    expect(result.receipt.state).toBe('no-change')
    expect(store.read('scope-a').revision).toBe(before)
  })

  it('records a provider failure and applies nothing', async () => {
    const { runDreamSession } = await import('../src/memory-dream-receipt.ts')
    const store = seed()
    const receipts = new DreamReceiptStore(root)
    const before = store.read('scope-a').revision

    const result = await runDreamSession({
      store,
      receipts,
      context: context(),
      runId: 'run-fail',
      config: {},
      now: NOW,
      callModel: async () => { throw new Error('socket hang up') },
    })

    expect(result.receipt.state).toBe('provider-failed')
    expect(store.read('scope-a').revision).toBe(before)
    expect(receipts.read('run-fail')?.error).toMatch(/socket hang up/u)
  })

  it('records truncation distinctly so a retry can shrink the input', async () => {
    const { runDreamSession } = await import('../src/memory-dream-receipt.ts')
    const store = seed()
    const receipts = new DreamReceiptStore(root)
    const result = await runDreamSession({
      store,
      receipts,
      context: context(),
      runId: 'run-trunc',
      config: {},
      now: NOW,
      callModel: async () => ({ truncated: true }),
    })
    expect(result.receipt.state).toBe('output-truncated')
  })

  it('records a stale scope instead of applying to the wrong records', async () => {
    // The model planned against a snapshot that moved. Writing anyway would
    // target records the model never saw.
    const { runDreamSession } = await import('../src/memory-dream-receipt.ts')
    const store = seed()
    const receipts = new DreamReceiptStore(root)
    let swapped = false

    const result = await runDreamSession({
      store,
      receipts,
      context: context(),
      runId: 'run-stale',
      config: {},
      now: NOW,
      callModel: async () => {
        if (!swapped) {
          swapped = true
          store.replace({
            format: 1,
            scopeKey: 'scope-a',
            revision: 'gov1:9999999999999999',
            claims: [claim({ name: 'gamma' })],
            degraded: false,
          })
        }
        return { actions: [{ action: 'cool', target: 'alpha' }] }
      },
    })

    expect(result.receipt.state).toBe('stale-scope')
    expect(store.read('scope-a').claims.map(entry => entry.name)).toEqual(['gamma'])
  })

  it('keeps a receipt for every run, including failures', async () => {
    const { runDreamSession } = await import('../src/memory-dream-receipt.ts')
    const store = seed()
    const receipts = new DreamReceiptStore(root)
    await runDreamSession({
      store, receipts, context: context(), runId: 'r1', config: {}, now: NOW,
      callModel: async () => ({ actions: [] }),
    })
    await runDreamSession({
      store, receipts, context: context(), runId: 'r2', config: {}, now: NOW + 1000,
      callModel: async () => { throw new Error('boom') },
    })
    expect(receipts.list().map(entry => entry.runId)).toEqual(['r2', 'r1'])
  })
})
describe('Two-phase Dream run', () => {
  it('plans without writing, then applies only after approval', async () => {
    const { planDreamSession, approveDreamPlan } = await import('../src/memory-dream-receipt.ts')
    const store = seed()
    const receipts = new DreamReceiptStore(root)
    const before = store.read('scope-a').revision

    const pending = await planDreamSession({
      receipts, context: context(), runId: 'phase-1', config: {}, now: NOW,
      callModel: async () => ({ actions: [{ action: 'cool', target: 'alpha' }] }),
    })
    expect(pending.planned).toBe(true)
    // Planning alone must not touch the store.
    expect(store.read('scope-a').revision).toBe(before)
    expect(receipts.read('phase-1')).toBeUndefined()

    const applied = approveDreamPlan({ store, receipts, runId: 'phase-1', now: NOW + 1 })
    expect(applied.receipt.state).toBe('committed')
    expect(store.read('scope-a').claims.find(entry => entry.name === 'alpha')?.lifecycle).toBe('cooled')
    // The pending copy is consumed once approved.
    expect(receipts.readPending('phase-1')).toBeUndefined()
  })

  it('discards a pending plan without touching the store', async () => {
    const { planDreamSession, discardDreamPlan } = await import('../src/memory-dream-receipt.ts')
    const store = seed()
    const receipts = new DreamReceiptStore(root)
    const before = store.read('scope-a').revision

    await planDreamSession({
      receipts, context: context(), runId: 'phase-2', config: {}, now: NOW,
      callModel: async () => ({ actions: [{ action: 'cool', target: 'alpha' }] }),
    })
    discardDreamPlan(receipts, 'phase-2')
    expect(receipts.readPending('phase-2')).toBeUndefined()
    expect(store.read('scope-a').revision).toBe(before)
  })

  it('refuses to approve a plan that was never planned', async () => {
    // Without this, a stale browser tab could approve a run id that no longer
    // has a pending plan and apply nothing while reporting success.
    const { approveDreamPlan } = await import('../src/memory-dream-receipt.ts')
    const store = seed()
    const receipts = new DreamReceiptStore(root)
    expect(() => approveDreamPlan({ store, receipts, runId: 'missing', now: NOW }))
      .toThrow(/no pending plan/u)
  })

  it('lists pending plans so the panel can show them', async () => {
    const { planDreamSession } = await import('../src/memory-dream-receipt.ts')
    const receipts = new DreamReceiptStore(root)
    await planDreamSession({
      receipts, context: context(), runId: 'p-a', config: {}, now: NOW,
      callModel: async () => ({ actions: [{ action: 'cool', target: 'alpha' }] }),
    })
    await planDreamSession({
      receipts, context: context(), runId: 'p-b', config: {}, now: NOW + 1000,
      callModel: async () => ({ actions: [{ action: 'archive', target: 'beta' }] }),
    })
    expect(receipts.listPending().map(entry => entry.runId)).toEqual(['p-b', 'p-a'])
  })
})
describe('Approval edge cases from the spec', () => {
  async function stage(runId: string, actions: unknown[], store = seed()) {
    const { planDreamSession } = await import('../src/memory-dream-receipt.ts')
    const receipts = new DreamReceiptStore(root)
    await planDreamSession({
      receipts, context: context(), runId, config: {}, now: NOW,
      callModel: async () => ({ actions }),
    })
    return { store, receipts }
  }

  it('applies only the approved subset (partial approval)', async () => {
    const { approveDreamPlan } = await import('../src/memory-dream-receipt.ts')
    const { planActionFingerprint } = await import('../src/memory-dream-approval.ts')
    const { store, receipts } = await stage('p-partial', [
      { action: 'cool', target: 'alpha' },
      { action: 'archive', target: 'beta' },
    ])
    // Approve the first action only; the second must stay untouched.
    approveDreamPlan({
      store, receipts, runId: 'p-partial', now: NOW,
      approved: [planActionFingerprint({ action: 'cool', target: 'alpha' })],
    })
    const after = store.read('scope-a')
    expect(after.claims.find(entry => entry.name === 'alpha')?.lifecycle).toBe('cooled')
    expect(after.claims.find(entry => entry.name === 'beta')?.lifecycle).toBe('active')
  })

  it('is idempotent against a double click on approve', async () => {
    const { approveDreamPlan } = await import('../src/memory-dream-receipt.ts')
    const { store, receipts } = await stage('p-double', [{ action: 'cool', target: 'alpha' }])
    approveDreamPlan({ store, receipts, runId: 'p-double', now: NOW })
    // The second click finds no pending plan, so it cannot apply twice.
    expect(() => approveDreamPlan({ store, receipts, runId: 'p-double', now: NOW }))
      .toThrow(/no pending plan/u)
  })

  it('cancelling leaves the store and the pending plan untouched', async () => {
    const { discardDreamPlan } = await import('../src/memory-dream-receipt.ts')
    const { store, receipts } = await stage('p-cancel', [{ action: 'archive', target: 'beta' }])
    const before = store.read('scope-a').revision
    discardDreamPlan(receipts, 'p-cancel')
    expect(store.read('scope-a').revision).toBe(before)
    expect(receipts.readPending('p-cancel')).toBeUndefined()
    expect(receipts.read('p-cancel')).toBeUndefined()
  })

  it('reports source-changed when the store moved between plan and approve', async () => {
    const { approveDreamPlan } = await import('../src/memory-dream-receipt.ts')
    const { store, receipts } = await stage('p-stale', [{ action: 'cool', target: 'alpha' }])
    // Someone else replaced the record set in the meantime.
    store.replace({
      format: 1, scopeKey: 'scope-a', revision: 'gov1:aaaaaaaaaaaaaaaa',
      claims: [claim({ name: 'gamma' })], degraded: false,
    })
    const result = approveDreamPlan({ store, receipts, runId: 'p-stale', now: NOW })
    expect(result.receipt.state).toBe('stale-scope')
    // The pending plan survives so the user can see what failed.
    expect(store.read('scope-a').claims.map(entry => entry.name)).toEqual(['gamma'])
  })

  it('records provider-unavailable as a run the panel can show', async () => {
    const { planDreamSession } = await import('../src/memory-dream-receipt.ts')
    const receipts = new DreamReceiptStore(root)
    const result = await planDreamSession({
      receipts, context: context(), runId: 'p-provider', config: {}, now: NOW,
      callModel: async () => { throw new Error('provider unavailable') },
    })
    expect(result.planned).toBe(false)
    if (!result.planned) {
      expect(result.receipt.state).toBe('provider-failed')
      expect(result.receipt.error).toMatch(/provider unavailable/u)
    }
  })

  it('remembers a rejection so the same snapshot is not re-suggested', async () => {
    const { planActionFingerprint } = await import('../src/memory-dream-approval.ts')
    const { receipts } = await stage('p-reject', [{ action: 'cool', target: 'alpha' }])
    const print = planActionFingerprint({ action: 'cool', target: 'alpha' })
    receipts.recordRejection('scope-a', print, 'disagree', NOW)
    const declined = receipts.readRejections('scope-a')
    expect(declined).toHaveLength(1)
    expect(declined[0]?.reason).toBe('disagree')
  })

  it('replaces the reason when the same action is declined twice', async () => {
    const { receipts } = await stage('p-reject2', [])
    receipts.recordRejection('scope-a', 'fp', 'disagree', NOW)
    receipts.recordRejection('scope-a', 'fp', 'not-important', NOW + 1)
    const declined = receipts.readRejections('scope-a')
    expect(declined).toHaveLength(1)
    expect(declined[0]?.reason).toBe('not-important')
  })
})