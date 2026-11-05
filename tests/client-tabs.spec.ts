import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('Memory section tabs', () => {
  it('exposes forgetting as a peer tab, not a child of Session Consolidation', () => {
    // Session consolidation extracts memory from conversations; forgetting
    // governs the lifecycle of memory that already exists. They are different
    // jobs over different objects, so one must not be nested under the other.
    expect(zh.forgettingTab).toBe('遗忘复核')
    expect(en.forgettingTab).toBe('Forgetting Review')
  })

  it('keeps the tab set complete in both locales', () => {
    for (const key of ['globalTab', 'workspacesTab', 'sessionsTab', 'forgettingTab', 'settingsTab'] as const) {
      expect(zh[key]).toBeTruthy()
      expect(en[key]).toBeTruthy()
    }
  })

  it('keeps dictionaries key-for-key aligned', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('describes forgetting as governing records, not as extracting Sessions', () => {
    // The two tabs read as peer jobs: extraction works on conversations,
    // forgetting works on the records that already exist.
    expect(zh.forgettingHelp).toContain('记录')
    expect(zh.forgettingHelp).not.toContain('会话')
    expect(en.forgettingHelp).toContain('records')
    expect(en.forgettingHelp).not.toContain('Session')
  })
})
