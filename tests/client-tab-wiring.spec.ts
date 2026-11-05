import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Structural guard for tab wiring.
 *
 * A tab that renders but never loads shows a blank panel, which is exactly what
 * happened when the forgetting tab was added: it refreshed from the toolbar
 * button but not from its own click handler. Rendering tests cannot catch this
 * because the component loads asynchronously, so the wiring is checked directly.
 */
const source = readFileSync(
  join(import.meta.dirname, '..', 'src', 'client', 'MemorySection.tsx'),
  'utf8',
)

/** The tab ids the section declares. */
const TABS = ['global', 'workspaces', 'sessions', 'forgetting', 'settings'] as const

function changeTabBody(): string {
  const start = source.indexOf('const changeTab = (next: Tab): void => {')
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('\n  }', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('tab wiring', () => {
  it('declares every tab in the Tab union', () => {
    const union = /type Tab = ([^\n]+)/u.exec(source)?.[1] ?? ''
    for (const tab of TABS) expect(union).toContain(`'${tab}'`)
  })

  it('lists every tab in the tab bar, in order', () => {
    const bar = /\(\[([^\]]+)\] as const\)\.map\(id =>/u.exec(source)?.[1] ?? ''
    const ids = [...bar.matchAll(/'([a-z]+)'/gu)].map(match => match[1])
    expect(ids).toEqual([...TABS])
  })

  it('gives every tab an initial-load branch in changeTab', () => {
    const body = changeTabBody()
    // 'global' needs no branch: it is the initial tab and always loaded.
    for (const tab of TABS.filter(entry => entry !== 'global')) {
      expect(body, `changeTab must handle "${tab}"`).toContain(`next === '${tab}'`)
    }
  })

  it('gives every tab a refresh branch in refreshVisible', () => {
    const start = source.indexOf('const refreshVisible = async (): Promise<void> => {')
    const end = source.indexOf('\n  }', start)
    const body = source.slice(start, end)
    for (const tab of TABS.filter(entry => entry !== 'global')) {
      expect(body, `refreshVisible must handle "${tab}"`).toContain(`tab === '${tab}'`)
    }
  })

  it('renders a panel for every tab', () => {
    // `global` is the leading branch and `settings` is the trailing else, so the
    // ternary chain only spells out the middle three explicitly.
    for (const tab of ['workspaces', 'sessions', 'forgetting'] as const) {
      expect(source, `a panel must render for "${tab}"`).toContain(`tab === '${tab}' ?`)
    }
    // `global` opens the chain; `settings` is its trailing else, so neither
    // spells out `tab === '<id>' ?`. Both still need a panel of their own.
    expect(source).toContain("{tab === 'global' ? (")
    const tail = source.lastIndexOf(") : (")
    expect(tail).toBeGreaterThan(-1)
    expect(source.slice(tail)).toContain('memorySectionStyles.settingsGroup')
  })
})
