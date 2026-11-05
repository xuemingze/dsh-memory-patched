/** Wide-in strict-out candidate pool: parked proposals awaiting a later verdict. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConsolidationEvidenceRange } from './consolidation-proposal.ts'
import type { WorkspaceMemory } from './memory-store.ts'

/**
 * Why the worker parked a change instead of committing it.
 *
 * `conflict` and `needs-verification` are governance reasons: the change may be
 * right, but it disagrees with something already stored, or nothing was able to
 * check it yet. Parking keeps both sides visible until a deterministic verdict
 * exists, instead of letting the newest write win.
 */
export const CANDIDATE_REASONS = [
  'uncertain',
  'thin',
  'unverified',
  'transient',
  'conflict',
  'needs-verification',
] as const
export type ConsolidationCandidateReason = (typeof CANDIDATE_REASONS)[number]

/** Extra facts recorded when a candidate was parked because of a conflict. */
export interface ConsolidationCandidateConflict {
  /** Stable subject digest shared by the two disagreeing records. */
  readonly claimKey: string
  /** Records that already make the opposite claim. */
  readonly opposingRecords: readonly string[]
  /** Environment bucket the disagreement belongs to. */
  readonly environmentFingerprint: string
}

/** Hard ceiling per Workspace so an unadjudicated pool cannot grow forever. */
export const MAX_CANDIDATE_POOL = 200

/** How many pending candidates one worker run may be asked to adjudicate. */
export const MAX_CANDIDATES_PER_RUN = 20

/** One parked change with the audit facts needed to adjudicate it later. */
export interface ConsolidationCandidateEntry {
  readonly id: string
  readonly workspaceKey: string
  readonly change:
    | { readonly action: 'put'; readonly record: WorkspaceMemory; readonly evidence: readonly ConsolidationEvidenceRange[] }
    | { readonly action: 'delete'; readonly name: string; readonly evidence: readonly ConsolidationEvidenceRange[] }
  readonly reason: ConsolidationCandidateReason
  readonly evidenceExcerpt: string
  readonly lastEvidenceTime: number
  readonly origin: { readonly reviewId: string; readonly sourceSessionId: string }
  readonly proposedAt: string
  /** Present only when the candidate was parked because of a conflict. */
  readonly conflict?: ConsolidationCandidateConflict
}

export class ConsolidationCandidateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConsolidationCandidateError'
  }
}

const ID_PATTERN = /^cand-[a-f0-9]{8}-\d+$/u

/** Validate the governance facts attached to a parked conflict. */
function parseCandidateConflict(value: unknown, label: string): ConsolidationCandidateConflict {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['claimKey', 'opposingRecords', 'environmentFingerprint'], label)
  if (typeof record.claimKey !== 'string' || !/^[a-f0-9]{16}$/u.test(record.claimKey)) {
    throw new ConsolidationCandidateError(`${label}.claimKey must be 16 lowercase hex characters`)
  }
  if (!Array.isArray(record.opposingRecords)
    || record.opposingRecords.some(entry => typeof entry !== 'string' || entry === '')) {
    throw new ConsolidationCandidateError(`${label}.opposingRecords must be a list of record names`)
  }
  if (typeof record.environmentFingerprint !== 'string') {
    throw new ConsolidationCandidateError(`${label}.environmentFingerprint must be a string`)
  }
  return {
    claimKey: record.claimKey,
    opposingRecords: record.opposingRecords as string[],
    environmentFingerprint: record.environmentFingerprint,
  }
}

/** Validate one pool entry coming from disk or from replayed worker evidence. */
export function parseCandidateEntry(value: unknown): ConsolidationCandidateEntry {
  const record = requireRecord(value, 'candidate')
  const coreKeys = [
    'id', 'workspaceKey', 'change', 'reason', 'evidenceExcerpt', 'lastEvidenceTime', 'origin', 'proposedAt',
  ]
  // `conflict` is optional so entries written before governance existed still load.
  requireExactKeys(record, record.conflict === undefined ? coreKeys : [...coreKeys, 'conflict'], 'candidate')
  if (typeof record.id !== 'string' || !ID_PATTERN.test(record.id)) {
    throw new ConsolidationCandidateError('candidate.id must match cand-<hex8>-<n>')
  }
  if (typeof record.workspaceKey !== 'string' || record.workspaceKey.trim() === '') {
    throw new ConsolidationCandidateError('candidate.workspaceKey must be a non-empty string')
  }
  if (typeof record.reason !== 'string' || !CANDIDATE_REASONS.includes(record.reason as ConsolidationCandidateReason)) {
    throw new ConsolidationCandidateError('candidate.reason must be one of ' + CANDIDATE_REASONS.join(', '))
  }
  if (typeof record.evidenceExcerpt !== 'string') {
    throw new ConsolidationCandidateError('candidate.evidenceExcerpt must be a string')
  }
  if (typeof record.lastEvidenceTime !== 'number' || !Number.isSafeInteger(record.lastEvidenceTime) || record.lastEvidenceTime < 0) {
    throw new ConsolidationCandidateError('candidate.lastEvidenceTime must be a non-negative safe integer')
  }
  if (typeof record.proposedAt !== 'string' || record.proposedAt.trim() === '') {
    throw new ConsolidationCandidateError('candidate.proposedAt must be a non-empty string')
  }
  const origin = requireRecord(record.origin, 'candidate.origin')
  requireExactKeys(origin, ['reviewId', 'sourceSessionId'], 'candidate.origin')
  if (typeof origin.reviewId !== 'string' || origin.reviewId.trim() === ''
    || typeof origin.sourceSessionId !== 'string' || origin.sourceSessionId.trim() === '') {
    throw new ConsolidationCandidateError('candidate.origin must carry non-empty review and Session ids')
  }
  const conflict = record.conflict === undefined
    ? undefined
    : parseCandidateConflict(record.conflict, 'candidate.conflict')
  const change = requireRecord(record.change, 'candidate.change')
  const evidence = parseEvidenceRanges(change.evidence, 'candidate.change.evidence')
  if (change.action === 'put') {
    requireExactKeys(change, ['action', 'record', 'evidence'], 'candidate.change')
    return {
      id: record.id,
      workspaceKey: record.workspaceKey,
      change: { action: 'put', record: parseRecord(change.record), evidence },
      reason: record.reason as ConsolidationCandidateReason,
      evidenceExcerpt: record.evidenceExcerpt,
      lastEvidenceTime: record.lastEvidenceTime,
      origin: { reviewId: origin.reviewId, sourceSessionId: origin.sourceSessionId },
      proposedAt: record.proposedAt,
      ...(conflict === undefined ? {} : { conflict }),
    }
  }
  if (change.action === 'delete') {
    requireExactKeys(change, ['action', 'name', 'evidence'], 'candidate.change')
    if (typeof change.name !== 'string' || change.name.trim() === '') {
      throw new ConsolidationCandidateError('candidate.change.name must be a non-empty string')
    }
    return {
      id: record.id,
      workspaceKey: record.workspaceKey,
      change: { action: 'delete', name: change.name, evidence },
      reason: record.reason as ConsolidationCandidateReason,
      evidenceExcerpt: record.evidenceExcerpt,
      lastEvidenceTime: record.lastEvidenceTime,
      origin: { reviewId: origin.reviewId, sourceSessionId: origin.sourceSessionId },
      proposedAt: record.proposedAt,
      ...(conflict === undefined ? {} : { conflict }),
    }
  }
  throw new ConsolidationCandidateError('candidate.change.action must be put or delete')
}

function parseRecord(value: unknown): WorkspaceMemory {
  const record = requireRecord(value, 'candidate.change.record')
  requireExactKeys(record, ['name', 'description', 'type', 'content'], 'candidate.change.record')
  if (typeof record.name !== 'string' || typeof record.description !== 'string'
    || typeof record.content !== 'string') {
    throw new ConsolidationCandidateError('candidate.change.record string fields are invalid')
  }
  if (record.type !== 'feedback' && record.type !== 'project' && record.type !== 'reference') {
    throw new ConsolidationCandidateError('candidate.change.record.type must be feedback, project, or reference')
  }
  return {
    name: record.name,
    description: record.description,
    type: record.type,
    content: record.content,
  }
}

function parseEvidenceRanges(value: unknown, label: string): ConsolidationEvidenceRange[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConsolidationCandidateError(`${label} must be a non-empty array`)
  }
  return value.map((range, index) => {
    const record = requireRecord(range, `${label}[${index}]`)
    requireExactKeys(record, ['fromSeq', 'toSeq'], `${label}[${index}]`)
    if (!Number.isSafeInteger(record.fromSeq) || !Number.isSafeInteger(record.toSeq)
      || (record.fromSeq as number) > (record.toSeq as number)) {
      throw new ConsolidationCandidateError(`${label}[${index}] boundaries are invalid`)
    }
    return { fromSeq: record.fromSeq as number, toSeq: record.toSeq as number }
  })
}

/**
 * JSONL pool under `<memory root>/candidates/<workspaceKey>.jsonl`. One file
 * per Workspace, one in-process lock per file, atomic tmp+rename writes. A
 * corrupt or hand-edited file degrades to an empty pool with a warning, the
 * same contract the settings and receipt stores already follow.
 */
export class ConsolidationCandidatePool {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(readonly directory: string) {}

  /** All parked entries for one Workspace, oldest first. */
  list(workspaceKey: string): ConsolidationCandidateEntry[] {
    return this.read(workspaceKey)
  }

  /** The bounded window one worker run is asked to adjudicate, oldest first. */
  listForInput(workspaceKey: string): ConsolidationCandidateEntry[] {
    return this.read(workspaceKey).slice(0, MAX_CANDIDATES_PER_RUN)
  }

  /** Append entries idempotently by id; overflow drops the oldest. */
  park(workspaceKey: string, entries: readonly ConsolidationCandidateEntry[]): void {
    if (entries.length === 0) return
    this.withLock(workspaceKey, () => {
      const current = this.read(workspaceKey)
      const known = new Set(current.map(entry => entry.id))
      const merged = [...current]
      for (const entry of entries) {
        if (entry.workspaceKey !== workspaceKey) {
          throw new ConsolidationCandidateError(`candidate ${entry.id} belongs to another Workspace`)
        }
        if (known.has(entry.id)) continue
        known.add(entry.id)
        merged.push(entry)
      }
      const overflow = Math.max(0, merged.length - MAX_CANDIDATE_POOL)
      this.write(workspaceKey, overflow === 0 ? merged : merged.slice(overflow))
    })
  }

  /** Drop adjudicated ids; unknown ids are tolerated so recovery stays idempotent. */
  remove(workspaceKey: string, ids: readonly string[]): void {
    if (ids.length === 0) return
    this.withLock(workspaceKey, () => {
      const drop = new Set(ids)
      this.write(workspaceKey, this.read(workspaceKey).filter(entry => !drop.has(entry.id)))
    })
  }

  private read(workspaceKey: string): ConsolidationCandidateEntry[] {
    const path = this.pathFor(workspaceKey)
    if (!existsSync(path)) return []
    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch (error: unknown) {
      warnUnreadable(workspaceKey, error)
      return []
    }
    const entries: ConsolidationCandidateEntry[] = []
    for (const line of source.split('\n')) {
      if (line.trim() === '') continue
      try {
        const entry = parseCandidateEntry(JSON.parse(line))
        if (entry.workspaceKey === workspaceKey) entries.push(entry)
      } catch (error: unknown) {
        warnUnreadable(workspaceKey, error)
      }
    }
    return entries
  }

  private write(workspaceKey: string, entries: readonly ConsolidationCandidateEntry[]): void {
    mkdirSync(this.directory, { recursive: true })
    const temporary = `${this.pathFor(workspaceKey)}.tmp-${randomUUID()}`
    writeFileSync(temporary, entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length === 0 ? '' : '\n'), 'utf8')
    renameSync(temporary, this.pathFor(workspaceKey))
  }

  private pathFor(workspaceKey: string): string {
    return join(this.directory, `${workspaceKey}.jsonl`)
  }

  private withLock<T>(workspaceKey: string, body: () => T): T {
    const previous = this.locks.get(workspaceKey) ?? Promise.resolve()
    let release: (() => void) | undefined
    const current = new Promise<void>((resolveLock) => { release = resolveLock })
    const queued = previous.then(() => current)
    this.locks.set(workspaceKey, queued)
    void previous.catch(() => undefined)
    // The lock queue is synchronous-only today; awaiting the previous link keeps
    // the map coherent if that ever changes.
    try {
      return body()
    } finally {
      release?.()
      if (this.locks.get(workspaceKey) === queued) this.locks.delete(workspaceKey)
    }
  }
}

function warnUnreadable(workspaceKey: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`[dsh-memory] ignoring unreadable memory candidate entry for ${workspaceKey}: ${message}`)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConsolidationCandidateError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort()
  const canonical = [...expected].sort()
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new ConsolidationCandidateError(`${label} must contain exactly: ${canonical.join(', ')}`)
  }
}
