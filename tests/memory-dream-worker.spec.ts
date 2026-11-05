import { describe, expect, it } from 'vitest'
import {
  DREAM_WORKER_RULES,
  DreamWorkerError,
  renderDreamWorkerInput,
  resolveDreamWorkerConfig,
} from '../src/memory-dream-worker.ts'
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

describe('Dream worker config', () => {
  it('defaults to a bounded budget with reasoning off', () => {
    const config = resolveDreamWorkerConfig({})
    expect(config.maxTokens).toBeGreaterThan(0)
    expect(config.timeoutMs).toBeGreaterThan(0)
    expect(config.maxInputBytes).toBeGreaterThan(0)
    // Reasoning tokens count against maxTokens and Dream input is wide, not deep.
    expect(config.reasoningEffort).toBe('off')
  })

  it('rejects an empty model', () => {
    expect(() => resolveDreamWorkerConfig({ model: '  ' })).toThrow(TypeError)
  })

  it('rejects a non-positive budget', () => {
    expect(() => resolveDreamWorkerConfig({ maxTokens: 0 })).toThrow(TypeError)
    expect(() => resolveDreamWorkerConfig({ timeoutMs: -1 })).toThrow(TypeError)
  })
})

describe('Dream worker prompt', () => {
  it('tells the model it may not invent or delete', () => {
    // These two sentences are the whole safety argument for Dream, so they are
    // asserted rather than left to drift.
    expect(DREAM_WORKER_RULES).toMatch(/never invent/i)
    expect(DREAM_WORKER_RULES).toMatch(/never delete|no deletion/i)
  })

  it('forbids arithmetic in the prompt', () => {
    // The consolidation worker burned its whole budget on timestamp arithmetic
    // (2026-11-04). Dream carries the same rule.
    expect(DREAM_WORKER_RULES).toMatch(/do not (compute|calculate|do arithmetic)/i)
  })

  it('lists every permitted action', () => {
    for (const action of ['merge', 'supersede', 'mark-contested', 'set-priority', 'cool', 'archive', 'promote-global', 'extract-sop']) {
      expect(DREAM_WORKER_RULES).toContain(action)
    }
  })
})

describe('Dream worker input rendering', () => {
  const input = {
    scopeKey: 'scope-a',
    claims: [claim(), claim({ name: 'beta' })],
    globalSections: ['User Profile'],
    now: NOW,
  }

  it('marks the payload as untrusted evidence', () => {
    const rendered = renderDreamWorkerInput(input)
    expect(rendered).toContain('untrusted')
  })

  it('carries the record set so the model can only cite real names', () => {
    const rendered = renderDreamWorkerInput(input)
    expect(rendered).toContain('alpha')
    expect(rendered).toContain('beta')
  })

  it('is deterministic for the same input', () => {
    expect(renderDreamWorkerInput(input)).toBe(renderDreamWorkerInput(input))
  })

  it('omits the record body to keep the request small', () => {
    // Only the summary is sent: Dream reasons about what a memory is, and the
    // full body would double the request for no decision value.
    const rendered = renderDreamWorkerInput({
      ...input,
      claims: [claim({ text: 'short summary', ...{} })],
    })
    expect(rendered).toContain('short summary')
    expect(rendered.length).toBeLessThan(20_000)
  })

  it('refuses to render when the input exceeds the byte ceiling', () => {
    const huge = {
      ...input,
      claims: Array.from({ length: 2_000 }, (_, index) =>
        claim({ name: `record-${index}`, text: 'x'.repeat(400) })),
    }
    expect(() => renderDreamWorkerInput(huge, 1_000)).toThrow(DreamWorkerError)
  })
})

describe('Dream worker failures', () => {
  it('names a stable error code so the runner can classify it', () => {
    const error = new DreamWorkerError('missing-proposal', 'no proposal')
    expect(error.code).toBe('missing-proposal')
    expect(error.name).toBe('DreamWorkerError')
    expect(error).toBeInstanceOf(Error)
  })

  it('distinguishes truncation from a missing proposal', () => {
    // Truncation is retryable with a smaller input; a missing proposal is not.
    const truncated = new DreamWorkerError('output-truncated', 'cut off')
    const missing = new DreamWorkerError('missing-proposal', 'absent')
    expect(truncated.code).not.toBe(missing.code)
  })
})

describe('Dream worker validation entry point', () => {
  it('validates a proposal against the records it was shown', async () => {
    const { validateDreamSubmission } = await import('../src/memory-dream-worker.ts')
    const context = {
      scopeKey: 'scope-a',
      claims: [claim(), claim({ name: 'beta' })],
      globalSections: ['User Profile'],
      now: NOW,
    }
    const accepted = validateDreamSubmission(context, {
      actions: [{ action: 'cool', target: 'alpha' }],
    })
    expect(accepted.accepted).toBe(true)

    const rejected = validateDreamSubmission(context, {
      actions: [{ action: 'cool', target: 'ghost' }],
    })
    expect(rejected.accepted).toBe(false)
    expect(rejected.message).toMatch(/unknown record/u)
  })

  it('rejects without throwing so the worker can report and retry', async () => {
    const { validateDreamSubmission } = await import('../src/memory-dream-worker.ts')
    const context = {
      scopeKey: 'scope-a',
      claims: [claim()],
      globalSections: [],
      now: NOW,
    }
    const result = validateDreamSubmission(context, 'not an object')
    expect(result.accepted).toBe(false)
    expect(result.message).toContain('object')
  })
})

describe('Dream worker run loop', () => {
  type Run = typeof import('../src/memory-dream-worker.ts')['runDreamWorker']

  const context = {
    scopeKey: 'scope-a',
    claims: [claim(), claim({ name: 'beta' })],
    globalSections: ['User Profile'],
    now: NOW,
  }

  it('returns the accepted plan from a single submission', async () => {
    const { runDreamWorker } = await import('../src/memory-dream-worker.ts')
    const result = await runDreamWorker(context, {
      config: {},
      callModel: async () => ({ actions: [{ action: 'cool', target: 'alpha' }] }),
    })
    expect(result.plan.actions).toHaveLength(1)
    expect(result.attempts).toBe(1)
  })

  it('feeds a rejection back and lets the model correct itself', async () => {
    const { runDreamWorker } = await import('../src/memory-dream-worker.ts')
    const seen: string[] = []
    const result = await runDreamWorker(context, {
      config: {},
      callModel: async (request) => {
        seen.push(request.feedback ?? '')
        // First attempt cites a record that does not exist; second one is valid.
        return seen.length === 1
          ? { actions: [{ action: 'cool', target: 'ghost' }] }
          : { actions: [{ action: 'cool', target: 'beta' }] }
      },
    })
    expect(result.attempts).toBe(2)
    expect(seen[1]).toMatch(/unknown record/u)
    expect(result.plan.actions[0]).toMatchObject({ action: 'cool', target: 'beta' })
  })

  it('gives up after the attempt ceiling instead of looping', async () => {
    const { runDreamWorker } = await import('../src/memory-dream-worker.ts')
    await expect(runDreamWorker(context, {
      config: {},
      maxAttempts: 2,
      callModel: async () => ({ actions: [{ action: 'cool', target: 'ghost' }] }),
    })).rejects.toThrow(/unknown record|attempts/u)
  })

  it('reports a missing proposal distinctly from a rejected one', async () => {
    const { runDreamWorker } = await import('../src/memory-dream-worker.ts')
    await expect(runDreamWorker(context, {
      config: {},
      callModel: async () => undefined,
    })).rejects.toMatchObject({ code: 'missing-proposal' })
  })

  it('reports truncation so the caller can shrink the input', async () => {
    const { runDreamWorker } = await import('../src/memory-dream-worker.ts')
    await expect(runDreamWorker(context, {
      config: {},
      callModel: async () => ({ truncated: true }),
    })).rejects.toMatchObject({ code: 'output-truncated' })
  })

  it('wraps a provider throw so the runner has one error surface', async () => {
    const { runDreamWorker } = await import('../src/memory-dream-worker.ts')
    await expect(runDreamWorker(context, {
      config: {},
      callModel: async () => { throw new Error('socket hang up') },
    })).rejects.toMatchObject({ code: 'provider-failed' })
  })

  it('accepts an explicit empty plan as no change', async () => {
    // "Nothing to organise" must be expressible, or the model invents work.
    const { runDreamWorker } = await import('../src/memory-dream-worker.ts')
    const result = await runDreamWorker(context, {
      config: {},
      callModel: async () => ({ actions: [] }),
    })
    expect(result.plan.actions).toHaveLength(0)
    expect(result.noChange).toBe(true)
  })
})