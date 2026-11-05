import { describe, expect, it } from 'vitest'
import {
  DREAM_ACTIONS,
  DreamProposalError,
  parseDreamProposal,
  type DreamProposalContext,
} from '../src/memory-dream-proposal.ts'
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
    importanceScore: 40,
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

function context(overrides: Partial<DreamProposalContext> = {}): DreamProposalContext {
  return {
    scopeKey: 'scope-a',
    claims: [claim(), claim({ name: 'beta' }), claim({ name: 'gamma' })],
    globalSections: ['User Profile', 'User Preferences', 'General Tips'],
    now: NOW,
    ...overrides,
  }
}

/** A minimal well-formed proposal with one action. */
function proposal(actions: unknown[]): unknown {
  return { actions }
}

const mergeAction = {
  action: 'merge',
  sources: ['alpha', 'beta'],
  target: 'alpha-merged',
  description: 'merged summary',
  text: 'alpha and beta describe the same procedure',
}

describe('Dream proposal actions', () => {
  it('declares exactly the permitted actions', () => {
    // The model may only pick from this list; anything else is rejected.
    expect([...DREAM_ACTIONS].sort()).toEqual([
      'archive', 'cool', 'extract-sop', 'mark-contested',
      'merge', 'promote-global', 'set-priority', 'supersede',
    ])
  })

  it('accepts a merge that references existing records', () => {
    const plan = parseDreamProposal(proposal([mergeAction]), context())
    expect(plan.actions).toHaveLength(1)
    expect(plan.actions[0]).toMatchObject({ action: 'merge', sources: ['alpha', 'beta'] })
  })

  it('rejects an action kind that is not on the list', () => {
    expect(() => parseDreamProposal(proposal([
      { action: 'delete-everything', target: 'alpha' },
    ]), context())).toThrow(DreamProposalError)
  })

  it('rejects a merge that cites a record that does not exist', () => {
    // A hallucinated source is the single most dangerous Dream output.
    expect(() => parseDreamProposal(proposal([
      { ...mergeAction, sources: ['alpha', 'invented-record'] },
    ]), context())).toThrow(/unknown record/u)
  })

  it('rejects a merge with fewer than two sources', () => {
    expect(() => parseDreamProposal(proposal([
      { ...mergeAction, sources: ['alpha'] },
    ]), context())).toThrow(/at least two/u)
  })

  it('rejects duplicate target names across actions', () => {
    expect(() => parseDreamProposal(proposal([
      { action: 'cool', target: 'alpha' },
      { action: 'archive', target: 'alpha' },
    ]), context())).toThrow(/more than one action/u)
  })

  it('rejects a circular supersede chain', () => {
    expect(() => parseDreamProposal(proposal([
      { action: 'supersede', older: 'alpha', newer: 'beta' },
      { action: 'supersede', older: 'beta', newer: 'alpha' },
    ]), context())).toThrow(/circular/u)
  })

  it('rejects an action that reaches outside its scope', () => {
    expect(() => parseDreamProposal(proposal([
      { action: 'cool', target: 'alpha', scopeKey: 'scope-b' },
    ]), context())).toThrow(/unknown fields/u)
  })
})

describe('Dream promote-global boundary', () => {
  const promote = {
    action: 'promote-global',
    source: 'alpha',
    section: 'User Preferences',
    text: 'prefer npm installs',
  }

  it('allows promotion into a known global section', () => {
    const plan = parseDreamProposal(proposal([promote]), context())
    expect(plan.actions[0]).toMatchObject({ action: 'promote-global', section: 'User Preferences' })
  })

  it('refuses an invented global section', () => {
    expect(() => parseDreamProposal(proposal([
      { ...promote, section: 'Random Notes' },
    ]), context())).toThrow(/global section/u)
  })

  it('refuses a full-document replacement instead of a section', () => {
    // Dream must never be able to rewrite GLOBAL wholesale.
    expect(() => parseDreamProposal(proposal([
      { action: 'promote-global', source: 'alpha', document: '# everything', text: 'x' },
    ]), context())).toThrow(/section|unknown fields/u)
  })
})

describe('Dream scoring and risk', () => {
  it('recomputes priority instead of trusting the model score', () => {
    const plan = parseDreamProposal(proposal([{
      action: 'set-priority',
      target: 'alpha',
      score: 100,
      rationale: 'feels important',
    }]), context())
    const action = plan.actions[0]!
    expect(action.action).toBe('set-priority')
    // The model's number is rationale only; the deterministic score wins.
    expect((action as { score: number }).score).not.toBe(100)
    expect((action as { score: number }).score).toBe(60)
  })

  it('marks a plan that edits record text as higher risk than metadata only', () => {
    const metadataOnly = parseDreamProposal(proposal([
      { action: 'cool', target: 'alpha' },
      { action: 'mark-contested', target: 'beta' },
    ]), context())
    expect(metadataOnly.risk).toBe('metadata-only')

    const rewrites = parseDreamProposal(proposal([mergeAction]), context())
    expect(rewrites.risk).toBe('content-change')
  })

  it('never proposes a physical deletion', () => {
    const plan = parseDreamProposal(proposal([
      { action: 'cool', target: 'alpha' },
      { action: 'archive', target: 'beta' },
    ]), context())
    // Archiving keeps the record on disk; removal is a separate confirmed act.
    for (const action of plan.actions) {
      expect(action.action).not.toBe('purge')
      expect(action.action).not.toBe('delete')
    }
  })
})

describe('Dream proposal envelopes', () => {
  it('accepts an empty action list as no change', () => {
    // Rejecting this would force the model to invent work to satisfy the schema,
    // which is how a librarian turns into an author.
    const plan = parseDreamProposal(proposal([]), context())
    expect(plan.actions).toHaveLength(0)
    expect(plan.risk).toBe('metadata-only')
  })

  it('rejects unknown fields at the envelope level', () => {
    expect(() => parseDreamProposal({ actions: [mergeAction], extra: true }, context()))
      .toThrow(/unknown fields/u)
  })

  it('rejects a non-object proposal', () => {
    expect(() => parseDreamProposal('nope', context())).toThrow(DreamProposalError)
  })

  it('caps the number of actions per run', () => {
    const many = Array.from({ length: 200 }, () => ({ action: 'cool', target: 'alpha' }))
    expect(() => parseDreamProposal(proposal(many), context())).toThrow(/too many/u)
  })

  it('is deterministic for the same proposal and context', () => {
    const input = proposal([mergeAction])
    expect(parseDreamProposal(input, context())).toEqual(parseDreamProposal(input, context()))
  })
})
