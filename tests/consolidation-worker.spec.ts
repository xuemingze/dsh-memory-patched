import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONSOLIDATION_PROPOSAL_TOOL,
  ConsolidationEvidenceTooLargeError,
  ConsolidationWorkerError,
  ConsolidationProviderError,
  SessionConsolidationWorker,
  renderConsolidationWorkerInput,
  resolveConsolidationWorkerConfig,
  type ConsolidationWorkerAgents,
  type ConsolidationPreStepListener,
  type ConsolidationAgentErrorListener,
  type ConsolidationWorkerScope,
} from '../src/consolidation-worker.ts'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { SessionConsolidator, type SessionConsolidationInput } from '../src/session-consolidator.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Tool = {
  name: string
  parameters: Record<string, unknown>
  execute(args: unknown, exec: { concludeTurn(): void }): unknown
}

type Behavior =
  | { kind: 'valid'; proposal: unknown }
  | { kind: 'invalid'; proposal: unknown }
  | { kind: 'multiple'; proposals: [unknown, unknown] }
  | { kind: 'missing' }
  | { kind: 'provider-failed'; error: Error }

class FakeWorkerHost {
  readonly sections: unknown[] = []
  readonly restrictions: unknown[] = []
  readonly messages: unknown[] = []
  readonly events: unknown[] = []
  readonly createOptions: unknown[] = []
  readonly flushes: unknown[] = []
  tools: Tool[] = []
  modelRequests = 0
  suppressedRuntimeContext = 0
  disposed = 0
  cancelled = 0
  private preStep: ConsolidationPreStepListener | undefined
  private agentError: ConsolidationAgentErrorListener | undefined
  private pending = Promise.resolve()

  constructor(readonly behavior: Behavior) {}

  readonly agents: ConsolidationWorkerAgents = {
    create: async (options) => {
      this.createOptions.push(options)
      const scope: ConsolidationWorkerScope = {
        systemPrompt: {
          section: (value) => { this.sections.push(value); return () => undefined },
          suppressRuntimeContext: () => { this.suppressedRuntimeContext += 1; return () => undefined },
        },
        tools: {
          restrict: (value) => { this.restrictions.push(value); return () => undefined },
          register: (value) => { this.tools.push(value as Tool); return () => undefined },
        },
        on: ((_event: 'agent/pre-step' | 'agent/error', listener: unknown) => {
          if (_event === 'agent/pre-step') this.preStep = listener as ConsolidationPreStepListener
          else this.agentError = listener as ConsolidationAgentErrorListener
          return () => undefined
        }) as ConsolidationWorkerScope['on'],
      }
      options.setup(scope)
      const session = { id: options.sessionId, events: this.events }
      return {
        agent: {
          session,
          inject: (message) => { this.messages.push(message) },
          followup: (message) => {
            this.messages.push(message)
            this.pending = this.simulateRequest()
          },
          whenIdle: () => this.pending,
          cancel: () => { this.cancelled += 1 },
        },
        dispose: async () => { this.disposed += 1 },
      }
    },
  }

  readonly sessions = {
    flush: async (session: unknown) => { this.flushes.push(session); return true },
  }

  /** Resolve like `whenIdle` would, then reject: deterministic ordering for one failure test. */
  async whenIdleThenReject(cause: Error): Promise<never> {
    await this.pending
    throw cause
  }

  private async simulateRequest(): Promise<void> {
    const first = await this.preStep?.({ step: 1 }, async () => ({ kind: 'enter', messages: [] }))
    if (first?.kind === 'reject') return
    this.modelRequests += 1
    if (this.behavior.kind === 'provider-failed') {
      this.agentError?.({ error: this.behavior.error })
      return
    }
    const section = this.sections[0] as { text: string }
    this.events.push({
      type: 'request/header',
      data: { header: { system: section.text, tools: this.tools.map(tool => ({ name: tool.name })) } },
    })
    for (const message of this.messages) this.events.push({ type: 'user/message', data: message })
    const tool = this.tools.find(candidate => candidate.name === CONSOLIDATION_PROPOSAL_TOOL)
    if (tool === undefined) throw new Error('proposal tool missing')
    let concluded = false
    const call = (proposal: unknown, final: boolean): void => {
      const args = { final, ...(proposal as Record<string, unknown>) }
      this.events.push({ type: 'tool/call', data: { name: tool.name, arguments: JSON.stringify(args) } })
      const result = tool.execute(args, { concludeTurn() { concluded = true } })
      this.events.push({ type: 'tool/result', data: result })
    }
    if (this.behavior.kind === 'valid' || this.behavior.kind === 'invalid') call(this.behavior.proposal, true)
    if (this.behavior.kind === 'multiple') {
      call(this.behavior.proposals[0], false)
      const second = await this.preStep?.({ step: 2 }, async () => ({ kind: 'enter', messages: [] }))
      if (second?.kind !== 'reject') {
        this.modelRequests += 1
        call(this.behavior.proposals[1], true)
      }
    }
    if (!concluded) {
      const second = await this.preStep?.({ step: 2 }, async () => ({ kind: 'enter', messages: [] }))
      if (second?.kind !== 'reject') this.modelRequests += 1
    }
  }
}

async function inputAndConsolidator(): Promise<{
  input: SessionConsolidationInput
  consolidator: SessionConsolidator
}> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-worker-'))
  roots.push(root)
  const store = new MarkdownMemoryStore(new Context(), join(root, 'memory'))
  store.initialize()
  const scope = store.scopeForCwd('/work/worker')
  const workspace = await store.readWorkspace(scope)
  const global = await store.readGlobal()
  const input: SessionConsolidationInput = {
    reviewId: `review-${'a'.repeat(64)}`,
    consolidatorVersion: 'm3-multistep-global-v5',
    source: {
      sessionId: 'source-session',
      revision: 'source:a',
      createdAt: 42,
      events: [{ seq: 0, type: 'user/message', data: { content: 'Remember the verification rule.' } }],
      evidence: [{
        fromSeq: 0,
        toSeq: 0,
        user: ['Remember the verification rule.'],
        summaries: [],
        assistantFinal: null,
        tools: [],
      }],
    },
    global,
    workspace: { scope, ...workspace },
  }
  const consolidator = new SessionConsolidator(store, {
    async listSnapshots() { return [] },
    async inspect() { throw new Error('not used') },
  }, { get() { return undefined } })
  return { input, consolidator }
}

const validProposal = {
  outcome: 'changes',
  changes: [{
    action: 'put',
    record: {
      name: 'verification-rule',
      description: 'Use focused verification.',
      type: 'feedback',
      content: 'Run the smallest relevant automated checks.',
    },
    evidence: [{ fromSeq: 0, toSeq: 0 }],
  }],
}

describe('SessionConsolidationWorker', () => {
  it('runs one model request with an isolated prompt/tool surface and preserves replay input', async () => {
    const { input, consolidator } = await inputAndConsolidator()
    const host = new FakeWorkerHost({ kind: 'valid', proposal: validProposal })
    const attached: string[] = []
    const result = await new SessionConsolidationWorker(
      consolidator,
      host.agents,
      host.sessions,
      {},
      undefined,
      {
        async prepare() {
          return {
            cwd: '/work/memory-consolidation',
            attachSession: async sessionId => { attached.push(sessionId) },
          }
        },
      },
      async (selection, ceiling) => {
        expect(selection).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
        expect(ceiling).toBe(8192)
        return 2048
      },
    ).run(input, 1)

    expect(result).toMatchObject({
      workerSessionId: `session-memory-review-${'a'.repeat(64)}-attempt-1`,
      plan: { proposal: { outcome: 'changes', changes: [{ action: 'put' }] }, preview: { changed: true } },
    })
    expect(host.modelRequests).toBe(1)
    expect(host.createOptions).toMatchObject([{
      meta: { cwd: '/work/memory-consolidation' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 2048 },
    }])
    expect(host.suppressedRuntimeContext).toBe(1)
    expect(host.sections).toMatchObject([{ name: 'dsh-memory:consolidator', complete: true }])
    expect(host.sections).toMatchObject([{ text: expect.stringContaining('Call memory_review_propose as needed') }])
    expect(host.restrictions).toEqual([{ allow: [] }])
    expect(host.tools.map(tool => tool.name)).toEqual([CONSOLIDATION_PROPOSAL_TOOL])
    expect(host.tools[0]?.parameters).toMatchObject({
      outcome: { type: 'string', required: true },
      changes: {
        type: 'array',
        required: true,
        items: {
          oneOf: [
            { type: 'object', properties: { action: { const: 'replace-global' }, content: { type: 'string' } } },
            { type: 'object', properties: { action: { const: 'put' }, record: { type: 'object' } } },
            { type: 'object', properties: { action: { const: 'delete' }, name: { type: 'string' } } },
          ],
        },
      },
    })
    expect(host.tools[0]?.parameters).not.toHaveProperty('type')
    expect(host.flushes).toHaveLength(1)
    expect(attached).toEqual([`session-memory-review-${'a'.repeat(64)}-attempt-1`])
    expect(host.disposed).toBe(1)

    const replay = JSON.stringify(host.events)
    expect(replay).toContain('consolidate durable memory')
    expect(replay).toContain('source-session')
    expect(replay).toContain('Remember the verification rule.')
    expect(replay).toContain(CONSOLIDATION_PROPOSAL_TOOL)
    expect(replay).toContain('verification-rule')
  })

  it('allows multiple proposal rounds and requires one accepted final proposal', async () => {
    const { input, consolidator } = await inputAndConsolidator()
    const invalidHost = new FakeWorkerHost({
      kind: 'invalid',
      proposal: { outcome: 'changes', changes: [] },
    })
    await expect(new SessionConsolidationWorker(
      consolidator,
      invalidHost.agents,
      invalidHost.sessions,
    ).run(input, 1)).rejects.toMatchObject({ code: 'missing-proposal' })
    expect(invalidHost.modelRequests).toBe(2)
    expect(invalidHost.flushes).toHaveLength(1)
    expect(invalidHost.disposed).toBe(1)

    const multipleHost = new FakeWorkerHost({
      kind: 'multiple',
      proposals: [validProposal, validProposal],
    })
    await expect(new SessionConsolidationWorker(
      consolidator,
      multipleHost.agents,
      multipleHost.sessions,
    ).run(input, 2)).resolves.toMatchObject({ plan: { proposal: { outcome: 'changes' } } })
    expect(multipleHost.modelRequests).toBe(2)
    expect(multipleHost.disposed).toBe(1)
  })

  it('fails a prose-only response after the first step and still flushes the worker Session', async () => {
    const { input, consolidator } = await inputAndConsolidator()
    const host = new FakeWorkerHost({ kind: 'missing' })
    await expect(new SessionConsolidationWorker(consolidator, host.agents, host.sessions).run(input, 1))
      .rejects.toEqual(expect.objectContaining<Partial<ConsolidationWorkerError>>({ code: 'missing-proposal' }))
    expect(host.modelRequests).toBe(2)
    expect(host.flushes).toHaveLength(1)
    expect(host.disposed).toBe(1)
  })

  it('fails when no persistence listener accepts the worker audit Session', async () => {
    const { input, consolidator } = await inputAndConsolidator()
    const host = new FakeWorkerHost({ kind: 'valid', proposal: validProposal })
    const sessions = { flush: async () => false }
    await expect(new SessionConsolidationWorker(consolidator, host.agents, sessions).run(input, 1))
      .rejects.toMatchObject({ name: 'ConsolidationWorkerRuntimeError', code: 'flush' })
    expect(host.disposed).toBe(1)
  })

  it('fails safely when the dedicated Workspace cannot be prepared or attached', async () => {
    const { input, consolidator } = await inputAndConsolidator()
    const host = new FakeWorkerHost({ kind: 'valid', proposal: validProposal })
    await expect(new SessionConsolidationWorker(
      consolidator,
      host.agents,
      host.sessions,
      {},
      undefined,
      { async prepare() { throw new Error('workspace unavailable') } },
    ).run(input, 1)).rejects.toMatchObject({ code: 'workspace' })
    expect(host.createOptions).toHaveLength(0)

    const attachHost = new FakeWorkerHost({ kind: 'valid', proposal: validProposal })
    await expect(new SessionConsolidationWorker(
      consolidator,
      attachHost.agents,
      attachHost.sessions,
      {},
      undefined,
      {
        async prepare() {
          return {
            cwd: '/work/memory-consolidation',
            attachSession: async () => { throw new Error('attach failed') },
          }
        },
      },
    ).run(input, 1)).rejects.toMatchObject({ code: 'workspace-attach' })
    expect(attachHost.flushes).toHaveLength(1)
    expect(attachHost.disposed).toBe(1)
  })

  it('preserves a contained agent error as a Provider failure', async () => {
    const { input, consolidator } = await inputAndConsolidator()
    const host = new FakeWorkerHost({ kind: 'provider-failed', error: new Error('upstream unavailable') })
    await expect(new SessionConsolidationWorker(consolidator, host.agents, host.sessions).run(input, 1))
      .rejects.toMatchObject({ name: 'ConsolidationProviderError' })
    expect(host.flushes).toHaveLength(1)
    expect(host.disposed).toBe(1)
  })

  it('rejects an oversized filtered input before creating an Agent', async () => {
    const { input, consolidator } = await inputAndConsolidator()
    const host = new FakeWorkerHost({ kind: 'missing' })
    await expect(new SessionConsolidationWorker(
      consolidator,
      host.agents,
      host.sessions,
      { maxInputBytes: 1 },
    ).run(input, 1)).rejects.toBeInstanceOf(ConsolidationEvidenceTooLargeError)
    expect(host.createOptions).toHaveLength(0)
    expect(host.modelRequests).toBe(0)
  })

  it('aborts through the race when the host never settles and still runs cleanup', async () => {
    const { input, consolidator } = await inputAndConsolidator()
    const host = new FakeWorkerHost({ kind: 'valid', proposal: validProposal })
    const hangingAgents: ConsolidationWorkerAgents = {
      create: async options => {
        const handle = await host.agents.create(options)
        return {
          agent: { ...handle.agent, whenIdle: () => new Promise<void>(() => undefined) },
          dispose: handle.dispose,
        }
      },
    }
    await expect(new SessionConsolidationWorker(
      consolidator,
      hangingAgents,
      host.sessions,
      { timeoutMs: 50 },
    ).run(input, 1)).rejects.toMatchObject({ name: 'AbortError' })
    expect(host.cancelled).toBe(1)
    expect(host.flushes).toHaveLength(1)
    expect(host.disposed).toBe(1)
  })

  it('normalizes a rejected whenIdle with an observed agent failure into a provider failure', async () => {
    const { input, consolidator } = await inputAndConsolidator()
    const host = new FakeWorkerHost({ kind: 'provider-failed', error: new Error('provider exploded') })
    const rejectingAgents: ConsolidationWorkerAgents = {
      create: async options => {
        const handle = await host.agents.create(options)
        return {
          agent: {
            ...handle.agent,
            whenIdle: () => host.whenIdleThenReject(new Error('idle blew up')),
          },
          dispose: handle.dispose,
        }
      },
    }
    await expect(new SessionConsolidationWorker(
      consolidator,
      rejectingAgents,
      host.sessions,
    ).run(input, 1)).rejects.toBeInstanceOf(ConsolidationProviderError)
    expect(host.disposed).toBe(1)
  })

  it('renders only review identity, evidence, Global content, and Workspace records as dynamic input', async () => {
    const { input } = await inputAndConsolidator()
    const rendered = renderConsolidationWorkerInput(input)
    expect(rendered).toContain(input.reviewId)
    expect(rendered).toContain(input.source.sessionId)
    expect(rendered).toContain('sourceEvidence')
    expect(rendered).toContain('globalMemory')
    expect(rendered).toContain('workspaceRecords')
    expect(rendered).not.toContain(input.workspace.scope.key)
    expect(rendered).not.toContain(input.workspace.scope.directory)
    expect(rendered).not.toContain(input.workspace.revision)
  })

  it('validates explicit worker model and execution limits', () => {
    expect(resolveConsolidationWorkerConfig({})).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      maxTokens: 8192,
      timeoutMs: 120000,
      maxInputBytes: 131072,
    })
    expect(() => resolveConsolidationWorkerConfig({ provider: ' ' })).toThrow(/provider/)
    expect(() => resolveConsolidationWorkerConfig({ maxTokens: 0 })).toThrow(/maxTokens/)
    expect(() => resolveConsolidationWorkerConfig({ timeoutMs: 1.5 })).toThrow(/timeoutMs/)
    expect(() => resolveConsolidationWorkerConfig({ maxInputBytes: 0 })).toThrow(/maxInputBytes/)
  })
})
