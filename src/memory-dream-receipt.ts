/**
 * Dream receipts, applying a plan, and replay.
 *
 * A receipt is an audit record, not a second copy of memory. It stores what a run
 * decided and which handles it touched — never a memory body. Anything that needs
 * the prose reads Markdown, which stays the single source of truth.
 *
 * Applying a plan is deliberately conservative. The model planned against a
 * snapshot; if the store has moved on since then, applying anyway would target
 * the wrong record silently, so the whole plan is refused.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DreamAction, DreamPlan, DreamProposalContext, DreamRisk } from './memory-dream-proposal.ts'
import { planActionFingerprint, toApprovable } from './memory-dream-approval.ts'
import { GlobalGuardError, applyGlobalPromotion, parseGlobalSections } from './memory-global-guard.ts'
import {
  DEFAULT_DREAM_WORKER_CONFIG,
  DreamWorkerError,
  runDreamWorker,
  type DreamModelRequest,
  type DreamWorkerConfig,
} from './memory-dream-worker.ts'
import type { MemoryGovernanceStore } from './memory-governance-store.ts'
import type { GovernanceClaim, GovernanceClaimInput, Lifecycle } from './memory-governance-types.ts'

/** Bumped only if the on-disk receipt shape changes incompatibly. */
export const DREAM_RECEIPT_FORMAT = 1

export type DreamReceiptState =
  | 'committed'
  | 'no-change'
  | 'rejected'
  | 'stale-scope'
  | 'output-truncated'
  | 'provider-failed'
  | 'internal-error'

/** One action as recorded in a receipt: handles only, never prose. */
export interface DreamReceiptChange {
  readonly action: string
  readonly target: string
  /** For merge/extract-sop: the records that were combined. */
  readonly sources?: readonly string[]
}

export interface DreamReceipt {
  readonly format: number
  readonly runId: string
  readonly scopeKey: string
  readonly state: DreamReceiptState
  readonly attempt: number
  readonly provider: string
  readonly model: string
  readonly beforeRevision: string
  readonly afterRevision: string
  readonly proposalHash: string
  readonly risk: DreamRisk
  readonly changes: readonly DreamReceiptChange[]
  readonly createdAt: string
  readonly completedAt?: string
  readonly error?: string
}

export type DreamReceiptInput = Omit<DreamReceipt, 'format'>

/** Raised for a run id that would escape the store directory. */
export class DreamReceiptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DreamReceiptError'
  }
}

/**
 * Flat-file receipt store: one JSON per run under `<root>/dream/`.
 *
 * A corrupt file is skipped rather than thrown, so one bad run cannot hide every
 * other run from the panel.
 */
export class DreamReceiptStore {
  readonly #root: string

  constructor(memoryRoot: string) {
    this.#root = join(memoryRoot, 'dream')
  }

  get root(): string {
    return this.#root
  }

  write(input: DreamReceiptInput): DreamReceipt {
    const record: DreamReceipt = { format: DREAM_RECEIPT_FORMAT, ...input }
    mkdirSync(this.#root, { recursive: true })
    const target = this.#path(input.runId)
    // tmp-then-rename so a crash mid-write cannot leave a half-written receipt.
    const staging = `${target}.tmp`
    writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    renameSync(staging, target)
    return record
  }

  read(runId: string): DreamReceipt | undefined {
    const file = this.#path(runId)
    if (!existsSync(file)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as DreamReceipt
      return parsed.format === DREAM_RECEIPT_FORMAT ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /** Newest first, because the panel shows the most recent run. */
  list(): DreamReceipt[] {
    if (!existsSync(this.#root)) return []
    const records: DreamReceipt[] = []
    for (const entry of readdirSync(this.#root)) {
      if (!entry.endsWith('.json')) continue
      const parsed = this.read(entry.slice(0, -'.json'.length))
      if (parsed !== undefined) records.push(parsed)
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  remove(runId: string): void {
    rmSync(this.#path(runId), { force: true })
  }

  /**
   * Persist a plan that is waiting for a decision.
   *
   * Stored apart from receipts because a pending plan is not a run: it has not
   * touched the store and may still be rejected. Keeping it separate means a
   * killed process cannot leave a receipt claiming work that never happened.
   */
  writePending(plan: DreamPlan, runId: string, createdAt: number): void {
    mkdirSync(this.#pendingRoot, { recursive: true })
    const target = join(this.#pendingRoot, `${this.#check(runId)}.json`)
    writeFileSync(target, `${JSON.stringify({ runId, risk: plan.risk, scopeKey: plan.scopeKey, actions: plan.actions, createdAt }, null, 2)}\n`, 'utf8')
  }

  readPending(runId: string): { plan: DreamPlan; createdAt: number } | undefined {
    const file = join(this.#pendingRoot, `${this.#check(runId)}.json`)
    if (!existsSync(file)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        risk: DreamRisk
        scopeKey: string
        actions: DreamAction[]
        createdAt: number
      }
      return {
        plan: { scopeKey: parsed.scopeKey, actions: parsed.actions, risk: parsed.risk },
        createdAt: parsed.createdAt,
      }
    } catch {
      return undefined
    }
  }

  clearPending(runId: string): void {
    rmSync(join(this.#pendingRoot, `${this.#check(runId)}.json`), { force: true })
  }

  listPending(): Array<{ runId: string; createdAt: number }> {
    if (!existsSync(this.#pendingRoot)) return []
    const entries: Array<{ runId: string; createdAt: number }> = []
    for (const entry of readdirSync(this.#pendingRoot)) {
      if (!entry.endsWith('.json')) continue
      const runId = entry.slice(0, -'.json'.length)
      const pending = this.readPending(runId)
      if (pending !== undefined) entries.push({ runId, createdAt: pending.createdAt })
    }
    return entries.sort((left, right) => right.createdAt - left.createdAt)
  }

  get #pendingRoot(): string {
    return join(this.#root, 'pending')
  }

  /**
   * Remember that a user declined one action, with the reason.
   *
   * Without this the next run over the same snapshot re-proposes exactly what
   * was just dismissed, and the user learns to ignore the panel.
   */
  recordRejection(scopeKey: string, fingerprint: string, reason: string, now: number): void {
    mkdirSync(this.#rejectRoot, { recursive: true })
    const file = join(this.#rejectRoot, `${this.#check(scopeKey.replace(/[^A-Za-z0-9._-]/gu, '_'))}.json`)
    const current = this.readRejections(scopeKey)
    const next = current.filter(entry => entry.fingerprint !== fingerprint)
    next.push({ fingerprint, reason, at: now })
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }

  /** Fingerprints already declined for this scope. */
  readRejections(scopeKey: string): Array<{ fingerprint: string; reason: string; at: number }> {
    const file = join(this.#rejectRoot, `${this.#check(scopeKey.replace(/[^A-Za-z0-9._-]/gu, '_'))}.json`)
    if (!existsSync(file)) return []
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Array<{ fingerprint: string; reason: string; at: number }>
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  get #rejectRoot(): string {
    return join(this.#root, 'rejected')
  }

  /** Reject an unsafe run id before it reaches the filesystem. */
  #check(runId: string): string {
    if (!/^[A-Za-z0-9._-]+$/u.test(runId) || runId === '.' || runId === '..') {
      throw new DreamReceiptError(`dream run id "${runId}" is not a safe file name`)
    }
    return runId
  }

  #path(runId: string): string {
    // A run id reaches the filesystem, so it may not contain a separator or
    // traverse. Rejecting here keeps the failure at the caller.
    if (!/^[A-Za-z0-9._-]+$/u.test(runId) || runId === '.' || runId === '..') {
      throw new DreamReceiptError(`dream run id "${runId}" is not a safe file name`)
    }
    return join(this.#root, `${runId}.json`)
  }
}

/**
 * Hash a plan for the receipt.
 *
 * Rationale is excluded: it is a comment, and letting it change the hash would
 * make identical plans look different across runs.
 */
export function dreamPlanHash(plan: DreamPlan): string {
  const canonical = plan.actions.map(action => toChange(action))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32)
}

/** Project an action down to the handles a receipt records. */
export function toChange(action: DreamAction): DreamReceiptChange {
  switch (action.action) {
    case 'merge':
      return { action: action.action, target: action.target, sources: action.sources }
    case 'extract-sop':
      return { action: action.action, target: action.target, sources: [action.source] }
    case 'supersede':
      return { action: action.action, target: action.newer, sources: [action.older] }
    case 'promote-global':
      return { action: action.action, target: action.section, sources: [action.source] }
    default:
      return { action: action.action, target: action.target }
  }
}

export interface DreamApplyResult {
  readonly applied: number
  readonly afterRevision: string
  /** Section and text of each promotion that still needs writing to GLOBAL. */
  readonly promotions: readonly { readonly section: string; readonly text: string; readonly source: string }[]
}

/**
 * Apply a plan to the governance sidecar.
 *
 * Every target is re-checked against the current document first. The model
 * planned against a snapshot, and a record that vanished meanwhile would
 * otherwise be recreated by an upsert under the wrong meaning.
 */
export function applyDreamPlan(
  store: MemoryGovernanceStore,
  plan: DreamPlan,
  now: number,
): DreamApplyResult {
  const document = store.read(plan.scopeKey)
  const byName = new Map(document.claims.map(claim => [claim.name, claim]))

  for (const action of plan.actions) {
    for (const name of referencedNames(action)) {
      if (!byName.has(name)) {
        throw new Error(
          `dream plan refers to record "${name}" that no longer exists in scope "${plan.scopeKey}"`,
        )
      }
    }
  }

  const upserts = plan.actions.map(action => applyOne(action, byName, plan.scopeKey, now))
  // Promotions are reported rather than written here: GLOBAL lives in Markdown,
  // which this layer does not own. The caller writes them through the guard, so
  // the append-only rule is enforced in exactly one place.
  const promotions = plan.actions
    .filter((action): action is Extract<DreamAction, { action: 'promote-global' }> =>
      action.action === 'promote-global')
    .map(action => ({ section: action.section, text: action.text, source: action.source }))

  if (upserts.length === 0) {
    return { applied: 0, afterRevision: document.revision, promotions }
  }

  const result = store.commit({
    scopeKey: plan.scopeKey,
    expectedRevision: document.revision,
    upserts,
    removals: [],
  })
  return { applied: upserts.length, afterRevision: result.revision, promotions }
}

/** Every existing record name an action points at. */
function referencedNames(action: DreamAction): string[] {
  switch (action.action) {
    case 'merge':
      return [...action.sources]
    case 'supersede':
      return [action.older, action.newer]
    case 'extract-sop':
      return [action.source]
    case 'promote-global':
      return [action.source]
    case 'mark-contested':
      return [action.target, ...(action.opposingRecords ?? [])]
    default:
      return [action.target]
  }
}

/** Translate one validated action into a governance upsert. */
function applyOne(
  action: DreamAction,
  byName: ReadonlyMap<string, GovernanceClaim>,
  scopeKey: string,
  now: number,
): GovernanceClaimInput {
  const lifecycleOf = (name: string, next: Lifecycle) => ({
    ...byName.get(name)!,
    lifecycle: next,
    lastUsedAt: now,
  })

  switch (action.action) {
    case 'cool':
      return toUpsert(lifecycleOf(action.target, 'cooled'))
    case 'archive':
      return toUpsert(lifecycleOf(action.target, 'archived'))
    case 'mark-contested':
      return toUpsert(lifecycleOf(action.target, 'contested'))
    case 'set-priority':
      return { ...toUpsert(byName.get(action.target)!), importanceScore: action.score }
    case 'supersede':
      return toUpsert(lifecycleOf(action.older, 'superseded'))
    case 'merge':
    case 'extract-sop': {
      // Both produce a new record from existing ones. The body is written by the
      // caller that owns Markdown; the sidecar only records the handle.
      const base = byName.get(action.action === 'merge' ? action.sources[0]! : action.source)!
      return {
        name: action.target,
        scopeKey,
        kind: base.kind,
        volatility: base.volatility,
        lifecycle: 'active',
        text: action.description,
      }
    }
    case 'promote-global':
      // Promotion copies into GLOBAL, which is Markdown the sidecar does not own,
      // so the record itself keeps its lifecycle here.
      return toUpsert(byName.get(action.source)!)
  }
}

function toUpsert(claim: GovernanceClaim): GovernanceClaimInput {
  return {
    name: claim.name,
    scopeKey: claim.scopeKey,
    kind: claim.kind,
    volatility: claim.volatility,
    lifecycle: claim.lifecycle,
    text: claim.text,
  }
}

export interface DreamReplay {
  readonly runId: string
  readonly scopeKey: string
  readonly state: DreamReceiptState
  readonly actions: readonly DreamReceiptChange[]
  readonly risk: DreamRisk
  /** False when the caller expected a different plan than the one recorded. */
  readonly hashMatches: boolean
  readonly beforeRevision: string
  readonly afterRevision: string
  readonly createdAt: string
}

/**
 * Reconstruct what a run did from its receipt alone.
 *
 * No memory content is needed: the receipt carries handles, and the store still
 * holds the records those handles name.
 */
export function replayDreamReceipt(
  receipt: DreamReceipt,
  options: { readonly expectedHash?: string } = {},
): DreamReplay {
  return {
    runId: receipt.runId,
    scopeKey: receipt.scopeKey,
    state: receipt.state,
    actions: receipt.changes,
    risk: receipt.risk,
    hashMatches: options.expectedHash === undefined || options.expectedHash === receipt.proposalHash,
    beforeRevision: receipt.beforeRevision,
    afterRevision: receipt.afterRevision,
    createdAt: receipt.createdAt,
  }
}

export interface DreamSessionOptions {
  readonly store: MemoryGovernanceStore
  readonly receipts: DreamReceiptStore
  readonly context: DreamProposalContext
  readonly runId: string
  readonly config: Partial<DreamWorkerConfig>
  readonly now: number
  readonly callModel: (request: DreamModelRequest) => Promise<unknown>
  readonly maxAttempts?: number
}

export interface DreamSessionResult {
  readonly receipt: DreamReceipt
  readonly plan?: DreamPlan
}

/**
 * Run one Dream pass end to end: plan, apply, record.
 *
 * A receipt is written on every outcome, including failures. Without one, a run
 * that changed nothing and a run that crashed are indistinguishable later, and
 * the difference is exactly what a user needs to know before trusting the store.
 */
export async function runDreamSession(options: DreamSessionOptions): Promise<DreamSessionResult> {
  const before = options.store.read(options.context.scopeKey)
  const createdAt = new Date(options.now).toISOString()
  let plan: DreamPlan | undefined
  let attempt = 0

  try {
    const run = await runDreamWorker(options.context, {
      config: options.config,
      callModel: options.callModel,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    })
    plan = run.plan
    attempt = run.attempts
  } catch (cause: unknown) {
    const state = stateForFailure(cause)
    const receipt = options.receipts.write({
      runId: options.runId,
      scopeKey: options.context.scopeKey,
      state,
      attempt,
      provider: options.config.provider ?? DEFAULT_DREAM_WORKER_CONFIG.provider,
      model: options.config.model ?? DEFAULT_DREAM_WORKER_CONFIG.model,
      beforeRevision: before.revision,
      afterRevision: before.revision,
      proposalHash: '',
      risk: 'metadata-only',
      changes: [],
      createdAt,
      completedAt: createdAt,
      error: cause instanceof Error ? cause.message : String(cause),
    })
    return { receipt }
  }

  const hash = dreamPlanHash(plan)
  const provider = options.config.provider ?? DEFAULT_DREAM_WORKER_CONFIG.provider
  const model = options.config.model ?? DEFAULT_DREAM_WORKER_CONFIG.model

  if (plan.actions.length === 0) {
    const receipt = options.receipts.write({
      runId: options.runId,
      scopeKey: options.context.scopeKey,
      state: 'no-change',
      attempt,
      provider,
      model,
      beforeRevision: before.revision,
      afterRevision: before.revision,
      proposalHash: hash,
      risk: plan.risk,
      changes: [],
      createdAt,
      completedAt: createdAt,
    })
    return { receipt, plan }
  }

  try {
    const applied = applyDreamPlan(options.store, plan, options.now)
    const receipt = options.receipts.write({
      runId: options.runId,
      scopeKey: options.context.scopeKey,
      state: 'committed',
      attempt,
      provider,
      model,
      beforeRevision: before.revision,
      afterRevision: applied.afterRevision,
      proposalHash: hash,
      risk: plan.risk,
      changes: plan.actions.map(toChange),
      createdAt,
      completedAt: createdAt,
    })
    return { receipt, plan }
  } catch (cause: unknown) {
    // A record that vanished between planning and applying is not an internal
    // bug; it means the snapshot moved and the plan must be discarded.
    const stale = cause instanceof Error && /no longer exists/u.test(cause.message)
    const receipt = options.receipts.write({
      runId: options.runId,
      scopeKey: options.context.scopeKey,
      state: stale ? 'stale-scope' : 'internal-error',
      attempt,
      provider,
      model,
      beforeRevision: before.revision,
      afterRevision: options.store.read(options.context.scopeKey).revision,
      proposalHash: hash,
      risk: plan.risk,
      changes: plan.actions.map(toChange),
      createdAt,
      completedAt: createdAt,
      error: cause instanceof Error ? cause.message : String(cause),
    })
    return { receipt, plan }
  }
}

/** Map a worker failure onto the receipt vocabulary. */
function stateForFailure(cause: unknown): DreamReceiptState {
  const code = cause instanceof DreamWorkerError ? cause.code : undefined
  switch (code) {
    case 'output-truncated':
      return 'output-truncated'
    case 'provider-failed':
      return 'provider-failed'
    case 'missing-proposal':
      return 'rejected'
    default:
      return 'internal-error'
  }
}
export interface DreamPlanSessionOptions {
  readonly receipts: DreamReceiptStore
  readonly context: DreamProposalContext
  readonly runId: string
  readonly config: Partial<DreamWorkerConfig>
  readonly now: number
  readonly callModel: (request: DreamModelRequest) => Promise<unknown>
  readonly maxAttempts?: number
}

export type DreamPlanSessionResult =
  | { readonly planned: true; readonly plan: DreamPlan; readonly attempts: number }
  | { readonly planned: false; readonly receipt: DreamReceipt }

/**
 * Phase one: plan, but do not apply.
 *
 * Dream's content-changing actions rewrite memory, so the plan is staged and the
 * user decides. A rejected or failed run is still recorded immediately, because
 * there is nothing to approve in that case.
 */
export async function planDreamSession(
  options: DreamPlanSessionOptions,
): Promise<DreamPlanSessionResult> {
  const createdAt = new Date(options.now).toISOString()

  try {
    const run = await runDreamWorker(options.context, {
      config: options.config,
      callModel: options.callModel,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    })
    options.receipts.writePending(run.plan, options.runId, options.now)
    return { planned: true, plan: run.plan, attempts: run.attempts }
  } catch (cause: unknown) {
    const state = stateForFailure(cause)
    const receipt = options.receipts.write({
      runId: options.runId,
      scopeKey: options.context.scopeKey,
      state,
      attempt: 0,
      provider: options.config.provider ?? DEFAULT_DREAM_WORKER_CONFIG.provider,
      model: options.config.model ?? DEFAULT_DREAM_WORKER_CONFIG.model,
      beforeRevision: '',
      afterRevision: '',
      proposalHash: '',
      risk: 'metadata-only',
      changes: [],
      createdAt,
      completedAt: createdAt,
      error: cause instanceof Error ? cause.message : String(cause),
    })
    return { planned: false, receipt }
  }
}

export interface ApproveDreamOptions {
  readonly store: MemoryGovernanceStore
  readonly receipts: DreamReceiptStore
  readonly runId: string
  readonly now: number
  /** Provider and model are copied from the pending header when unknown here. */
  readonly provider?: string
  readonly model?: string
  /**
   * Fingerprints the user approved. Omitted means the whole plan, which is what
   * a direct caller wants; the RPC always passes the explicit list.
   */
  readonly approved?: readonly string[]
  readonly partial?: boolean
}

/**
 * Phase two: apply an approved pending plan and record it.
 *
 * The pending copy is consumed only after the write succeeds, so a crash mid-way
 * leaves the plan available to retry instead of losing it.
 */
export function approveDreamPlan(options: ApproveDreamOptions): {
  receipt: DreamReceipt
  /** Promotions still need writing to GLOBAL.md; the caller owns that file. */
  promotions: readonly { readonly section: string; readonly text: string; readonly source: string }[]
} {
  const pending = options.receipts.readPending(options.runId)
  if (pending === undefined) {
    throw new DreamReceiptError(`no pending plan for run "${options.runId}"`)
  }
  const document = options.store.read(pending.plan.scopeKey)
  const createdAt = new Date(options.now).toISOString()

  // Apply only what was approved. An empty selection is a full rejection and is
  // handled by the caller, so reaching here with nothing selected is a bug.
  const approvedSet = options.approved === undefined ? undefined : new Set(options.approved)
  const chosen = approvedSet === undefined
    ? pending.plan.actions
    : pending.plan.actions.filter(action => approvedSet.has(planActionFingerprint(toApprovable(action))))
  if (chosen.length === 0) {
    throw new DreamReceiptError(`no approved actions for run "${options.runId}"`)
  }
  const planToApply: DreamPlan = { ...pending.plan, actions: chosen }

  try {
    const applied = applyDreamPlan(options.store, planToApply, options.now)
    const receipt = options.receipts.write({
      runId: options.runId,
      scopeKey: pending.plan.scopeKey,
      state: applied.applied === 0 ? 'no-change' : 'committed',
      attempt: 1,
      provider: options.provider ?? DEFAULT_DREAM_WORKER_CONFIG.provider,
      model: options.model ?? DEFAULT_DREAM_WORKER_CONFIG.model,
      beforeRevision: document.revision,
      afterRevision: applied.afterRevision,
      proposalHash: dreamPlanHash(pending.plan),
      risk: pending.plan.risk,
      changes: pending.plan.actions.map(toChange),
      createdAt,
      completedAt: createdAt,
    })
    options.receipts.clearPending(options.runId)
    return { receipt, promotions: applied.promotions }
  } catch (cause: unknown) {
    const stale = cause instanceof Error && /no longer exists/u.test(cause.message)
    const receipt = options.receipts.write({
      runId: options.runId,
      scopeKey: pending.plan.scopeKey,
      state: stale ? 'stale-scope' : 'internal-error',
      attempt: 1,
      provider: options.provider ?? DEFAULT_DREAM_WORKER_CONFIG.provider,
      model: options.model ?? DEFAULT_DREAM_WORKER_CONFIG.model,
      beforeRevision: document.revision,
      afterRevision: options.store.read(pending.plan.scopeKey).revision,
      proposalHash: dreamPlanHash(pending.plan),
      risk: pending.plan.risk,
      changes: pending.plan.actions.map(toChange),
      createdAt,
      completedAt: createdAt,
      error: cause instanceof Error ? cause.message : String(cause),
    })
    return { receipt, promotions: [] }
  }
}

/** Drop a pending plan the user declined. Nothing was written, so nothing to undo. */
export function discardDreamPlan(receipts: DreamReceiptStore, runId: string): void {
  receipts.clearPending(runId)
}
/** The slice of MarkdownMemoryStore that publishing needs. */
export interface GlobalDocumentStore {
  readGlobalSync(): { content: string; revision: string }
  commitGlobal(input: { expectedRevision: string; content: string }): Promise<unknown>
}

/**
 * Write approved promotions into GLOBAL.md.
 *
 * This is the only place Dream touches GLOBAL, and it goes through the guard so
 * the append-only rule is enforced once rather than restated per caller. Every
 * promotion is applied to the in-memory copy first and published as a single
 * commit: two promotions landing in two commits would leave GLOBAL half-updated
 * if the second one is rejected.
 *
 * The whole batch is refused if any section is missing, because a partial
 * publish would silently drop the promotions that came after the bad one.
 */
export async function publishPromotions(
  store: GlobalDocumentStore,
  promotions: readonly { readonly section: string; readonly text: string; readonly source: string }[],
  context: { readonly runId: string; readonly globalSections: readonly string[] },
): Promise<{ readonly content: string; readonly published: number }> {
  if (promotions.length === 0) {
    const current = store.readGlobalSync()
    return { content: current.content, published: 0 }
  }

  const before = store.readGlobalSync()
  let draft = before.content
  for (const promotion of promotions) {
    const sections = parseGlobalSections(draft)
    if (!sections.includes(promotion.section)) {
      throw new GlobalGuardError(
        `global section "${promotion.section}" does not exist in GLOBAL.md`,
      )
    }
    draft = applyGlobalPromotion(draft, {
      section: promotion.section,
      text: promotion.text,
      source: promotion.source,
      runId: context.runId,
    })
  }

  await store.commitGlobal({ expectedRevision: before.revision, content: draft })
  return { content: draft, published: promotions.length }
}
