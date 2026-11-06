/**
 * The Dream run button must render as a clickable control.
 *
 * It once rendered with no base style: no cursor, no padding, no background. The
 * pointer showed an I-beam because the element kept the browser's text cursor, so
 * it read as a label rather than a button and could not be clicked. The cause was
 * that MemoryButton applied only the interactive states and whatever `style` the
 * caller passed, never the variant's base.
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DreamView } from '../src/client/MemorySection.tsx'
import { en } from '../src/client/locales.ts'

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

describe('Dream run button rendering', () => {
  it('carries a pointer cursor so it reads as a control', () => {
    const html = renderToStaticMarkup(<DreamView pending={[]} runs={[]} onRun={() => {}} t={t} />)
    // Without a cursor the pointer falls back to the I-beam and the button looks
    // like text, which is exactly how it appeared to be unclickable.
    expect(html).toContain('cursor:pointer')
  })

  it('has a visible fill and padding', () => {
    const html = renderToStaticMarkup(<DreamView pending={[]} runs={[]} onRun={() => {}} t={t} />)
    expect(html).toContain('#5b5bd6')
    expect(html).toMatch(/padding:9px 14px/u)
  })

  it('is a real button element with an explicit type', () => {
    const html = renderToStaticMarkup(<DreamView pending={[]} runs={[]} onRun={() => {}} t={t} />)
    expect(html).toMatch(/<button[^>]*type="button"/u)
  })

  it('is not rendered at all when no handler is supplied', () => {
    const html = renderToStaticMarkup(<DreamView pending={[]} runs={[]} t={t} />)
    expect(html).not.toContain(en.dreamRun)
  })

  it('is disabled while a run is in flight', () => {
    const html = renderToStaticMarkup(
      <DreamView pending={[]} runs={[]} onRun={() => {}} busy t={t} />,
    )
    expect(html).toContain('disabled')
    expect(html).toContain('not-allowed')
  })
})
