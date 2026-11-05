import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ForgettingReportView, type ForgettingReportViewProps } from '../src/client/MemorySection.tsx'
import { en } from '../src/client/locales.ts'

const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (en as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params !== undefined && name in params ? String(params[name]) : match)
}) as ForgettingReportViewProps['t']

function report(overrides: Partial<ForgettingReportViewProps['report']> = {}): ForgettingReportViewProps['report'] {
  return {
    mode: 'shadow',
    changes: [
      { name: 'stale-plugin-detail', from: 'active', to: 'cooled', importanceScore: 20, importanceClass: 'transient', reason: 'cooled' },
    ],
    counts: { cooled: 1, archived: 0, restored: 0 },
    protectedCount: 2,
    ...overrides,
  }
}

function render(props: Partial<ForgettingReportViewProps> = {}): string {
  return renderToStaticMarkup(<ForgettingReportView report={report()} t={t} {...props} />)
}

describe('ForgettingReportView', () => {
  it('says nothing changed in shadow mode', () => {
    const html = render()
    expect(html).toContain('shadow')
  })

  it('lists each proposed change with its target state', () => {
    const html = render()
    expect(html).toContain('stale-plugin-detail')
    expect(html).toContain('cooled')
  })

  it('reports how many records are protected', () => {
    // Protected records are the reassurance: the user's own rules are untouched.
    expect(render()).toContain('2')
  })

  it('offers no destructive action anywhere', () => {
    const html = render()
    // Physical removal is a separate act that needs explicit consent, so the
    // report must contain no control that could perform it.
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<form')
    expect(html.toLowerCase()).not.toContain('purge')
  })

  it('states that nothing is removed when there are no changes', () => {
    const html = render({
      report: report({ changes: [], counts: { cooled: 0, archived: 0, restored: 0 } }),
    })
    expect(html).toContain('No records')
  })

  it('shows a restore suggestion distinctly', () => {
    const html = render({
      report: report({
        changes: [
          { name: 'revived-record', from: 'archived', to: 'active', importanceScore: 40, importanceClass: 'working', reason: 'restored' },
        ],
        counts: { cooled: 0, archived: 0, restored: 1 },
      }),
    })
    expect(html).toContain('revived-record')
    expect(html).toContain('active')
  })
})
