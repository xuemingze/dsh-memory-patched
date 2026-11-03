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

/** Canonical proposal plus the exact Workspace generation it would produce. */
export interface ConsolidationProposalPlan {
  readonly proposal: ConsolidationProposal
  readonly globalBefore: GlobalMemoryView
  readonly globalPreview: GlobalMemoryPreview
  readonly preview: WorkspaceMemoryPreview
  readonly dedupe?: readonly ConsolidationDedupeEvent[]
  readonly staleChanges?: readonly StaleConsolidationChange[]
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
    readonly dedupe?: ConsolidationDedupeMode
  },
): ConsolidationProposalPlan {
  const candidate = requireRecord(value, 'proposal')
  requireExactKeys(candidate, ['outcome', 'changes'], 'proposal')
  if (!Array.isArray(candidate.changes)) {
    throw new ConsolidationProposalError('proposal.changes must be an array')
  }
  if (candidate.outcome === 'no-change') {
    if (candidate.changes.length !== 0) {
      throw new ConsolidationProposalError('proposal.changes must be empty when outcome is no-change')
    }
    return {
      proposal: { outcome: 'no-change', changes: [] },
      globalBefore: { ...input.global },
      globalPreview: unchangedGlobalPreview(input.global),
      preview: unchangedPreview(input.workspace),
    }
  }
  if (candidate.outcome !== 'changes') {
    throw new ConsolidationProposalError('proposal.outcome must be no-change or changes')
  }
  if (candidate.changes.length === 0) {
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

  const guarded = applyTemporalGuard(changes, input)
  const guardedChanges = guarded.changes
  const stale = guarded.stale.length === 0 ? {} : { staleChanges: guarded.stale }

  const dedupeMode = input.dedupe ?? 'merge'
  let effectiveChanges: readonly ConsolidationProposalChange[] = guardedChanges
  let dedupeEvents: readonly ConsolidationDedupeEvent[] | undefined
  if (dedupeMode !== 'off') {
    try {
      const applied = applyDedupe(guardedChanges, input, dedupeMode)
      effectiveChanges = applied.changes
      if (applied.events.length > 0) dedupeEvents = applied.events
    } catch (cause: unknown) {
      // Dedupe must never break consolidation: fall back to the untouched proposal.
      effectiveChanges = guardedChanges
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
  if (!globalPreview.changed && !preview.changed) {
    return {
      proposal: { outcome: 'no-change', changes: [] },
      globalBefore: { ...input.global }, globalPreview, preview, ...dedupe, ...stale,
    }
  }
  return {
    proposal: { outcome: 'changes', changes: effectiveChanges },
    globalBefore: { ...input.global }, globalPreview, preview, ...dedupe, ...stale,
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
  const pendingDeleteNames = new Set<string>()
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
    if (nameSurvivorIsNew) pendingDeleteNames.add(existing.name)
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
      }
      events.push({ kind: 'merged-put', kept: keptName, absorbed: put.record.name, intersection: intersectionOf(survivor, absorbed) })
      continue
    }
    finalPuts.push(put)
  }

  // A synthesized delete is skipped when the batch itself puts onto that name.
  const synthesizedDeletes: DeleteChange[] = [...pendingDeleteNames]
    .filter(name => !finalPuts.some(put => put.record.name === name))
    .map(name => ({
      action: 'delete' as const,
      name,
      evidence: puts.find(put => put.record.name !== name)!.evidence,
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
