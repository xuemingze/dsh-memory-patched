/** Settings section for Global Memory, Workspace Memory, Session Consolidation, and preferences. */

import { useCallback, useEffect, useRef, useState } from 'react'
import { REJECT_REASONS } from '../memory-dream-approval.ts'
import type {
  GlobalMemoryView,
  GlobalReplaceResponse,
  MemoryRevision,
  MemoryStatus,
  SessionIneligibleReason,
  SessionConsolidateResponse,
  SessionListResponse,
  SessionReceiptState,
  SessionSummary,
  SuppressedSessionsSummary,
  ConsolidationModelCatalogResponse,
  ConsolidationModelSelectResponse,
  WorkspaceId,
  WorkspaceCommitChange,
  WorkspaceCommitPayload,
  WorkspaceCommitResponse,
  WorkspaceListResponse,
  WorkspaceRecordView,
  WorkspaceReadResponse,
} from '../protocol.ts'
import type { MemoryLocaleKey, MemoryTranslate } from './locales.ts'

/** Host operations used by the Settings component. */
export interface MemoryApi {
  status(signal?: AbortSignal): Promise<MemoryStatus>
  readGlobal(signal?: AbortSignal): Promise<GlobalMemoryView>
  replaceGlobal(input: { expectedRevision: MemoryRevision; content: string }, signal?: AbortSignal): Promise<GlobalReplaceResponse>
  listWorkspaces(signal?: AbortSignal): Promise<WorkspaceListResponse>
  readWorkspace(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<WorkspaceReadResponse>
  commitWorkspace(input: WorkspaceCommitPayload, signal?: AbortSignal): Promise<WorkspaceCommitResponse>
  listSessions(signal?: AbortSignal): Promise<SessionListResponse>
  forgettingReport(signal?: AbortSignal): Promise<ForgettingReportViewProps['report']>
  dreamReport(signal?: AbortSignal): Promise<Pick<DreamViewProps, 'mode' | 'pending' | 'runs'>>
  dreamApprove(runId: string, approved: readonly string[], signal?: AbortSignal): Promise<unknown>
  dreamReject(runId: string, reason: string, signal?: AbortSignal): Promise<unknown>
  consolidateSession(sessionId: string, signal?: AbortSignal): Promise<SessionConsolidateResponse>
  readModels(signal?: AbortSignal): Promise<ConsolidationModelCatalogResponse>
  selectModel(input: {
    expectedRevision: MemoryRevision
    provider: string
    model: string
    debugEnabled: boolean
  }, signal?: AbortSignal): Promise<ConsolidationModelSelectResponse>
}

/** Settings slot injection assembled by the Browser Cordis entry. */
export interface MemorySectionInjected {
  readonly api: MemoryApi
  readonly loopback: boolean
  readonly t: MemoryTranslate
}

type Tab = 'global' | 'workspaces' | 'sessions' | 'forgetting' | 'dream' | 'settings'
type MemoryButtonVariant = 'default' | 'primary' | 'danger' | 'tab' | 'workspace'
type ErrorState =
  | { readonly kind: 'global-conflict' }
  | { readonly kind: 'workspace-conflict' }
  | { readonly kind: 'settings-conflict' }
  | { readonly kind: 'message'; readonly value: string }

export interface WorkspaceDraftRecord extends WorkspaceRecordView {
  readonly draftId: string
  readonly originalName?: string
}

export type WorkspaceDraftIssue = 'name' | 'duplicate-name' | 'description' | 'content'

export interface SessionWorkspaceGroup {
  readonly key: string
  readonly workspaceId: WorkspaceId | null
  readonly workspaceName: string | null
  readonly sessions: SessionSummary[]
}

/** Format a Session timestamp as a compact local date and minute. */
export function formatSessionCreatedAt(createdAt: number): string {
  const date = new Date(createdAt)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Whether the current stable Session revision already has a successful terminal review. */
export function sessionIsConsolidated(session: SessionSummary): boolean {
  if (!session.eligible || session.latestReceipt?.current !== true) return false
  return session.latestReceipt.state === 'committed' || session.latestReceipt.state === 'no-change'
}

const UNASSIGNED_SESSION_WORKSPACE = 'unassigned'

let workspaceDraftSequence = 0

interface MemoryButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: MemoryButtonVariant
}

/** Button wrapper that keeps hover/press feedback in inline styles. */
function MemoryButton({
  variant = 'default',
  style,
  disabled,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onBlur,
  ...props
}: MemoryButtonProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [pressed, setPressed] = useState(false)
  return (
    <button
      {...props}
      disabled={disabled}
      style={{
        ...style,
        ...(hovered && !disabled ? memoryButtonHoverStyles[variant] : {}),
        ...(pressed && !disabled ? memoryButtonPressedStyle : {}),
        ...(disabled ? memoryButtonDisabledStyle : {}),
      }}
      onPointerEnter={(event) => { setHovered(true); onPointerEnter?.(event) }}
      onPointerLeave={(event) => { setHovered(false); setPressed(false); onPointerLeave?.(event) }}
      onPointerDown={(event) => { setPressed(true); onPointerDown?.(event) }}
      onPointerUp={(event) => { setPressed(false); onPointerUp?.(event) }}
      onPointerCancel={(event) => { setPressed(false); onPointerCancel?.(event) }}
      onBlur={(event) => { setHovered(false); setPressed(false); onBlur?.(event) }}
    />
  )
}

function draftsFrom(records: readonly WorkspaceRecordView[]): WorkspaceDraftRecord[] {
  return records.map(record => ({ ...record, draftId: `existing:${record.name}`, originalName: record.name }))
}

/** Build one deterministic delete-then-put batch from the editable Workspace draft. */
export function buildWorkspaceChanges(
  original: readonly WorkspaceRecordView[],
  drafts: readonly WorkspaceDraftRecord[],
): WorkspaceCommitChange[] {
  const originalByName = new Map(original.map(record => [record.name, record]))
  const retainedNames = new Set(drafts
    .filter(draft => draft.originalName !== undefined && draft.originalName === draft.name)
    .map(draft => draft.originalName as string))
  const deletes: WorkspaceCommitChange[] = original
    .filter(record => !retainedNames.has(record.name))
    .map(record => ({ action: 'delete' as const, name: record.name }))
    .sort((left, right) => left.action === 'delete' && right.action === 'delete'
      ? left.name.localeCompare(right.name, 'en')
      : 0)
  const puts: WorkspaceCommitChange[] = drafts
    .filter((draft) => {
      const previous = draft.originalName === undefined ? undefined : originalByName.get(draft.originalName)
      return previous === undefined
        || previous.name !== draft.name
        || previous.description !== draft.description
        || previous.type !== draft.type
        || previous.content !== draft.content
    })
    .map(({ name, description, type, content }) => ({
      action: 'put' as const,
      record: { name, description, type, content },
    }))
    .sort((left, right) => left.action === 'put' && right.action === 'put'
      ? left.record.name.localeCompare(right.record.name, 'en')
      : 0)
  return [...deletes, ...puts]
}

/** Return the first client-side issue that prevents a valid Workspace batch. */
export function workspaceDraftIssue(drafts: readonly WorkspaceDraftRecord[]): WorkspaceDraftIssue | undefined {
  const names = new Set<string>()
  for (const draft of drafts) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(draft.name) || draft.name.toLowerCase() === 'memory') return 'name'
    if (names.has(draft.name)) return 'duplicate-name'
    names.add(draft.name)
    if (draft.description.trim() === '' || /[\r\n]/u.test(draft.description)) return 'description'
    if (draft.content.trim() === '') return 'content'
  }
}

/** Group newest-first Session summaries by opaque Workspace identity, preserving an unassigned bucket. */
export function groupSessionsByWorkspace(sessions: readonly SessionSummary[]): SessionWorkspaceGroup[] {
  const groups = new Map<string, SessionWorkspaceGroup>()
  for (const session of sessions) {
    const key = session.workspaceId ?? UNASSIGNED_SESSION_WORKSPACE
    const current = groups.get(key)
    if (current === undefined) {
      groups.set(key, {
        key,
        workspaceId: session.workspaceId,
        workspaceName: session.workspaceName,
        sessions: [session],
      })
    } else {
      current.sessions.push(session)
    }
  }
  return [...groups.values()].sort((left, right) => {
    if (left.workspaceId === null) return right.workspaceId === null ? 0 : 1
    if (right.workspaceId === null) return -1
    const byName = left.workspaceName!.localeCompare(right.workspaceName!, 'en')
    return byName === 0 ? left.workspaceId.localeCompare(right.workspaceId, 'en') : byName
  })
}

/**
 * Disclosure caret rotation. Kept as a single CSS rule so opening a Session row
 * never triggers a React re-render; the inline styles cannot express `[open]`.
 */
const DISCLOSURE_CSS = `details[data-memory-session] > summary > span[data-memory-caret] {
  display: inline-block;
}
details[data-memory-session][open] > summary > span[data-memory-caret] {
  transform: rotate(90deg);
}
details[data-memory-session] > summary::-webkit-details-marker {
  display: none;
}`

/** Inject the disclosure stylesheet once per document, idempotently. */
function useDisclosureStyles(): void {
  useEffect(() => {
    const id = 'dsh-memory-disclosure'
    if (document.getElementById(id) !== null) return
    const element = document.createElement('style')
    element.id = id
    element.textContent = DISCLOSURE_CSS
    document.head.appendChild(element)
  }, [])
}

/** Props for one Session disclosure row. */
export interface SessionRowProps {
  readonly session: SessionSummary
  readonly t: MemoryTranslate
  readonly consolidating: boolean
  readonly busy: boolean
  readonly result?: SessionConsolidateResponse | undefined
  readonly onConsolidate: (sessionId: string) => void
}

/**
 * One Session as a native disclosure.
 *
 * Collapsed state carries only what a user scans: title, creation time, and the
 * eligibility/consolidated badge. The full Session id, receipt state, run
 * result, and the consolidate action live in the body so a long list stays
 * compact and every row keeps the same height.
 *
 * Using `<details>` instead of React state keeps toggling free of re-renders:
 * the caret rotation is driven by a CSS attribute selector.
 */
export function SessionRow(props: SessionRowProps): React.JSX.Element {
  const { session, t, consolidating, busy, result, onConsolidate } = props
  const consolidated = sessionIsConsolidated(session)
  return (
    <details data-memory-session="" style={memorySectionStyles.sessionCard}>
      <summary style={memorySectionStyles.sessionSummary}>
        <div style={memorySectionStyles.sessionIdentity}>
          <strong style={memorySectionStyles.sessionTitle}>{session.title ?? t('sessionUntitled')}</strong>
          <small style={{ ...memorySectionStyles.sessionId, ...memorySectionStyles.muted }}>
            {t('sessionCreatedAt', { value: formatSessionCreatedAt(session.createdAt) })}
          </small>
        </div>
        <div style={memorySectionStyles.sessionBadges}>
          {session.archived
            ? <span style={memorySectionStyles.ineligibleBadge}>{t('sessionArchived')}</span>
            : null}
          <span style={consolidated
            ? memorySectionStyles.consolidatedBadge
            : session.eligible
              ? memorySectionStyles.eligibleBadge
              : memorySectionStyles.ineligibleBadge}>
            {consolidated
              ? t('sessionConsolidated')
              : session.eligible
                ? t('sessionEligible')
                : t(sessionReasonKey(session.reason))}
          </span>
        </div>
        <span aria-hidden="true" data-memory-caret="" style={memorySectionStyles.sessionCaret}>{'▸'}</span>
      </summary>
      <div style={memorySectionStyles.sessionBody}>
        <small style={{ ...memorySectionStyles.sessionId, ...memorySectionStyles.muted }}>{session.sessionId}</small>
        <span>{session.latestReceipt === null
          ? t('sessionNoReceipt')
          : t(session.latestReceipt.current ? 'sessionReceiptCurrent' : 'sessionReceiptOlder', {
            state: t(sessionReceiptStateKey(session.latestReceipt.state)),
          })}</span>
        {result === undefined
          ? null
          : <>
              <p style={memorySectionStyles.sessionResult}>{result.recovered
                ? t('sessionConsolidationRecovered', { state: t(sessionReceiptStateKey(result.status)) })
                : result.status === 'committed'
                  ? t('sessionConsolidationCommitted', { count: result.changeCount })
                  : result.status === 'no-change'
                    ? t('sessionConsolidationNoChange')
                    : t('sessionConsolidationResult', { state: t(sessionReceiptStateKey(result.status)) })}</p>
              {result.debugLoggingEnabled
                ? <code style={memorySectionStyles.debugPath}>{t('sessionDebugLog', {
                    reviewId: result.reviewId,
                    attempt: result.attempt,
                  })}</code>
                : null}
            </>}
        {session.eligible ? (
          <div style={memorySectionStyles.actions}>
            <MemoryButton
              variant="primary"
              style={memorySectionStyles.primaryButton}
              disabled={busy || consolidated}
              onClick={() => { onConsolidate(session.sessionId) }}
            >
              {consolidating ? t('sessionConsolidating') : t('sessionConsolidate')}
            </MemoryButton>
          </div>
        ) : null}
      </div>
    </details>
  )
}

/** Props for the collapsed summary of Sessions omitted from the candidate list. */
export interface SuppressedSessionsProps {
  readonly suppressed: SuppressedSessionsSummary
  readonly t: MemoryTranslate
}

/**
 * A single collapsed row listing Sessions that cannot yield memory.
 *
 * These are Kept, not deleted: the disclosure keeps them reachable for auditing
 * while removing them from the review workflow. No consolidate action appears
 * here on purpose — a Session that produced no output has nothing to extract.
 */
export function SuppressedSessions(props: SuppressedSessionsProps): React.JSX.Element | null {
  const { suppressed, t } = props
  const total = suppressed.failedZeroOutput + suppressed.trivialAutomation
  if (total === 0) return null
  return (
    <details data-memory-suppressed="" style={memorySectionStyles.sessionCard}>
      <summary style={memorySectionStyles.sessionSummary}>
        <div style={memorySectionStyles.sessionIdentity}>
          <strong style={memorySectionStyles.sessionTitle}>
            {t('sessionSuppressedTitle', { count: total })}
          </strong>
          <small style={{ ...memorySectionStyles.sessionId, ...memorySectionStyles.muted }}>
            {t('sessionSuppressedHelp')}
          </small>
        </div>
        <span aria-hidden="true" data-memory-caret="" style={memorySectionStyles.sessionCaret}>{'▸'}</span>
      </summary>
      <div style={memorySectionStyles.sessionBody}>
        {suppressed.groups.map(group => (
          <div key={group.fingerprint} data-memory-suppressed-group="">
            <span>{t('sessionSuppressedGroup', {
              count: group.count,
              title: group.title ?? t('sessionUntitled'),
            })}</span>
            <small style={{ ...memorySectionStyles.sessionId, ...memorySectionStyles.muted }}>
              {t('sessionSuppressedRange', {
                first: formatSessionCreatedAt(group.firstCreatedAt),
                last: formatSessionCreatedAt(group.lastCreatedAt),
              })}
            </small>
            {group.errorCode === undefined
              ? null
              : <code style={memorySectionStyles.debugPath}>
                  {t('sessionSuppressedError', { code: group.errorCode })}
                </code>}
          </div>
        ))}
      </div>
    </details>
  )
}

/** One staged or completed Dream action as shown in the panel. */
export interface DreamActionViewProps {
  readonly action: string
  readonly target: string
  readonly sources?: readonly string[]
  readonly rationale?: string
}

/** Browser-side view of Dream: plans waiting for a decision, plus recent runs. */
export interface DreamViewProps {
  /** off | shadow | manual, straight from settings. */
  readonly mode?: string | undefined
  readonly pending: readonly {
    readonly runId: string
    readonly scopeKey: string
    readonly risk: string
    readonly proposalHash: string
    readonly actions: readonly DreamActionViewProps[]
    readonly createdAt: number
    /** Fingerprints the user already declined; shown greyed, not as fresh. */
    readonly declined?: readonly string[]
  }[]
  readonly runs: readonly {
    readonly runId: string
    readonly scopeKey: string
    readonly state: string
    readonly risk: string
    readonly changes: readonly DreamActionViewProps[]
    readonly createdAt: number
    readonly error?: string
  }[]
  /** `approved` holds the fingerprints the user ticked; empty means reject all. */
  readonly onApprove?: (runId: string, approved: readonly string[]) => void
  readonly onDiscard?: (runId: string, reason: string) => void
  readonly busy?: boolean
  readonly t: MemoryTranslate
}

/**
 * Explicit key maps.
 *
 * `en` is declared `as const`, so `MemoryLocaleKey` is a union of literals and a
 * template-literal expression like `` `${id}Tab` `` cannot index it. Mapping by
 * hand also makes a missing translation a compile error rather than a raw key
 * rendered into the panel.
 */
const TAB_KEY: Record<string, MemoryLocaleKey> = {
  global: 'globalTab',
  workspaces: 'workspacesTab',
  sessions: 'sessionsTab',
  forgetting: 'forgettingTab',
  dream: 'dreamTab',
  settings: 'settingsTab',
}

const REASON_KEY: Record<string, MemoryLocaleKey> = {
  'wrong-merge': 'dreamReason_wrong_merge',
  disagree: 'dreamReason_disagree',
  'not-important': 'dreamReason_not_important',
  'already-known': 'dreamReason_already_known',
}

/**
 * Dream's staging area.
 *
 * Approval is per action, so each proposed change has its own checkbox and the
 * buttons act on what is ticked. An all-or-nothing yes would force the user to
 * accept one bad action to get the good ones, and people respond to that by
 * approving without reading.
 *
 * Nothing here applies a plan silently, and nothing deletes.
 */

export function DreamView(props: DreamViewProps): React.JSX.Element {
  const { mode, pending, runs, onApprove, onDiscard, busy = false, t } = props
  // Selection lives per run: two staged plans can be open at once.
  const [ticked, setTicked] = useState<Record<string, string[]>>({})
  const [reason, setReason] = useState<string>(REJECT_REASONS[0]!)

  const fingerprintOf = (action: DreamActionViewProps): string =>
    `${action.action}\u0000${action.target}\u0000${[...(action.sources ?? [])].sort().join(',')}`

  const toggle = (runId: string, fingerprint: string): void => {
    setTicked(current => {
      const held = current[runId] ?? []
      return {
        ...current,
        [runId]: held.includes(fingerprint)
          ? held.filter(entry => entry !== fingerprint)
          : [...held, fingerprint],
      }
    })
  }

  return (
    <section data-memory-dream="" style={memorySectionStyles.sessionCard}>
      <header style={memorySectionStyles.workspaceHeading}>
        <div>
          <h3 style={memorySectionStyles.workspaceTitle}>{t('dreamTitle')}</h3>
          <p style={memorySectionStyles.subtitle}>{t('dreamHelp')}</p>
          {mode === undefined ? null : (
            <p style={memorySectionStyles.subtitle}>
              {t('dreamMode')}: <strong>{mode}</strong>
              {mode === 'manual' ? ` — ${t('dreamModeManualHelp')}` : null}
              {mode === 'off' ? ` — ${t('dreamModeOffHelp')}` : null}
            </p>
          )}
        </div>
      </header>

      <h4 style={memorySectionStyles.workspaceTitle}>{t('dreamPendingTitle')}</h4>
      {pending.length === 0
        ? <p style={memorySectionStyles.subtitle}>{t('dreamNoPending')}</p>
        : (
          <ul style={memorySectionStyles.list}>
            {pending.map(entry => {
              const declined = new Set(entry.declined ?? [])
              const selected = ticked[entry.runId] ?? []
              return (
                <li key={entry.runId} data-dream-pending={entry.runId} style={memorySectionStyles.sessionCard}>
                  <div style={memorySectionStyles.sessionSummary}>
                    <code>{entry.runId}</code>
                    <span style={memorySectionStyles.badge}>
                      {entry.risk === 'content-change' ? t('dreamRiskContent') : t('dreamRiskMetadata')}
                    </span>
                    <span style={memorySectionStyles.badge}>
                      {t('dreamActionsCount')} {entry.actions.length}
                    </span>
                  </div>
                  <ul style={memorySectionStyles.list}>
                    {entry.actions.map((action, index) => {
                      const fingerprint = fingerprintOf(action)
                      const alreadyDeclined = declined.has(fingerprint)
                      return (
                        <li key={`${entry.runId}-${index}`} data-dream-action={fingerprint}>
                          <label>
                            <input
                              type="checkbox"
                              checked={selected.includes(fingerprint)}
                              disabled={busy || alreadyDeclined}
                              onChange={() => { toggle(entry.runId, fingerprint) }}
                            />
                            <code>{action.action}</code> → <strong>{action.target}</strong>
                            {action.sources === undefined ? null : ` (${action.sources.join(', ')})`}
                            {action.rationale === undefined ? null : <em> — {action.rationale}</em>}
                            {alreadyDeclined ? <span style={memorySectionStyles.badge}>{t('dreamAlreadyDeclined')}</span> : null}
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                  <div>
                    <MemoryButton
                      type="button"
                      variant="primary"
                      disabled={busy || selected.length === 0}
                      onClick={() => { onApprove?.(entry.runId, selected) }}
                    >
                      {t('dreamApprove')}
                    </MemoryButton>
                    <select
                      value={reason}
                      disabled={busy}
                      onChange={event => { setReason(event.target.value) }}
                      aria-label={t('dreamRejectReason')}
                    >
                      {REJECT_REASONS.map(entry => (
                        <option key={entry} value={entry}>
                          {t(REASON_KEY[entry] ?? 'dreamRejectReason')}
                        </option>
                      ))}
                    </select>
                    <MemoryButton
                      type="button"
                      disabled={busy}
                      onClick={() => { onDiscard?.(entry.runId, reason) }}
                    >
                      {t('dreamDiscard')}
                    </MemoryButton>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

      <h4 style={memorySectionStyles.workspaceTitle}>{t('dreamHistoryTitle')}</h4>
      {runs.length === 0
        ? <p style={memorySectionStyles.subtitle}>{t('dreamNoRuns')}</p>
        : (
          <ul style={memorySectionStyles.list}>
            {runs.map(entry => (
              <li key={entry.runId} data-dream-run={entry.runId}>
                <code>{entry.runId}</code> — <span>{entry.state}</span>
                {' · '}
                {entry.risk === 'content-change' ? t('dreamRiskContent') : t('dreamRiskMetadata')}
                {' · '}
                {t('dreamActionsCount')} {entry.changes.length}
                {entry.error === undefined ? null : <div style={memorySectionStyles.validation}>{entry.error}</div>}
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

/** Browser-side view of the shadow forgetting report. */
export interface ForgettingReportViewProps {
  readonly report: {
    readonly mode: string
    readonly changes: readonly {
      readonly name: string
      readonly from: string
      readonly to: string
      readonly importanceScore: number
      readonly importanceClass: string
      readonly reason: string
    }[]
    readonly counts: { readonly cooled: number; readonly archived: number; readonly restored: number }
    readonly protectedCount: number
  }
  readonly t: MemoryTranslate
}

/**
 * What forgetting would do, shown before it does anything.
 *
 * The report is descriptive only. There is deliberately no action here that
 * removes a record: hiding is reversible and shown as such, while physical
 * deletion is a separate act requiring the user to ask for it in so many words.
 */
export function ForgettingReportView(props: ForgettingReportViewProps): React.JSX.Element {
  const { report, t } = props
  const shadow = report.mode === 'shadow'
  return (
    <section data-memory-forgetting="" style={memorySectionStyles.sessionCard}>
      <header style={memorySectionStyles.workspaceHeading}>
        <div>
          <strong>{t('forgettingTitle')}</strong>
          <p style={memorySectionStyles.subtitle}>{t('forgettingHelp')}</p>
        </div>
        <span style={memorySectionStyles.muted}>{t('forgettingMode', { mode: report.mode })}</span>
      </header>
      {shadow ? <p style={memorySectionStyles.muted}>{t('forgettingShadowNote')}</p> : null}
      {report.protectedCount > 0
        ? <p style={{ ...memorySectionStyles.muted, ...memorySectionStyles.sessionId }}>
            <strong>{t('forgettingProtected', { count: report.protectedCount })}</strong>
            {' — '}
            {t('forgettingProtectedHelp')}
          </p>
        : null}
      {report.changes.length === 0
        ? <p style={memorySectionStyles.muted}>{t('forgettingEmpty')}</p>
        : <div style={memorySectionStyles.sessionList}>
            {report.changes.map(change => (
              <div key={change.name} data-memory-forgetting-change="">
                <span>{t('forgettingChange', {
                  name: change.name,
                  from: change.from,
                  to: change.to,
                })}</span>
                <small style={{ ...memorySectionStyles.sessionId, ...memorySectionStyles.muted }}>
                  {t('forgettingReason', { reason: change.reason })}
                </small>
              </div>
            ))}
          </div>}
    </section>
  )
}

/** Render status plus Global, Workspaces, and Sessions tabs. */
export function MemorySection(props: MemorySectionInjected): React.JSX.Element {
  const { t } = props
  const [tab, setTab] = useState<Tab>('global')
  const [status, setStatus] = useState<MemoryStatus>()
  const [global, setGlobal] = useState<GlobalMemoryView>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [workspaces, setWorkspaces] = useState<WorkspaceListResponse['workspaces']>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<WorkspaceId>()
  const [workspace, setWorkspace] = useState<WorkspaceReadResponse>()
  const [workspaceDrafts, setWorkspaceDrafts] = useState<WorkspaceDraftRecord[]>([])
  const [sessionBusy, setSessionBusy] = useState(false)
  const [sessions, setSessions] = useState<SessionListResponse>()
  const [forgetting, setForgetting] = useState<ForgettingReportViewProps['report']>()
  const [forgettingBusy, setForgettingBusy] = useState(false)
  const [dream, setDream] = useState<Pick<DreamViewProps, 'mode' | 'pending' | 'runs'>>()
  const [dreamBusy, setDreamBusy] = useState(false)
  const [selectedSessionWorkspaceKey, setSelectedSessionWorkspaceKey] = useState<string>()
  const [consolidatingSessionId, setConsolidatingSessionId] = useState<string>()
  const [consolidationResult, setConsolidationResult] = useState<{ sessionId: string; result: SessionConsolidateResponse }>()
  const [modelBusy, setModelBusy] = useState(false)
  const [modelCatalog, setModelCatalog] = useState<ConsolidationModelCatalogResponse>()
  const [modelProvider, setModelProvider] = useState('')
  const [modelName, setModelName] = useState('')
  const [debugEnabled, setDebugEnabled] = useState(false)
  const [error, setError] = useState<ErrorState>()
  const workspaceChanges = workspace === undefined ? [] : buildWorkspaceChanges(workspace.records, workspaceDrafts)
  const workspaceDirty = workspaceChanges.length > 0
  const globalDirty = global !== undefined && draft !== global.content
  const draftIssue = workspaceDraftIssue(workspaceDrafts)
  useDisclosureStyles()
  const sessionWorkspaceGroups = groupSessionsByWorkspace(sessions?.sessions ?? [])
  const selectedSessionWorkspace = sessionWorkspaceGroups.find(group => group.key === selectedSessionWorkspaceKey)
    ?? sessionWorkspaceGroups[0]
  const selectedModelProvider = modelCatalog?.providers.find(provider => provider.id === modelProvider)
  const settingsDirty = modelCatalog !== undefined && (
    modelProvider !== modelCatalog.selection.provider
    || modelName !== modelCatalog.selection.model
    || debugEnabled !== modelCatalog.debugEnabled
  )
  const tabRefreshController = useRef<AbortController | undefined>(undefined)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!props.loopback) return
    setBusy(true)
    setError(undefined)
    try {
      const [nextStatus, nextGlobal] = await Promise.all([
        props.api.status(signal),
        props.api.readGlobal(signal),
      ])
      setStatus(nextStatus)
      setGlobal(nextGlobal)
      setDraft(nextGlobal.content)
    } catch (cause: unknown) {
      if (!signal?.aborted) setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (!signal?.aborted) setBusy(false)
    }
  }, [props.api, props.loopback])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => {
      controller.abort()
      tabRefreshController.current?.abort()
    }
  }, [refresh])

  const save = async (): Promise<void> => {
    if (global === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await props.api.replaceGlobal({ expectedRevision: global.revision, content: draft })
      if (result.status === 'conflict') {
        setError({ kind: 'global-conflict' })
        return
      }
      await refresh()
    } catch (cause: unknown) {
      setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(false)
    }
  }

  const readWorkspace = async (workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void> => {
    setSelectedWorkspaceId(workspaceId)
    setWorkspace(undefined)
    setWorkspaceBusy(true)
    setError(undefined)
    try {
      const next = await props.api.readWorkspace(workspaceId, signal)
      setWorkspace(next)
      setWorkspaceDrafts(draftsFrom(next.records))
    } catch (cause: unknown) {
      if (!signal?.aborted) setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (!signal?.aborted) setWorkspaceBusy(false)
    }
  }

  const refreshWorkspaces = async (signal?: AbortSignal): Promise<void> => {
    setWorkspaceBusy(true)
    setError(undefined)
    try {
      const result = await props.api.listWorkspaces(signal)
      setWorkspaces(result.workspaces)
      const target = result.workspaces.find(entry => entry.workspaceId === selectedWorkspaceId)
        ?? result.workspaces[0]
      if (target === undefined) {
        setSelectedWorkspaceId(undefined)
        setWorkspace(undefined)
        setWorkspaceDrafts([])
      } else {
        setSelectedWorkspaceId(target.workspaceId)
        setWorkspace(undefined)
        setWorkspaceDrafts([])
        const next = await props.api.readWorkspace(target.workspaceId, signal)
        setWorkspace(next)
        setWorkspaceDrafts(draftsFrom(next.records))
      }
    } catch (cause: unknown) {
      if (!signal?.aborted) setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (!signal?.aborted) setWorkspaceBusy(false)
    }
  }

  const refreshSessions = async (signal?: AbortSignal): Promise<void> => {
    setSessionBusy(true)
    setError(undefined)
    try {
      const next = await props.api.listSessions(signal)
      const groups = groupSessionsByWorkspace(next.sessions)
      setSessions(next)
      setSelectedSessionWorkspaceKey(current => groups.some(group => group.key === current)
        ? current
        : groups[0]?.key)
    } catch (cause: unknown) {
      if (!signal?.aborted) setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (!signal?.aborted) setSessionBusy(false)
    }
  }

  const refreshForgetting = async (signal?: AbortSignal): Promise<void> => {
    setForgettingBusy(true)
    setError(undefined)
    try {
      setForgetting(await props.api.forgettingReport(signal))
    } catch (cause: unknown) {
      if (!signal?.aborted) setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (!signal?.aborted) setForgettingBusy(false)
    }
  }

  const refreshDream = async (signal?: AbortSignal): Promise<void> => {
    setDreamBusy(true)
    setError(undefined)
    try {
      setDream(await props.api.dreamReport(signal))
    } catch (cause: unknown) {
      if (!signal?.aborted) setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (!signal?.aborted) setDreamBusy(false)
    }
  }

  /**
   * Send the ticked actions for one run.
   *
   * An empty selection is a full rejection and writes nothing, which is why it
   * needs a reason: the reason is what stops the next run from re-proposing it.
   */
  const decideDream = async (runId: string, approved: readonly string[], reason: string): Promise<void> => {
    setDreamBusy(true)
    setError(undefined)
    try {
      if (approved.length === 0) await props.api.dreamReject(runId, reason)
      else await props.api.dreamApprove(runId, approved)
      setDream(await props.api.dreamReport())
    } catch (cause: unknown) {
      setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setDreamBusy(false)
    }
  }

  const consolidateSession = async (sessionId: string): Promise<void> => {
    setConsolidatingSessionId(sessionId)
    setConsolidationResult(undefined)
    setError(undefined)
    try {
      const result = await props.api.consolidateSession(sessionId)
      setConsolidationResult({ sessionId, result })
      await refreshSessions()
    } catch (cause: unknown) {
      setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setConsolidatingSessionId(undefined)
    }
  }

  const refreshModels = async (signal?: AbortSignal): Promise<void> => {
    setModelBusy(true)
    setError(undefined)
    try {
      const catalog = await props.api.readModels(signal)
      setModelCatalog(catalog)
      setModelProvider(catalog.selection.provider)
      setModelName(catalog.selection.model)
      setDebugEnabled(catalog.debugEnabled)
    } catch (cause: unknown) {
      if (!signal?.aborted) setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (!signal?.aborted) setModelBusy(false)
    }
  }

  const saveSettings = async (): Promise<void> => {
    if (modelCatalog === undefined || modelProvider === '' || modelName === '') return
    setModelBusy(true)
    setError(undefined)
    try {
      const result = await props.api.selectModel({
        expectedRevision: modelCatalog.revision,
        provider: modelProvider,
        model: modelName,
        debugEnabled,
      })
      if (result.status === 'conflict') {
        setError({ kind: 'settings-conflict' })
        return
      }
      await refreshModels()
    } catch (cause: unknown) {
      setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setModelBusy(false)
    }
  }

  const changeTab = (next: Tab): void => {
    setTab(next)
    setError(undefined)
    // A tab-triggered refresh is owned by this switch: abort the previous one so
    // an out-of-order response cannot overwrite the state (and drafts) of the
    // tab the user just opened.
    tabRefreshController.current?.abort()
    const controller = new AbortController()
    tabRefreshController.current = controller
    const signal = controller.signal
    if (next === 'workspaces' && workspaces.length === 0) void refreshWorkspaces(signal)
    if (next === 'sessions' && sessions === undefined) void refreshSessions(signal)
    if (next === 'forgetting' && forgetting === undefined) void refreshForgetting(signal)
    if (next === 'dream' && dream === undefined) void refreshDream(signal)
    if (next === 'settings' && modelCatalog === undefined) void refreshModels(signal)
  }

  const refreshVisible = async (): Promise<void> => {
    await refresh()
    if (tab === 'workspaces') await refreshWorkspaces()
    if (tab === 'sessions') await refreshSessions()
    // Forgetting is its own concern, so it refreshes on its own entry rather
    // than piggybacking on the Session list.
    if (tab === 'forgetting') await refreshForgetting()
    if (tab === 'dream') await refreshDream()
    if (tab === 'settings') await refreshModels()
  }

  const updateWorkspaceDraft = (
    draftId: string,
    update: Partial<Pick<WorkspaceDraftRecord, 'name' | 'description' | 'type' | 'content'>>,
  ): void => {
    setWorkspaceDrafts(current => current.map(record => record.draftId === draftId ? { ...record, ...update } : record))
  }

  const addWorkspaceRecord = (): void => {
    const names = new Set(workspaceDrafts.map(record => record.name))
    let suffix = 1
    let name = 'new-memory'
    while (names.has(name)) {
      suffix += 1
      name = `new-memory-${suffix}`
    }
    workspaceDraftSequence += 1
    setWorkspaceDrafts(current => [...current, {
      draftId: `new:${workspaceDraftSequence}`,
      name,
      description: '',
      type: 'project',
      content: '',
    }])
  }

  const discardWorkspaceChanges = (): void => {
    if (workspace === undefined) return
    setWorkspaceDrafts(draftsFrom(workspace.records))
    setError(undefined)
  }

  const saveWorkspace = async (): Promise<void> => {
    if (workspace === undefined || workspaceChanges.length === 0 || draftIssue !== undefined) return
    setWorkspaceBusy(true)
    setError(undefined)
    try {
      const result = await props.api.commitWorkspace({
        workspaceId: workspace.workspaceId,
        expectedRevision: workspace.revision,
        changes: workspaceChanges,
      })
      if (result.status === 'conflict') {
        setError({ kind: 'workspace-conflict' })
        return
      }
      await refreshWorkspaces()
    } catch (cause: unknown) {
      setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setWorkspaceBusy(false)
    }
  }

  if (!props.loopback) {
    return <section style={memorySectionStyles.page}><h2>{t('title')}</h2><p>{t('loopbackOnly')}</p></section>
  }

  return (
    <section style={memorySectionStyles.page}>
      <header style={memorySectionStyles.header}>
        <div style={memorySectionStyles.heading}>
          <h2 style={memorySectionStyles.title}>{t('title')}</h2>
          <p style={memorySectionStyles.subtitle}>{t('subtitle')}</p>
        </div>
        <MemoryButton
          type="button"
          style={memorySectionStyles.button}
          disabled={busy || workspaceBusy || sessionBusy || modelBusy
            || (tab === 'workspaces' && workspaceDirty)
            || (tab === 'global' && globalDirty)}
          onClick={() => { void refreshVisible() }}
        >
          {t('refresh')}
        </MemoryButton>
      </header>

      <div style={memorySectionStyles.status}>
        <span><strong>{t('status')}</strong> {status === undefined ? t('loading') : t('enabled')}</span>
        <span><strong>{t('global')}</strong> {t('bytes', { count: status?.globalBytes ?? 0 })}</span>
        <span><strong>{t('workspaces')}</strong> {status?.workspaceCount ?? 0}</span>
        <span style={memorySectionStyles.path}><strong>{t('root')}</strong> {status?.root ?? '—'}</span>
      </div>

      <nav style={memorySectionStyles.tabs} aria-label={t('sections')}>
        {(['global', 'workspaces', 'sessions', 'forgetting', 'dream', 'settings'] as const).map(id => (
          <MemoryButton
            key={id}
            type="button"
            variant="tab"
            style={{ ...memorySectionStyles.tab, ...(tab === id ? memorySectionStyles.activeTab : {}) }}
            onClick={() => { changeTab(id) }}
          >
            {t(`${id}Tab`)}
          </MemoryButton>
        ))}
      </nav>

      {error === undefined ? null : (
        <p role="alert" style={memorySectionStyles.error}>
          {error.kind === 'global-conflict'
            ? t('conflict')
            : error.kind === 'workspace-conflict'
              ? t('workspaceConflict')
              : error.kind === 'settings-conflict'
                ? t('settingsConflict')
              : error.value}
        </p>
      )}

      {tab === 'global' ? (
        <div style={memorySectionStyles.panel}>
          <p style={memorySectionStyles.subtitle}>{t('globalHelp')}</p>
          <label htmlFor="dsh-memory-global"><strong>GLOBAL.md</strong></label>
          <textarea
            id="dsh-memory-global"
            style={memorySectionStyles.editor}
            spellCheck={false}
            value={draft}
            onChange={event => { setDraft(event.target.value) }}
          />
          <div style={memorySectionStyles.actions}>
            <MemoryButton variant="primary" type="button" style={memorySectionStyles.primaryButton} disabled={busy || global === undefined} onClick={() => { void save() }}>
              {t('saveGlobal')}
            </MemoryButton>
          </div>
        </div>
      ) : tab === 'workspaces' ? (
        <div style={memorySectionStyles.panel}>
          <p style={memorySectionStyles.subtitle}>{t('workspaceHelp')}</p>
          <div style={memorySectionStyles.workspaceLayout}>
          <aside style={memorySectionStyles.workspaceList} aria-label={t('workspaceList')}>
            <strong>{t('workspaceList')}</strong>
            {workspaceBusy && workspaces.length === 0 ? <p>{t('loading')}</p> : null}
            {!workspaceBusy && workspaces.length === 0 ? <p style={memorySectionStyles.muted}>{t('workspaceEmpty')}</p> : null}
            {workspaces.map(entry => (
              <MemoryButton
                key={entry.workspaceId}
                type="button"
                variant="workspace"
                style={{
                  ...memorySectionStyles.workspaceButton,
                  ...(selectedWorkspaceId === entry.workspaceId ? memorySectionStyles.activeWorkspaceButton : {}),
                }}
                disabled={workspaceBusy || workspaceDirty}
                onClick={() => { void readWorkspace(entry.workspaceId) }}
              >
                <span>{entry.displayName}</span>
                <small style={memorySectionStyles.muted}>{t('recordCount', { count: entry.recordCount })}</small>
              </MemoryButton>
            ))}
          </aside>

          <div style={memorySectionStyles.workspaceDetail}>
            {workspace === undefined ? null : (
              <>
                <header style={memorySectionStyles.workspaceHeading}>
                  <h3 style={memorySectionStyles.workspaceTitle}>{workspace.displayName}</h3>
                  <span style={memorySectionStyles.muted}>{t('recordCount', { count: workspaceDrafts.length })}</span>
                </header>
                <section>
                  <h4>{t('workspaceIndex')}</h4>
                  <pre style={memorySectionStyles.workspaceIndex}>{workspace.index}</pre>
                </section>
                <section>
                  <header style={memorySectionStyles.recordSectionHeading}>
                    <h4 style={memorySectionStyles.recordSectionTitle}>{t('workspaceRecords')}</h4>
                    <MemoryButton type="button" style={memorySectionStyles.button} disabled={workspaceBusy} onClick={addWorkspaceRecord}>
                      {t('addRecord')}
                    </MemoryButton>
                  </header>
                  {draftIssue === undefined ? null : (
                    <p role="alert" style={memorySectionStyles.validation}>
                      {t(draftIssue === 'name'
                        ? 'workspaceInvalidName'
                        : draftIssue === 'duplicate-name'
                          ? 'workspaceDuplicateName'
                          : draftIssue === 'description'
                            ? 'workspaceInvalidDescription'
                            : 'workspaceInvalidContent')}
                    </p>
                  )}
                  {workspaceDrafts.length === 0 ? <p style={memorySectionStyles.muted}>{t('workspaceNoRecords')}</p> : null}
                  <div style={memorySectionStyles.recordList}>
                    {workspaceDrafts.map(record => (
                      <article key={record.draftId} style={memorySectionStyles.recordCard}>
                        <header style={memorySectionStyles.recordHeading}>
                          <strong>{record.name || t('newRecord')}</strong>
                          <MemoryButton
                            type="button"
                            variant="danger"
                            style={memorySectionStyles.dangerButton}
                            disabled={workspaceBusy}
                            onClick={() => { setWorkspaceDrafts(current => current.filter(candidate => candidate.draftId !== record.draftId)) }}
                          >
                            {t('deleteRecord')}
                          </MemoryButton>
                        </header>
                        <div style={memorySectionStyles.recordFields}>
                          <label style={memorySectionStyles.field}>
                            <span>{t('recordName')}</span>
                            <input
                              style={memorySectionStyles.input}
                              value={record.name}
                              disabled={workspaceBusy}
                              onChange={event => { updateWorkspaceDraft(record.draftId, { name: event.target.value }) }}
                            />
                          </label>
                          <label style={memorySectionStyles.field}>
                            <span>{t('recordType')}</span>
                            <select
                              style={memorySectionStyles.input}
                              value={record.type}
                              disabled={workspaceBusy}
                              onChange={event => { updateWorkspaceDraft(record.draftId, { type: event.target.value as WorkspaceRecordView['type'] }) }}
                            >
                              <option value="feedback">feedback</option>
                              <option value="project">project</option>
                              <option value="reference">reference</option>
                            </select>
                          </label>
                        </div>
                        <label style={memorySectionStyles.field}>
                          <span>{t('recordDescription')}</span>
                          <input
                            style={memorySectionStyles.input}
                            value={record.description}
                            disabled={workspaceBusy}
                            onChange={event => { updateWorkspaceDraft(record.draftId, { description: event.target.value }) }}
                          />
                        </label>
                        <label style={memorySectionStyles.field}>
                          <span>{t('recordContent')}</span>
                          <textarea
                            style={memorySectionStyles.recordEditor}
                            value={record.content}
                            disabled={workspaceBusy}
                            spellCheck={false}
                            onChange={event => { updateWorkspaceDraft(record.draftId, { content: event.target.value }) }}
                          />
                        </label>
                      </article>
                    ))}
                  </div>
                  <div style={{ ...memorySectionStyles.actions, ...memorySectionStyles.workspaceActions }}>
                    <MemoryButton type="button" style={memorySectionStyles.button} disabled={workspaceBusy || !workspaceDirty} onClick={discardWorkspaceChanges}>
                      {t('discardChanges')}
                    </MemoryButton>
                    <MemoryButton
                      type="button"
                      variant="primary"
                      style={memorySectionStyles.primaryButton}
                      disabled={workspaceBusy || !workspaceDirty || draftIssue !== undefined}
                      onClick={() => { void saveWorkspace() }}
                    >
                      {t('saveWorkspace')}
                    </MemoryButton>
                  </div>
                </section>
              </>
            )}
          </div>
          </div>
        </div>
      ) : tab === 'dream' ? (
        <div style={memorySectionStyles.panel}>
          {dreamBusy && dream === undefined ? <p>{t('loading')}</p> : null}
          {dream === undefined
            ? null
            : (
              <DreamView
                mode={dream.mode}
                pending={dream.pending}
                runs={dream.runs}
                busy={dreamBusy}
                onApprove={(runId, approved) => { void decideDream(runId, approved, 'disagree') }}
                onDiscard={(runId, reason) => { void decideDream(runId, [], reason) }}
                t={t}
              />
            )}
        </div>
      ) : tab === 'forgetting' ? (
        <div style={memorySectionStyles.panel}>
          {forgettingBusy && forgetting === undefined ? <p>{t('loading')}</p> : null}
          {forgetting === undefined
            ? null
            : <ForgettingReportView report={forgetting} t={t} />}
        </div>
      ) : tab === 'sessions' ? (
        <div style={memorySectionStyles.sessionPanel}>
          <header style={memorySectionStyles.workspaceHeading}>
            <div>
              <h3 style={memorySectionStyles.workspaceTitle}>{t('sessionCandidates')}</h3>
              <p style={memorySectionStyles.subtitle}>{t('sessionCandidateHelp')}</p>
            </div>
            <span style={memorySectionStyles.muted}>{t('sessionCount', { count: sessions?.sessions.length ?? 0 })}</span>
          </header>
          {sessionBusy && sessions === undefined ? <p>{t('loading')}</p> : null}
          {sessions?.available === false ? <p style={memorySectionStyles.validation}>{t('sessionUnavailable')}</p> : null}
          {sessions?.available === true && sessions.sessions.length === 0
            && sessions.suppressed.failedZeroOutput + sessions.suppressed.trivialAutomation === 0
            ? <p style={memorySectionStyles.muted}>{t('sessionEmpty')}</p>
            : null}
          {/* When every persisted Session was suppressed there is no Workspace to
              select, so the disclosure has to render outside the split layout. */}
          {sessions?.available === true && sessions.sessions.length === 0
            && sessions.suppressed.failedZeroOutput + sessions.suppressed.trivialAutomation > 0
            ? <div style={memorySectionStyles.sessionList}>
                <SuppressedSessions suppressed={sessions.suppressed} t={t} />
              </div>
            : null}
          <div style={memorySectionStyles.workspaceLayout}>
            <aside style={memorySectionStyles.workspaceList} aria-label={t('sessionWorkspaceList')}>
              <strong>{t('sessionWorkspaceList')}</strong>
              {sessionWorkspaceGroups.map(group => (
                <MemoryButton
                  key={group.key}
                  type="button"
                  variant="workspace"
                  style={{
                    ...memorySectionStyles.workspaceButton,
                    ...(selectedSessionWorkspace?.key === group.key ? memorySectionStyles.activeWorkspaceButton : {}),
                  }}
                  disabled={sessionBusy}
                  onClick={() => { setSelectedSessionWorkspaceKey(group.key) }}
                >
                  <span>{group.workspaceName ?? t('sessionWorkspaceUnassigned')}</span>
                  <small style={memorySectionStyles.muted}>{t('sessionCount', { count: group.sessions.length })}</small>
                </MemoryButton>
              ))}
            </aside>
            <div style={memorySectionStyles.workspaceDetail}>
              {selectedSessionWorkspace === undefined ? null : (
                <>
                  <header style={memorySectionStyles.workspaceHeading}>
                    <h3 style={memorySectionStyles.workspaceTitle}>
                      {selectedSessionWorkspace.workspaceName ?? t('sessionWorkspaceUnassigned')}
                    </h3>
                    <span style={memorySectionStyles.muted}>
                      {t('sessionCount', { count: selectedSessionWorkspace.sessions.length })}
                    </span>
                  </header>
                  <div style={memorySectionStyles.sessionList}>
                    {/* Rendered above the per-Workspace groups: a Workspace whose
                        only Sessions were suppressed would otherwise vanish
                        entirely, taking the explanation with it. */}
                    {sessions === undefined
                      ? null
                      : <SuppressedSessions suppressed={sessions.suppressed} t={t} />}
                    {selectedSessionWorkspace.sessions.map(session => (
                      <SessionRow
                        key={session.sessionId}
                        session={session}
                        t={t}
                        consolidating={consolidatingSessionId === session.sessionId}
                        busy={consolidatingSessionId !== undefined}
                        result={consolidationResult?.sessionId === session.sessionId ? consolidationResult.result : undefined}
                        onConsolidate={sid => { void consolidateSession(sid) }}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div style={memorySectionStyles.modelPanel}>
          <div>
            <h3 style={memorySectionStyles.workspaceTitle}>{t('settingsTitle')}</h3>
            <p style={memorySectionStyles.subtitle}>{t('settingsHelp')}</p>
          </div>
          <section style={memorySectionStyles.settingsGroup}>
            <h3 style={memorySectionStyles.workspaceTitle}>{t('modelSettingsTitle')}</h3>
            <p style={memorySectionStyles.subtitle}>{t('modelSettingsHelp')}</p>
          </section>
          {modelBusy && modelCatalog === undefined ? <p>{t('loading')}</p> : null}
          {modelCatalog?.available === false ? <p style={memorySectionStyles.validation}>{t('modelCatalogUnavailable')}</p> : null}
          {modelCatalog?.available === true && modelCatalog.providers.length === 0
            ? <p style={memorySectionStyles.validation}>{t('modelCatalogEmpty')}</p>
            : null}
          {modelCatalog?.failures.map(failure => (
            <p key={failure.provider} style={memorySectionStyles.validation}>
              {t('modelCatalogFailure', { provider: failure.provider, message: failure.message })}
            </p>
          ))}
          <div style={memorySectionStyles.modelFields}>
            <label style={memorySectionStyles.field}>
              <span>{t('modelProvider')}</span>
              <select
                style={memorySectionStyles.input}
                value={modelProvider}
                disabled={modelBusy || modelCatalog?.available !== true}
                onChange={(event) => {
                  const provider = event.target.value
                  setModelProvider(provider)
                  setModelName(modelCatalog?.providers.find(entry => entry.id === provider)?.models[0]?.id ?? '')
                }}
              >
                {!modelCatalog?.providers.some(provider => provider.id === modelProvider)
                  ? <option value={modelProvider}>{modelProvider || '—'}</option>
                  : null}
                {modelCatalog?.providers.map(provider => (
                  <option key={provider.id} value={provider.id}>{provider.name} ({provider.id})</option>
                ))}
              </select>
            </label>
            <label style={memorySectionStyles.field}>
              <span>{t('modelName')}</span>
              <select
                style={memorySectionStyles.input}
                value={modelName}
                disabled={modelBusy || modelCatalog?.available !== true}
                onChange={event => { setModelName(event.target.value) }}
              >
                {!selectedModelProvider?.models.some(model => model.id === modelName)
                  ? <option value={modelName}>{modelName || '—'}</option>
                  : null}
                {selectedModelProvider?.models.map(model => (
                  <option key={model.id} value={model.id}>{model.name} ({model.id})</option>
                ))}
              </select>
            </label>
          </div>
          <p style={memorySectionStyles.muted}>{t('modelCurrent', {
            provider: modelCatalog?.selection.provider ?? '—',
            model: modelCatalog?.selection.model ?? '—',
          })}</p>
          <section style={memorySectionStyles.settingsGroup}>
            <label style={memorySectionStyles.toggleRow}>
              <input
                type="checkbox"
                checked={debugEnabled}
                disabled={modelBusy || modelCatalog === undefined}
                onChange={event => { setDebugEnabled(event.target.checked) }}
              />
              <span>
                <strong>{t('debugEnabled')}</strong>
                <small style={memorySectionStyles.settingHelp}>{t('debugHelp')}</small>
              </span>
            </label>
            {debugEnabled ? <p style={memorySectionStyles.muted}>{t('debugLocation')}</p> : null}
          </section>
          <div style={memorySectionStyles.actions}>
            <MemoryButton
              variant="primary"
              style={memorySectionStyles.primaryButton}
              disabled={modelBusy || !settingsDirty || modelProvider === '' || modelName === ''}
              onClick={() => { void saveSettings() }}
            >
              {t('saveSettings')}
            </MemoryButton>
          </div>
        </div>
      )}
    </section>
  )
}

export const memorySectionStyles: Record<string, React.CSSProperties> = {
  page: { display: 'grid', gap: 16, padding: 24, color: 'inherit', boxSizing: 'border-box', width: '100%', maxWidth: '100%', minWidth: 0 },
  header: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 16, alignItems: 'center', minWidth: 0 },
  heading: { flex: '1 1 240px', minWidth: 0 },
  title: { margin: 0, fontSize: 24 },
  subtitle: { margin: '4px 0 0', opacity: 0.72 },
  button: { padding: '8px 12px', borderRadius: 8, border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer', transition: 'background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease' },
  primaryButton: { padding: '9px 14px', borderRadius: 8, border: 0, background: '#5b5bd6', color: '#fff', fontWeight: 600, cursor: 'pointer', transition: 'background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease' },
  status: { display: 'flex', flexWrap: 'wrap', gap: '8px 20px', padding: 14, borderRadius: 10, background: 'rgba(127,127,127,0.12)', boxSizing: 'border-box', width: '100%', maxWidth: '100%', minWidth: 0 },
  path: { flexBasis: '100%', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  tabs: { display: 'flex', flexWrap: 'wrap', gap: 8, borderBottom: '1px solid rgba(127,127,127,0.3)', maxWidth: '100%', minWidth: 0 },
  tab: { padding: '9px 12px', border: 0, borderBottom: '2px solid transparent', borderRadius: '8px 8px 0 0', background: 'transparent', color: 'inherit', opacity: 0.7, cursor: 'pointer', transition: 'background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease' },
  activeTab: { borderBottom: '2px solid #5b5bd6', opacity: 1, fontWeight: 600 },
  panel: { display: 'grid', gap: 10, width: '100%', maxWidth: '100%', minWidth: 0 },
  editor: { display: 'block', minHeight: 320, width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', resize: 'vertical', borderRadius: 10, padding: 14, border: '1px solid rgba(127,127,127,0.4)', background: 'rgba(127,127,127,0.06)', color: 'inherit', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.5 },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 12, alignItems: 'center', minWidth: 0 },
  workspaceActions: { marginTop: 16 },
  error: { margin: 0, padding: 12, borderRadius: 8, background: 'rgba(200,40,40,0.15)', color: '#d44', overflowWrap: 'anywhere' },
  sessionPanel: { display: 'grid', gap: 14, width: '100%', maxWidth: '100%', minWidth: 0 },
  sessionList: { display: 'grid', gap: 10, minWidth: 0 },
  sessionCard: { minWidth: 0, border: '1px solid rgba(127,127,127,0.3)', borderRadius: 10 },
  sessionSummary: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: 14, minWidth: 0, cursor: 'pointer', listStyle: 'none' },
  sessionCaret: { flex: '0 0 auto', width: 18, textAlign: 'center', opacity: 0.55, fontSize: 12, transition: 'transform 140ms ease' },
  sessionBadges: { display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 },
  sessionBody: { display: 'grid', gap: 10, padding: '0 14px 14px', minWidth: 0 },
  sessionIdentity: { display: 'grid', gap: 3, minWidth: 0 },
  sessionTitle: { minWidth: 0, overflowWrap: 'anywhere' },
  sessionId: { minWidth: 0, overflowWrap: 'anywhere' },
  sessionMeta: { display: 'flex', flexWrap: 'wrap', gap: '6px 18px', minWidth: 0, opacity: 0.72, fontSize: 13 },
  eligibleBadge: { width: 'fit-content', alignSelf: 'flex-start', whiteSpace: 'nowrap', padding: '2px 6px', borderRadius: 999, background: 'rgba(91,91,214,0.14)', color: '#6868e8', lineHeight: 1.4, fontSize: 12, fontWeight: 600 },
  consolidatedBadge: { width: 'fit-content', alignSelf: 'flex-start', whiteSpace: 'nowrap', padding: '2px 6px', borderRadius: 999, background: 'rgba(45,160,90,0.16)', color: '#2a9d58', lineHeight: 1.4, fontSize: 12, fontWeight: 600 },
  ineligibleBadge: { width: 'fit-content', alignSelf: 'flex-start', whiteSpace: 'nowrap', padding: '2px 6px', borderRadius: 999, background: 'rgba(127,127,127,0.13)', color: 'inherit', opacity: 0.76, lineHeight: 1.4, fontSize: 12 },
  sessionResult: { margin: 0, padding: 10, borderRadius: 8, background: 'rgba(45,160,90,0.12)', overflowWrap: 'anywhere' },
  debugPath: { minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  modelPanel: { display: 'grid', gap: 16, width: '100%', maxWidth: 720, minWidth: 0 },
  modelFields: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12, minWidth: 0 },
  settingsGroup: { display: 'grid', gap: 8, paddingTop: 4, minWidth: 0 },
  toggleRow: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: 12, border: '1px solid rgba(127,127,127,0.3)', borderRadius: 10, cursor: 'pointer' },
  settingHelp: { display: 'block', marginTop: 4, opacity: 0.68, lineHeight: 1.45 },
  workspaceLayout: { display: 'flex', flexWrap: 'wrap', gap: 16, width: '100%', maxWidth: '100%', minWidth: 0, alignItems: 'flex-start' },
  workspaceList: { display: 'grid', gap: 8, flex: '1 1 180px', maxWidth: '100%', minWidth: 0 },
  workspaceButton: { display: 'grid', gap: 4, width: '100%', minWidth: 0, padding: 12, textAlign: 'left', border: '1px solid rgba(127,127,127,0.3)', borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer', transition: 'background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease' },
  activeWorkspaceButton: { background: 'rgba(91,91,214,0.16)', border: '1px solid #5b5bd6' },
  workspaceDetail: { display: 'grid', gap: 16, flex: '3 1 360px', maxWidth: '100%', minWidth: 0 },
  workspaceHeading: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, minWidth: 0 },
  workspaceTitle: { margin: 0, overflowWrap: 'anywhere' },
  workspaceIndex: { margin: 0, padding: 12, maxWidth: '100%', minWidth: 0, overflowX: 'auto', boxSizing: 'border-box', borderRadius: 8, background: 'rgba(127,127,127,0.08)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  recordList: { display: 'grid', gap: 12, minWidth: 0 },
  recordSectionHeading: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12 },
  recordSectionTitle: { margin: 0 },
  recordCard: { display: 'grid', gap: 12, padding: 14, minWidth: 0, border: '1px solid rgba(127,127,127,0.3)', borderRadius: 10 },
  recordHeading: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, minWidth: 0 },
  recordFields: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 12, minWidth: 0 },
  field: { display: 'grid', gap: 6, minWidth: 0 },
  input: { width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', padding: '8px 10px', border: '1px solid rgba(127,127,127,0.4)', borderRadius: 8, background: 'rgba(127,127,127,0.06)', color: 'inherit' },
  recordEditor: { display: 'block', minHeight: 150, width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', resize: 'vertical', padding: 10, border: '1px solid rgba(127,127,127,0.4)', borderRadius: 8, background: 'rgba(127,127,127,0.06)', color: 'inherit', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.5 },
  dangerButton: { padding: '6px 10px', borderRadius: 8, border: '1px solid #c44', background: 'transparent', color: '#c44', cursor: 'pointer', transition: 'background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease' },
  validation: { margin: '0 0 12px', padding: 10, borderRadius: 8, background: 'rgba(200,140,40,0.15)', color: 'inherit' },
  muted: { opacity: 0.68 },
}

export const memoryButtonHoverStyles: Record<MemoryButtonVariant, React.CSSProperties> = {
  default: { background: 'rgba(127,127,127,0.13)', transform: 'translateY(-1px)', boxShadow: '0 3px 10px rgba(0,0,0,0.12)' },
  primary: { filter: 'brightness(1.1)', transform: 'translateY(-1px)', boxShadow: '0 4px 12px rgba(91,91,214,0.3)' },
  danger: { background: 'rgba(204,68,68,0.12)', transform: 'translateY(-1px)', boxShadow: '0 3px 10px rgba(204,68,68,0.14)' },
  tab: { background: 'rgba(127,127,127,0.1)' },
  workspace: { background: 'rgba(91,91,214,0.1)', transform: 'translateY(-1px)', boxShadow: '0 3px 10px rgba(0,0,0,0.1)' },
}

export const memoryButtonPressedStyle: React.CSSProperties = {
  transform: 'translateY(0) scale(0.98)',
  boxShadow: 'none',
}

export const memoryButtonDisabledStyle: React.CSSProperties = {
  cursor: 'not-allowed',
  opacity: 0.48,
  filter: 'none',
  transform: 'none',
  boxShadow: 'none',
}

function sessionReasonKey(reason: SessionIneligibleReason): MemoryLocaleKey {
  switch (reason) {
    case 'live': return 'sessionReasonLive'
    case 'missing-cwd': return 'sessionReasonMissingCwd'
    case 'workspace-unavailable': return 'sessionReasonWorkspaceUnavailable'
    case 'unstable': return 'sessionReasonUnstable'
    case 'subagent': return 'sessionReasonSubagent'
    case 'empty': return 'sessionReasonEmpty'
    case 'failed-zero-output': return 'sessionReasonFailedZeroOutput'
  }
}

function sessionReceiptStateKey(state: SessionReceiptState): MemoryLocaleKey {
  switch (state) {
    case 'committing': return 'sessionStateCommitting'
    case 'committed': return 'sessionStateCommitted'
    case 'no-change': return 'sessionStateNoChange'
    case 'cancelled': return 'sessionStateCancelled'
    case 'source-changed': return 'sessionStateSourceChanged'
    case 'target-conflict': return 'sessionStateTargetConflict'
    case 'invalid-proposal': return 'sessionStateInvalidProposal'
    case 'output-truncated': return 'sessionStateOutputTruncated'
    case 'provider-failed': return 'sessionStateProviderFailed'
    case 'evidence-too-large': return 'sessionStateEvidenceTooLarge'
    case 'internal-error': return 'sessionStateInternalError'
  }
}
