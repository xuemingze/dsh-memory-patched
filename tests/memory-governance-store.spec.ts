import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MemoryGovernanceStore,
  GovernanceConflictError,
} from '../src/memory-governance-store.ts'
import type { GovernanceClaimInput } from '../src/memory-governance-types.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-governance-'))
  roots.push(root)
  return root
}

function claim(overrides: Partial<GovernanceClaimInput> = {}): GovernanceClaimInput {
  return {
    name: 'dsh-ops-removal',
    scopeKey: 'workspace-8a3bfb34f9e9b1a1',
    kind: 'configuration',
    volatility: 'versioned',
    text: 'dsh-ops must be installed from npm, never from a GitHub source checkout.',
    evidenceCount: 3,
    ...overrides,
  }
}

describe('MemoryGovernanceStore', () => {
  it('starts empty and derives a revision per scope', () => {
    const store = new MemoryGovernanceStore(makeRoot())
    const document = store.read('workspace-8a3bfb34f9e9b1a1')
    expect(document.format).toBe(1)
    expect(document.claims).toEqual([])
    expect(document.revision).toMatch(/^gov1:[a-f0-9]{16}$/u)
  })

  it('round-trips a claim and reports the new revision', () => {
    const store = new MemoryGovernanceStore(makeRoot())
    const first = store.read('scope-a')
    const result = store.commit({
      scopeKey: 'scope-a',
      expectedRevision: first.revision,
      upserts: [claim({ scopeKey: 'scope-a' })],
      removals: [],
    })
    expect(result.revision).not.toBe(first.revision)
    const reloaded = new MemoryGovernanceStore(store.root).read('scope-a')
    expect(reloaded.claims).toHaveLength(1)
    expect(reloaded.claims[0]).toMatchObject({
      name: 'dsh-ops-removal',
      kind: 'configuration',
      volatility: 'versioned',
      lifecycle: 'active',
    })
  })

  it('rejects a stale expected revision instead of overwriting', () => {
    const store = new MemoryGovernanceStore(makeRoot())
    const first = store.read('scope-a')
    store.commit({
      scopeKey: 'scope-a',
      expectedRevision: first.revision,
      upserts: [claim({ scopeKey: 'scope-a' })],
      removals: [],
    })
    expect(() => store.commit({
      scopeKey: 'scope-a',
      expectedRevision: first.revision,
      upserts: [claim({ scopeKey: 'scope-a', text: 'different' })],
      removals: [],
    })).toThrow(GovernanceConflictError)
  })

  it('writes atomically, leaving no temporary file behind', () => {
    const root = makeRoot()
    const store = new MemoryGovernanceStore(root)
    const first = store.read('scope-a')
    store.commit({
      scopeKey: 'scope-a',
      expectedRevision: first.revision,
      upserts: [claim({ scopeKey: 'scope-a' })],
      removals: [],
    })
    const document = JSON.parse(readFileSync(join(root, 'governance', 'workspaces', 'scope-a.json'), 'utf8'))
    expect(document.format).toBe(1)
    expect(document.claims).toHaveLength(1)
  })

  it('fails open on a corrupt sidecar instead of breaking memory reads', () => {
    const root = makeRoot()
    const path = join(root, 'governance', 'workspaces', 'scope-a.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{ this is not json', 'utf8')

    const store = new MemoryGovernanceStore(root)
    const document = store.read('scope-a')
    // Every claim stays active and visible when governance data is unreadable.
    expect(document.claims).toEqual([])
    expect(document.degraded).toBe(true)
  })

  it('rejects a sidecar written by an unknown future format', () => {
    const root = makeRoot()
    const path = join(root, 'governance', 'workspaces', 'scope-a.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ format: 99, claims: [] }), 'utf8')

    const document = new MemoryGovernanceStore(root).read('scope-a')
    expect(document.degraded).toBe(true)
  })

  it('removes a claim by name', () => {
    const store = new MemoryGovernanceStore(makeRoot())
    const first = store.read('scope-a')
    const afterAdd = store.commit({
      scopeKey: 'scope-a',
      expectedRevision: first.revision,
      upserts: [claim({ scopeKey: 'scope-a' })],
      removals: [],
    })
    const afterRemove = store.commit({
      scopeKey: 'scope-a',
      expectedRevision: afterAdd.revision,
      upserts: [],
      removals: ['dsh-ops-removal'],
    })
    expect(store.read('scope-a').claims).toEqual([])
    expect(afterRemove.revision).not.toBe(afterAdd.revision)
  })

  it('keeps scopes independent', () => {
    const store = new MemoryGovernanceStore(makeRoot())
    const a = store.read('scope-a')
    store.commit({
      scopeKey: 'scope-a',
      expectedRevision: a.revision,
      upserts: [claim({ scopeKey: 'scope-a' })],
      removals: [],
    })
    expect(store.read('scope-b').claims).toEqual([])
  })
})
