import { describe, expect, it } from 'vitest'
import {
  REJECT_REASONS,
  isRejectReason,
  planActionFingerprint,
  selectApprovedActions,
} from '../src/memory-dream-approval.ts'

describe('Reject reasons', () => {
  it('offers a closed vocabulary', () => {
    expect([...REJECT_REASONS].sort()).toEqual([
      'already-known', 'disagree', 'not-important', 'wrong-merge',
    ])
  })

  it('accepts only a listed reason', () => {
    expect(isRejectReason('disagree')).toBe(true)
    expect(isRejectReason('because-i-said-so')).toBe(false)
    expect(isRejectReason(undefined)).toBe(false)
  })
})

describe('Action fingerprints', () => {
  it('identifies one action within a plan', () => {
    // The user approves per action, so each needs a stable handle that does not
    // depend on its position in the array.
    const a = planActionFingerprint({ action: 'cool', target: 'alpha' })
    const b = planActionFingerprint({ action: 'cool', target: 'beta' })
    expect(a).not.toBe(b)
  })

  it('distinguishes action kinds on the same record', () => {
    expect(planActionFingerprint({ action: 'cool', target: 'alpha' }))
      .not.toBe(planActionFingerprint({ action: 'archive', target: 'alpha' }))
  })

  it('is stable for the same action', () => {
    expect(planActionFingerprint({ action: 'cool', target: 'alpha' }))
      .toBe(planActionFingerprint({ action: 'cool', target: 'alpha' }))
  })

  it('ignores rationale', () => {
    expect(planActionFingerprint({ action: 'cool', target: 'a', rationale: 'x' }))
      .toBe(planActionFingerprint({ action: 'cool', target: 'a' }))
  })
})

describe('Selecting approved actions', () => {
  const actions = [
    { action: 'cool', target: 'alpha' },
    { action: 'archive', target: 'beta' },
    { action: 'merge', target: 'gamma', sources: ['gamma', 'delta'] },
  ]

  it('keeps only the actions the user ticked', () => {
    const picked = selectApprovedActions(actions, [planActionFingerprint(actions[1]!)])
    expect(picked).toHaveLength(1)
    expect(picked[0]).toMatchObject({ action: 'archive', target: 'beta' })
  })

  it('supports approving nothing, which is a full rejection', () => {
    expect(selectApprovedActions(actions, [])).toHaveLength(0)
  })

  it('ignores a fingerprint that is not in the plan', () => {
    // A stale browser tab may send an action that was already decided.
    const picked = selectApprovedActions(actions, ['not-a-real-fingerprint'])
    expect(picked).toHaveLength(0)
  })

  it('never returns an action twice even if ticked twice', () => {
    const print = planActionFingerprint(actions[0]!)
    expect(selectApprovedActions(actions, [print, print])).toHaveLength(1)
  })

  it('preserves plan order regardless of tick order', () => {
    const picked = selectApprovedActions(actions, [
      planActionFingerprint(actions[2]!),
      planActionFingerprint(actions[0]!),
    ])
    expect(picked.map(entry => entry.action)).toEqual(['cool', 'merge'])
  })
})

describe('Approval gating by mode and risk', () => {
  it('lets metadata-only actions commit in manual mode', async () => {
    const { requiresExplicitApproval } = await import('../src/memory-dream-approval.ts')
    // Metadata can be undone by another metadata action, so manual mode is
    // enough for it.
    expect(requiresExplicitApproval({ action: 'cool', target: 'a' }, 'manual')).toBe(false)
    expect(requiresExplicitApproval({ action: 'set-priority', target: 'a' }, 'manual')).toBe(false)
  })

  it('always requires approval for actions that rewrite content', async () => {
    const { requiresExplicitApproval } = await import('../src/memory-dream-approval.ts')
    // These can lose information, so no mode auto-applies them.
    for (const action of ['merge', 'archive', 'promote-global', 'supersede', 'extract-sop'] as const) {
      expect(requiresExplicitApproval({ action, target: 'a' }, 'manual')).toBe(true)
    }
  })

  it('requires approval for everything in shadow mode', async () => {
    const { requiresExplicitApproval } = await import('../src/memory-dream-approval.ts')
    expect(requiresExplicitApproval({ action: 'cool', target: 'a' }, 'shadow')).toBe(true)
  })
})
