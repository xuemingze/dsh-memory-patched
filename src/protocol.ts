/** Browser/Host wire values for the dedicated loopback Memory RPC channel. */

import { isConsolidationReviewId } from './consolidation-identity.ts'

/** Opaque content revision used for compare-and-swap writes. */
export type MemoryRevision = string & { readonly __memoryRevision: unique symbol }

/** Browser-safe identifier resolved against the Host Workspace catalog. */
export type WorkspaceId = string & { readonly __workspaceId: unique symbol }

/** Summary displayed at the top of the Memory settings section. */
export interface MemoryStatus {
  enabled: true
  root: string
  globalBytes: number
  workspaceCount: number
}

/** Complete global memory document and its current revision. */
export interface GlobalMemoryView {
  content: string
  revision: MemoryRevision
}

/** Browser-safe summary of one discovered Workspace. */
export interface WorkspaceSummary {
  workspaceId: WorkspaceId
  displayName: string
  revision: MemoryRevision
  recordCount: number
}

/** Closed record projection returned by the Workspace read endpoint. */
export interface WorkspaceRecordView {
  name: string
  description: string
  type: 'feedback' | 'project' | 'reference'
  content: string
  /** Present when the record carries a store-authored temporal stamp. */
  lastEvidenceTime?: number
}

/** Complete read-only Workspace projection returned to the Browser. */
export interface WorkspaceReadResponse extends WorkspaceSummary {
  index: string
  records: WorkspaceRecordView[]
}

/** Ordered catalog returned by the Workspace list endpoint. */
export interface WorkspaceListResponse {
  workspaces: WorkspaceSummary[]
}

/**
 * Deterministic reason why a persisted Session is not offered as a candidate.
 * `failed-zero-output` Sessions produced nothing and are hidden from the list
 * entirely; they are reported through `SessionListResponse.suppressed`.
 */
export type SessionIneligibleReason =
  | 'live'
  | 'missing-cwd'
  | 'workspace-unavailable'
  | 'unstable'
  | 'subagent'
  | 'empty'
  | 'failed-zero-output'

export type SessionReceiptState =
  | 'committing'
  | 'committed'
  | 'no-change'
  | 'cancelled'
  | 'source-changed'
  | 'target-conflict'
  | 'invalid-proposal'
  | 'output-truncated'
  | 'provider-failed'
  | 'evidence-too-large'
  | 'internal-error'

/** Browser-safe receipt status without model route, Workspace key, or revisions. */
export interface SessionReceiptSummary {
  reviewId: string
  state: SessionReceiptState
  attempt: number
  current: boolean
  completedAt: string | null
}

/** Browser-safe projection of one persisted Session snapshot. */
export type SessionSummary = {
  sessionId: string
  title: string | null
  createdAt: number
  workspaceId: WorkspaceId | null
  workspaceName: string | null
  latestReceipt: SessionReceiptSummary | null
  archived: boolean
} & (
  | { eligible: true; reason: null }
  | { eligible: false; reason: SessionIneligibleReason }
)

/** One suppressed cluster of Sessions that share a failure fingerprint. */
export interface SuppressedSessionGroup {
  readonly fingerprint: string
  readonly title: string | null
  readonly count: number
  readonly firstCreatedAt: number
  readonly lastCreatedAt: number
  readonly reason: 'failed-zero-output' | 'trivial-automation'
  readonly errorCode?: string
}

/** Counts and clusters for Sessions intentionally omitted from `sessions`. */
export interface SuppressedSessionsSummary {
  readonly failedZeroOutput: number
  readonly trivialAutomation: number
  readonly groups: SuppressedSessionGroup[]
}

/** One proposed lifecycle transition in the shadow forgetting report. */
export interface ForgettingChangeView {
  readonly name: string
  readonly from: string
  readonly to: string
  readonly importanceScore: number
  readonly importanceClass: string
  readonly reason: string
}

/** Browser-safe view of the shadow forgetting report. */
export interface ForgettingReportResponse {
  readonly mode: string
  readonly changes: readonly ForgettingChangeView[]
  readonly counts: { readonly cooled: number; readonly archived: number; readonly restored: number }
  readonly protectedCount: number
}

/** One action in a Dream plan, as shown to the user before approval. */
export interface DreamActionView {
  readonly action: string
  readonly target: string
  readonly sources?: readonly string[]
  readonly rationale?: string
}

/**
 * A Dream plan awaiting a decision.
 *
 * Carries handles only. The prose each handle names stays in Markdown, so this
 * view can be shown in the browser without duplicating memory content.
 */
export interface DreamPlanResponse {
  readonly runId: string
  readonly scopeKey: string
  readonly state: 'planned'
  readonly risk: string
  readonly proposalHash: string
  readonly actions: readonly DreamActionView[]
  readonly createdAt: number
}

/** A finished Dream run: what it decided and whether it took effect. */
export interface DreamRunResponse {
  readonly runId: string
  readonly scopeKey: string
  readonly state: string
  readonly risk: string
  readonly proposalHash: string
  readonly beforeRevision: string
  readonly afterRevision: string
  readonly changes: readonly DreamActionView[]
  readonly createdAt: number
  readonly error?: string
}

export class DreamProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DreamProtocolError'
  }
}

/** The states a stored Dream run may report. */
const DREAM_RUN_STATES = [
  'committed', 'no-change', 'rejected', 'stale-scope',
  'output-truncated', 'provider-failed', 'internal-error',
] as const

const DREAM_RISKS = ['metadata-only', 'content-change'] as const
const DREAM_RUN_MODES = ['off', 'shadow', 'manual'] as const

function dreamRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DreamProtocolError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function dreamExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!(key in record)) throw new DreamProtocolError(`${label} is missing: ${key}`)
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new DreamProtocolError(`${label} has unknown field: ${key}`)
  }
}

function dreamText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new DreamProtocolError(`${label} must be a non-empty string`)
  }
  return value
}

/**
 * A string that may be empty.
 *
 * A run that never produced a proposal has no hash, so `""` is the honest value
 * rather than a placeholder. Requiring a non-empty hash made the panel refuse to
 * render the receipts a user most needs to read — the failed ones.
 */
function dreamOptionalText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new DreamProtocolError(`${label} must be a string`)
  }
  return value
}

function dreamTime(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DreamProtocolError(`${label} must be a number`)
  }
  return value
}

function parseDreamActions(value: unknown, label: string): DreamActionView[] {
  if (!Array.isArray(value)) throw new DreamProtocolError(`${label} must be an array`)
  return value.map((entry, index) => {
    const record = dreamRecord(entry, `${label}[${index}]`)
    dreamExactKeys(record, ['action', 'target'], `${label}[${index}]`, ['sources', 'rationale'])
    const sources = record.sources
    if (sources !== undefined && (!Array.isArray(sources) || sources.some(item => typeof item !== 'string'))) {
      throw new DreamProtocolError(`${label}[${index}].sources must be a list of record names`)
    }
    return {
      action: dreamText(record.action, `${label}[${index}].action`),
      target: dreamText(record.target, `${label}[${index}].target`),
      ...(sources === undefined ? {} : { sources: sources as string[] }),
      ...(record.rationale === undefined
        ? {}
        : { rationale: dreamText(record.rationale, `${label}[${index}].rationale`) }),
    }
  })
}

/** Parse a plan awaiting approval. */
export function parseDreamPlanResponse(value: unknown): DreamPlanResponse {
  const record = dreamRecord(value, 'dream plan')
  dreamExactKeys(
    record,
    ['runId', 'scopeKey', 'state', 'risk', 'proposalHash', 'actions', 'createdAt'],
    'dream plan',
  )
  if (record.state !== 'planned') {
    throw new DreamProtocolError('dream plan.state must be "planned"')
  }
  if (!DREAM_RISKS.includes(record.risk as (typeof DREAM_RISKS)[number])) {
    throw new DreamProtocolError(`dream plan.risk must be one of: ${DREAM_RISKS.join(', ')}`)
  }
  return {
    runId: dreamText(record.runId, 'dream plan.runId'),
    scopeKey: dreamText(record.scopeKey, 'dream plan.scopeKey'),
    state: 'planned',
    risk: record.risk as string,
    proposalHash: dreamText(record.proposalHash, 'dream plan.proposalHash'),
    actions: parseDreamActions(record.actions, 'dream plan.actions'),
    createdAt: dreamTime(record.createdAt, 'dream plan.createdAt'),
  }
}

/**
 * Parse the Dream panel payload: staged plans plus recent runs.
 *
 * Each element is validated through the single-plan and single-run parsers, so
 * a malformed entry is rejected rather than rendered half-populated.
 */
export function parseDreamPanelResponse(value: unknown): {
  mode: string
  pending: DreamPlanResponse[]
  runs: DreamRunResponse[]
} {
  const record = dreamRecord(value, 'dream panel')
  dreamExactKeys(record, ['mode', 'pending', 'runs'], 'dream panel')
  // The mode is validated rather than defaulted: silently reading an unknown
  // mode as shadow would hide that the panel is showing stale expectations.
  if (!DREAM_RUN_MODES.includes(record.mode as (typeof DREAM_RUN_MODES)[number])) {
    throw new DreamProtocolError(`dream panel.mode must be one of: ${DREAM_RUN_MODES.join(', ')}`)
  }
  if (!Array.isArray(record.pending)) throw new DreamProtocolError('dream panel.pending must be an array')
  if (!Array.isArray(record.runs)) throw new DreamProtocolError('dream panel.runs must be an array')
  return {
    mode: record.mode as string,
    pending: record.pending.map((entry, index) => parseDreamPlanResponse(entry)),
    runs: record.runs.map((entry, index) => parseDreamRunResponse(entry)),
  }
}

/** Parse a finished run. */
export function parseDreamRunResponse(value: unknown): DreamRunResponse {
  const record = dreamRecord(value, 'dream run')
  dreamExactKeys(
    record,
    ['runId', 'scopeKey', 'state', 'risk', 'proposalHash', 'beforeRevision', 'afterRevision', 'changes', 'createdAt'],
    'dream run',
    ['error'],
  )
  if (!DREAM_RUN_STATES.includes(record.state as (typeof DREAM_RUN_STATES)[number])) {
    throw new DreamProtocolError(`dream run.state must be one of: ${DREAM_RUN_STATES.join(', ')}`)
  }
  if (!DREAM_RISKS.includes(record.risk as (typeof DREAM_RISKS)[number])) {
    throw new DreamProtocolError(`dream run.risk must be one of: ${DREAM_RISKS.join(', ')}`)
  }
  return {
    runId: dreamText(record.runId, 'dream run.runId'),
    scopeKey: dreamText(record.scopeKey, 'dream run.scopeKey'),
    state: record.state as string,
    risk: record.risk as string,
    // Only a run that reached a proposal can carry a hash. Demanding one from a
    // failed run would either force a fake value or hide the receipt entirely.
    proposalHash: record.state === 'committed'
      ? dreamText(record.proposalHash, 'dream run.proposalHash')
      : dreamOptionalText(record.proposalHash, 'dream run.proposalHash'),
    beforeRevision: dreamText(record.beforeRevision, 'dream run.beforeRevision'),
    afterRevision: dreamText(record.afterRevision, 'dream run.afterRevision'),
    changes: parseDreamActions(record.changes, 'dream run.changes'),
    createdAt: dreamTime(record.createdAt, 'dream run.createdAt'),
    ...(record.error === undefined ? {} : { error: dreamText(record.error, 'dream run.error') }),
  }
}

/** Session candidate capability and ordered persisted Session list. */
export interface SessionListResponse {
  available: boolean
  sessions: SessionSummary[]
  suppressed: SuppressedSessionsSummary
}

export interface SessionConsolidatePayload {
  sessionId: string
}

export interface SessionConsolidateResponse {
  status: Exclude<SessionReceiptState, 'committing'>
  recovered: boolean
  reviewId: string
  attempt: number
  changeCount: number
  debugLoggingEnabled: boolean
}

/** Memory-specific model route chosen from DSH's active model catalog. */
export interface ConsolidationModelSelection {
  provider: string
  model: string
}

export interface ConsolidationModelView {
  id: string
  name: string
  description?: string
}

export interface ConsolidationModelProviderView {
  id: string
  name: string
  models: ConsolidationModelView[]
}

export interface ConsolidationModelCatalogResponse {
  available: boolean
  selection: ConsolidationModelSelection
  debugEnabled: boolean
  revision: MemoryRevision
  providers: ConsolidationModelProviderView[]
  failures: Array<{ provider: string; message: string }>
}

export interface ConsolidationModelSelectPayload extends ConsolidationModelSelection {
  expectedRevision: MemoryRevision
  debugEnabled: boolean
}

export type ConsolidationModelSelectResponse =
  | { status: 'committed'; revision: MemoryRevision }
  | { status: 'conflict'; currentRevision: MemoryRevision }

/** One Browser-proposed change in a canonical delete-then-put batch. */
export type WorkspaceCommitChange =
  | { action: 'delete'; name: string }
  | { action: 'put'; record: WorkspaceRecordView }

/** Revision-checked Workspace batch submitted through the loopback RPC. */
export interface WorkspaceCommitPayload {
  workspaceId: WorkspaceId
  expectedRevision: MemoryRevision
  changes: WorkspaceCommitChange[]
}

/** Result of one Workspace batch commit through the Web API. */
export type WorkspaceCommitResponse =
  | { status: 'committed'; revision: MemoryRevision }
  | { status: 'conflict'; currentRevision: MemoryRevision }

/** Result of replacing the global document through the Web API. */
export type GlobalReplaceResponse =
  | { status: 'committed'; revision: MemoryRevision }
  | { status: 'conflict'; currentRevision: MemoryRevision }

/** Minimal RPC error vocabulary accepted by the Connection envelope. */
export interface MemoryRpcError {
  code: 'bad-request' | 'cancelled' | 'internal'
  message: string
  details: Record<string, unknown>
}

/** Connection-compatible result returned by one Memory RPC call. */
export type MemoryRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MemoryRpcError }

/** Parse an empty-object request payload. */
export function parseEmptyPayload(value: unknown): Record<string, never> {
  const record = requireRecord(value, 'payload')
  requireExactKeys(record, [], 'payload')
  return {}
}

/** Parse a revision-checked global replacement request. */
export function parseGlobalReplacePayload(value: unknown): {
  expectedRevision: MemoryRevision
  content: string
} {
  const record = requireRecord(value, 'payload')
  requireExactKeys(record, ['expectedRevision', 'content'], 'payload')
  if (typeof record.expectedRevision !== 'string' || !record.expectedRevision.startsWith('sha256:')) {
    throw new TypeError('payload.expectedRevision must be a sha256 revision')
  }
  if (typeof record.content !== 'string') throw new TypeError('payload.content must be a string')
  return {
    expectedRevision: record.expectedRevision as MemoryRevision,
    content: record.content,
  }
}

/** Parse a Browser request for one opaque Workspace id. */
export function parseWorkspaceReadPayload(value: unknown): { workspaceId: WorkspaceId } {
  const record = requireRecord(value, 'payload')
  requireExactKeys(record, ['workspaceId'], 'payload')
  return { workspaceId: requireWorkspaceId(record.workspaceId, 'payload.workspaceId') }
}

/** Parse one manual Session consolidation request. */
export function parseSessionConsolidatePayload(value: unknown): SessionConsolidatePayload {
  const record = requireRecord(value, 'payload')
  requireExactKeys(record, ['sessionId'], 'payload')
  return { sessionId: requireNonEmptySingleLine(record.sessionId, 'payload.sessionId') }
}

export function parseConsolidationModelSelectPayload(value: unknown): ConsolidationModelSelectPayload {
  const record = requireRecord(value, 'payload')
  requireExactKeys(record, ['expectedRevision', 'provider', 'model', 'debugEnabled'], 'payload')
  return {
    expectedRevision: requireRevision(record.expectedRevision, 'payload.expectedRevision'),
    provider: requireNonEmptySingleLine(record.provider, 'payload.provider'),
    model: requireNonEmptySingleLine(record.model, 'payload.model'),
    debugEnabled: requireBoolean(record.debugEnabled, 'payload.debugEnabled'),
  }
}

/** Parse and canonicalize a revision-checked Workspace mutation batch. */
export function parseWorkspaceCommitPayload(value: unknown): WorkspaceCommitPayload {
  const record = requireRecord(value, 'payload')
  requireExactKeys(record, ['workspaceId', 'expectedRevision', 'changes'], 'payload')
  if (!Array.isArray(record.changes) || record.changes.length === 0) {
    throw new TypeError('payload.changes must be a non-empty array')
  }
  const changes: WorkspaceCommitChange[] = []
  const deletes = new Set<string>()
  const puts = new Set<string>()
  let reachedPuts = false
  for (const [index, candidate] of record.changes.entries()) {
    const label = `payload.changes[${index}]`
    const change = requireRecord(candidate, label)
    if (change.action === 'delete') {
      if (reachedPuts) throw new TypeError('payload.changes must place every delete before every put')
      requireExactKeys(change, ['action', 'name'], label)
      const name = requireWorkspaceMemoryName(change.name, `${label}.name`)
      if (deletes.has(name)) throw new TypeError(`${label}.name duplicates an earlier delete`)
      deletes.add(name)
      changes.push({ action: 'delete', name })
    } else if (change.action === 'put') {
      reachedPuts = true
      requireExactKeys(change, ['action', 'record'], label)
      const parsed = parseWorkspaceRecord(change.record, `${label}.record`)
      if (puts.has(parsed.name)) throw new TypeError(`${label}.record.name duplicates an earlier put`)
      puts.add(parsed.name)
      changes.push({ action: 'put', record: parsed })
    } else {
      throw new TypeError(`${label}.action must be delete or put`)
    }
  }
  return {
    workspaceId: requireWorkspaceId(record.workspaceId, 'payload.workspaceId'),
    expectedRevision: requireRevision(record.expectedRevision, 'payload.expectedRevision'),
    changes,
  }
}

/** Parse a Host status response before the Browser renders it. */
export function parseMemoryStatus(value: unknown): MemoryStatus {
  const record = requireRecord(value, 'status response')
  requireExactKeys(record, ['enabled', 'root', 'globalBytes', 'workspaceCount'], 'status response')
  if (record.enabled !== true) throw new TypeError('status response.enabled must be true')
  if (typeof record.root !== 'string') throw new TypeError('status response.root must be a string')
  if (!isNonNegativeInteger(record.globalBytes)) throw new TypeError('status response.globalBytes must be a non-negative integer')
  if (!isNonNegativeInteger(record.workspaceCount)) throw new TypeError('status response.workspaceCount must be a non-negative integer')
  return {
    enabled: true,
    root: record.root,
    globalBytes: record.globalBytes,
    workspaceCount: record.workspaceCount,
  }
}

/** Parse a global document response before the Browser edits it. */
export function parseGlobalMemoryView(value: unknown): GlobalMemoryView {
  const record = requireRecord(value, 'global response')
  requireExactKeys(record, ['content', 'revision'], 'global response')
  if (typeof record.content !== 'string') throw new TypeError('global response.content must be a string')
  if (typeof record.revision !== 'string' || !record.revision.startsWith('sha256:')) {
    throw new TypeError('global response.revision must be a sha256 revision')
  }
  return { content: record.content, revision: record.revision as MemoryRevision }
}

/** Parse a global replacement response before the Browser updates its revision. */
export function parseGlobalReplaceResponse(value: unknown): GlobalReplaceResponse {
  const record = requireRecord(value, 'replace response')
  if (record.status === 'committed') {
    requireExactKeys(record, ['status', 'revision'], 'replace response')
    return { status: 'committed', revision: requireRevision(record.revision, 'replace response.revision') }
  }
  if (record.status === 'conflict') {
    requireExactKeys(record, ['status', 'currentRevision'], 'replace response')
    return { status: 'conflict', currentRevision: requireRevision(record.currentRevision, 'replace response.currentRevision') }
  }
  throw new TypeError('replace response.status must be committed or conflict')
}

/** Parse the closed Workspace catalog on both sides of the Host/Browser wire. */
export function parseWorkspaceListResponse(value: unknown): WorkspaceListResponse {
  const record = requireRecord(value, 'workspace list response')
  requireExactKeys(record, ['workspaces'], 'workspace list response')
  if (!Array.isArray(record.workspaces)) throw new TypeError('workspace list response.workspaces must be an array')
  return {
    workspaces: record.workspaces.map((entry, index) => parseWorkspaceSummary(entry, `workspace list response.workspaces[${index}]`)),
  }
}

/** Parse one complete read-only Workspace projection on both sides of the wire. */
export function parseWorkspaceReadResponse(value: unknown): WorkspaceReadResponse {
  const record = requireRecord(value, 'workspace read response')
  requireExactKeys(record, ['workspaceId', 'displayName', 'revision', 'recordCount', 'index', 'records'], 'workspace read response')
  const summary = parseWorkspaceSummaryFields(record, 'workspace read response')
  if (typeof record.index !== 'string') throw new TypeError('workspace read response.index must be a string')
  if (!Array.isArray(record.records)) throw new TypeError('workspace read response.records must be an array')
  const records = record.records.map((entry, index) => parseWorkspaceRecord(entry, `workspace read response.records[${index}]`, true))
  if (records.length !== summary.recordCount) {
    throw new TypeError('workspace read response.recordCount must match records length')
  }
  return { ...summary, index: record.index, records }
}

/** Parse a Workspace commit result before either side trusts its revision. */
export function parseWorkspaceCommitResponse(value: unknown): WorkspaceCommitResponse {
  const record = requireRecord(value, 'workspace commit response')
  if (record.status === 'committed') {
    requireExactKeys(record, ['status', 'revision'], 'workspace commit response')
    return { status: 'committed', revision: requireRevision(record.revision, 'workspace commit response.revision') }
  }
  if (record.status === 'conflict') {
    requireExactKeys(record, ['status', 'currentRevision'], 'workspace commit response')
    return { status: 'conflict', currentRevision: requireRevision(record.currentRevision, 'workspace commit response.currentRevision') }
  }
  throw new TypeError('workspace commit response.status must be committed or conflict')
}

/** Parse the Session candidate projection on both sides of the Host/Browser wire. */
export function parseSessionListResponse(value: unknown): SessionListResponse {
  const record = requireRecord(value, 'session list response')
  requireExactKeys(record, ['available', 'sessions', 'suppressed'], 'session list response')
  if (typeof record.available !== 'boolean') throw new TypeError('session list response.available must be a boolean')
  if (!Array.isArray(record.sessions)) throw new TypeError('session list response.sessions must be an array')
  if (!record.available && record.sessions.length !== 0) {
    throw new TypeError('session list response.sessions must be empty when unavailable')
  }
  return {
    available: record.available,
    sessions: record.sessions.map((entry, index) => parseSessionSummary(entry, `session list response.sessions[${index}]`)),
    suppressed: parseSuppressedSummary(record.suppressed, 'session list response.suppressed'),
  }
}

/** Parse the suppressed-Session summary carried alongside the candidate list. */
function parseSuppressedSummary(value: unknown, label: string): SuppressedSessionsSummary {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['failedZeroOutput', 'trivialAutomation', 'groups'], label)
  const failedZeroOutput = nonNegativeInteger(record.failedZeroOutput, `${label}.failedZeroOutput`)
  const trivialAutomation = nonNegativeInteger(record.trivialAutomation, `${label}.trivialAutomation`)
  if (!Array.isArray(record.groups)) throw new TypeError(`${label}.groups must be an array`)
  return {
    failedZeroOutput,
    trivialAutomation,
    groups: record.groups.map((entry, index) => parseSuppressedGroup(entry, `${label}.groups[${index}]`)),
  }
}

function parseSuppressedGroup(value: unknown, label: string): SuppressedSessionGroup {
  const record = requireRecord(value, label)
  const keys = ['count', 'fingerprint', 'firstCreatedAt', 'lastCreatedAt', 'reason', 'title']
  const hasErrorCode = record.errorCode !== undefined
  requireExactKeys(record, hasErrorCode ? [...keys, 'errorCode'] : keys, label)
  if (typeof record.fingerprint !== 'string' || !/^[a-f0-9]{16}$/u.test(record.fingerprint)) {
    throw new TypeError(`${label}.fingerprint must be 16 lowercase hex characters`)
  }
  if (record.title !== null && typeof record.title !== 'string') {
    throw new TypeError(`${label}.title must be a string or null`)
  }
  const count = positiveInteger(record.count, `${label}.count`)
  const firstCreatedAt = nonNegativeInteger(record.firstCreatedAt, `${label}.firstCreatedAt`)
  const lastCreatedAt = nonNegativeInteger(record.lastCreatedAt, `${label}.lastCreatedAt`)
  if (record.reason !== 'failed-zero-output' && record.reason !== 'trivial-automation') {
    throw new TypeError(`${label}.reason must be a suppressed Session reason`)
  }
  if (hasErrorCode && typeof record.errorCode !== 'string') {
    throw new TypeError(`${label}.errorCode must be a string when present`)
  }
  return {
    fingerprint: record.fingerprint,
    title: record.title as string | null,
    count,
    firstCreatedAt,
    lastCreatedAt,
    reason: record.reason,
    ...(hasErrorCode ? { errorCode: record.errorCode as string } : {}),
  }
}

/** Narrow one parsed field to a non-negative safe integer. */
function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
  return value
}

/** Narrow one parsed field to a strictly positive safe integer. */
function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label)
  if (parsed < 1) throw new TypeError(`${label} must be a positive safe integer`)
  return parsed
}

/** Parse one terminal manual consolidation result on both sides of the wire. */
export function parseSessionConsolidateResponse(value: unknown): SessionConsolidateResponse {
  const record = requireRecord(value, 'session consolidate response')
  requireExactKeys(record, ['status', 'recovered', 'reviewId', 'attempt', 'changeCount', 'debugLoggingEnabled'], 'session consolidate response')
  if (!isTerminalReceiptState(record.status)) throw new TypeError('session consolidate response.status must be terminal')
  if (typeof record.recovered !== 'boolean') throw new TypeError('session consolidate response.recovered must be a boolean')
  if (!isConsolidationReviewId(record.reviewId)) {
    throw new TypeError('session consolidate response.reviewId must be a review id')
  }
  if (!isNonNegativeInteger(record.attempt)) throw new TypeError('session consolidate response.attempt must be a non-negative integer')
  if (!isNonNegativeInteger(record.changeCount)) throw new TypeError('session consolidate response.changeCount must be a non-negative integer')
  if (typeof record.debugLoggingEnabled !== 'boolean') throw new TypeError('session consolidate response.debugLoggingEnabled must be a boolean')
  return {
    status: record.status,
    recovered: record.recovered,
    reviewId: record.reviewId,
    attempt: record.attempt,
    changeCount: record.changeCount,
    debugLoggingEnabled: record.debugLoggingEnabled,
  }
}

export function parseConsolidationModelCatalogResponse(value: unknown): ConsolidationModelCatalogResponse {
  const record = requireRecord(value, 'model catalog response')
  requireExactKeys(record, ['available', 'selection', 'debugEnabled', 'revision', 'providers', 'failures'], 'model catalog response')
  if (typeof record.available !== 'boolean') throw new TypeError('model catalog response.available must be a boolean')
  const selection = parseModelSelection(record.selection, 'model catalog response.selection')
  const debugEnabled = requireBoolean(record.debugEnabled, 'model catalog response.debugEnabled')
  const revision = requireRevision(record.revision, 'model catalog response.revision')
  if (!Array.isArray(record.providers)) throw new TypeError('model catalog response.providers must be an array')
  if (!Array.isArray(record.failures)) throw new TypeError('model catalog response.failures must be an array')
  const providers = record.providers.map((value, index) => parseModelProvider(value, `model catalog response.providers[${index}]`))
  const failures = record.failures.map((value, index) => {
    const label = `model catalog response.failures[${index}]`
    const failure = requireRecord(value, label)
    requireExactKeys(failure, ['provider', 'message'], label)
    return {
      provider: requireNonEmptySingleLine(failure.provider, `${label}.provider`),
      message: requireNonEmptySingleLine(failure.message, `${label}.message`),
    }
  })
  if (!record.available && (providers.length !== 0 || failures.length !== 0)) {
    throw new TypeError('unavailable model catalog must not contain providers or failures')
  }
  return { available: record.available, selection, debugEnabled, revision, providers, failures }
}

export function parseConsolidationModelSelectResponse(value: unknown): ConsolidationModelSelectResponse {
  const record = requireRecord(value, 'model select response')
  if (record.status === 'committed') {
    requireExactKeys(record, ['status', 'revision'], 'model select response')
    return { status: 'committed', revision: requireRevision(record.revision, 'model select response.revision') }
  }
  if (record.status === 'conflict') {
    requireExactKeys(record, ['status', 'currentRevision'], 'model select response')
    return { status: 'conflict', currentRevision: requireRevision(record.currentRevision, 'model select response.currentRevision') }
  }
  throw new TypeError('model select response.status must be committed or conflict')
}

function parseSessionSummary(value: unknown, label: string): SessionSummary {
  const raw = requireRecord(value, label)
  // Legacy senders predate the archived marker: default it instead of rejecting the whole list.
  const record: Record<string, unknown> = { ...raw, archived: raw.archived ?? false }
  requireExactKeys(record, [
    'sessionId',
    'title',
    'createdAt',
    'workspaceId',
    'workspaceName',
    'eligible',
    'reason',
    'latestReceipt',
    'archived',
  ], label)
  const sessionId = requireNonEmptySingleLine(record.sessionId, `${label}.sessionId`)
  const title = record.title === null ? null : requireNonEmptySingleLine(record.title, `${label}.title`)
  if (!isNonNegativeInteger(record.createdAt)) throw new TypeError(`${label}.createdAt must be a non-negative integer`)
  const workspaceId = record.workspaceId === null
    ? null
    : requireWorkspaceId(record.workspaceId, `${label}.workspaceId`)
  const workspaceName = record.workspaceName === null
    ? null
    : requireNonEmptySingleLine(record.workspaceName, `${label}.workspaceName`)
  if ((workspaceId === null) !== (workspaceName === null)) {
    throw new TypeError(`${label}.workspaceId and workspaceName must both be null or both be present`)
  }
  const latestReceipt = record.latestReceipt === null
    ? null
    : parseSessionReceiptSummary(record.latestReceipt, `${label}.latestReceipt`)
  if (typeof record.archived !== 'boolean') throw new TypeError(`${label}.archived must be a boolean`)
  const base = {
    sessionId, title, createdAt: record.createdAt, workspaceId, workspaceName, latestReceipt, archived: record.archived,
  } as const
  if (record.eligible === true) {
    if (record.reason !== null) throw new TypeError(`${label}.reason must be null when eligible`)
    return { ...base, eligible: true, reason: null }
  }
  if (record.eligible !== false || !isSessionIneligibleReason(record.reason)) {
    throw new TypeError(`${label}.reason must explain an ineligible Session`)
  }
  return { ...base, eligible: false, reason: record.reason }
}

function parseSessionReceiptSummary(value: unknown, label: string): SessionReceiptSummary {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['reviewId', 'state', 'attempt', 'current', 'completedAt'], label)
  if (!isConsolidationReviewId(record.reviewId)) {
    throw new TypeError(`${label}.reviewId must be a review id`)
  }
  if (!isSessionReceiptState(record.state)) throw new TypeError(`${label}.state must be a receipt state`)
  if (!isNonNegativeInteger(record.attempt)) throw new TypeError(`${label}.attempt must be a non-negative integer`)
  if (typeof record.current !== 'boolean') throw new TypeError(`${label}.current must be a boolean`)
  if (record.completedAt !== null && (typeof record.completedAt !== 'string' || Number.isNaN(Date.parse(record.completedAt)))) {
    throw new TypeError(`${label}.completedAt must be null or an ISO timestamp`)
  }
  return {
    reviewId: record.reviewId,
    state: record.state,
    attempt: record.attempt,
    current: record.current,
    completedAt: record.completedAt,
  }
}

function parseModelSelection(value: unknown, label: string): ConsolidationModelSelection {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['provider', 'model'], label)
  return {
    provider: requireNonEmptySingleLine(record.provider, `${label}.provider`),
    model: requireNonEmptySingleLine(record.model, `${label}.model`),
  }
}

function parseModelProvider(value: unknown, label: string): ConsolidationModelProviderView {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['id', 'name', 'models'], label)
  if (!Array.isArray(record.models)) throw new TypeError(`${label}.models must be an array`)
  return {
    id: requireNonEmptySingleLine(record.id, `${label}.id`),
    name: requireNonEmptySingleLine(record.name, `${label}.name`),
    models: record.models.map((entry, index) => {
      const modelLabel = `${label}.models[${index}]`
      const model = requireRecord(entry, modelLabel)
      const keys = model.description === undefined ? ['id', 'name'] : ['id', 'name', 'description']
      requireExactKeys(model, keys, modelLabel)
      return {
        id: requireNonEmptySingleLine(model.id, `${modelLabel}.id`),
        name: requireNonEmptySingleLine(model.name, `${modelLabel}.name`),
        ...(model.description === undefined
          ? {}
          : { description: requireNonEmptyString(model.description, `${modelLabel}.description`) }),
      }
    }),
  }
}

function parseWorkspaceSummary(value: unknown, label: string): WorkspaceSummary {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['workspaceId', 'displayName', 'revision', 'recordCount'], label)
  return parseWorkspaceSummaryFields(record, label)
}

function parseWorkspaceSummaryFields(record: Record<string, unknown>, label: string): WorkspaceSummary {
  const displayName = requireNonEmptySingleLine(record.displayName, `${label}.displayName`)
  if (!isNonNegativeInteger(record.recordCount)) {
    throw new TypeError(`${label}.recordCount must be a non-negative integer`)
  }
  return {
    workspaceId: requireWorkspaceId(record.workspaceId, `${label}.workspaceId`),
    displayName,
    revision: requireRevision(record.revision, `${label}.revision`),
    recordCount: record.recordCount,
  }
}

function parseWorkspaceRecord(value: unknown, label: string, allowLastEvidenceTime = false): WorkspaceRecordView {
  const record = requireRecord(value, label)
  const keys = allowLastEvidenceTime && record.lastEvidenceTime !== undefined
    ? ['name', 'description', 'type', 'content', 'lastEvidenceTime']
    : ['name', 'description', 'type', 'content']
  requireExactKeys(record, keys, label)
  const name = requireWorkspaceMemoryName(record.name, `${label}.name`)
  const description = requireNonEmptySingleLine(record.description, `${label}.description`)
  if (record.type !== 'feedback' && record.type !== 'project' && record.type !== 'reference') {
    throw new TypeError(`${label}.type must be feedback, project, or reference`)
  }
  if (typeof record.content !== 'string' || record.content.trim() === '') {
    throw new TypeError(`${label}.content must be a non-empty string`)
  }
  // The stamp is store-authored: callers may read it, but only the read endpoint accepts it.
  const stamp = record.lastEvidenceTime
  return {
    name,
    description,
    type: record.type,
    content: record.content,
    ...(allowLastEvidenceTime && typeof stamp === 'number' && Number.isFinite(stamp)
      ? { lastEvidenceTime: stamp }
      : {}),
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly: ${wanted.join(', ') || '(no fields)'}`)
  }
}

function requireRevision(value: unknown, label: string): MemoryRevision {
  if (typeof value !== 'string' || !value.startsWith('sha256:')) {
    throw new TypeError(`${label} must be a sha256 revision`)
  }
  return value as MemoryRevision
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

function requireWorkspaceId(value: unknown, label: string): WorkspaceId {
  if (typeof value !== 'string' || !/^workspace:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be an opaque Workspace id`)
  }
  return value as WorkspaceId
}

function requireNonEmptySingleLine(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty single line`)
  }
  return value
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`)
  return value
}

const RESERVED_WORKSPACE_MEMORY_NAME = 'memory'

function requireWorkspaceMemoryName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new TypeError(`${label} must be a kebab-case Workspace memory name`)
  }
  if (value.toLowerCase() === RESERVED_WORKSPACE_MEMORY_NAME) {
    throw new TypeError(`${label} cannot use the reserved name "${RESERVED_WORKSPACE_MEMORY_NAME}"`)
  }
  return value
}

/** Parse the shadow forgetting report on both sides of the wire. */
export function parseForgettingReportResponse(value: unknown): ForgettingReportResponse {
  const record = requireRecord(value, 'forgetting report response')
  requireExactKeys(record, ['mode', 'changes', 'counts', 'protectedCount'], 'forgetting report response')
  if (typeof record.mode !== 'string') throw new TypeError('forgetting report response.mode must be a string')
  if (!Array.isArray(record.changes)) throw new TypeError('forgetting report response.changes must be an array')
  const counts = requireRecord(record.counts, 'forgetting report response.counts')
  requireExactKeys(counts, ['cooled', 'archived', 'restored'], 'forgetting report response.counts')
  return {
    mode: record.mode,
    changes: record.changes.map((entry, index) => parseForgettingChange(entry, `forgetting report response.changes[${index}]`)),
    counts: {
      cooled: nonNegativeInteger(counts.cooled, 'forgetting report response.counts.cooled'),
      archived: nonNegativeInteger(counts.archived, 'forgetting report response.counts.archived'),
      restored: nonNegativeInteger(counts.restored, 'forgetting report response.counts.restored'),
    },
    protectedCount: nonNegativeInteger(record.protectedCount, 'forgetting report response.protectedCount'),
  }
}

function parseForgettingChange(value: unknown, label: string): ForgettingChangeView {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['name', 'from', 'to', 'importanceScore', 'importanceClass', 'reason'], label)
  for (const key of ['name', 'from', 'to', 'importanceClass', 'reason'] as const) {
    if (typeof record[key] !== 'string') throw new TypeError(`${label}.${key} must be a string`)
  }
  return {
    name: record.name as string,
    from: record.from as string,
    to: record.to as string,
    importanceScore: nonNegativeInteger(record.importanceScore, `${label}.importanceScore`),
    importanceClass: record.importanceClass as string,
    reason: record.reason as string,
  }
}

function isSessionIneligibleReason(value: unknown): value is SessionIneligibleReason {
  return value === 'live' || value === 'missing-cwd' || value === 'workspace-unavailable' || value === 'unstable'
    || value === 'subagent' || value === 'empty' || value === 'failed-zero-output'
}

function isSessionReceiptState(value: unknown): value is SessionReceiptState {
  return value === 'committing' || isTerminalReceiptState(value)
}

function isTerminalReceiptState(value: unknown): value is Exclude<SessionReceiptState, 'committing'> {
  return value === 'committed' || value === 'no-change' || value === 'cancelled'
    || value === 'source-changed' || value === 'target-conflict' || value === 'invalid-proposal'
    || value === 'output-truncated' || value === 'provider-failed' || value === 'evidence-too-large'
    || value === 'internal-error'
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
