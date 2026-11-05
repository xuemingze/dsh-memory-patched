import { describe, expect, it } from 'vitest'
import {
  DREAM_PROPOSAL_TOOL,
  DreamAgentWorkerError,
  dreamProposalTool,
  renderDreamPrompt,
  runDreamWithAgent,
  selectGlobalSections,
} from '../src/memory-dream-agent.ts'
import type { DreamProposalContext } from '../src/memory-dream-proposal.ts'

const NOW = 1_793_860_469_791

function context(overrides: Partial<DreamProposalContext> = {}): DreamProposalContext {
  return {
    scopeKey: 'scope-a',
    claims: [{
      name: 'alpha', scopeKey: 'scope-a', kind: 'procedure', volatility: 'stable',
      lifecycle: 'active', importanceClass: 'working', importanceScore: 60,
      text: 'summary', environmentFingerprint: '', evidenceCount: 1,
      lastEvidenceAt: NOW, lastVerifiedAt: null, lastUsedAt: null,
      supersedes: [], sourcePlugins: [],
    }],
    globalSections: ['User Profile', 'General Tips'],
    now: NOW,
    ...overrides,
  }
}

describe('Dream proposal tool', () => {
  it('has its own name, distinct from the consolidation tool', () => {
    // Sharing a name would let a Dream run be mistaken for a Session review in
    // the receipts and in the debug log.
    expect(DREAM_PROPOSAL_TOOL).toBe('memory_dream_propose')
    expect(DREAM_PROPOSAL_TOOL).not.toBe('memory_review_propose')
  })
})

describe('Dream prompt rendering', () => {
  it('names the tool it must call', () => {
    expect(renderDreamPrompt(context())).toContain(DREAM_PROPOSAL_TOOL)
  })

  it('carries the safety rules that the parser enforces', () => {
    const prompt = renderDreamPrompt(context())
    expect(prompt).toMatch(/never invent/i)
    expect(prompt).toMatch(/never delete|no deletion/i)
    // The consolidation worker burned its budget on timestamp arithmetic
    // (2026-11-04); Dream carries the same prohibition.
    expect(prompt).toMatch(/do not (compute|calculate|do arithmetic)/i)
  })

  it('lists the real record names so the model can only cite them', () => {
    const prompt = renderDreamPrompt(context({
      claims: [
        { ...context().claims[0]!, name: 'alpha' },
        { ...context().claims[0]!, name: 'beta' },
      ],
    }))
    expect(prompt).toContain('alpha')
    expect(prompt).toContain('beta')
  })

  it('lists the real global sections so promotion cannot invent one', () => {
    const prompt = renderDreamPrompt(context())
    expect(prompt).toContain('User Profile')
    expect(prompt).toContain('General Tips')
  })

  it('marks the payload as untrusted', () => {
    expect(renderDreamPrompt(context())).toContain('untrusted')
  })
})

describe('Global section selection', () => {
  it('returns the level-2 headings of the document', () => {
    const global = ['# Global', '', '## User Profile', '', 'text', '## General Tips', ''].join('\n')
    expect(selectGlobalSections(global)).toEqual(['User Profile', 'General Tips'])
  })

  it('ignores deeper headings', () => {
    const global = ['## Section', '', '### Detail', ''].join('\n')
    expect(selectGlobalSections(global)).toEqual(['Section'])
  })

  it('returns an empty list rather than throwing on a headingless document', () => {
    // Promotion then fails with a clear "section does not exist" instead of the
    // worker crashing before it can report anything.
    expect(selectGlobalSections('just text')).toEqual([])
  })
})

describe('Dream agent errors', () => {
  it('distinguishes provider failure from a missing proposal', () => {
    expect(new DreamAgentWorkerError('provider-failed', 'x').code).toBe('provider-failed')
    expect(new DreamAgentWorkerError('missing-proposal', 'x').code).toBe('missing-proposal')
  })

  it('carries a message through', () => {
    expect(new DreamAgentWorkerError('provider-failed', 'socket hang up').message)
      .toBe('socket hang up')
  })
})

describe('Dream proposal tool definition', () => {
  it('accepts the actions array the parser expects', () => {
    const tool = dreamProposalTool()
    expect(tool.name).toBe(DREAM_PROPOSAL_TOOL)
    expect(tool.parameters).toMatchObject({ required: ['actions'] })
  })
})

describe('Driving a Dream run through an agent', () => {
  /** A fake agent that runs a scripted list of submissions. */
  function makeAgents(script: unknown[], options: { throwOnIdle?: Error } = {}) {
    const seen: { allowed?: readonly string[]; registered: string[]; disposed: number; injected: unknown[] } = {
      registered: [], disposed: 0, injected: [],
    }
    let handler: ((value: unknown) => Promise<{ accepted: boolean; message: string }>) | undefined
    const agents = {
      create: async (createOptions: {
        setup: (scope: {
          systemPrompt: { section: () => () => void; suppressRuntimeContext: () => () => void }
          tools: {
            restrict: (i: { allow: readonly string[] }) => () => void
            register: (d: unknown) => () => void
          }
          on: () => () => void
        }) => void
      }) => {
        const scope = {
          systemPrompt: { section: () => () => {}, suppressRuntimeContext: () => () => {} },
          tools: {
            restrict: (input: { allow: readonly string[] }) => {
              seen.allowed = [...input.allow]
              return () => {}
            },
            register: (definition: unknown) => {
              const tool = definition as { name: string; handler: typeof handler }
              seen.registered.push(tool.name)
              handler = tool.handler
              return () => {}
            },
          },
          on: () => () => {},
        }
        createOptions.setup(scope)
        return {
          agent: {
            session: { id: 'dream-worker-1', events: [] },
            inject: (message: unknown) => { seen.injected.push(message) },
            followup: () => {},
            whenIdle: async () => {
              if (options.throwOnIdle !== undefined) throw options.throwOnIdle
              for (const submission of script) await handler?.(submission)
            },
            cancel: () => {},
          },
          dispose: async () => { seen.disposed += 1 },
        }
      },
    }
    return { agents: agents as never, seen }
  }

  const base = {
    context: context(),
    sessionId: 'dream-1',
    cwd: '/tmp',
    config: { provider: 'p', model: 'm', maxTokens: 1000 },
  }

  it('restricts the worker to the one proposal tool', async () => {
    const { agents, seen } = makeAgents([{ actions: [] }])
    await runDreamWithAgent({ ...base, agents, validate: () => ({ accepted: true, message: 'ok' }) })
    expect(seen.allowed).toEqual([DREAM_PROPOSAL_TOOL])
    expect(seen.registered).toEqual([DREAM_PROPOSAL_TOOL])
  })

  it('sends messages with a producer-owned source kind', async () => {
    // The host's v4 session admission rejects a bare { role, content } object,
    // and the failure surfaces only at persistence — the worker's session is
    // empty and the receipt says provider-failed. That exact bug cost this
    // machine a day on 2026-10-21.
    const { agents, seen } = makeAgents([{ actions: [] }])
    await runDreamWithAgent({ ...base, agents, validate: () => ({ accepted: true, message: 'ok' }) })
    const sent = seen.injected[0] as { source?: { kind?: string } }
    expect(sent.source?.kind).toBe('plugin:dsh-memory')
    expect(sent.source?.kind).not.toBe('plugin')
  })

  it('injects the rendered prompt as the first message', async () => {
    const { agents, seen } = makeAgents([{ actions: [] }])
    await runDreamWithAgent({ ...base, agents, validate: () => ({ accepted: true, message: 'ok' }) })
    expect(JSON.stringify(seen.injected[0])).toContain(DREAM_PROPOSAL_TOOL)
  })

  it('returns the accepted submission', async () => {
    const { agents } = makeAgents([{ actions: [{ action: 'cool', target: 'alpha' }] }])
    const result = await runDreamWithAgent({ ...base, agents, validate: () => ({ accepted: true, message: 'ok' }) })
    expect(result.submission).toMatchObject({ actions: [{ action: 'cool', target: 'alpha' }] })
    expect(result.attempts).toBe(1)
  })

  it('keeps the last accepted submission when a later one is rejected', async () => {
    // The worker may submit twice; the accepted one must win, not the last.
    const { agents } = makeAgents([
      { actions: [{ action: 'cool', target: 'alpha' }] },
      { actions: [{ action: 'cool', target: 'ghost' }] },
    ])
    let call = 0
    const result = await runDreamWithAgent({
      ...base, agents,
      validate: () => {
        call += 1
        return call === 1 ? { accepted: true, message: 'ok' } : { accepted: false, message: 'unknown record' }
      },
    })
    expect(result.submission).toMatchObject({ actions: [{ action: 'cool', target: 'alpha' }] })
  })

  it('reports a missing proposal when the tool is never called', async () => {
    const { agents } = makeAgents([])
    await expect(runDreamWithAgent({ ...base, agents, validate: () => ({ accepted: true, message: 'ok' }) }))
      .rejects.toMatchObject({ code: 'missing-proposal' })
  })

  it('reports a missing proposal when every attempt is rejected', async () => {
    const { agents } = makeAgents([{ actions: [] }, { actions: [] }])
    await expect(runDreamWithAgent({
      ...base, agents,
      validate: () => ({ accepted: false, message: 'nope' }),
    })).rejects.toMatchObject({ code: 'missing-proposal' })
  })

  it('always disposes the agent, even when the run fails', async () => {
    const { agents, seen } = makeAgents([], { throwOnIdle: new Error('boom') })
    await expect(runDreamWithAgent({ ...base, agents, validate: () => ({ accepted: true, message: 'ok' }) }))
      .rejects.toBeTruthy()
    expect(seen.disposed).toBe(1)
  })
})