import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SuppressedSessions, type SuppressedSessionsProps } from '../src/client/MemorySection.tsx'
import { en } from '../src/client/locales.ts'

const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (en as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params !== undefined && name in params ? String(params[name]) : match)
}) as SuppressedSessionsProps['t']

function render(props: Partial<SuppressedSessionsProps> = {}): string {
  const merged: SuppressedSessionsProps = {
    suppressed: {
      failedZeroOutput: 3,
      trivialAutomation: 0,
      groups: [{
        fingerprint: '3b9e89e6c41bd3c9',
        title: '请只回复两个字：成功',
        count: 3,
        firstCreatedAt: new Date(2026, 10, 4, 21, 43).getTime(),
        lastCreatedAt: new Date(2026, 10, 4, 21, 51).getTime(),
        reason: 'failed-zero-output',
        errorCode: 'PI_AI_ERROR',
      }],
    },
    t,
    ...props,
  }
  return renderToStaticMarkup(<SuppressedSessions {...merged} />)
}

describe('SuppressedSessions disclosure', () => {
  it('renders nothing when no Session was suppressed', () => {
    const html = render({ suppressed: { failedZeroOutput: 0, trivialAutomation: 0, groups: [] } })
    expect(html).toBe('')
  })

  it('summarizes the omitted count in a collapsed disclosure', () => {
    const html = render()
    expect(html).toContain('<details')
    expect(html).not.toMatch(/<details[^>]*\sopen/)
    const head = html.slice(html.indexOf('<summary'), html.indexOf('</summary>'))
    expect(head).toContain('3')
  })

  it('titles a group with its run count and Session title', () => {
    const html = render()
    expect(html).toContain('3 × 请只回复两个字：成功')
  })

  it('shows the error code so the fix is identifiable', () => {
    expect(render()).toContain('PI_AI_ERROR')
  })

  it('shows the time range across the cluster', () => {
    const html = render()
    expect(html).toContain('2026-11-04 21:43')
    expect(html).toContain('2026-11-04 21:51')
  })

  it('never offers a consolidate action for a suppressed group', () => {
    // There is nothing to extract; offering the button would invite a useless run.
    expect(render()).not.toContain('Consolidate')
  })

  it('falls back to an untitled label when the group has no title', () => {
    const html = render({
      suppressed: {
        failedZeroOutput: 1,
        trivialAutomation: 0,
        groups: [{
          fingerprint: 'aaaaaaaaaaaaaaaa',
          title: null,
          count: 1,
          firstCreatedAt: 1,
          lastCreatedAt: 1,
          reason: 'failed-zero-output',
        }],
      },
    })
    expect(html).toContain('Untitled Session')
  })

  it('omits the error line when the group has no error code', () => {
    const html = render({
      suppressed: {
        failedZeroOutput: 1,
        trivialAutomation: 0,
        groups: [{
          fingerprint: 'aaaaaaaaaaaaaaaa',
          title: 'ping',
          count: 1,
          firstCreatedAt: 1,
          lastCreatedAt: 1,
          reason: 'failed-zero-output',
        }],
      },
    })
    expect(html).toContain('ping')
    expect(html).not.toContain('Error:')
  })
})
