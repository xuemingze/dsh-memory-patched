/** Runtime validation and deterministic planning for one model-proposed consolidation. */

import {
  MemoryValidationError,
  previewGlobalMemory,
  previewWorkspaceChanges,
  type GlobalMemoryPreview,
  type GlobalMemoryView,
  type WorkspaceMemory,
  type WorkspaceMemoryChange,
  type WorkspaceMemoryPreview,
  type WorkspaceMemoryType,
  type WorkspaceMemoryView,
} from './memory-store.ts'
import type { ConsolidationEvidenceTurn } from './consolidation-evidence.ts'
import { chunkIntersection, demoteHeadings, isSameTopic, stripSignpostSections, textChunks } from './consolidation-dedupe.ts'
import { redactCredentials } from './redact.ts'
import {
  CANDIDATE_REASONS,
  type ConsolidationCandidateEntry,
  type ConsolidationCandidateReason,
} from './consolidation-candidates.ts'

/** Inclusive source Session evidence interval. */
export interface ConsolidationEvidenceRange {
  readonly fromSeq: number
  readonly toSeq: number
}

/** One validated model-proposed Workspace change with source evidence. */
export type ConsolidationProposalChange =
  | {
      readonly action: 'replace-global'
      readonly content: string
      readonly evidence: readonly ConsolidationEvidenceRange[]
    }
  | {
      readonly action: 'put'
      readonly record: WorkspaceMemory
      readonly evidence: readonly ConsolidationEvidenceRange[]
    }
  | {
      readonly action: 'delete'
      readonly name: string
      readonly evidence: readonly ConsolidationEvidenceRange[]
    }

/** Closed semantic result accepted from the consolidation worker. */
export type ConsolidationProposal =
  | { readonly outcome: 'no-change'; readonly changes: readonly [] }
  | { readonly outcome: 'changes'; readonly changes: readonly ConsolidationProposalChange[] }

/**
 * Deterministic dedupe applied to a parsed proposal before it is previewed and
 * committed. `merge` (default) only rewrites the proposal; `merge-delete`
 * additionally lets a fuller new record replace an existing one by name.
 */
export type ConsolidationDedupeMode = 'off' | 'merge' | 'merge-delete'

/** Audit trail of one dedupe pass, recorded to the consolidation debug log. */
export type ConsolidationDedupeEvent =
  | { readonly kind: 'merged-put'; readonly kept: string; readonly absorbed: string; readonly intersection: number }
  | { readonly kind: 'dropped-signpost-section'; readonly heading: string }
  | { readonly kind: 'dedupe-failed'; readonly error: string }

/** One change rejected because its evidence predates the record it would rewrite. */
export interface StaleConsolidationChange {
  readonly index: number
  readonly reason: 'stale-evidence'
}

export type ConsolidationWriteGateMode = 'off' | 'on'

export type ConsolidationCandidateEvent =
  | { readonly kind: 'parked'; readonly id: string; readonly name: string; readonly reason: ConsolidationCandidateReason }
  | { readonly kind: 'admitted'; readonly id: string; readonly name: string }
  | { readonly kind: 'blocked'; readonly id: string; readonly reason?: string }
  | { readonly kind: 'candidate-stale'; readonly id: string; readonly name: string }
  | { readonly kind: 'candidate-shadowed'; readonly id: string; readonly name: string }

/** Canonical proposal plus the exact Workspace generation it would produce. */
export interface ConsolidationProposalPlan {
  readonly proposal: ConsolidationProposal
  readonly globalBefore: GlobalMemoryView
  readonly globalPreview: GlobalMemoryPreview
  readonly preview: WorkspaceMemoryPreview
  readonly dedupe?: readonly ConsolidationDedupeEvent[]
  readonly staleChanges?: readonly StaleConsolidationChange[]
  readonly parked?: readonly ConsolidationCandidateEntry[]
  readonly candidateEvents?: readonly ConsolidationCandidateEvent[]
}

/** Raised when an untrusted worker proposal violates the closed contract. */
export class ConsolidationProposalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConsolidationProposalError'
  }
}

/** Parse, validate, canonicalize, deduplicate, and preview one untrusted worker proposal. */
export function parseConsolidationProposal(
  value: unknown,
  input: {
    readonly sourceEvidence: readonly ConsolidationEvidenceTurn[]
    readonly global: GlobalMemoryView
    readonly workspace: WorkspaceMemoryView
    readonly dedupe?: ConsolidationDedupeMode | undefined
    readonly writeGate?: ConsolidationWriteGateMode | undefined
    readonly pendingCandidates?: readonly ConsolidationCandidateEntry[] | undefined
    readonly reviewId?: string | undefined
    readonly sourceSessionId?: string | undefined
    readonly workspaceKey?: string | undefined
  },
): ConsolidationProposalPlan {
  const candidate = requireRecord(value, 'proposal')
  requireAllowedKeys(candidate, ['outcome', 'changes'], ['candidates', 'candidateVerdicts'], 'proposal')

  const writeGate = input.writeGate ?? 'on'
  if (writeGate === 'off') {
    if (candidate.candidates !== undefined || candidate.candidateVerdicts !== undefined) {
      throw new ConsolidationProposalError('writeGate is off; candidates and candidateVerdicts must not be supplied')
    }
  }

  if (!Array.isArray(candidate.changes)) {
    throw new ConsolidationProposalError('proposal.changes must be an array')
  }
  if (candidate.outcome === 'no-change') {
    if (candidate.changes.length !== 0) {
      throw new ConsolidationProposalError('proposal.changes must be empty when outcome is no-change')
    }
  } else if (candidate.outcome !== 'changes') {
    throw new ConsolidationProposalError('proposal.outcome must be no-change or changes')
  } else if (candidate.changes.length === 0) {
    throw new ConsolidationProposalError('proposal.changes must be non-empty when outcome is changes')
  }

  const allowedEvidence = evidenceRanges(input.sourceEvidence)
  const changes = candidate.changes.map((change, index) => parseChange(change, index, allowedEvidence))
  const names = new Set<string>()
  for (const change of changes) {
    const name = change.action === 'replace-global' ? '@global' : change.action === 'put' ? change.record.name : change.name
    if (names.has(name)) {
      throw new ConsolidationProposalError(`proposal.changes contains more than one change for ${name}`)
    }
    names.add(name)
  }
  changes.sort(compareChanges)

  const parsedCandidates: Array<{
    name: string
    change:
      | { action: 'put'; record: WorkspaceMemory; evidence: ConsolidationEvidenceRange[] }
      | { action: 'delete'; name: string; evidence: ConsolidationEvidenceRange[] }
    reason: ConsolidationCandidateReason
    evidence: ConsolidationEvidenceRange[]
  }> = []

  if (candidate.candidates !== undefined) {
    if (!Array.isArray(candidate.candidates)) {
      throw new ConsolidationProposalError('proposal.candidates must be an array')
    }
    const candidateNames = new Set<string>()
    for (const [index, item] of candidate.candidates.entries()) {
      const label = `proposal.candidates[${index}]`
      const raw = requireRecord(item, label)
      if (typeof raw.reason !== 'string' || !CANDIDATE_REASONS.includes(raw.reason as ConsolidationCandidateReason)) {
        throw new ConsolidationProposalError(`${label}.reason must be one of ${CANDIDATE_REASONS.join(', ')}`)
      }
      const reason = raw.reason as ConsolidationCandidateReason
      if (raw.action === 'put') {
        requireExactKeys(raw, ['action', 'record', 'reason', 'evidence'], label)
        const record = parseRecord(raw.record, `${label}.record`)
        const ev = parseEvidence(raw.evidence, `${label}.evidence`, allowedEvidence)
        if (candidateNames.has(record.name)) {
          throw new ConsolidationProposalError(`proposal.candidates contains more than one candidate for ${record.name}`)
        }
        candidateNames.add(record.name)
        parsedCandidates.push({ name: record.name, change: { action: 'put', record, evidence: ev }, reason, evidence: ev })
      } else if (raw.action === 'delete') {
        requireExactKeys(raw, ['action', 'name', 'reason', 'evidence'], label)
        if (typeof raw.name !== 'string' || raw.name.trim() === '') {
          throw new ConsolidationProposalError(`${label}.name must be a non-empty string`)
        }
        const ev = parseEvidence(raw.evidence, `${label}.evidence`, allowedEvidence)
        if (candidateNames.has(raw.name)) {
          throw new ConsolidationProposalError(`proposal.candidates contains more than one candidate for ${raw.name}`)
        }
        candidateNames.add(raw.name)
        parsedCandidates.push({ name: raw.name, change: { action: 'delete', name: raw.name, evidence: ev }, reason, evidence: ev })
      } else {
        throw new ConsolidationProposalError(`${label}.action must be put or delete`)
      }
    }
  }

  for (const cand of parsedCandidates) {
    if (names.has(cand.name)) {
      throw new ConsolidationProposalError(`candidate name "${cand.name}" conflicts with a proposal change`)
    }
  }

  const pending = input.pendingCandidates ?? []
  const candidateEvents: ConsolidationCandidateEvent[] = []
  const admittedChanges: ConsolidationProposalChange[] = []

  if (pending.length > 0) {
    if (!Array.isArray(candidate.candidateVerdicts)) {
      throw new ConsolidationProposalError('proposal.candidateVerdicts must match the pending candidates exactly')
    }
    const verdicts = candidate.candidateVerdicts
    if (verdicts.length !== pending.length) {
      throw new ConsolidationProposalError('proposal.candidateVerdicts must match the pending candidates exactly')
    }
    const pendingIds = new Set(pending.map(p => p.id))
    const seenIds = new Set<string>()
    for (const [index, item] of verdicts.entries()) {
      const label = `proposal.candidateVerdicts[${index}]`
      const v = requireRecord(item, label)
      requireAllowedKeys(v, ['id', 'verdict'], ['reason'], label)
      if (typeof v.id !== 'string' || !pendingIds.has(v.id) || seenIds.has(v.id)) {
        throw new ConsolidationProposalError('proposal.candidateVerdicts must match the pending candidates exactly')
      }
      if (v.verdict !== 'pass' && v.verdict !== 'block') {
        throw new ConsolidationProposalError(`${label}.verdict must be pass or block`)
      }
      if (v.reason !== undefined && (typeof v.reason !== 'string' || v.reason.length > 500)) {
        throw new ConsolidationProposalError(`${label}.reason must be a string up to 500 characters`)
      }
      seenIds.add(v.id)

      const entry = pending.find(p => p.id === v.id)!
      const candTargetName = entry.change.action === 'put' ? entry.change.record.name : entry.change.name

      if (v.verdict === 'block') {
        candidateEvents.push({
          kind: 'blocked',
          id: entry.id,
          ...(typeof v.reason === 'string' && v.reason ? { reason: v.reason } : {}),
        })
      } else {
        if (names.has(candTargetName)) {
          candidateEvents.push({ kind: 'candidate-shadowed', id: entry.id, name: candTargetName })
        } else {
          const existingRecord = input.workspace.records.find(r => r.name === candTargetName)
          if (existingRecord !== undefined && entry.lastEvidenceTime > 0 && entry.lastEvidenceTime < (existingRecord.lastEvidenceTime ?? 0)) {
            candidateEvents.push({ kind: 'candidate-stale', id: entry.id, name: candTargetName })
          } else {
            candidateEvents.push({ kind: 'admitted', id: entry.id, name: candTargetName })
            if (entry.change.action === 'put') {
              admittedChanges.push({
                action: 'put',
                record: {
                  ...entry.change.record,
                  ...(entry.lastEvidenceTime > 0 ? { lastEvidenceTime: entry.lastEvidenceTime } : {}),
                },
                evidence: entry.change.evidence,
              })
            } else {
              admittedChanges.push({
                action: 'delete',
                name: entry.change.name,
                evidence: entry.change.evidence,
              })
            }
          }
        }
      }
    }
  } else {
    if (candidate.candidateVerdicts !== undefined) {
      throw new ConsolidationProposalError('candidateVerdicts supplied without pending candidates')
    }
  }

  const parked: ConsolidationCandidateEntry[] = []
  const shortReviewId = candidatePrefix(input.reviewId)
  const targetWorkspaceKey = input.workspaceKey ?? (pending[0]?.workspaceKey ?? 'workspace')
  const originReviewId = input.reviewId ?? 'review-unknown'
  const originSessionId = input.sourceSessionId ?? 'session-unknown'
  const proposedAt = new Date().toISOString()

  for (const [index, cand] of parsedCandidates.entries()) {
    const id = `cand-${shortReviewId}-${index}`
    const candEvidenceTime = evidenceTimeOf(cand.evidence, input.sourceEvidence)
    const excerpt = excerptForEvidence(cand.evidence, input.sourceEvidence)
    const candEntry: ConsolidationCandidateEntry = {
      id,
      workspaceKey: targetWorkspaceKey,
      change: cand.change,
      reason: cand.reason,
      evidenceExcerpt: excerpt,
      lastEvidenceTime: candEvidenceTime,
      origin: { reviewId: originReviewId, sourceSessionId: originSessionId },
      proposedAt,
    }
    parked.push(candEntry)
    candidateEvents.push({ kind: 'parked', id, name: cand.name, reason: cand.reason })
  }

  const guarded = applyTemporalGuard(changes, input)
  const guardedChanges = guarded.changes
  const stale = guarded.stale.length === 0 ? {} : { staleChanges: guarded.stale }

  const combinedChanges = [...guardedChanges, ...admittedChanges].sort(compareChanges)

  const dedupeMode = input.dedupe ?? 'merge'
  let effectiveChanges: readonly ConsolidationProposalChange[] = combinedChanges
  let dedupeEvents: readonly ConsolidationDedupeEvent[] | undefined
  if (dedupeMode !== 'off') {
    try {
      const applied = applyDedupe(combinedChanges, input, dedupeMode)
      effectiveChanges = applied.changes
      if (applied.events.length > 0) dedupeEvents = applied.events
    } catch (cause: unknown) {
      // Dedupe must never break consolidation: fall back to the untouched proposal.
      effectiveChanges = combinedChanges
      dedupeEvents = [{
        kind: 'dedupe-failed',
        error: redactCredentials(cause instanceof Error ? cause.message : String(cause)),
      }]
    }
  }

  const globalChange = effectiveChanges.find(change => change.action === 'replace-global')
  const globalPreview = globalChange?.action === 'replace-global'
    ? previewGlobalMemory(input.global, globalChange.content)
    : unchangedGlobalPreview(input.global)
  let preview: WorkspaceMemoryPreview
  try {
    const workspaceChanges = effectiveChanges.filter(isWorkspaceChange).map(toMemoryChange)
    preview = workspaceChanges.length === 0
      ? unchangedPreview(input.workspace)
      : previewWorkspaceChanges(input.workspace, workspaceChanges)
  } catch (cause: unknown) {
    if (cause instanceof MemoryValidationError) {
      throw new ConsolidationProposalError(`proposal changes are invalid: ${cause.message}`, { cause })
    }
    throw cause
  }
  const dedupe = dedupeEvents === undefined ? {} : { dedupe: dedupeEvents }
  const extraProps = {
    ...dedupe,
    ...stale,
    ...(parked.length > 0 ? { parked } : {}),
    ...(candidateEvents.length > 0 ? { candidateEvents } : {}),
  }

  if (!globalPreview.changed && !preview.changed) {
    return {
      proposal: { outcome: 'no-change', changes: [] },
      globalBefore: { ...input.global },
      globalPreview,
      preview,
      ...extraProps,
    }
  }
  return {
    proposal: { outcome: 'changes', changes: effectiveChanges },
    globalBefore: { ...input.global },
    globalPreview,
    preview,
    ...extraProps,
  }
}

/** Reject changes whose evidence predates the record they would rewrite, and stamp survivors. */
function applyTemporalGuard(
  changes: readonly ConsolidationProposalChange[],
  input: {
    readonly sourceEvidence: readonly ConsolidationEvidenceTurn[]
    readonly workspace: WorkspaceMemoryView
  },
): { changes: ConsolidationProposalChange[]; stale: StaleConsolidationChange[] } {
  const existing = new Map(input.workspace.records.map(record => [record.name, record]))
  const kept: ConsolidationProposalChange[] = []
  const stale: StaleConsolidationChange[] = []
  changes.forEach((change, index) => {
    if (change.action === 'replace-global') {
      kept.push(change)
      return
    }
    const name = change.action === 'put' ? change.record.name : change.name
    const record = existing.get(name)
    const evidenceTime = evidenceTimeOf(change.evidence, input.sourceEvidence)
    if (record !== undefined && evidenceTime > 0 && evidenceTime < (record.lastEvidenceTime ?? 0)) {
      stale.push({ index, reason: 'stale-evidence' })
      return
    }
    if (change.action === 'put') {
      kept.push({
        ...change,
        record: {
          ...change.record,
          // Unknown evidence time (0) stays unstamped: 0 and "absent" mean the same to the guard.
          ...(evidenceTime > 0 ? { lastEvidenceTime: evidenceTime } : {}),
        },
      })
      return
    }
    kept.push(change)
  })
  return { changes: kept, stale }
}

function evidenceTimeOf(
  evidence: readonly ConsolidationEvidenceRange[],
  turns: readonly ConsolidationEvidenceTurn[],
): number {
  let time = 0
  for (const range of evidence) {
    for (const turn of turns) {
      if (turn.fromSeq <= range.toSeq && turn.toSeq >= range.fromSeq && turn.time > time) time = turn.time
    }
  }
  return time
}

/** Keep the newest stamp when two records are folded together. */
function mergedEvidenceTime(
  left: WorkspaceMemory,
  right: WorkspaceMemory,
): Pick<WorkspaceMemory, 'lastEvidenceTime'> {
  const values = [left.lastEvidenceTime, right.lastEvidenceTime].filter((value): value is number => value !== undefined)
  return values.length === 0 ? {} : { lastEvidenceTime: Math.max(...values) }
}

function parseChange(
  value: unknown,
  index: number,
  allowedEvidence: ReadonlySet<string>,
): ConsolidationProposalChange {
  const label = `proposal.changes[${index}]`
  const change = requireRecord(value, label)
  if (change.action === 'replace-global') {
    requireExactKeys(change, ['action', 'content', 'evidence'], label)
    if (typeof change.content !== 'string') {
      throw new ConsolidationProposalError(`${label}.content must be a string`)
    }
    return {
      action: 'replace-global',
      content: change.content,
      evidence: parseEvidence(change.evidence, `${label}.evidence`, allowedEvidence),
    }
  }
  if (change.action === 'put') {
    requireExactKeys(change, ['action', 'record', 'evidence'], label)
    return {
      action: 'put',
      record: parseRecord(change.record, `${label}.record`),
      evidence: parseEvidence(change.evidence, `${label}.evidence`, allowedEvidence),
    }
  }
  if (change.action === 'delete') {
    requireExactKeys(change, ['action', 'name', 'evidence'], label)
    if (typeof change.name !== 'string') {
      throw new ConsolidationProposalError(`${label}.name must be a string`)
    }
    return {
      action: 'delete',
      name: change.name,
      evidence: parseEvidence(change.evidence, `${label}.evidence`, allowedEvidence),
    }
  }
  throw new ConsolidationProposalError(`${label}.action must be replace-global, put, or delete`)
}

function parseRecord(value: unknown, label: string): WorkspaceMemory {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['name', 'description', 'type', 'content'], label)
  if (typeof record.name !== 'string') throw new ConsolidationProposalError(`${label}.name must be a string`)
  if (typeof record.description !== 'string') throw new ConsolidationProposalError(`${label}.description must be a string`)
  if (!isWorkspaceMemoryType(record.type)) {
    throw new ConsolidationProposalError(`${label}.type must be feedback, project, or reference`)
  }
  if (typeof record.content !== 'string') throw new ConsolidationProposalError(`${label}.content must be a string`)
  return {
    name: record.name,
    description: record.description,
    type: record.type,
    content: record.content,
  }
}

function parseEvidence(
  value: unknown,
  label: string,
  allowedEvidence: ReadonlySet<string>,
): ConsolidationEvidenceRange[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConsolidationProposalError(`${label} must be a non-empty array`)
  }
  const ranges = value.map((candidate, index) => {
    const rangeLabel = `${label}[${index}]`
    const range = requireRecord(candidate, rangeLabel)
    requireExactKeys(range, ['fromSeq', 'toSeq'], rangeLabel)
    if (!Number.isSafeInteger(range.fromSeq) || !Number.isSafeInteger(range.toSeq)) {
      throw new ConsolidationProposalError(`${rangeLabel} boundaries must be safe integers`)
    }
    const fromSeq = range.fromSeq as number
    const toSeq = range.toSeq as number
    if (fromSeq > toSeq) throw new ConsolidationProposalError(`${rangeLabel}.fromSeq must not exceed toSeq`)
    if (!allowedEvidence.has(rangeKey(fromSeq, toSeq))) {
      throw new ConsolidationProposalError(`${rangeLabel} must exactly match a supplied evidence turn`)
    }
    return { fromSeq, toSeq }
  })
  return ranges.sort((left, right) => left.fromSeq - right.fromSeq || left.toSeq - right.toSeq)
}

function evidenceRanges(evidence: readonly ConsolidationEvidenceTurn[]): Set<string> {
  const ranges = new Set<string>()
  let previousTo = -1
  for (const [index, turn] of evidence.entries()) {
    if (!Number.isSafeInteger(turn.fromSeq) || !Number.isSafeInteger(turn.toSeq)
      || turn.fromSeq < 0 || turn.fromSeq > turn.toSeq || turn.fromSeq <= previousTo) {
      throw new TypeError(`sourceEvidence[${index}] must have an ordered non-overlapping event range`)
    }
    ranges.add(rangeKey(turn.fromSeq, turn.toSeq))
    previousTo = turn.toSeq
  }
  return ranges
}

function rangeKey(fromSeq: number, toSeq: number): string {
  return `${fromSeq}:${toSeq}`
}

function compareChanges(left: ConsolidationProposalChange, right: ConsolidationProposalChange): number {
  if (left.action === 'replace-global' || right.action === 'replace-global') {
    return left.action === right.action ? 0 : left.action === 'replace-global' ? -1 : 1
  }
  if (left.action !== right.action) return left.action === 'delete' ? -1 : 1
  const leftName = left.action === 'put' ? left.record.name : left.name
  const rightName = right.action === 'put' ? right.record.name : right.name
  return leftName.localeCompare(rightName, 'en')
}

function isWorkspaceChange(change: ConsolidationProposalChange): change is Exclude<ConsolidationProposalChange, { action: 'replace-global' }> {
  return change.action !== 'replace-global'
}

function toMemoryChange(change: Exclude<ConsolidationProposalChange, { action: 'replace-global' }>): WorkspaceMemoryChange {
  return change.action === 'put'
    ? { action: 'put', record: change.record }
    : { action: 'delete', name: change.name }
}

function unchangedGlobalPreview(global: GlobalMemoryView): GlobalMemoryPreview {
  return { ...global, changed: false }
}

function unchangedPreview(workspace: WorkspaceMemoryView): WorkspaceMemoryPreview {
  return {
    changed: false,
    records: workspace.records.map(record => ({ ...record })),
    index: workspace.index,
    revision: workspace.revision,
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConsolidationProposalError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort()
  const canonical = [...expected].sort()
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new ConsolidationProposalError(`${label} must contain exactly: ${canonical.join(', ')}`)
  }
}

function isWorkspaceMemoryType(value: unknown): value is WorkspaceMemoryType {
  return value === 'feedback' || value === 'project' || value === 'reference'
}

type PutChange = Extract<ConsolidationProposalChange, { action: 'put' }>
type DeleteChange = Extract<ConsolidationProposalChange, { action: 'delete' }>
type GlobalChange = Extract<ConsolidationProposalChange, { action: 'replace-global' }>

function recordText(record: WorkspaceMemory): string {
  return `${record.name} ${record.description} ${record.content}`
}

/** isSameTopic ordered by text length, as its (shorter, longer) contract requires. */
function sameTopicPair(a: WorkspaceMemory, b: WorkspaceMemory): boolean {
  const [shorter, longer] = recordText(a).length <= recordText(b).length ? [a, b] : [b, a]
  return isSameTopic(recordText(shorter), recordText(longer))
}

function intersectionOf(a: WorkspaceMemory, b: WorkspaceMemory): number {
  return chunkIntersection(textChunks(recordText(a)), textChunks(recordText(b)))
}

/** Longer content survives first; the absorbed body is demoted and appended. */
function mergedContent(survivor: WorkspaceMemory, absorbed: WorkspaceMemory): string {
  if (absorbed.content.trim() === '') return survivor.content
  // Absorbed content already fully contained in the survivor: folding is a
  // no-op. Appending would double the record and compound across runs.
  const absorbedChunks = textChunks(absorbed.content)
  if (absorbedChunks.size > 0 && chunkIntersection(textChunks(survivor.content), absorbedChunks) === absorbedChunks.size) {
    return survivor.content
  }
  return `${survivor.content}\n\n${demoteHeadings(absorbed.content)}`
}

function longerDescription(a: WorkspaceMemory, b: WorkspaceMemory): string {
  return a.description.length >= b.description.length ? a.description : b.description
}

function mergeEvidenceRanges(
  left: readonly ConsolidationEvidenceRange[],
  right: readonly ConsolidationEvidenceRange[],
): ConsolidationEvidenceRange[] {
  const unique = new Map<string, ConsolidationEvidenceRange>()
  for (const range of [...left, ...right]) {
    unique.set(rangeKey(range.fromSeq, range.toSeq), range)
  }
  return [...unique.values()].sort((a, b) => a.fromSeq - b.fromSeq || a.toSeq - b.toSeq)
}

/**
 * Deterministic dedupe over a parsed proposal (alice-core's consolidation rules):
 * same-topic puts fold into one record, signpost sections are stripped from a
 * Global replacement, and every decision is reported as an audit event.
 * Pure: never mutates the input; the caller owns the failure fallback.
 */
function applyDedupe(
  changes: readonly ConsolidationProposalChange[],
  input: {
    readonly global: GlobalMemoryView
    readonly workspace: WorkspaceMemoryView
  },
  mode: ConsolidationDedupeMode,
): { changes: ConsolidationProposalChange[]; events: ConsolidationDedupeEvent[] } {
  const events: ConsolidationDedupeEvent[] = []
  const globalChange = changes.find((change): change is GlobalChange => change.action === 'replace-global')
  const puts = changes.filter((change): change is PutChange => change.action === 'put')
  const deleteChanges = changes.filter((change): change is DeleteChange => change.action === 'delete')
  const deletedNames = new Set(deleteChanges.map(change => change.name))

  // Phase A: fold each put against same-topic records that already exist.
  const folded: PutChange[] = []
  const pendingDeletes = new Map<string, readonly ConsolidationEvidenceRange[]>()
  for (const put of puts) {
    const existing = input.workspace.records.find(record =>
      record.name !== put.record.name
      && !deletedNames.has(record.name)
      && sameTopicPair(record, put.record))
    if (existing === undefined) {
      folded.push(put)
      continue
    }
    // Time decides content first; length only breaks ties. An older absorbed
    // record must never outweigh a newer surviving one just by being longer.
    const putTime = put.record.lastEvidenceTime ?? 0
    const existingTime = existing.lastEvidenceTime ?? 0
    const contentSurvivorIsNew = putTime !== existingTime
      ? putTime > existingTime
      : put.record.content.length >= existing.content.length
    const nameSurvivorIsNew = mode === 'merge-delete' && contentSurvivorIsNew
    const contentSurvivor = contentSurvivorIsNew ? put.record : existing
    const contentAbsorbed = contentSurvivorIsNew ? existing : put.record
    folded.push({
      action: 'put',
      record: {
        name: nameSurvivorIsNew ? put.record.name : existing.name,
        description: longerDescription(put.record, existing),
        type: nameSurvivorIsNew ? put.record.type : existing.type,
        content: mergedContent(contentSurvivor, contentAbsorbed),
        ...mergedEvidenceTime(put.record, existing),
      },
      evidence: put.evidence,
    })
    if (nameSurvivorIsNew) {
      const prior = pendingDeletes.get(existing.name)
      pendingDeletes.set(existing.name, prior === undefined ? put.evidence : mergeEvidenceRanges(prior, put.evidence))
    }
    events.push({
      kind: 'merged-put',
      kept: nameSurvivorIsNew ? put.record.name : existing.name,
      absorbed: nameSurvivorIsNew ? existing.name : put.record.name,
      intersection: intersectionOf(existing, put.record),
    })
  }

  // Phase B: fold the batch's own puts against each other. The first-comer
  // keeps the name unless the other name is an existing record's name (so an
  // existing record is never orphaned by its own update being folded away).
  const existingNames = new Set(input.workspace.records.map(record => record.name))
  const finalPuts: PutChange[] = []
  for (const put of folded) {
    const twinIndex = finalPuts.findIndex(other => other.record.name === put.record.name)
    if (twinIndex !== -1) {
      const twin = finalPuts[twinIndex]
      if (twin === undefined) continue
      const survivor = put.record.content.length >= twin.record.content.length ? put.record : twin.record
      const absorbed = survivor === put.record ? twin.record : put.record
      finalPuts[twinIndex] = {
        ...twin,
        record: {
          ...survivor,
          description: longerDescription(survivor, absorbed),
          content: mergedContent(survivor, absorbed),
          ...mergedEvidenceTime(survivor, absorbed),
        },
        evidence: mergeEvidenceRanges(twin.evidence, put.evidence),
      }
      events.push({ kind: 'merged-put', kept: twin.record.name, absorbed: put.record.name, intersection: intersectionOf(survivor, absorbed) })
      continue
    }
    const relatedIndex = finalPuts.findIndex(other => other.record.name !== put.record.name && sameTopicPair(other.record, put.record))
    if (relatedIndex !== -1) {
      const related = finalPuts[relatedIndex]
      if (related === undefined) continue
      const survivor = put.record.content.length >= related.record.content.length ? put.record : related.record
      const absorbed = survivor === put.record ? related.record : put.record
      const keptName = existingNames.has(related.record.name) || !existingNames.has(put.record.name)
        ? related.record.name
        : put.record.name
      finalPuts[relatedIndex] = {
        ...related,
        record: {
          name: keptName,
          description: longerDescription(survivor, absorbed),
          type: related.record.type,
          content: mergedContent(survivor, absorbed),
          ...mergedEvidenceTime(survivor, absorbed),
        },
        evidence: mergeEvidenceRanges(related.evidence, put.evidence),
      }
      events.push({ kind: 'merged-put', kept: keptName, absorbed: put.record.name, intersection: intersectionOf(survivor, absorbed) })
      continue
    }
    finalPuts.push(put)
  }

  // A synthesized delete is skipped when the batch itself puts onto that name.
  const synthesizedDeletes: DeleteChange[] = [...pendingDeletes.entries()]
    .filter(([name]) => !finalPuts.some(put => put.record.name === name))
    .map(([name, evidence]) => ({
      action: 'delete' as const,
      name,
      evidence,
    }))

  // Global replacement: strip signpost sections that duplicate a fuller section.
  let globalResult = globalChange
  if (globalChange !== undefined) {
    const stripped = stripSignpostSections(globalChange.content)
    if (stripped !== globalChange.content) {
      for (const heading of droppedSectionHeadings(globalChange.content, stripped)) {
        events.push({ kind: 'dropped-signpost-section', heading })
      }
      globalResult = { ...globalChange, content: stripped }
    }
  }

  const result: ConsolidationProposalChange[] = [
    ...(globalResult === undefined ? [] : [globalResult]),
    ...finalPuts,
    ...deleteChanges,
    ...synthesizedDeletes,
  ]
  result.sort(compareChanges)
  return { changes: result, events }
}

/** Multiset diff of `##` section headings, used to report stripped sections. */
function droppedSectionHeadings(before: string, after: string): string[] {
  const count = (source: string) => {
    const counts = new Map<string, number>()
    for (const match of source.matchAll(/^##\s+(.+)$/gm)) {
      const heading = match[1]
      if (heading === undefined) continue
      const trimmed = heading.trim()
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1)
    }
    return counts
  }
  const beforeCounts = count(before)
  const afterCounts = count(after)
  const dropped: string[] = []
  for (const [heading, occurrences] of beforeCounts) {
    const remaining = afterCounts.get(heading) ?? 0
    for (let index = remaining; index < occurrences; index++) dropped.push(heading)
  }
  return dropped
}

function requireAllowedKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record)
  const actualSet = new Set(actual)
  for (const req of required) {
    if (!actualSet.has(req)) {
      throw new ConsolidationProposalError(`${label} must contain exactly: ${required.join(', ')}`)
    }
  }
  const allowed = new Set([...required, ...optional])
  for (const key of actual) {
    if (!allowed.has(key)) {
      throw new ConsolidationProposalError(`${label} must contain exactly: ${required.join(', ')}`)
    }
  }
}

function candidatePrefix(reviewId: string | undefined): string {
  if (reviewId !== undefined && reviewId.startsWith('review-')) {
    const raw = reviewId.slice(7)
    if (raw.length >= 8) return raw.slice(0, 8)
  }
  return '00000000'
}

function excerptForEvidence(
  evidence: readonly ConsolidationEvidenceRange[],
  turns: readonly ConsolidationEvidenceTurn[],
): string {
  for (const range of evidence) {
    for (const turn of turns) {
      if (turn.fromSeq <= range.toSeq && turn.toSeq >= range.fromSeq) {
        if (turn.user.length > 0 && turn.user[0]) {
          return turn.user[0].slice(0, 240)
        }
        if (turn.summaries.length > 0 && turn.summaries[0]) {
          return turn.summaries[0].slice(0, 240)
        }
        if (turn.assistantFinal) {
          return turn.assistantFinal.slice(0, 240)
        }
      }
    }
  }
  return ''
}
