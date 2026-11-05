import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DreamView } from '../src/client/MemorySection.tsx'
import { en, zh } from '../src/client/locales.ts'

const t = ((key: string) => (zh as Record<string, string>)[key] ?? key) as never

function pending(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'dream-1',
    scopeKey: 'scope-a',
    risk: 'metadata-only',
    proposalHash: 'abc',
    actions: [{ action: 'cool', target: 'alpha' }],
    createdAt: 1793860469791,
    ...overrides,
  }
}

describe('Dream panel', () => {
  it('shows a pending plan with its actions', () => {
    const html = renderToStaticMarkup(
      <DreamView pending={[pending()]} runs={[]} t={t} />,
    )
    expect(html).toContain('dream-1')
    expect(html).toContain('cool')
    expect(html).toContain('alpha')
  })

  it('labels a metadata-only plan differently from a content change', () => {
    // The risk label is the whole point: only one of these can lose information.
    const metadata = renderToStaticMarkup(
      <DreamView pending={[pending({ risk: 'metadata-only' })]} runs={[]} t={t} />,
    )
    const content = renderToStaticMarkup(
      <DreamView pending={[pending({ risk: 'content-change' })]} runs={[]} t={t} />,
    )
    expect(metadata).toContain(zh.dreamRiskMetadata)
    expect(content).toContain(zh.dreamRiskContent)
    expect(metadata).not.toContain(zh.dreamRiskContent)
  })

  it('offers approve and discard, and nothing that deletes', () => {
    const html = renderToStaticMarkup(<DreamView pending={[pending()]} runs={[]} t={t} />)
    expect(html).toContain(zh.dreamApprove)
    expect(html).toContain(zh.dreamDiscard)
    // Deletion is never a Dream action. The help text may *say* nothing is
    // deleted — that reassurance is the point — but no control may offer it.
    expect(html.toLowerCase()).not.toContain('purge')
    expect(html).not.toContain('data-dream-delete')
    const buttonLabels = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/gu)].map(match => match[1])
    expect(buttonLabels).toEqual([zh.dreamApprove, zh.dreamDiscard])
  })

  it('says so when nothing is waiting', () => {
    const html = renderToStaticMarkup(<DreamView pending={[]} runs={[]} t={t} />)
    expect(html).toContain(zh.dreamNoPending)
  })

  it('shows recent runs with their outcome', () => {
    const html = renderToStaticMarkup(
      <DreamView
        pending={[]}
        runs={[{
          runId: 'dream-old',
          scopeKey: 'scope-a',
          state: 'committed',
          risk: 'metadata-only',
          changes: [{ action: 'cool', target: 'alpha' }],
          createdAt: 1793860469791,
        }]}
        t={t}
      />,
    )
    expect(html).toContain('dream-old')
    expect(html).toContain('committed')
  })

  it('surfaces a failure message instead of hiding it', () => {
    const html = renderToStaticMarkup(
      <DreamView
        pending={[]}
        runs={[{
          runId: 'dream-bad',
          scopeKey: 'scope-a',
          state: 'provider-failed',
          risk: 'metadata-only',
          changes: [],
          createdAt: 1793860469791,
          error: 'socket hang up',
        }]}
        t={t}
      />,
    )
    expect(html).toContain('socket hang up')
  })

  it('disables the buttons while a decision is in flight', () => {
    const html = renderToStaticMarkup(
      <DreamView pending={[pending()]} runs={[]} busy t={t} />,
    )
    expect(html).toContain('disabled')
  })

  it('has strings for both locales', () => {
    for (const key of ['dreamTitle', 'dreamHelp', 'dreamApprove', 'dreamDiscard', 'dreamRiskContent'] as const) {
      expect((zh as Record<string, string>)[key]).toBeTruthy()
      expect((en as Record<string, string>)[key]).toBeTruthy()
    }
  })
})
