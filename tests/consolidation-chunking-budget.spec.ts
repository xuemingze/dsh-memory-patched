import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EVIDENCE_SEGMENT_TOKENS,
  deriveSegmentBudgetTokens,
  segmentEvidence,
} from '../src/consolidation-chunking.ts'
import type { ConsolidationEvidenceTurn } from '../src/consolidation-evidence.ts'

function turn(index: number, text = 'a'.repeat(2_500)): ConsolidationEvidenceTurn {
  return {
    fromSeq: index,
    toSeq: index,
    time: index,
    user: [text],
    summaries: [],
    assistantFinal: null,
    tools: [],
  }
}

describe('deriveSegmentBudgetTokens', () => {
  it('shrinks the budget as fixed context grows', () => {
    // Compare under a ceiling tight enough that both cases stay below it;
    // with a generous ceiling both would clamp to the same value.
    const ceiling = 20_000
    const small = deriveSegmentBudgetTokens(
      { globalContentBytes: 4_000, workspaceRecordBytes: 4_000 },
      40_000,
      ceiling,
    )
    const large = deriveSegmentBudgetTokens(
      { globalContentBytes: 14_000, workspaceRecordBytes: 14_000 },
      40_000,
      ceiling,
    )
    expect(large).toBeLessThan(small)
    expect(large).toBeGreaterThan(0)
  })

  it('never exceeds the ceiling', () => {
    const budget = deriveSegmentBudgetTokens(
      { globalContentBytes: 0, workspaceRecordBytes: 0 },
      10_000_000,
    )
    expect(budget).toBe(DEFAULT_EVIDENCE_SEGMENT_TOKENS)
  })

  it('falls back to a small budget when context alone fills the request', () => {
    const budget = deriveSegmentBudgetTokens(
      { globalContentBytes: 200_000, workspaceRecordBytes: 100_000 },
      262_144,
    )
    expect(budget).toBeGreaterThan(0)
    expect(budget).toBeLessThanOrEqual(1_024)
  })

  it('keeps a floor so a segment can still carry a real turn', () => {
    const budget = deriveSegmentBudgetTokens(
      { globalContentBytes: 250_000, workspaceRecordBytes: 10_000 },
      262_144,
    )
    expect(budget).toBeGreaterThanOrEqual(512)
  })

  it('reproduces the 2026-11-04 overflow as a smaller budget', () => {
    // 34.5 KB Global + ~100 KB records against the old 128 KB ceiling left
    // almost nothing free; the derived budget must reflect that instead of
    // pretending the full 8192-token segment still fits.
    const oldCeiling = 131_072
    const budget = deriveSegmentBudgetTokens(
      { globalContentBytes: 34_537, workspaceRecordBytes: 100_000 },
      oldCeiling,
    )
    expect(budget).toBeLessThanOrEqual(1_024)
  })

  it('gives a normal review close to the full segment budget', () => {
    const budget = deriveSegmentBudgetTokens(
      { globalContentBytes: 8_000, workspaceRecordBytes: 20_000 },
      262_144,
    )
    // ~234 KB free / 2.5 bytes-per-token is far past the 8192 ceiling.
    expect(budget).toBe(DEFAULT_EVIDENCE_SEGMENT_TOKENS)
  })
})

describe('segmentEvidence with a derived budget', () => {
  it('produces more segments when the budget shrinks', () => {
    const evidence = Array.from({ length: 8 }, (_, index) => turn(index))
    const generous = segmentEvidence(evidence, DEFAULT_EVIDENCE_SEGMENT_TOKENS)
    const tight = segmentEvidence(evidence, 1_200)
    expect(tight.length).toBeGreaterThan(generous.length)
    expect(tight.flat()).toHaveLength(evidence.length)
  })
})
