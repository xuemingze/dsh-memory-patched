import { describe, expect, it } from 'vitest'
import {
  parseDreamPanelResponse,
  parseDreamRunResponse,
  parseDreamPlanResponse,
  DreamProtocolError,
} from '../src/protocol.ts'

describe('Dream plan view', () => {
  const plan = {
    runId: 'dream-1',
    scopeKey: 'scope-a',
    state: 'planned',
    risk: 'metadata-only',
    proposalHash: 'abc',
    actions: [
      { action: 'cool', target: 'alpha', rationale: 'stale' },
      { action: 'merge', sources: ['beta', 'gamma'], target: 'beta-merged' },
    ],
    createdAt: 1793860469791,
  }

  it('parses a complete plan', () => {
    const parsed = parseDreamPlanResponse(plan)
    expect(parsed.actions).toHaveLength(2)
    expect(parsed.risk).toBe('metadata-only')
  })

  it('rejects an unknown state rather than guessing', () => {
    expect(() => parseDreamPlanResponse({ ...plan, state: 'applied' }))
      .toThrow(DreamProtocolError)
  })

  it('rejects an unknown risk level', () => {
    expect(() => parseDreamPlanResponse({ ...plan, risk: 'harmless' }))
      .toThrow(DreamProtocolError)
  })

  it('rejects an action without a target', () => {
    expect(() => parseDreamPlanResponse({
      ...plan,
      actions: [{ action: 'cool' }],
    })).toThrow(DreamProtocolError)
  })

  it('rejects extra fields so the browser cannot smuggle state', () => {
    expect(() => parseDreamPlanResponse({ ...plan, applied: true }))
      .toThrow(DreamProtocolError)
  })

  it('accepts an empty action list', () => {
    const parsed = parseDreamPlanResponse({ ...plan, actions: [] })
    expect(parsed.actions).toHaveLength(0)
  })

  it('keeps rationale optional', () => {
    const parsed = parseDreamPlanResponse({
      ...plan,
      actions: [{ action: 'cool', target: 'alpha' }],
    })
    expect(parsed.actions[0]?.rationale).toBeUndefined()
  })
})

describe('Dream run view', () => {
  const run = {
    runId: 'dream-1',
    scopeKey: 'scope-a',
    state: 'committed',
    risk: 'metadata-only',
    proposalHash: 'abc',
    beforeRevision: 'gov1:0000000000000000',
    afterRevision: 'gov1:1111111111111111',
    changes: [{ action: 'cool', target: 'alpha' }],
    createdAt: 1793860469791,
  }

  it('parses a committed run', () => {
    const parsed = parseDreamRunResponse(run)
    expect(parsed.state).toBe('committed')
    expect(parsed.changes).toHaveLength(1)
  })

  it('carries the error text for a failed run', () => {
    const parsed = parseDreamRunResponse({ ...run, state: 'provider-failed', error: 'socket hang up' })
    expect(parsed.error).toBe('socket hang up')
  })

  it('rejects a run whose revisions are missing', () => {
    const { beforeRevision: _drop, ...withoutRevision } = run
    expect(() => parseDreamRunResponse(withoutRevision)).toThrow(DreamProtocolError)
  })

  it('rejects an unknown receipt state', () => {
    expect(() => parseDreamRunResponse({ ...run, state: 'rolled-back' })).toThrow(DreamProtocolError)
  })
})

describe('Dream protocol safety', () => {
  it('never exposes a memory body through the plan view', () => {
    // The browser shows handles and a rationale; prose stays on disk.
    const parsed = parseDreamPlanResponse({
      runId: 'd', scopeKey: 's', state: 'planned', risk: 'content-change',
      proposalHash: 'h', createdAt: 1,
      actions: [{ action: 'cool', target: 'alpha', rationale: 'stale' }],
    })
    expect(JSON.stringify(parsed)).not.toContain('summary')
  })

  it('rejects a non-object payload', () => {
    expect(() => parseDreamPlanResponse('nope')).toThrow(DreamProtocolError)
    expect(() => parseDreamRunResponse(null)).toThrow(DreamProtocolError)
  })
})

describe('Dream panel payload', () => {
  const plan = {
    runId: 'd1', scopeKey: 's', state: 'planned', risk: 'metadata-only',
    proposalHash: 'h', actions: [], createdAt: 1,
  }

  it('accepts the mode the status endpoint reports', async () => {
    // dream/status returns the active mode alongside the lists; without it the
    // panel cannot tell shadow from manual.
    const { parseDreamPanelResponse } = await import('../src/protocol.ts')
    const parsed = parseDreamPanelResponse({ mode: 'shadow', pending: [plan], runs: [] })
    expect(parsed.mode).toBe('shadow')
    expect(parsed.pending).toHaveLength(1)
  })

  it('rejects an unknown mode rather than defaulting silently', async () => {
    const { parseDreamPanelResponse } = await import('../src/protocol.ts')
    expect(() => parseDreamPanelResponse({ mode: 'auto', pending: [], runs: [] }))
      .toThrow(/mode/u)
  })

  it('requires the mode to be present', async () => {
    const { parseDreamPanelResponse } = await import('../src/protocol.ts')
    expect(() => parseDreamPanelResponse({ pending: [], runs: [] })).toThrow(/mode/u)
  })
})
describe('Failed receipts stay renderable', () => {
  const base = {
    runId: 'dream-1', scopeKey: 'scope-a', risk: 'metadata-only',
    beforeRevision: 'gov1:0', afterRevision: 'gov1:0', changes: [], createdAt: 1,
  }

  it('accepts an empty hash on a rejected run', () => {
    // The panel loads history on open. Rejecting this made the whole panel show a
    // protocol error, hiding the one thing the user needed: why the run failed.
    const parsed = parseDreamRunResponse({
      ...base, state: 'rejected', proposalHash: '', error: 'restrict failed',
    })
    expect(parsed.state).toBe('rejected')
    expect(parsed.proposalHash).toBe('')
    expect(parsed.error).toBe('restrict failed')
  })

  it('still requires a hash on a committed run', () => {
    // A committed run without a hash cannot be verified against its own receipt.
    expect(() => parseDreamRunResponse({
      ...base, state: 'committed', proposalHash: '',
    })).toThrow(/proposalHash/u)
  })

  it('rejects a non-string hash in either case', () => {
    expect(() => parseDreamRunResponse({
      ...base, state: 'rejected', proposalHash: 42,
    })).toThrow(/proposalHash/u)
  })
})
describe('Panel-only plan fields', () => {
  const plan = {
    runId: 'r1', scopeKey: 's1', state: 'planned', risk: 'metadata-only',
    proposalHash: 'h', actions: [], createdAt: 1,
  }

  it('accepts declined on a staged plan', () => {
    // dream/status adds this so a dismissed action comes back marked. The plan
    // file on disk does not carry it, which is why it must be optional.
    const parsed = parseDreamPlanResponse({ ...plan, declined: ['fp-1', 'fp-2'] })
    expect(parsed.declined).toEqual(['fp-1', 'fp-2'])
  })

  it('accepts a plan without declined', () => {
    expect(parseDreamPlanResponse(plan).declined).toBeUndefined()
  })

  it('rejects a malformed declined list', () => {
    expect(() => parseDreamPlanResponse({ ...plan, declined: 'fp-1' })).toThrow(/declined/u)
    expect(() => parseDreamPlanResponse({ ...plan, declined: [1] })).toThrow(/declined/u)
  })

  it('still rejects a field nobody declared', () => {
    // Being permissive about known optional keys must not open the record up.
    expect(() => parseDreamPlanResponse({ ...plan, surprise: true }))
      .toThrow(/unknown field: surprise/u)
  })

  it('round-trips through the panel parser', () => {
    const panel = parseDreamPanelResponse({
      mode: 'shadow',
      pending: [{ ...plan, declined: ['fp-1'] }],
      runs: [],
    })
    expect(panel.pending[0]?.declined).toEqual(['fp-1'])
  })
})