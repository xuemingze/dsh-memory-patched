import { describe, expect, it } from 'vitest'
import { applyGlobalPromotion, parseGlobalSections, GLOBAL_PROMOTION_MARKER } from '../src/memory-global-guard.ts'

const GLOBAL = [
  '# Global Memory',
  '',
  '## User Profile',
  '',
  '- the user is a person',
  '',
  '## User Preferences',
  '',
  '- prefers tabs',
  '',
  '## General Tips',
  '',
  '- be brief',
  '',
].join('\n')

describe('Reading GLOBAL sections', () => {
  it('lists headings without the hash prefix', () => {
    expect(parseGlobalSections(GLOBAL)).toEqual(['User Profile', 'User Preferences', 'General Tips'])
  })

  it('ignores deeper headings so subsections do not look like sections', () => {
    const nested = `${GLOBAL}\n### Sub detail\n\ntext\n`
    expect(parseGlobalSections(nested)).not.toContain('Sub detail')
  })

  it('returns an empty list for a document with no sections', () => {
    expect(parseGlobalSections('# Empty\n\ntext\n')).toEqual([])
  })
})

describe('Promoting a record into GLOBAL', () => {
  it('appends inside the named section', () => {
    const result = applyGlobalPromotion(GLOBAL, {
      section: 'User Preferences',
      text: 'prefers npm installs',
      source: 'alpha',
      runId: 'dream-1',
    })
    const index = result.indexOf('- prefers npm installs')
    const nextSection = result.indexOf('## General Tips')
    expect(index).toBeGreaterThan(result.indexOf('## User Preferences'))
    expect(index).toBeLessThan(nextSection)
  })

  it('leaves every other section byte-identical', () => {
    const result = applyGlobalPromotion(GLOBAL, {
      section: 'User Preferences',
      text: 'prefers npm installs',
      source: 'alpha',
      runId: 'dream-1',
    })
    expect(result).toContain('- the user is a person')
    expect(result).toContain('- be brief')
    expect(result).toContain('## User Profile')
  })

  it('refuses a section that does not exist', () => {
    // Creating sections is authorship. Dream may only append where a human
    // already decided the topic belongs.
    expect(() => applyGlobalPromotion(GLOBAL, {
      section: 'Random Notes',
      text: 'x',
      source: 'alpha',
      runId: 'dream-1',
    })).toThrow(/does not exist/u)
  })

  it('refuses to replace the document wholesale', () => {
    expect(() => applyGlobalPromotion(GLOBAL, {
      section: 'User Preferences',
      text: '# Global Memory\n\nreplaced\n',
      source: 'alpha',
      runId: 'dream-1',
    })).toThrow(/multi-line|document/u)
  })

  it('refuses text that would open a new section', () => {
    // A promoted line containing a heading would silently restructure GLOBAL.
    expect(() => applyGlobalPromotion(GLOBAL, {
      section: 'User Preferences',
      text: 'see below\n## Inserted Section',
      source: 'alpha',
      runId: 'dream-1',
    })).toThrow(/heading|section/u)
  })

  it('refuses text containing a level-2 heading even as the first line', () => {
    expect(() => applyGlobalPromotion(GLOBAL, {
      section: 'User Preferences',
      text: '## Injected',
      source: 'alpha',
      runId: 'dream-1',
    })).toThrow(/heading|section/u)
  })

  it('is idempotent for the same promotion', () => {
    const once = applyGlobalPromotion(GLOBAL, {
      section: 'User Preferences', text: 'prefers npm installs', source: 'alpha', runId: 'dream-1',
    })
    const twice = applyGlobalPromotion(once, {
      section: 'User Preferences', text: 'prefers npm installs', source: 'alpha', runId: 'dream-1',
    })
    expect(twice).toBe(once)
  })

  it('records provenance so the line can be traced back', () => {
    const result = applyGlobalPromotion(GLOBAL, {
      section: 'General Tips', text: 'new tip', source: 'alpha', runId: 'dream-7',
    })
    expect(result).toContain(GLOBAL_PROMOTION_MARKER)
    expect(result).toContain('dream-7')
  })

  it('keeps the document ending with exactly one newline', () => {
    const result = applyGlobalPromotion(GLOBAL, {
      section: 'General Tips', text: 'tip', source: 'alpha', runId: 'd',
    })
    expect(result.endsWith('\n')).toBe(true)
    expect(result.endsWith('\n\n')).toBe(false)
  })

  it('rejects empty text', () => {
    expect(() => applyGlobalPromotion(GLOBAL, {
      section: 'General Tips', text: '   ', source: 'a', runId: 'd',
    })).toThrow()
  })

  it('caps the promoted text length', () => {
    expect(() => applyGlobalPromotion(GLOBAL, {
      section: 'General Tips', text: 'x'.repeat(5_000), source: 'a', runId: 'd',
    })).toThrow(/exceeds/u)
  })
})

describe('GLOBAL protection invariants', () => {
  it('never removes an existing line', () => {
    const before = GLOBAL.split('\n')
    const after = applyGlobalPromotion(GLOBAL, {
      section: 'User Profile', text: 'added', source: 'a', runId: 'd',
    }).split('\n')
    for (const line of before) {
      if (line.trim() === '') continue
      expect(after).toContain(line)
    }
  })

  it('never shortens the document', () => {
    const after = applyGlobalPromotion(GLOBAL, {
      section: 'User Profile', text: 'added', source: 'a', runId: 'd',
    })
    expect(after.length).toBeGreaterThan(GLOBAL.length)
  })
})
