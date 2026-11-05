import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionRow, type SessionRowProps } from '../src/client/MemorySection.tsx'
import { en } from '../src/client/locales.ts'
import type { SessionSummary, WorkspaceId } from '../src/protocol.ts'

const workspaceId = `workspace:${'a'.repeat(64)}` as WorkspaceId

const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (en as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params !== undefined && name in params ? String(params[name]) : match)
}) as SessionRowProps['t']

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'session-69ab6114-39ef-4707-951b-92d677e27aaa',
    title: '请只回复两个字：成功',
    createdAt: new Date(2026, 10, 4, 21, 43).getTime(),
    workspaceId,
    workspaceName: '闲聊及灵感',
    eligible: true,
    reason: null,
    latestReceipt: null,
    archived: false,
    ...overrides,
  } as SessionSummary
}

function render(overrides: Partial<SessionRowProps> = {}): string {
  const props: SessionRowProps = {
    session: summary(),
    t,
    consolidating: false,
    busy: false,
    result: undefined,
    onConsolidate: () => undefined,
    ...overrides,
  }
  return renderToStaticMarkup(<SessionRow {...props} />)
}

function summarySection(html: string): string {
  return html.slice(html.indexOf('<summary'), html.indexOf('</summary>'))
}

describe('SessionRow disclosure', () => {
  it('renders a native disclosure that starts collapsed', () => {
    const html = render()
    expect(html).toContain('<details')
    expect(html).toContain('<summary')
    expect(html).not.toMatch(/<details[^>]*\sopen/)
  })

  it('keeps title, creation time, and badge in the summary', () => {
    const head = summarySection(render())
    expect(head).toContain('请只回复两个字：成功')
    expect(head).toContain('2026-11-04 21:43')
    expect(head).toContain('Eligible')
  })

  it('moves the full Session id out of the summary', () => {
    const html = render()
    expect(summarySection(html)).not.toContain('session-69ab6114')
    expect(html).toContain('session-69ab6114-39ef-4707-951b-92d677e27aaa')
  })

  it('hides the consolidate action while collapsed', () => {
    const html = render()
    expect(summarySection(html)).not.toContain('Consolidate')
    expect(html).toContain('Consolidate')
  })

  it('marks a consolidated Session and disables its action', () => {
    const html = render({
      session: summary({
        latestReceipt: {
          reviewId: `review-${'b'.repeat(64)}`,
          state: 'committed',
          attempt: 3,
          current: true,
          completedAt: '2026-11-05T00:00:00.000Z',
        },
      }),
    })
    expect(summarySection(html)).toContain('Consolidated')
    expect(html).toContain('disabled')
  })

  it('disables the action while any other Session is consolidating', () => {
    expect(render({ busy: true })).toContain('disabled')
    expect(render({ busy: false })).not.toContain('disabled')
  })

  it('shows the run result and debug path inside the body', () => {
    const html = render({
      result: {
        status: 'committed',
        recovered: false,
        reviewId: `review-${'c'.repeat(64)}`,
        attempt: 3,
        changeCount: 8,
        debugLoggingEnabled: true,
      },
    })
    expect(html).toContain('applied 8 memory changes')
    expect(html).toContain('attempt-3.jsonl')
  })

  it('renders an ineligible Session without the action', () => {
    const html = render({ session: summary({ eligible: false, reason: 'live' }) })
    expect(summarySection(html)).toContain('Currently running')
    expect(html).not.toContain('Consolidate')
  })

  it('shows the archived badge alongside the eligibility badge', () => {
    const head = summarySection(render({ session: summary({ archived: true }) }))
    expect(head).toContain('Archived')
    expect(head).toContain('Eligible')
  })
})
