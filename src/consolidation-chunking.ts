/**
 * Deterministic evidence segmentation for consolidation workers.
 *
 * A Session with hundreds of turns produces an evidence projection the worker
 * cannot digest inside one output budget: reasoning tokens alone can exhaust it
 * before the first proposal call (2026-11-04 incident). Splitting the evidence
 * into token-bounded segments keeps every worker run small, while the review,
 * the proposal gate, and the commit barrier stay single-instance: each segment
 * proposes, the runner merges, and one parse/commit happens for the whole review.
 */

import type { ConsolidationEvidenceTurn } from './consolidation-evidence.ts'

/** Target input size of one segment, in estimated tokens. */
export const DEFAULT_EVIDENCE_SEGMENT_TOKENS = 8_192

/**
 * Bytes reserved per segment beyond the evidence itself: the JSON envelope,
 * the system rules, and the tool schema all travel with every request.
 */
const SEGMENT_ENVELOPE_BYTES = 8_192

/**
 * Derive a per-segment token budget from the bytes the rendered request has
 * left after fixed context (Global memory plus Workspace records).
 *
 * The old model only bounded the evidence, so a Session whose evidence was a
 * single turn still overflowed `maxInputBytes` once Global memory and the
 * Workspace record set grew (2026-11-04: 6.5 KB evidence, 150 KB request). The
 * budget must therefore be measured against the space that is actually free.
 */
export function deriveSegmentBudgetTokens(
  input: {
    readonly globalContentBytes: number
    readonly workspaceRecordBytes: number
  },
  maxInputBytes: number,
  ceilingTokens: number = DEFAULT_EVIDENCE_SEGMENT_TOKENS,
): number {
  const fixed = input.globalContentBytes + input.workspaceRecordBytes + SEGMENT_ENVELOPE_BYTES
  const free = maxInputBytes - fixed
  if (free <= 0) {
    // Context alone already fills the budget: fall back to the smallest useful
    // segment so the caller still gets a bounded, predictable request.
    return Math.min(ceilingTokens, 1_024)
  }
  // Same bytes-per-token ratio the estimator uses, so the two agree.
  const tokens = Math.floor(free / 2.5)
  return Math.max(512, Math.min(ceilingTokens, tokens))
}

/**
 * Conservative token estimate for one evidence turn: bytes over 2.5 under-counts
 * nothing for mixed CJK/Latin text and errs toward smaller segments, which is the
 * safe direction (a too-large segment loses the whole proposal).
 */
export function estimateEvidenceTokens(turn: ConsolidationEvidenceTurn): number {
  const text = [
    ...turn.user,
    ...turn.summaries,
    turn.assistantFinal ?? '',
    ...turn.tools.map(tool => `${tool.name} ${tool.status}`),
  ].join('\n')
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 2.5)
}

/** A silence longer than this between turns marks a topic boundary. */
export const TOPIC_BREAK_GAP_MS = 30 * 60 * 1000

/** Never emit a segment smaller than this share of the budget just to hit a break. */
const MIN_SEGMENT_FILL_RATIO = 0.5

/**
 * Split evidence into contiguous segments whose estimated size stays within the
 * budget. Order is preserved and no turn is duplicated or dropped. A turn larger
 * than the whole budget occupies its own segment. Empty input yields one empty
 * segment so callers keep a single uniform path.
 *
 * Boundary choice prefers topic breaks over pure budget arithmetic: when the
 * accumulated segment is already past half the budget and the next turn follows
 * a long silence, the split happens there instead of mid-topic. That mirrors how
 * the episode layer avoids cutting one conversation in half, and it matters here
 * because a worker that sees "user asked for X" without "X finished" either
 * proposes nothing or proposes the wrong fact.
 */
export function segmentEvidence(
  evidence: readonly ConsolidationEvidenceTurn[],
  budgetTokens: number = DEFAULT_EVIDENCE_SEGMENT_TOKENS,
): readonly (readonly ConsolidationEvidenceTurn[])[] {
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1) {
    throw new TypeError('evidence segment budget must be a positive safe integer')
  }
  if (evidence.length === 0) return [[]]

  const segments: ConsolidationEvidenceTurn[][] = []
  let current: ConsolidationEvidenceTurn[] = []
  let currentTokens = 0

  for (const [index, turn] of evidence.entries()) {
    const tokens = estimateEvidenceTokens(turn)
    const previous = index === 0 ? undefined : evidence[index - 1]
    const gap = previous === undefined ? 0 : Math.abs(turn.time - previous.time)
    const atTopicBreak = gap >= TOPIC_BREAK_GAP_MS && currentTokens >= budgetTokens * MIN_SEGMENT_FILL_RATIO
    const overBudget = current.length > 0 && currentTokens + tokens > budgetTokens

    if (atTopicBreak || overBudget) {
      if (current.length > 0) {
        segments.push(current)
        current = []
        currentTokens = 0
      }
    }
    current.push(turn)
    currentTokens += tokens
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/**
 * Merge per-segment proposals into one proposal for the single review parse.
 *
 * `changes` concatenates in segment order. Names must be unique before the gate
 * runs (it rejects duplicates), so a later proposal for the same name replaces
 * the earlier one — the newer segment saw the same Workspace plus its own
 * evidence, and the consolidation rules already favour the freshest fact.
 * `replace-global` keeps only the last occurrence for the same reason.
 * Candidate verdicts are taken from the first segment that supplied them: the
 * pending pool is adjudicated once per review, not once per segment.
 */
export function mergeSegmentProposals(proposals: readonly unknown[]): unknown {
  const changes: Record<string, unknown>[] = []
  const candidates: Record<string, unknown>[] = []
  let candidateVerdicts: unknown[] | undefined

  for (const proposal of proposals) {
    if (proposal === null || typeof proposal !== 'object' || Array.isArray(proposal)) continue
    const record = proposal as Record<string, unknown>

    if (Array.isArray(record.changes)) {
      for (const change of record.changes) {
        if (change === null || typeof change !== 'object' || Array.isArray(change)) continue
        const entry = change as Record<string, unknown>
        const name = nameOf(entry)
        if (name === undefined) continue
        const existingIndex = changes.findIndex(candidate => nameOf(candidate) === name)
        if (existingIndex !== -1) changes.splice(existingIndex, 1)
        changes.push(entry)
      }
    }

    if (Array.isArray(record.candidates)) {
      for (const candidate of record.candidates) {
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
        const entry = candidate as Record<string, unknown>
        const name = nameOf(entry)
        if (name === undefined) continue
        const existingIndex = candidates.findIndex(item => nameOf(item) === name)
        if (existingIndex !== -1) candidates.splice(existingIndex, 1)
        candidates.push(entry)
      }
    }

    if (candidateVerdicts === undefined && Array.isArray(record.candidateVerdicts)) {
      candidateVerdicts = record.candidateVerdicts
    }
  }

  const merged: Record<string, unknown> = {
    outcome: changes.length === 0 ? 'no-change' : 'changes',
    changes,
  }
  if (candidates.length > 0) merged.candidates = candidates
  if (candidateVerdicts !== undefined) merged.candidateVerdicts = candidateVerdicts
  return merged
}

function nameOf(change: Record<string, unknown>): string | undefined {
  if (change.action === 'replace-global') return '@global'
  if (change.action === 'put') {
    const record = change.record
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined
    const name = (record as Record<string, unknown>).name
    return typeof name === 'string' ? name : undefined
  }
  if (change.action === 'delete') return typeof change.name === 'string' ? change.name : undefined
  return undefined
}
