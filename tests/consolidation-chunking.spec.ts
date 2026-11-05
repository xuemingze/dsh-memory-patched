import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EVIDENCE_SEGMENT_TOKENS,
  estimateEvidenceTokens,
  mergeSegmentProposals,
  segmentEvidence,
  TOPIC_BREAK_GAP_MS,
} from '../src/consolidation-chunking.ts'
import type { ConsolidationEvidenceTurn } from '../src/consolidation-evidence.ts'

function turn(overrides: Partial<ConsolidationEvidenceTurn> = {}): ConsolidationEvidenceTurn {
  return {
    fromSeq: 0,
    toSeq: 0,
    time: 0,
    user: ['x'],
    summaries: [],
    assistantFinal: null,
    tools: [],
    ...overrides,
  }
}

function filler(tokens: number, index: number, time = index): ConsolidationEvidenceTurn {
  // ~2.5 bytes per estimated token; pad with ASCII so the estimate is predictable.
  const text = 'a'.repeat(Math.max(1, Math.floor(tokens * 2.5)))
  return turn({ fromSeq: index, toSeq: index, time, user: [text] })
}

describe('estimateEvidenceTokens', () => {
  it('counts user, summary, assistant, and tool text', () => {
    const plain = estimateEvidenceTokens(turn({ user: ['abcd'] }))
    const withMore = estimateEvidenceTokens(turn({
      user: ['abcd'],
      summaries: ['efgh'],
      assistantFinal: 'ijkl',
      tools: [{ name: 'tool', status: 'succeeded' }],
    }))
    expect(withMore).toBeGreaterThan(plain)
  })
})

describe('segmentEvidence', () => {
  it('returns a single empty segment for empty evidence', () => {
    expect(segmentEvidence([])).toEqual([[]])
  })

  it('keeps everything in one segment when the budget is not exceeded', () => {
    const evidence = [filler(10, 0), filler(10, 1), filler(10, 2)]
    expect(segmentEvidence(evidence, 10_000)).toHaveLength(1)
  })

  it('splits on the budget without dropping or duplicating turns', () => {
    const evidence = Array.from({ length: 10 }, (_, index) => filler(400, index))
    const segments = segmentEvidence(evidence, 1_000)
    expect(segments.length).toBeGreaterThan(1)

    const flattened = segments.flat()
    expect(flattened).toHaveLength(evidence.length)
    expect(flattened.map(item => item.fromSeq)).toEqual(evidence.map(item => item.fromSeq))

    for (const segment of segments) {
      const tokens = segment.reduce((sum, item) => sum + estimateEvidenceTokens(item), 0)
      // A segment may exceed the budget only when it is a single oversized turn.
      if (segment.length > 1) expect(tokens).toBeLessThanOrEqual(1_000 + 400)
    }
  })

  it('gives an oversized single turn its own segment', () => {
    const evidence = [filler(100, 0), filler(5_000, 1), filler(100, 2)]
    const segments = segmentEvidence(evidence, 1_000)
    const oversized = segments.find(segment => segment.some(item => item.fromSeq === 1))
    expect(oversized).toBeDefined()
    expect(oversized!).toHaveLength(1)
  })

  it('prefers a topic break over a mid-topic split once past half the budget', () => {
    // Two 300-token turns, then a long silence, then two more.
    const evidence = [
      filler(300, 0, 0),
      filler(300, 1, 1_000),
      filler(300, 2, 1_000 + TOPIC_BREAK_GAP_MS + 60_000),
      filler(300, 3, 1_000 + TOPIC_BREAK_GAP_MS + 61_000),
    ]
    // Budget forces a split somewhere; the silence should win.
    const segments = segmentEvidence(evidence, 700)
    expect(segments).toHaveLength(2)
    expect(segments[0]!.map(item => item.fromSeq)).toEqual([0, 1])
    expect(segments[1]!.map(item => item.fromSeq)).toEqual([2, 3])
  })

  it('does not split on a topic break before half the budget is used', () => {
    const evidence = [
      filler(50, 0, 0),
      filler(50, 1, TOPIC_BREAK_GAP_MS + 1_000),
      filler(50, 2, TOPIC_BREAK_GAP_MS + 2_000),
    ]
    expect(segmentEvidence(evidence, 10_000)).toHaveLength(1)
  })

  it('rejects an invalid budget', () => {
    expect(() => segmentEvidence([turn()], 0)).toThrow(/positive safe integer/)
    expect(() => segmentEvidence([turn()], 1.5)).toThrow(/positive safe integer/)
  })

  it('defaults to the documented budget', () => {
    expect(DEFAULT_EVIDENCE_SEGMENT_TOKENS).toBe(8_192)
  })
})

describe('mergeSegmentProposals', () => {
  it('concatenates changes from every segment', () => {
    const merged = mergeSegmentProposals([
      { outcome: 'changes', changes: [{ action: 'put', record: { name: 'a' }, evidence: [] }] },
      { outcome: 'changes', changes: [{ action: 'put', record: { name: 'b' }, evidence: [] }] },
    ]) as { outcome: string; changes: Array<{ record: { name: string } }> }
    expect(merged.outcome).toBe('changes')
    expect(merged.changes.map(change => change.record.name)).toEqual(['a', 'b'])
  })

  it('lets a later segment replace an earlier change for the same name', () => {
    const merged = mergeSegmentProposals([
      { outcome: 'changes', changes: [{ action: 'put', record: { name: 'same', content: 'old' }, evidence: [] }] },
      { outcome: 'changes', changes: [{ action: 'put', record: { name: 'same', content: 'new' }, evidence: [] }] },
    ]) as { changes: Array<{ record: { content: string } }> }
    expect(merged.changes).toHaveLength(1)
    expect(merged.changes[0]!.record.content).toBe('new')
  })

  it('keeps only the last replace-global', () => {
    const merged = mergeSegmentProposals([
      { outcome: 'changes', changes: [{ action: 'replace-global', content: 'first', evidence: [] }] },
      { outcome: 'changes', changes: [{ action: 'replace-global', content: 'second', evidence: [] }] },
    ]) as { changes: Array<{ content: string }> }
    expect(merged.changes).toHaveLength(1)
    expect(merged.changes[0]!.content).toBe('second')
  })

  it('merges candidate buckets and takes verdicts from the first segment that has them', () => {
    const merged = mergeSegmentProposals([
      {
        outcome: 'no-change',
        changes: [],
        candidates: [{ action: 'put', record: { name: 'cand-a' }, reason: 'thin', evidence: [] }],
        candidateVerdicts: [{ id: 'cand-00000000-0', verdict: 'pass' }],
      },
      {
        outcome: 'no-change',
        changes: [],
        candidates: [{ action: 'put', record: { name: 'cand-b' }, reason: 'uncertain', evidence: [] }],
        candidateVerdicts: [{ id: 'cand-00000000-0', verdict: 'block' }],
      },
    ]) as {
      candidates: Array<{ record: { name: string } }>
      candidateVerdicts: Array<{ verdict: string }>
    }
    expect(merged.candidates.map(item => item.record.name)).toEqual(['cand-a', 'cand-b'])
    expect(merged.candidateVerdicts).toEqual([{ id: 'cand-00000000-0', verdict: 'pass' }])
  })

  it('reports no-change when no segment proposed anything', () => {
    const merged = mergeSegmentProposals([
      { outcome: 'no-change', changes: [] },
      { outcome: 'no-change', changes: [] },
    ]) as { outcome: string; changes: unknown[] }
    expect(merged.outcome).toBe('no-change')
    expect(merged.changes).toEqual([])
  })

  it('ignores malformed segment payloads instead of throwing', () => {
    const merged = mergeSegmentProposals([null, 'x', 42, { outcome: 'changes', changes: 'nope' }]) as {
      outcome: string
      changes: unknown[]
    }
    expect(merged.outcome).toBe('no-change')
    expect(merged.changes).toEqual([])
  })

  it('treats delete and put on the same name as one slot', () => {
    const merged = mergeSegmentProposals([
      { outcome: 'changes', changes: [{ action: 'delete', name: 'x', evidence: [] }] },
      { outcome: 'changes', changes: [{ action: 'put', record: { name: 'x' }, evidence: [] }] },
    ]) as { changes: Array<{ action: string }> }
    expect(merged.changes).toHaveLength(1)
    expect(merged.changes[0]!.action).toBe('put')
  })
})
