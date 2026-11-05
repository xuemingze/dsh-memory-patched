import { describe, expect, it, vi } from 'vitest'
import {
  MemoryGovernanceRegistry,
  type MemoryVerificationProvider,
} from '../src/memory-governance-registry.ts'
import type { GovernanceClaim } from '../src/memory-governance-types.ts'

function claim(overrides: Partial<GovernanceClaim> = {}): GovernanceClaim {
  return {
    name: 'proxy-available',
    scopeKey: 'scope-a',
    kind: 'availability',
    volatility: 'intermittent',
    lifecycle: 'active',
    importanceClass: 'working',
    importanceScore: 40,
    text: 'the system proxy works for git over HTTPS',
    environmentFingerprint: 'desktop|win32',
    evidenceCount: 2,
    lastEvidenceAt: 1,
    lastVerifiedAt: null,
    lastUsedAt: null,
    supersedes: [],
    sourcePlugins: [],
    ...overrides,
  }
}

function provider(overrides: Partial<MemoryVerificationProvider> = {}): MemoryVerificationProvider {
  return {
    id: 'net-check',
    supports: () => true,
    verify: async () => ({
      providerId: 'net-check',
      observedAt: 100,
      environmentFingerprint: 'desktop|win32',
      result: 'supports',
      confidence: 'strong',
    }),
    ...overrides,
  }
}

describe('MemoryGovernanceRegistry', () => {
  it('works with zero providers', async () => {
    const registry = new MemoryGovernanceRegistry()
    const batch = await registry.verify([claim()], new AbortController().signal)
    // No verifier means "we could not check", never "the claim is false".
    expect(batch.observations).toEqual([])
    expect(batch.unavailable).toBe(1)
  })

  it('collects observations from a supporting provider', async () => {
    const registry = new MemoryGovernanceRegistry()
    registry.registerVerificationProvider(provider())
    const batch = await registry.verify([claim()], new AbortController().signal)
    expect(batch.observations).toHaveLength(1)
    expect(batch.observations[0]?.result).toBe('supports')
    expect(batch.unavailable).toBe(0)
  })

  it('skips providers that do not support the claim', async () => {
    const registry = new MemoryGovernanceRegistry()
    registry.registerVerificationProvider(provider({ supports: () => false }))
    const batch = await registry.verify([claim()], new AbortController().signal)
    expect(batch.observations).toEqual([])
  })

  it('rejects a duplicate provider id', () => {
    const registry = new MemoryGovernanceRegistry()
    registry.registerVerificationProvider(provider())
    expect(() => registry.registerVerificationProvider(provider())).toThrow(/already registered/u)
  })

  it('stops using a provider once it is unregistered', async () => {
    const registry = new MemoryGovernanceRegistry()
    const dispose = registry.registerVerificationProvider(provider())
    dispose()
    const batch = await registry.verify([claim()], new AbortController().signal)
    expect(batch.observations).toEqual([])
    expect(batch.unavailable).toBe(1)
  })

  it('isolates a throwing provider as unavailable', async () => {
    const registry = new MemoryGovernanceRegistry()
    registry.registerVerificationProvider(provider({
      verify: async () => { throw new Error('network down') },
    }))
    const batch = await registry.verify([claim()], new AbortController().signal)
    // A broken verifier must never take the memory system down with it.
    expect(batch.observations).toEqual([])
    expect(batch.unavailable).toBe(1)
    expect(batch.failures[0]).toMatchObject({ providerId: 'net-check' })
  })

  it('treats a timeout as unavailable rather than hanging', async () => {
    const registry = new MemoryGovernanceRegistry({ providerTimeoutMs: 20 })
    registry.registerVerificationProvider(provider({
      verify: () => new Promise(() => { /* never settles */ }),
    }))
    const batch = await registry.verify([claim()], new AbortController().signal)
    expect(batch.unavailable).toBe(1)
    expect(batch.failures[0]?.reason).toMatch(/timeout/u)
  })

  it('drops observations with an invalid shape', async () => {
    const registry = new MemoryGovernanceRegistry()
    registry.registerVerificationProvider(provider({
      verify: async () => ({ providerId: 'net-check' } as never),
    }))
    const batch = await registry.verify([claim()], new AbortController().signal)
    expect(batch.observations).toEqual([])
    expect(batch.unavailable).toBe(1)
  })

  it('overrides a provider-reported id with the registered one', async () => {
    const registry = new MemoryGovernanceRegistry()
    registry.registerVerificationProvider(provider({
      verify: async () => ({
        providerId: 'someone-else',
        observedAt: 1,
        environmentFingerprint: 'desktop|win32',
        result: 'supports',
        confidence: 'strong',
      }),
    }))
    const batch = await registry.verify([claim()], new AbortController().signal)
    // Identity comes from the registration, not from the payload: otherwise one
    // provider could impersonate another and fake independent corroboration.
    expect(batch.observations[0]?.providerId).toBe('net-check')
  })

  it('caps concurrency across many providers', async () => {
    const registry = new MemoryGovernanceRegistry({ maxConcurrency: 2 })
    let inFlight = 0
    let peak = 0
    for (let index = 0; index < 6; index += 1) {
      registry.registerVerificationProvider(provider({
        id: `p${index}`,
        verify: async () => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise(resolve => setTimeout(resolve, 5))
          inFlight -= 1
          return {
            providerId: `p${index}`,
            observedAt: 1,
            environmentFingerprint: 'desktop|win32',
            result: 'supports',
            confidence: 'strong',
          }
        },
      }))
    }
    await registry.verify([claim()], new AbortController().signal)
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('aborts verification when the signal is already aborted', async () => {
    const registry = new MemoryGovernanceRegistry()
    const verify = vi.fn()
    registry.registerVerificationProvider(provider({ verify }))
    const controller = new AbortController()
    controller.abort()
    const batch = await registry.verify([claim()], controller.signal)
    expect(verify).not.toHaveBeenCalled()
    expect(batch.observations).toEqual([])
  })

  it('reports which providers are registered', () => {
    const registry = new MemoryGovernanceRegistry()
    registry.registerVerificationProvider(provider({ id: 'a' }))
    registry.registerVerificationProvider(provider({ id: 'b' }))
    expect(registry.verificationProviderIds()).toEqual(['a', 'b'])
  })
})
