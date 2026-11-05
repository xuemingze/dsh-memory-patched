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

  it('gives every action its own checkbox', () => {
    // Per-action approval is the point: an all-or-nothing yes trains people to
    // approve without reading.
    const html = renderToStaticMarkup(
      <DreamView
        pending={[pending({
          actions: [
            { action: 'cool', target: 'alpha' },
            { action: 'archive', target: 'beta' },
          ],
        })]}
        runs={[]}
        t={t}
      />,
    )
    const boxes = [...html.matchAll(/data-dream-action="([^"]+)"/gu)].map(match => match[1])
    expect(boxes).toHaveLength(2)
    expect(html).toContain('type="checkbox"')
  })

  it('offers a reason code when declining', () => {
    const html = renderToStaticMarkup(<DreamView pending={[pending()]} runs={[]} t={t} />)
    expect(html).toContain('<select')
    for (const reason of ['wrong-merge', 'disagree', 'not-important', 'already-known']) {
      expect(html).toContain(`value="${reason}"`)
    }
  })

  it('marks an already-declined action and disables its checkbox', () => {
    const declinedPrint = 'cool\u0000alpha\u0000'
    const html = renderToStaticMarkup(
      <DreamView pending={[pending({ declined: [declinedPrint] })]} runs={[]} t={t} />,
    )
    expect(html).toContain(zh.dreamAlreadyDeclined)
    expect(html).toMatch(/type="checkbox"[^>]*disabled/u)
  })

  it('disables approve until something is ticked', () => {
    // An empty selection is a rejection, so the approve button must not look
    // available when nothing is chosen.
    const html = renderToStaticMarkup(<DreamView pending={[pending()]} runs={[]} t={t} />)
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*批准/u)
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

  it('offers a run button only when a handler is supplied', () => {
    // Without the handler the button would look clickable and do nothing.
    const withoutRun = renderToStaticMarkup(<DreamView pending={[]} runs={[]} t={t} />)
    expect(withoutRun).not.toContain(zh.dreamRun)

    const withRun = renderToStaticMarkup(<DreamView pending={[]} runs={[]} onRun={() => {}} t={t} />)
    expect(withRun).toContain(zh.dreamRun)
  })

  it('has strings for both locales', () => {
    for (const key of ['dreamTitle', 'dreamHelp', 'dreamApprove', 'dreamDiscard', 'dreamRiskContent'] as const) {
      expect((zh as Record<string, string>)[key]).toBeTruthy()
      expect((en as Record<string, string>)[key]).toBeTruthy()
    }
  })
})
