import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConsolidationCandidatePool,
  parseCandidateEntry,
  type ConsolidationCandidateEntry,
} from '../src/consolidation-candidates.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function pool(): ConsolidationCandidatePool {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-candidates-conflict-'))
  roots.push(root)
  return new ConsolidationCandidatePool(join(root, 'candidates'))
}

const base = {
  id: 'cand-1234abcd-1',
  workspaceKey: 'workspace-8a3bfb34f9e9b1a1',
  change: {
    action: 'put' as const,
    record: {
      name: 'dsh-ops-installed',
      description: 'dsh-ops installation state',
      type: 'project' as const,
      content: 'dsh-ops is installed from npm.',
    },
    evidence: [{ fromSeq: 0, toSeq: 1 }],
  },
  evidenceExcerpt: 'dsh-ops is installed from npm',
  lastEvidenceTime: 1_700_000_000_000,
  origin: { reviewId: 'review-abc', sourceSessionId: 'session-1' },
  proposedAt: '2026-11-05T00:00:00.000Z',
}

describe('candidate conflict metadata', () => {
  it('accepts the governance reasons', () => {
    for (const reason of ['conflict', 'needs-verification'] as const) {
      const entry = parseCandidateEntry({ ...base, reason })
      expect(entry.reason).toBe(reason)
    }
  })

  it('still accepts the original reasons', () => {
    for (const reason of ['uncertain', 'thin', 'unverified', 'transient'] as const) {
      expect(parseCandidateEntry({ ...base, reason }).reason).toBe(reason)
    }
  })

  it('round-trips conflict metadata', () => {
    const entry = parseCandidateEntry({
      ...base,
      reason: 'conflict',
      conflict: {
        claimKey: 'a1b2c3d4e5f60718',
        opposingRecords: ['dsh-ops-removed'],
        environmentFingerprint: 'desktop|win32',
      },
    })
    expect(entry.conflict).toEqual({
      claimKey: 'a1b2c3d4e5f60718',
      opposingRecords: ['dsh-ops-removed'],
      environmentFingerprint: 'desktop|win32',
    })
  })

  it('treats conflict metadata as optional so old entries still load', () => {
    expect(parseCandidateEntry({ ...base, reason: 'uncertain' }).conflict).toBeUndefined()
  })

  it('rejects a malformed claim key', () => {
    expect(() => parseCandidateEntry({
      ...base,
      reason: 'conflict',
      conflict: { claimKey: 'not-a-digest', opposingRecords: [], environmentFingerprint: '' },
    })).toThrow(/claimKey/u)
  })

  it('rejects a non-list opposingRecords', () => {
    expect(() => parseCandidateEntry({
      ...base,
      reason: 'conflict',
      conflict: { claimKey: 'a1b2c3d4e5f60718', opposingRecords: 'nope', environmentFingerprint: '' },
    })).toThrow(/opposingRecords/u)
  })

  it('rejects unknown fields on the conflict block', () => {
    expect(() => parseCandidateEntry({
      ...base,
      reason: 'conflict',
      conflict: {
        claimKey: 'a1b2c3d4e5f60718',
        opposingRecords: [],
        environmentFingerprint: '',
        extra: true,
      },
    })).toThrow(/exactly/u)
  })

  it('persists and reloads a parked conflict through the pool', () => {
    const store = pool()
    const entry: ConsolidationCandidateEntry = parseCandidateEntry({
      ...base,
      reason: 'needs-verification',
      conflict: {
        claimKey: 'a1b2c3d4e5f60718',
        opposingRecords: ['dsh-ops-removed'],
        environmentFingerprint: 'desktop|win32',
      },
    })
    store.park('workspace-8a3bfb34f9e9b1a1', [entry])
    const reloaded = new ConsolidationCandidatePool(store.directory)
      .list('workspace-8a3bfb34f9e9b1a1')
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0]?.reason).toBe('needs-verification')
    expect(reloaded[0]?.conflict?.opposingRecords).toEqual(['dsh-ops-removed'])
  })
})
