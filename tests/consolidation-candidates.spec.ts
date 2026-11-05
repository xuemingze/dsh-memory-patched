import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConsolidationCandidatePool,
  MAX_CANDIDATE_POOL,
  MAX_CANDIDATES_PER_RUN,
  parseCandidateEntry,
  type ConsolidationCandidateEntry,
} from '../src/consolidation-candidates.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function entry(overrides: Partial<ConsolidationCandidateEntry> = {}): ConsolidationCandidateEntry {
  return {
    id: 'cand-01234567-0',
    workspaceKey: 'workspace-0123456789abcdef',
    change: {
      action: 'put',
      record: {
        name: 'maybe-rule',
        description: 'A possibly durable rule.',
        type: 'feedback',
        content: 'Prefer the narrow path.',
      },
      evidence: [{ fromSeq: 0, toSeq: 1 }],
    },
    reason: 'uncertain',
    evidenceExcerpt: 'user said maybe',
    lastEvidenceTime: 1_000,
    origin: { reviewId: 'review-0123456789abcdef', sourceSessionId: 'session-1' },
    proposedAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  }
}

function pool(): { store: ConsolidationCandidatePool; directory: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-candidates-'))
  roots.push(root)
  const directory = join(root, 'candidates')
  mkdirSync(directory, { recursive: true })
  return { store: new ConsolidationCandidatePool(directory), directory }
}

describe('ConsolidationCandidatePool', () => {
  it('parks and lists entries oldest first', () => {
    const { store } = pool()
    store.park('workspace-0123456789abcdef', [entry()])
    store.park('workspace-0123456789abcdef', [entry({ id: 'cand-01234567-1', reason: 'thin' })])
    const listed = store.list('workspace-0123456789abcdef')
    expect(listed.map(item => item.id)).toEqual(['cand-01234567-0', 'cand-01234567-1'])
    expect(listed[0]).toEqual(entry())
  })

  it('keeps workspaces isolated', () => {
    const { store } = pool()
    store.park('workspace-0123456789abcdef', [entry()])
    store.park('workspace-ffffffffffffffff', [entry({ workspaceKey: 'workspace-ffffffffffffffff' })])
    expect(store.list('workspace-0123456789abcdef')).toHaveLength(1)
    expect(store.list('workspace-ffffffffffffffff')).toHaveLength(1)
    expect(store.list('workspace-0000000000000000')).toEqual([])
  })

  it('is idempotent by candidate id', () => {
    const { store } = pool()
    store.park('workspace-0123456789abcdef', [entry()])
    store.park('workspace-0123456789abcdef', [entry({ reason: 'thin' })])
    const listed = store.list('workspace-0123456789abcdef')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.reason).toBe('uncertain')
  })

  it('caps the pool at the configured size, dropping the oldest', () => {
    const { store } = pool()
    const key = 'workspace-0123456789abcdef'
    // One park call rather than a loop: park rewrites the whole file, so parking
    // 205 times is quadratic and took ~4s, close enough to the runner's timeout
    // that it failed intermittently under parallel load. The overflow rule is
    // what is under test, not the cost of repeated writes.
    store.park(key, Array.from({ length: MAX_CANDIDATE_POOL + 5 }, (_, index) =>
      entry({ id: `cand-01234567-${index}` })))
    const listed = store.list(key)
    expect(listed).toHaveLength(MAX_CANDIDATE_POOL)
    expect(listed[0]!.id).toBe(`cand-01234567-5`)
    expect(listed.at(-1)!.id).toBe(`cand-01234567-${MAX_CANDIDATE_POOL + 4}`)
  })

  it('limits the per-run injection window', () => {
    const { store } = pool()
    const key = 'workspace-0123456789abcdef'
    for (let index = 0; index < MAX_CANDIDATES_PER_RUN + 10; index++) {
      store.park(key, [entry({ id: `cand-01234567-${index}` })])
    }
    expect(store.listForInput(key)).toHaveLength(MAX_CANDIDATES_PER_RUN)
    expect(store.listForInput(key)[0]!.id).toBe('cand-01234567-0')
  })

  it('removes adjudicated ids and tolerates unknown ones', () => {
    const { store } = pool()
    const key = 'workspace-0123456789abcdef'
    store.park(key, [entry(), entry({ id: 'cand-01234567-1' })])
    store.remove(key, ['cand-01234567-0', 'cand-unknown-9'])
    expect(store.list(key).map(item => item.id)).toEqual(['cand-01234567-1'])
    store.remove(key, [])
    expect(store.list(key)).toHaveLength(1)
  })

  it('skips corrupt lines with a warning instead of failing', () => {
    const { store, directory } = pool()
    const key = 'workspace-0123456789abcdef'
    store.park(key, [entry()])
    const path = join(directory, `${key}.jsonl`)
    const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '')
    writeFileSync(path, `${lines[0]}\n{not json\n`, 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(store.list(key)).toEqual([entry()])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('treats an unreadable file as an empty pool', () => {
    const { store, directory } = pool()
    const key = 'workspace-0123456789abcdef'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeFileSync(join(directory, `${key}.jsonl`), 'not json at all', 'utf8')
    expect(store.list(key)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    // A later park recovers the file.
    store.park(key, [entry()])
    expect(store.list(key)).toEqual([entry()])
  })
})

describe('parseCandidateEntry', () => {
  it('round-trips a valid entry', () => {
    expect(parseCandidateEntry(JSON.parse(JSON.stringify(entry())))).toEqual(entry())
  })

  it('accepts delete entries', () => {
    const value = entry({ change: { action: 'delete', name: 'obsolete-rule', evidence: [{ fromSeq: 2, toSeq: 3 }] } })
    expect(parseCandidateEntry(JSON.parse(JSON.stringify(value)))).toEqual(value)
  })

  it('rejects unknown or missing fields', () => {
    const base = JSON.parse(JSON.stringify(entry())) as Record<string, unknown>
    expect(() => parseCandidateEntry({ ...base, extra: 1 })).toThrow()
    expect(() => parseCandidateEntry({ ...base, reason: undefined })).toThrow()
    const { origin, ...withoutOrigin } = base
    expect(origin).toBeDefined()
    expect(() => parseCandidateEntry(withoutOrigin)).toThrow()
  })

  it('rejects invalid reasons, ids, and evidence', () => {
    const base = JSON.parse(JSON.stringify(entry())) as Record<string, unknown>
    expect(() => parseCandidateEntry({ ...base, reason: 'maybe' })).toThrow()
    expect(() => parseCandidateEntry({ ...base, id: 'cand-XYZ-0' })).toThrow()
    expect(() => parseCandidateEntry({ ...base, lastEvidenceTime: -1 })).toThrow()
    const change = base.change as Record<string, unknown>
    expect(() => parseCandidateEntry({ ...base, change: { ...change, evidence: [] } })).toThrow()
    expect(() => parseCandidateEntry({ ...base, change: { ...change, evidence: [{ fromSeq: 3, toSeq: 1 }] } })).toThrow()
  })

  it('rejects replace-global changes and non-objects', () => {
    const base = JSON.parse(JSON.stringify(entry())) as Record<string, unknown>
    expect(() => parseCandidateEntry({ ...base, change: { action: 'replace-global', content: 'x', evidence: [{ fromSeq: 0, toSeq: 0 }] } })).toThrow()
    expect(() => parseCandidateEntry(null)).toThrow()
    expect(() => parseCandidateEntry('x')).toThrow()
  })
})
