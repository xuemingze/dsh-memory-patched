/**
 * The closed schema Dream proposals must satisfy.
 *
 * Dream is a librarian, not an author. It may merge, supersede, contest, rank,
 * cool, archive, promote, or extract a procedure from records that already
 * exist. It may not invent a fact, rewrite a body of memory, replace GLOBAL
 * wholesale, or delete anything.
 *
 * Every rule here exists because the failure mode is silent: a hallucinated
 * record name or a plausible-looking merge would corrupt memory without any
 * error surfacing. So the parser validates against the real record set rather
 * than trusting the proposal, and it recomputes anything that carries authority
 * (priority) from deterministic inputs.
 */

import { scoreImportance, type ImportanceSignals } from './memory-importance.ts'
import type { ClaimKind, GovernanceClaim, Volatility } from './memory-governance-types.ts'

/** The only actions Dream may propose. */
export const DREAM_ACTIONS = [
  'merge',
  'supersede',
  'mark-contested',
  'set-priority',
  'cool',
  'archive',
  'promote-global',
  'extract-sop',
] as const
export type DreamActionKind = (typeof DREAM_ACTIONS)[number]

/** Hard ceiling per run so one proposal cannot rewrite the whole store. */
export const MAX_DREAM_ACTIONS = 40

/** Raised when a proposal does not satisfy the closed schema. */
export class DreamProposalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DreamProposalError'
  }
}

/** Everything the parser is allowed to check a proposal against. */
export interface DreamProposalContext {
  readonly scopeKey: string
  readonly claims: readonly GovernanceClaim[]
  /** Existing GLOBAL section headings; promotion must target one of these. */
  readonly globalSections: readonly string[]
  readonly now: number
}

interface BaseAction {
  readonly action: DreamActionKind | 'set-priority'
}

/** Combine several records into one. */
export interface DreamMergeAction {
  readonly action: 'merge'
  readonly sources: readonly string[]
  readonly target: string
  readonly description: string
  readonly text: string
  readonly rationale?: string
}

/** Replace an older record with a newer one. */
export interface DreamSupersedeAction {
  readonly action: 'supersede'
  readonly older: string
  readonly newer: string
  readonly rationale?: string
}

/** Mark a record as disputed without deciding who is right. */
export interface DreamContestAction {
  readonly action: 'mark-contested'
  readonly target: string
  readonly opposingRecords?: readonly string[]
  readonly rationale?: string
}

/** Revise a record's priority. The score is recomputed, never trusted. */
export interface DreamPriorityAction {
  readonly action: 'set-priority'
  readonly target: string
  readonly score: number
  readonly rationale?: string
}

/** Lower a record's visibility. */
export interface DreamCoolAction {
  readonly action: 'cool'
  readonly target: string
  readonly rationale?: string
}

/** Move a record out of the default prompt while keeping it on disk. */
export interface DreamArchiveAction {
  readonly action: 'archive'
  readonly target: string
  readonly rationale?: string
}

/** Copy a workspace record into one existing GLOBAL section. */
export interface DreamPromoteAction {
  readonly action: 'promote-global'
  readonly source: string
  readonly section: string
  readonly text: string
  readonly rationale?: string
}

/** Lift a reusable procedure out of an incident. */
export interface DreamExtractSopAction {
  readonly action: 'extract-sop'
  readonly source: string
  readonly target: string
  readonly description: string
  readonly text: string
  readonly rationale?: string
}

export type DreamAction =
  | DreamMergeAction
  | DreamSupersedeAction
  | DreamContestAction
  | DreamPriorityAction
  | DreamCoolAction
  | DreamArchiveAction
  | DreamPromoteAction
  | DreamExtractSopAction

/** How much damage applying this plan could do. */
export type DreamRisk = 'metadata-only' | 'content-change'

/** A validated, canonicalized plan. Nothing here has been applied. */
export interface DreamPlan {
  readonly scopeKey: string
  readonly actions: readonly DreamAction[]
  readonly risk: DreamRisk
}

/** Actions that leave every record body untouched. */
const METADATA_ONLY: ReadonlySet<string> = new Set(['mark-contested', 'set-priority', 'cool', 'archive'])

/**
 * Validate one untrusted proposal.
 *
 * Throws `DreamProposalError` on anything unexpected: unknown action kinds,
 * unknown fields, unknown record names, cycles, and out-of-scope targets.
 */
export function parseDreamProposal(value: unknown, context: DreamProposalContext): DreamPlan {
  const record = requireRecord(value, 'dream proposal')
  requireExactKeys(record, ['actions'], 'dream proposal')
  if (!Array.isArray(record.actions)) throw new DreamProposalError('dream proposal.actions must be an array')
  // An explicit empty plan is a valid answer: "nothing here needs reorganising".
  // Rejecting it would push the model to invent work to satisfy the schema.
  if (record.actions.length > MAX_DREAM_ACTIONS) {
    throw new DreamProposalError(`dream proposal carries too many actions (max ${MAX_DREAM_ACTIONS})`)
  }

  const known = new Map(context.claims.map(claim => [claim.name, claim]))
  const actions: DreamAction[] = []

  for (const [index, entry] of record.actions.entries()) {
    actions.push(parseAction(entry, `dream proposal.actions[${index}]`, known, context))
  }

  // Cycles are checked before the overlap rule so a looping supersede chain is
  // reported as what it is, not as a vaguer "two actions on one record".
  assertNoSupersedeCycle(actions)

  // Two actions may not fight over one record: whichever won would depend on
  // array order, which the model does not control deterministically.
  const claimedTargets = new Set<string>()
  for (const action of actions) {
    for (const name of touchedTargets(action)) {
      if (claimedTargets.has(name)) {
        throw new DreamProposalError(`dream proposal applies more than one action to "${name}"`)
      }
      claimedTargets.add(name)
    }
  }
  return {
    scopeKey: context.scopeKey,
    actions,
    risk: actions.every(action => METADATA_ONLY.has(action.action)) ? 'metadata-only' : 'content-change',
  }
}

function parseAction(
  value: unknown,
  label: string,
  known: ReadonlyMap<string, GovernanceClaim>,
  context: DreamProposalContext,
): DreamAction {
  const record = requireRecord(value, label)
  const kind = record.action
  if (typeof kind !== 'string' || !isDreamAction(kind)) {
    throw new DreamProposalError(`${label}.action is not a permitted Dream action`)
  }

  switch (kind) {
    case 'merge':
      return parseMerge(record, label, known)
    case 'supersede':
      return parseSupersede(record, label, known)
    case 'mark-contested':
      return parseContest(record, label, known)
    case 'set-priority':
      return parsePriority(record, label, known)
    case 'cool':
      return parseSimple(record, label, known, 'cool')
    case 'archive':
      return parseSimple(record, label, known, 'archive')
    case 'promote-global':
      return parsePromote(record, label, known, context)
    case 'extract-sop':
      return parseExtractSop(record, label, known)
  }
}

function parseMerge(
  record: Record<string, unknown>,
  label: string,
  known: ReadonlyMap<string, GovernanceClaim>,
): DreamMergeAction {
  requireExactKeys(record, ['action', 'sources', 'target', 'description', 'text'], label, ['rationale'])
  if (!Array.isArray(record.sources) || record.sources.some(entry => typeof entry !== 'string')) {
    throw new DreamProposalError(`${label}.sources must be a list of record names`)
  }
  if (record.sources.length < 2) {
    throw new DreamProposalError(`${label}.sources must cite at least two records`)
  }
  for (const source of record.sources as string[]) requireKnown(known, source, label)
  if (new Set(record.sources).size !== record.sources.length) {
    throw new DreamProposalError(`${label}.sources must be distinct`)
  }
  return {
    action: 'merge',
    sources: record.sources as string[],
    target: requireName(record.target, `${label}.target`),
    description: requireText(record.description, `${label}.description`, 500),
    text: requireText(record.text, `${label}.text`, 8_000),
    ...rationaleOf(record, label),
  }
}

function parseSupersede(
  record: Record<string, unknown>,
  label: string,
  known: ReadonlyMap<string, GovernanceClaim>,
): DreamSupersedeAction {
  requireExactKeys(record, ['action', 'older', 'newer'], label, ['rationale'])
  const older = requireName(record.older, `${label}.older`)
  const newer = requireName(record.newer, `${label}.newer`)
  requireKnown(known, older, label)
  requireKnown(known, newer, label)
  if (older === newer) throw new DreamProposalError(`${label} cannot supersede a record with itself`)
  return { action: 'supersede', older, newer, ...rationaleOf(record, label) }
}

function parseContest(
  record: Record<string, unknown>,
  label: string,
  known: ReadonlyMap<string, GovernanceClaim>,
): DreamContestAction {
  requireExactKeys(record, ['action', 'target'], label, ['rationale', 'opposingRecords'])
  const target = requireName(record.target, `${label}.target`)
  requireKnown(known, target, label)
  const opposing = record.opposingRecords
  if (opposing !== undefined) {
    if (!Array.isArray(opposing) || opposing.some(entry => typeof entry !== 'string')) {
      throw new DreamProposalError(`${label}.opposingRecords must be a list of record names`)
    }
    for (const name of opposing as string[]) requireKnown(known, name, label)
  }
  return {
    action: 'mark-contested',
    target,
    ...(opposing === undefined ? {} : { opposingRecords: opposing as string[] }),
    ...rationaleOf(record, label),
  }
}

/**
 * Rescore a record.
 *
 * The model's `score` is deliberately ignored: priority drives what gets
 * forgotten, so it must come from the deterministic scorer rather than from a
 * number the model produced.
 */
function parsePriority(
  record: Record<string, unknown>,
  label: string,
  known: ReadonlyMap<string, GovernanceClaim>,
): DreamPriorityAction {
  requireExactKeys(record, ['action', 'target', 'score'], label, ['rationale'])
  const target = requireName(record.target, `${label}.target`)
  const claim = known.get(target)
  if (claim === undefined) throw new DreamProposalError(`${label} cites unknown record "${target}"`)
  if (typeof record.score !== 'number' || !Number.isFinite(record.score)) {
    throw new DreamProposalError(`${label}.score must be a number`)
  }
  const score = rescore(claim)
  // A re-score that lands on the current value changes nothing. Accepting it
  // produced a plan that was approved, committed, and left the store byte for
  // byte identical — the user spent a decision on a no-op. Rejecting it feeds
  // the reason back to the model, which can then propose something that matters
  // or submit no change at all.
  if (score === claim.importanceScore) {
    throw new DreamProposalError(
      `${label} would not change "${target}": it already scores ${score}`,
    )
  }
  return {
    action: 'set-priority',
    target,
    score,
    ...rationaleOf(record, label),
  }
}

function parseSimple(
  record: Record<string, unknown>,
  label: string,
  known: ReadonlyMap<string, GovernanceClaim>,
  action: 'cool' | 'archive',
): DreamCoolAction | DreamArchiveAction {
  requireExactKeys(record, ['action', 'target'], label, ['rationale'])
  const target = requireName(record.target, `${label}.target`)
  requireKnown(known, target, label)
  return { action, target, ...rationaleOf(record, label) }
}

function parsePromote(
  record: Record<string, unknown>,
  label: string,
  known: ReadonlyMap<string, GovernanceClaim>,
  context: DreamProposalContext,
): DreamPromoteAction {
  requireExactKeys(record, ['action', 'source', 'section', 'text'], label, ['rationale'])
  const source = requireName(record.source, `${label}.source`)
  requireKnown(known, source, label)
  const section = requireText(record.section, `${label}.section`, 120)
  // Promotion may only append into a section that already exists. A wholesale
  // document replacement would hand Dream authorship of GLOBAL.
  if (!context.globalSections.includes(section)) {
    throw new DreamProposalError(`${label}.section "${section}" is not a known global section`)
  }
  return {
    action: 'promote-global',
    source,
    section,
    text: requireText(record.text, `${label}.text`, 2_000),
    ...rationaleOf(record, label),
  }
}

function parseExtractSop(
  record: Record<string, unknown>,
  label: string,
  known: ReadonlyMap<string, GovernanceClaim>,
): DreamExtractSopAction {
  requireExactKeys(record, ['action', 'source', 'target', 'description', 'text'], label, ['rationale'])
  const source = requireName(record.source, `${label}.source`)
  requireKnown(known, source, label)
  return {
    action: 'extract-sop',
    source,
    target: requireName(record.target, `${label}.target`),
    description: requireText(record.description, `${label}.description`, 500),
    text: requireText(record.text, `${label}.text`, 8_000),
    ...rationaleOf(record, label),
  }
}

/** Every record name an action would touch. */
function touchedTargets(action: DreamAction): string[] {
  switch (action.action) {
    case 'merge':
      return [...action.sources, action.target]
    case 'supersede':
      return [action.older, action.newer]
    case 'extract-sop':
      return [action.source, action.target]
    case 'promote-global':
      return [action.source]
    default:
      return [action.target]
  }
}

/** Reject a supersede graph that loops back on itself. */
function assertNoSupersedeCycle(actions: readonly DreamAction[]): void {
  const edges = new Map<string, string>()
  for (const action of actions) {
    if (action.action === 'supersede') edges.set(action.newer, action.older)
  }
  for (const start of edges.keys()) {
    const seen = new Set<string>([start])
    let cursor = edges.get(start)
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        throw new DreamProposalError(`dream proposal contains a circular supersede chain at "${cursor}"`)
      }
      seen.add(cursor)
      cursor = edges.get(cursor)
    }
  }
}

/** Derive importance from the stored claim rather than from the proposal. */
function rescore(claim: GovernanceClaim): number {
  const signals: ImportanceSignals = {
    kind: claim.kind as ClaimKind,
    volatility: claim.volatility as Volatility,
    evidenceCount: claim.evidenceCount,
    distinctSources: 1,
    workspaceCount: 1,
    sourcePlugins: claim.sourcePlugins,
    userStated: claim.kind === 'preference' || claim.kind === 'identity',
    hasProcedure: claim.kind === 'procedure',
    superseded: claim.lifecycle === 'superseded',
  }
  return scoreImportance(signals)
}

function isDreamAction(value: string): value is DreamActionKind {
  return (DREAM_ACTIONS as readonly string[]).includes(value)
}

function requireKnown(
  known: ReadonlyMap<string, GovernanceClaim>,
  name: string,
  label: string,
): void {
  if (!known.has(name)) throw new DreamProposalError(`${label} cites unknown record "${name}"`)
}

function requireName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DreamProposalError(`${label} must be a non-empty record name`)
  }
  return value
}

function requireText(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DreamProposalError(`${label} must be non-empty text`)
  }
  if (value.length > limit) throw new DreamProposalError(`${label} exceeds ${limit} characters`)
  return value
}

/** `rationale` is optional everywhere and never influences behaviour. */
function rationaleOf(record: Record<string, unknown>, label: string): { rationale?: string } {
  const rationale = record.rationale
  if (rationale === undefined) return {}
  if (typeof rationale !== 'string') throw new DreamProposalError(`${label}.rationale must be a string`)
  return { rationale: rationale.slice(0, 500) }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DreamProposalError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

/** Reject unknown or missing keys, with an explicit allowlist for optionals. */
function requireExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(record).sort()
  const allowed = [...required, ...optional].sort()
  const missing = required.filter(key => !(key in record))
  if (missing.length > 0) {
    throw new DreamProposalError(`${label} is missing: ${[...missing].sort().join(', ')}`)
  }
  const unexpected = actual.filter(key => !allowed.includes(key))
  if (unexpected.length > 0) {
    throw new DreamProposalError(`${label} has unknown fields: ${unexpected.join(', ')}`)
  }
}
