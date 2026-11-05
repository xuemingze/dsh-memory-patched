import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryGovernanceStore } from '../src/memory-governance-store.ts'
import { inferClaimFacts, initializeGovernance } from '../src/memory-governance-init.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function store(): MemoryGovernanceStore {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-gov-init-'))
  roots.push(root)
  return new MemoryGovernanceStore(root)
}

const NOW = new Date('2026-11-05T12:00:00Z').getTime()

function record(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    description: `${name} description`,
    type: 'project' as const,
    content: 'body text',
    ...overrides,
  }
}

describe('inferClaimFacts', () => {
  it('treats a feedback record as a stated preference', () => {
    const facts = inferClaimFacts(record('r', { type: 'feedback' }))
    expect(facts.kind).toBe('preference')
    expect(facts.signals.userStated).toBe(true)
  })

  it('recognizes availability subject matter', () => {
    const facts = inferClaimFacts(record('r', { content: 'the proxy keeps timing out' }))
    expect(facts.kind).toBe('availability')
    expect(facts.volatility).toBe('intermittent')
  })

  it('recognizes a procedure', () => {
    const facts = inferClaimFacts(record('r', { content: 'steps to rebuild the bundle' }))
    expect(facts.kind).toBe('procedure')
    expect(facts.signals.hasProcedure).toBe(true)
  })

  it('recognizes a superseded marker', () => {
    const facts = inferClaimFacts(record('r', { content: 'deprecated, replaced by the new tool' }))
    expect(facts.signals.superseded).toBe(true)
  })

  it('defaults an unremarkable project record to stable configuration', () => {
    const facts = inferClaimFacts(record('r'))
    expect(facts.kind).toBe('configuration')
    expect(facts.volatility).toBe('stable')
  })

  it('marks clearly temporary content transient', () => {
    const facts = inferClaimFacts(record('r', { content: 'temporary workaround for today' }))
    expect(facts.volatility).toBe('transient')
  })
})

describe('initializeGovernance', () => {
  it('creates a claim for every record', () => {
    const target = store()
    const summaries = initializeGovernance(target, [{
      scopeKey: 'scope-a',
      records: [record('alpha'), record('beta')],
    }], NOW)
    expect(summaries[0]).toMatchObject({ created: 2, skipped: 0 })
    const document = target.read('scope-a')
    expect(document.claims.map(claim => claim.name).sort()).toEqual(['alpha', 'beta'])
    expect(document.claims.every(claim => claim.lifecycle === 'active')).toBe(true)
  })

  it('is idempotent: a second run creates nothing', () => {
    const target = store()
    const scope = { scopeKey: 'scope-a', records: [record('alpha')] }
    initializeGovernance(target, [scope], NOW)
    const second = initializeGovernance(target, [scope], NOW)
    expect(second[0]).toMatchObject({ created: 0, skipped: 1 })
    expect(target.read('scope-a').claims).toHaveLength(1)
  })

  it('never overwrites an existing claim, including its lifecycle', () => {
    const target = store()
    initializeGovernance(target, [{ scopeKey: 'scope-a', records: [record('alpha')] }], NOW)

    // Simulate the policy having cooled it in the meantime.
    const document = target.read('scope-a')
    target.commit({
      scopeKey: 'scope-a',
      expectedRevision: document.revision,
      upserts: [{ ...document.claims[0]!, lifecycle: 'cooled' }],
      removals: [],
    })

    initializeGovernance(target, [{ scopeKey: 'scope-a', records: [record('alpha')] }], NOW)
    expect(target.read('scope-a').claims[0]?.lifecycle).toBe('cooled')
  })

  it('treats a record without a temporal stamp as current', () => {
    const target = store()
    initializeGovernance(target, [{ scopeKey: 'scope-a', records: [record('alpha')] }], NOW)
    // A fresh record must not look stale, or the first report would propose
    // hiding things that were just written.
    expect(target.read('scope-a').claims[0]?.lastEvidenceAt).toBe(NOW)
  })

  it('preserves a supplied temporal stamp', () => {
    const target = store()
    const old = NOW - 200 * 24 * 60 * 60 * 1000
    initializeGovernance(target, [{
      scopeKey: 'scope-a',
      records: [record('alpha', { lastEvidenceTime: old })],
    }], NOW)
    expect(target.read('scope-a').claims[0]?.lastEvidenceAt).toBe(old)
  })

  it('scores a stated feedback record high enough to be protected', () => {
    const target = store()
    initializeGovernance(target, [{
      scopeKey: 'scope-a',
      records: [record('user-rule', { type: 'feedback' })],
    }], NOW)
    expect(target.read('scope-a').claims[0]?.importanceScore).toBeGreaterThanOrEqual(80)
  })

  it('stores a short summary rather than the record body', () => {
    const target = store()
    const body = 'x'.repeat(5_000)
    initializeGovernance(target, [{
      scopeKey: 'scope-a',
      records: [record('alpha', { description: 'short summary', content: body })],
    }], NOW)
    const claim = target.read('scope-a').claims[0]!
    // Markdown stays the source of truth for what a memory says; copying the
    // body here would double storage and let the two copies drift apart.
    expect(claim.text).toBe('short summary')
    expect(claim.text.length).toBeLessThan(400)
    expect(claim.text).not.toContain('xxxx')
  })

  it('keeps scopes independent', () => {
    const target = store()
    initializeGovernance(target, [
      { scopeKey: 'scope-a', records: [record('alpha')] },
      { scopeKey: 'scope-b', records: [record('beta')] },
    ], NOW)
    expect(target.read('scope-a').claims.map(c => c.name)).toEqual(['alpha'])
    expect(target.read('scope-b').claims.map(c => c.name)).toEqual(['beta'])
  })

  it('does nothing for an empty scope', () => {
    const target = store()
    const summaries = initializeGovernance(target, [{ scopeKey: 'scope-a', records: [] }], NOW)
    expect(summaries[0]).toMatchObject({ created: 0, skipped: 0 })
  })
})
