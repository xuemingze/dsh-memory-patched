/** Atomic review receipts and the Workspace consolidation commit barrier. */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import type {
  ConsolidationEvidenceRange,
  ConsolidationProposalChange,
  ConsolidationProposalPlan,
} from './consolidation-proposal.ts'
import type { ConsolidationWorkerConfig } from './consolidation-worker.ts'
import {
  MemoryConflictError,
  type MarkdownMemoryStore,
  type WorkspaceMemoryChange,
  type WorkspaceTarget,
} from './memory-store.ts'
import type { MemoryRevision } from './protocol.ts'
import type { SessionConsolidationInput, SessionConsolidator } from './session-consolidator.ts'
import { isConsolidationReviewId } from './consolidation-identity.ts'

const RECEIPT_FORMAT = 1

export type ConsolidationReceiptState =
  | 'committing'
  | 'committed'
  | 'no-change'
  | 'cancelled'
  | 'source-changed'
  | 'target-conflict'
  | 'invalid-proposal'
  | 'provider-failed'
  | 'evidence-too-large'
  | 'internal-error'

export interface ConsolidationReceiptAttempt {
  readonly attempt: number
  readonly workerSessionId: string | null
  readonly provider: string
  readonly model: string
  readonly status: 'proposed' | Exclude<ConsolidationReceiptState, 'committing'>
}

export interface ConsolidationReceiptChange {
  readonly action: 'replace-global' | 'put' | 'delete'
  readonly name: string
  readonly type?: 'feedback' | 'project' | 'reference'
  readonly evidence: readonly ConsolidationEvidenceRange[]
  readonly contentHash?: string
}

/** Minimal Host audit record. It deliberately excludes proposal and memory bodies. */
export interface ConsolidationReceipt {
  readonly format: 1
  readonly reviewId: string
  readonly consolidatorVersion: string
  readonly sourceSessionId: string
  readonly sourceRevision: string
  readonly coveredSeq: { readonly from: number; readonly to: number } | null
  readonly workspaceKey: string
  readonly beforeRevision: MemoryRevision
  readonly plannedAfterRevision: MemoryRevision
  readonly state: ConsolidationReceiptState
  readonly attempts: readonly ConsolidationReceiptAttempt[]
  readonly proposalHash: string
  readonly changes: readonly ConsolidationReceiptChange[]
  readonly createdAt: string
  readonly completedAt?: string
}

export interface ConsolidationCommitInput {
  readonly input: SessionConsolidationInput
  readonly plan: ConsolidationProposalPlan
  readonly attempt: number
  readonly workerSessionId: string | null
  readonly workerConfig: Pick<ConsolidationWorkerConfig, 'provider' | 'model'>
  readonly signal?: AbortSignal
}

export interface ConsolidationCommitResult {
  readonly outcome: 'committed' | 'no-change' | 'target-conflict'
  readonly recovered: boolean
  readonly receipt: ConsolidationReceipt
}

export interface ConsolidationFailureInput {
  readonly input: SessionConsolidationInput
  readonly attempt: number
  readonly workerSessionId: string
  readonly workerConfig: Pick<ConsolidationWorkerConfig, 'provider' | 'model'>
  readonly state: Exclude<ConsolidationReceiptState, 'committing' | 'committed' | 'no-change' | 'target-conflict'>
}

export class ConsolidationReceiptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConsolidationReceiptError'
  }
}

/** Markdown receipt storage with one in-process lock per deterministic review id. */
export class ConsolidationReceiptStore {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(
    readonly directory: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  read(reviewId: string): ConsolidationReceipt | undefined {
    assertReviewId(reviewId)
    const path = this.pathFor(reviewId)
    if (!existsSync(path)) return
    return parseReceipt(readFileSync(path, 'utf8'), reviewId)
  }

  /** Discover durable commit intents for one source Session without reading Session storage. */
  listCommittingBySourceSession(sourceSessionId: string): ConsolidationReceipt[] {
    if (sourceSessionId.trim() === '') throw new TypeError('source Session id must not be empty')
    if (!existsSync(this.directory)) return []
    return readdirSync(this.directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^review-[a-f0-9]{64}\.md$/u.test(entry.name))
      .map(entry => this.readScanned(entry.name.slice(0, -3)))
      .filter((receipt): receipt is ConsolidationReceipt => receipt !== undefined)
      .filter(receipt => receipt.sourceSessionId === sourceSessionId && receipt.state === 'committing')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.reviewId.localeCompare(right.reviewId))
  }

  /** Return the newest receipt for a source Session, preferring the current source revision. */
  latestBySourceSession(sourceSessionId: string, sourceRevision: string): ConsolidationReceipt | undefined {
    if (sourceSessionId.trim() === '') throw new TypeError('source Session id must not be empty')
    return this.latestBySourceSessions(new Map([[sourceSessionId, sourceRevision]])).get(sourceSessionId)
  }

  /** Scan receipts once for a complete Session catalog refresh. */
  latestBySourceSessions(sourceRevisions: ReadonlyMap<string, string>): Map<string, ConsolidationReceipt> {
    const selected = new Map<string, ConsolidationReceipt>()
    for (const receipt of this.listAll()) {
      const sourceRevision = sourceRevisions.get(receipt.sourceSessionId)
      if (sourceRevision === undefined) continue
      const current = selected.get(receipt.sourceSessionId)
      if (current === undefined
        || shouldPreferReceipt(receipt, current, sourceRevision)) {
        selected.set(receipt.sourceSessionId, receipt)
      }
    }
    return selected
  }

  write(receipt: ConsolidationReceipt): void {
    const validated = parseReceiptDocument(receipt, receipt.reviewId)
    mkdirSync(this.directory, { recursive: true })
    atomicWrite(this.pathFor(validated.reviewId), serializeReceipt(validated))
  }

  timestamp(): string {
    return this.now().toISOString()
  }

  async withReviewLock<T>(reviewId: string, body: () => Promise<T>): Promise<T> {
    assertReviewId(reviewId)
    const previous = this.locks.get(reviewId) ?? Promise.resolve()
    let release: (() => void) | undefined
    const current = new Promise<void>((resolveLock) => { release = resolveLock })
    const queued = previous.then(() => current)
    this.locks.set(reviewId, queued)
    await previous
    try {
      return await body()
    } finally {
      release?.()
      if (this.locks.get(reviewId) === queued) this.locks.delete(reviewId)
    }
  }

  private pathFor(reviewId: string): string {
    return join(this.directory, `${reviewId}.md`)
  }

  private listAll(): ConsolidationReceipt[] {
    if (!existsSync(this.directory)) return []
    return readdirSync(this.directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^review-[a-f0-9]{64}\.md$/u.test(entry.name))
      .map(entry => this.readScanned(entry.name.slice(0, -3)))
      .filter((receipt): receipt is ConsolidationReceipt => receipt !== undefined)
  }

  /**
   * Batch scans must tolerate one corrupt or hand-edited receipt file: skip it
   * with a warning instead of failing the whole consolidation pipeline. Direct
   * reads (`read`) stay strict so a targeted commit still fails loudly.
   */
  private readScanned(reviewId: string): ConsolidationReceipt | undefined {
    try {
      return this.read(reviewId)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[dsh-memory] ignoring unreadable consolidation receipt ${reviewId}: ${message}`)
      return undefined
    }
  }
}

function compareReceiptNewestFirst(left: ConsolidationReceipt, right: ConsolidationReceipt): number {
  const leftTimestamp = left.completedAt ?? left.createdAt
  const rightTimestamp = right.completedAt ?? right.createdAt
  return rightTimestamp.localeCompare(leftTimestamp) || right.reviewId.localeCompare(left.reviewId)
}

function shouldPreferReceipt(
  candidate: ConsolidationReceipt,
  current: ConsolidationReceipt,
  sourceRevision: string,
): boolean {
  const candidateMatches = candidate.sourceRevision === sourceRevision
  const currentMatches = current.sourceRevision === sourceRevision
  if (candidateMatches !== currentMatches) return candidateMatches
  return compareReceiptNewestFirst(candidate, current) < 0
}

/** Own the pre-commit recheck, durable intent, CAS commit, and crash convergence. */
export class ConsolidationCommitCoordinator {
  constructor(
    private readonly memory: MarkdownMemoryStore,
    private readonly consolidator: SessionConsolidator,
    private readonly receipts: ConsolidationReceiptStore,
  ) {}

  commit(request: ConsolidationCommitInput): Promise<ConsolidationCommitResult> {
    return this.receipts.withReviewLock(request.input.reviewId, () => this.commitWithinReviewLock(request))
  }

  /** Commit when the caller already owns the review lock across the model attempt. */
  async commitWithinReviewLock(request: ConsolidationCommitInput): Promise<ConsolidationCommitResult> {
    request.signal?.throwIfAborted()
    const existing = this.receipts.read(request.input.reviewId)
    if (existing?.state === 'committed' || existing?.state === 'no-change') {
      return { outcome: existing.state, recovered: true, receipt: existing }
    }
    if (existing?.state === 'committing') {
      assertPlanMatchesReceipt(existing, request)
      // The recovery target is owned by the receipt, not by whatever scope the
      // caller presents: two empty Workspaces share one revision, so trusting
      // request.input.workspace.scope could commit the plan into the wrong
      // Workspace directory.
      return this.recoverReceiptWithinReviewLock(existing, this.memory.workspaceTargetForKey(existing.workspaceKey), request.plan)
    }

    await this.consolidator.assertSourceStable(request.input, request.signal)
    request.signal?.throwIfAborted()
    const [currentGlobal, current] = await Promise.all([
      this.memory.readGlobal(),
      this.memory.readWorkspace(request.input.workspace.scope),
    ])
    if (currentGlobal.revision !== request.input.global.revision
      || current.revision !== request.input.workspace.revision) {
      return this.finishConflict(createReceipt(request, this.receipts.timestamp(), existing))
    }

    const receipt = createReceipt(request, this.receipts.timestamp(), existing)
    if (request.plan.proposal.outcome === 'no-change') {
      const completed = completeReceipt(receipt, 'no-change', this.receipts.timestamp())
      this.receipts.write(completed)
      return { outcome: 'no-change', recovered: false, receipt: completed }
    }

    this.receipts.write(receipt)
    return this.publish(receipt, request.input.workspace.scope, request.plan, false)
  }

  /** Recover one already locked durable intent, optionally without loading a plan when already committed/conflicted. */
  async recoverReceiptWithinReviewLock(
    receipt: ConsolidationReceipt,
    target: WorkspaceTarget,
    plan?: ConsolidationProposalPlan,
  ): Promise<ConsolidationCommitResult> {
    if (plan === undefined) throw new ConsolidationReceiptError('Recovery plan is required')
    assertRecoveryPlanMatchesReceipt(receipt, plan)
    const [global, current] = await Promise.all([this.memory.readGlobal(), this.memory.readWorkspace(target)])
    const globalKnown = global.revision === plan.globalBefore.revision || global.revision === plan.globalPreview.revision
    const workspaceKnown = current.revision === receipt.beforeRevision || current.revision === receipt.plannedAfterRevision
    if (!globalKnown || !workspaceKnown) return this.finishConflict(receipt, true)
    if (global.revision === plan.globalPreview.revision && current.revision === receipt.plannedAfterRevision) {
      const completed = completeReceipt(receipt, 'committed', this.receipts.timestamp())
      this.receipts.write(completed)
      return { outcome: 'committed', recovered: true, receipt: completed }
    }
    return this.publish(receipt, target, plan, true)
  }

  private async publish(
    receipt: ConsolidationReceipt,
    target: WorkspaceTarget,
    plan: ConsolidationProposalPlan,
    recovered: boolean,
  ): Promise<ConsolidationCommitResult> {
    try {
      const currentGlobal = await this.memory.readGlobal()
      if (currentGlobal.revision !== plan.globalBefore.revision
        && currentGlobal.revision !== plan.globalPreview.revision) {
        throw new MemoryConflictError(currentGlobal.revision)
      }
      if (plan.globalPreview.changed && currentGlobal.revision === plan.globalBefore.revision) {
        const committed = await this.memory.commitGlobal({
          expectedRevision: plan.globalBefore.revision,
          content: plan.globalPreview.content,
        })
        if (committed.revision !== plan.globalPreview.revision) {
          throw new ConsolidationReceiptError('Global commit revision does not match the durable plan')
        }
      }
      const workspaceChanges = plan.proposal.changes.flatMap(change => (
        isWorkspaceProposalChange(change) ? [toWorkspaceChange(change)] : []
      ))
      const currentWorkspace = await this.memory.readWorkspace(target)
      if (currentWorkspace.revision !== receipt.beforeRevision
        && currentWorkspace.revision !== receipt.plannedAfterRevision) {
        throw new MemoryConflictError(currentWorkspace.revision)
      }
      if (workspaceChanges.length > 0 && currentWorkspace.revision === receipt.beforeRevision) {
        const committed = await this.memory.commitWorkspace({
          scope: target,
          expectedRevision: receipt.beforeRevision,
          changes: workspaceChanges,
        })
        if (committed.revision !== receipt.plannedAfterRevision) {
          throw new ConsolidationReceiptError('Workspace commit revision does not match the durable plan')
        }
      }
      const completed = completeReceipt(receipt, 'committed', this.receipts.timestamp())
      this.receipts.write(completed)
      return { outcome: 'committed', recovered, receipt: completed }
    } catch (error: unknown) {
      if (!(error instanceof MemoryConflictError)) throw error
      return this.finishConflict(receipt, recovered)
    }
  }

  private finishConflict(
    receipt: ConsolidationReceipt,
    recovered = false,
  ): ConsolidationCommitResult {
    const completed = completeReceipt(receipt, 'target-conflict', this.receipts.timestamp())
    this.receipts.write(completed)
    return { outcome: 'target-conflict', recovered, receipt: completed }
  }
}

export function proposalHash(plan: ConsolidationProposalPlan): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(plan.proposal), 'utf8').digest('hex')}`
}

/** Create one terminal pre-barrier failure while preserving prior attempt history. */
export function createFailedConsolidationReceipt(
  request: ConsolidationFailureInput,
  timestamp: string,
  previous?: ConsolidationReceipt,
): ConsolidationReceipt {
  const attempts = [
    ...(previous?.attempts ?? []),
    {
      attempt: request.attempt,
      workerSessionId: request.workerSessionId,
      provider: request.workerConfig.provider,
      model: request.workerConfig.model,
      status: request.state,
    },
  ]
  return {
    format: RECEIPT_FORMAT,
    reviewId: request.input.reviewId,
    consolidatorVersion: request.input.consolidatorVersion,
    sourceSessionId: request.input.source.sessionId,
    sourceRevision: request.input.source.revision,
    coveredSeq: coveredSeqOf(request.input.source.events),
    workspaceKey: request.input.workspace.scope.key,
    beforeRevision: request.input.workspace.revision,
    plannedAfterRevision: request.input.workspace.revision,
    state: request.state,
    attempts,
    proposalHash: 'none',
    changes: [],
    createdAt: previous?.createdAt ?? timestamp,
    completedAt: timestamp,
  }
}

function createReceipt(
  request: ConsolidationCommitInput,
  createdAt: string,
  previous?: ConsolidationReceipt,
): ConsolidationReceipt {
  const events = request.input.source.events
  const attempt = {
    attempt: request.attempt,
    workerSessionId: request.workerSessionId,
    provider: request.workerConfig.provider,
    model: request.workerConfig.model,
    status: 'proposed' as const,
  }
  return {
    format: RECEIPT_FORMAT,
    reviewId: request.input.reviewId,
    consolidatorVersion: request.input.consolidatorVersion,
    sourceSessionId: request.input.source.sessionId,
    sourceRevision: request.input.source.revision,
    coveredSeq: coveredSeqOf(events),
    workspaceKey: request.input.workspace.scope.key,
    beforeRevision: request.input.workspace.revision,
    plannedAfterRevision: request.plan.preview.revision,
    state: 'committing',
    attempts: [...(previous?.attempts ?? []), attempt],
    proposalHash: proposalHash(request.plan),
    changes: request.plan.proposal.changes.map(summarizeChange),
    createdAt: previous?.createdAt ?? createdAt,
  }
}

function completeReceipt(
  receipt: ConsolidationReceipt,
  state: 'committed' | 'no-change' | 'target-conflict',
  completedAt: string,
): ConsolidationReceipt {
  const attempts = receipt.attempts.map((attempt, index) => index === receipt.attempts.length - 1
    ? { ...attempt, status: state }
    : attempt)
  return { ...receipt, state, attempts, completedAt }
}

function coveredSeqOf(events: readonly unknown[]): { from: number; to: number } | null {
  const seq = events.map((event) => {
    if (event === null || typeof event !== 'object') throw new TypeError('source event must be an object')
    const value = (event as { seq?: unknown }).seq
    if (!Number.isSafeInteger(value)) throw new TypeError('source event seq must be a safe integer')
    return value as number
  })
  return seq.length === 0 ? null : { from: seq[0]!, to: seq.at(-1)! }
}

function assertPlanMatchesReceipt(receipt: ConsolidationReceipt, request: ConsolidationCommitInput): void {
  if (receipt.reviewId !== request.input.reviewId
    || receipt.beforeRevision !== request.input.workspace.revision
    || receipt.plannedAfterRevision !== request.plan.preview.revision
    || request.plan.globalBefore.revision !== request.input.global.revision
    || receipt.proposalHash !== proposalHash(request.plan)) {
    throw new ConsolidationReceiptError('Recovery plan does not match the committing receipt')
  }
}

function assertRecoveryPlanMatchesReceipt(receipt: ConsolidationReceipt, plan: ConsolidationProposalPlan): void {
  if (receipt.plannedAfterRevision !== plan.preview.revision
    || receipt.proposalHash !== proposalHash(plan)) {
    throw new ConsolidationReceiptError('Recovery plan does not match the committing receipt')
  }
}

function summarizeChange(change: ConsolidationProposalChange): ConsolidationReceiptChange {
  if (change.action === 'replace-global') {
    return {
      action: 'replace-global',
      name: 'GLOBAL.md',
      evidence: change.evidence.map(range => ({ ...range })),
      contentHash: `sha256:${createHash('sha256').update(change.content, 'utf8').digest('hex')}`,
    }
  }
  if (change.action === 'delete') {
    return { action: 'delete', name: change.name, evidence: change.evidence.map(range => ({ ...range })) }
  }
  return {
    action: 'put',
    name: change.record.name,
    type: change.record.type,
    evidence: change.evidence.map(range => ({ ...range })),
    contentHash: `sha256:${createHash('sha256').update(change.record.content, 'utf8').digest('hex')}`,
  }
}

function toWorkspaceChange(change: Exclude<ConsolidationProposalChange, { action: 'replace-global' }>): WorkspaceMemoryChange {
  return change.action === 'put'
    ? { action: 'put', record: change.record }
    : { action: 'delete', name: change.name }
}

function isWorkspaceProposalChange(
  change: ConsolidationProposalChange,
): change is Exclude<ConsolidationProposalChange, { action: 'replace-global' }> {
  return change.action !== 'replace-global'
}

function serializeReceipt(receipt: ConsolidationReceipt): string {
  return `---\n${stringify(receipt, { lineWidth: 0 }).trimEnd()}\n---\n\n# Session Consolidation Receipt\n`
}

function parseReceipt(source: string, expectedReviewId: string): ConsolidationReceipt {
  // Receipts are Markdown files a user may open in any editor; tolerate CRLF line endings.
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(source.replace(/\r\n/gu, '\n'))
  if (match?.[1] === undefined) throw new ConsolidationReceiptError('receipt must contain YAML frontmatter')
  try {
    return parseReceiptDocument(parse(match[1]), expectedReviewId)
  } catch (error: unknown) {
    if (error instanceof ConsolidationReceiptError) throw error
    throw new ConsolidationReceiptError('receipt frontmatter is invalid', { cause: error })
  }
}

function parseReceiptDocument(value: unknown, expectedReviewId: string): ConsolidationReceipt {
  const record = requireObject(value, 'receipt')
  const required = [
    'format', 'reviewId', 'consolidatorVersion', 'sourceSessionId', 'sourceRevision', 'coveredSeq',
    'workspaceKey', 'beforeRevision', 'plannedAfterRevision', 'state', 'attempts', 'proposalHash',
    'changes', 'createdAt',
  ]
  const allowed = new Set([...required, 'completedAt'])
  if (Object.keys(record).some(key => !allowed.has(key)) || required.some(key => !(key in record))) {
    throw new ConsolidationReceiptError('receipt contains missing or unknown fields')
  }
  if (record.format !== RECEIPT_FORMAT) throw new ConsolidationReceiptError('unsupported receipt format')
  if (record.reviewId !== expectedReviewId) throw new ConsolidationReceiptError('receipt review id mismatch')
  assertReviewId(expectedReviewId)
  for (const key of ['consolidatorVersion', 'sourceSessionId', 'sourceRevision', 'workspaceKey', 'beforeRevision', 'plannedAfterRevision', 'proposalHash', 'createdAt']) {
    if (typeof record[key] !== 'string' || record[key] === '') throw new ConsolidationReceiptError(`receipt.${key} must be a non-empty string`)
  }
  if (!isReceiptState(record.state)) throw new ConsolidationReceiptError('receipt.state is invalid')
  if (!Array.isArray(record.attempts) || !Array.isArray(record.changes)) {
    throw new ConsolidationReceiptError('receipt attempts and changes must be arrays')
  }
  const coveredSeq = parseCoveredSeq(record.coveredSeq)
  const attempts = record.attempts.map(parseAttempt)
  const changes = record.changes.map(parseChangeSummary)
  if (record.completedAt !== undefined && typeof record.completedAt !== 'string') {
    throw new ConsolidationReceiptError('receipt.completedAt must be a string')
  }
  return {
    format: 1,
    reviewId: record.reviewId as string,
    consolidatorVersion: record.consolidatorVersion as string,
    sourceSessionId: record.sourceSessionId as string,
    sourceRevision: record.sourceRevision as string,
    coveredSeq,
    workspaceKey: record.workspaceKey as string,
    beforeRevision: record.beforeRevision as MemoryRevision,
    plannedAfterRevision: record.plannedAfterRevision as MemoryRevision,
    state: record.state,
    attempts,
    proposalHash: record.proposalHash as string,
    changes,
    createdAt: record.createdAt as string,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
  }
}

function parseAttempt(value: unknown, index: number): ConsolidationReceiptAttempt {
  const record = requireExactObject(value, ['attempt', 'workerSessionId', 'provider', 'model', 'status'], `attempts[${index}]`)
  if (!Number.isSafeInteger(record.attempt) || (record.attempt as number) < 1) {
    throw new ConsolidationReceiptError(`attempts[${index}].attempt is invalid`)
  }
  for (const key of ['provider', 'model']) {
    if (typeof record[key] !== 'string' || record[key] === '') throw new ConsolidationReceiptError(`attempts[${index}].${key} is invalid`)
  }
  if (record.workerSessionId !== null
    && (typeof record.workerSessionId !== 'string' || record.workerSessionId === '')) {
    throw new ConsolidationReceiptError(`attempts[${index}].workerSessionId is invalid`)
  }
  if (record.status !== 'proposed'
    && (!isReceiptState(record.status) || record.status === 'committing')) {
    throw new ConsolidationReceiptError(`attempts[${index}].status is invalid`)
  }
  return record as unknown as ConsolidationReceiptAttempt
}

function parseChangeSummary(value: unknown, index: number): ConsolidationReceiptChange {
  const record = requireObject(value, `changes[${index}]`)
  const expected = record.action === 'put'
    ? ['action', 'name', 'type', 'evidence', 'contentHash']
    : record.action === 'replace-global'
      ? ['action', 'name', 'evidence', 'contentHash']
    : ['action', 'name', 'evidence']
  requireExactKeys(record, expected, `changes[${index}]`)
  if (record.action !== 'replace-global' && record.action !== 'put' && record.action !== 'delete') {
    throw new ConsolidationReceiptError(`changes[${index}].action is invalid`)
  }
  if (typeof record.name !== 'string' || record.name === '') throw new ConsolidationReceiptError(`changes[${index}].name is invalid`)
  if (!Array.isArray(record.evidence)) throw new ConsolidationReceiptError(`changes[${index}].evidence is invalid`)
  const evidence = record.evidence.map((range, rangeIndex) => parseEvidenceRange(range, `changes[${index}].evidence[${rangeIndex}]`))
  if (record.action === 'delete') return { action: 'delete', name: record.name, evidence }
  if (record.action === 'replace-global') {
    if (record.name !== 'GLOBAL.md' || typeof record.contentHash !== 'string' || !record.contentHash.startsWith('sha256:')) {
      throw new ConsolidationReceiptError(`changes[${index}] Global summary is invalid`)
    }
    return { action: 'replace-global', name: 'GLOBAL.md', evidence, contentHash: record.contentHash }
  }
  if (record.type !== 'feedback' && record.type !== 'project' && record.type !== 'reference') {
    throw new ConsolidationReceiptError(`changes[${index}].type is invalid`)
  }
  if (typeof record.contentHash !== 'string' || !record.contentHash.startsWith('sha256:')) {
    throw new ConsolidationReceiptError(`changes[${index}].contentHash is invalid`)
  }
  return { action: 'put', name: record.name, type: record.type, evidence, contentHash: record.contentHash }
}

function parseCoveredSeq(value: unknown): { from: number; to: number } | null {
  if (value === null) return null
  const record = requireExactObject(value, ['from', 'to'], 'coveredSeq')
  if (!Number.isSafeInteger(record.from) || !Number.isSafeInteger(record.to) || (record.from as number) > (record.to as number)) {
    throw new ConsolidationReceiptError('receipt.coveredSeq is invalid')
  }
  return { from: record.from as number, to: record.to as number }
}

function parseEvidenceRange(value: unknown, label: string): ConsolidationEvidenceRange {
  const record = requireExactObject(value, ['fromSeq', 'toSeq'], label)
  if (!Number.isSafeInteger(record.fromSeq) || !Number.isSafeInteger(record.toSeq)
    || (record.fromSeq as number) > (record.toSeq as number)) {
    throw new ConsolidationReceiptError(`${label} is invalid`)
  }
  return { fromSeq: record.fromSeq as number, toSeq: record.toSeq as number }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConsolidationReceiptError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireExactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const record = requireObject(value, label)
  requireExactKeys(record, keys, label)
  return record
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ConsolidationReceiptError(`${label} contains missing or unknown fields`)
  }
}

function isReceiptState(value: unknown): value is ConsolidationReceiptState {
  return value === 'committing' || value === 'committed' || value === 'no-change'
    || value === 'cancelled' || value === 'source-changed' || value === 'target-conflict'
    || value === 'invalid-proposal' || value === 'provider-failed' || value === 'evidence-too-large'
    || value === 'internal-error'
}

function assertReviewId(reviewId: string): void {
  if (!isConsolidationReviewId(reviewId)) throw new ConsolidationReceiptError('invalid review id')
}

function atomicWrite(path: string, source: string): void {
  const temporary = `${path}.tmp-${randomUUID()}`
  writeFileSync(temporary, source, 'utf8')
  renameSync(temporary, path)
}
