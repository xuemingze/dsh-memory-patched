import { describe, expect, it } from 'vitest'
import {
  classifyClaimConflict,
  summarizeAvailabilityWindow,
  environmentFingerprint,
} from '../src/memory-conflicts.ts'
import type { GovernanceClaim } from '../src/memory-governance-types.ts'
import type { VerificationObservation } from '../src/memory-conflicts.ts'

const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000
const NOW = new Date('2026-11-05T12:00:00Z').getTime()

function claim(overrides: Partial<GovernanceClaim> = {}): GovernanceClaim {
  return {
    name: 'git-proxy',
    scopeKey: 'workspace-8a3bfb34f9e9b1a1',
    kind: 'availability',
    volatility: 'intermittent',
    lifecycle: 'active',
    importanceClass: 'working',
    importanceScore: 40,
    text: 'git over HTTPS works through the system proxy',
    environmentFingerprint: 'desktop/win32',
    evidenceCount: 3,
    lastEvidenceAt: NOW - DAY,
    lastVerifiedAt: null,
    lastUsedAt: null,
    supersedes: [],
    sourcePlugins: [],
    ...overrides,
  }
}

function observation(overrides: Partial<VerificationObservation> = {}): VerificationObservation {
  return {
    providerId: 'net-check',
    observedAt: NOW - DAY,
    environmentFingerprint: 'desktop/win32',
    result: 'supports',
    confidence: 'strong',
    ...overrides,
  }
}

describe('environmentFingerprint', () => {
  it('separates profiles so desktop and web facts never collide', () => {
    const desktop = environmentFingerprint({ profile: 'desktop', platform: 'win32' })
    const web = environmentFingerprint({ profile: 'web', platform: 'win32' })
    expect(desktop).not.toBe(web)
  })

  it('treats an unspecified environment as its own bucket', () => {
    expect(environmentFingerprint({})).toBe(environmentFingerprint({}))
    expect(environmentFingerprint({})).not.toBe(environmentFingerprint({ profile: 'desktop' }))
  })

  it('includes a version when one is supplied', () => {
    const a = environmentFingerprint({ profile: 'desktop', version: '0.2.1' })
    const b = environmentFingerprint({ profile: 'desktop', version: '0.2.2' })
    expect(a).not.toBe(b)
  })
})

describe('summarizeAvailabilityWindow', () => {
  it('reports nothing for an empty log', () => {
    const profile = summarizeAvailabilityWindow([], NOW)
    expect(profile.verdict).toBe('unknown')
    expect(profile.failures).toBe(0)
    expect(profile.successes).toBe(0)
  })

  it('does not let a single failure become a durable fact', () => {
    const profile = summarizeAvailabilityWindow([observation({ result: 'contradicts' })], NOW)
    expect(profile.verdict).toBe('transient')
    expect(profile.failures).toBe(1)
  })

  it('does not let a single success erase a long failure history', () => {
    const profile = summarizeAvailabilityWindow([
      observation({ observedAt: NOW - 3 * DAY, result: 'contradicts' }),
      observation({ observedAt: NOW - 2 * DAY, result: 'contradicts' }),
      observation({ observedAt: NOW - 1 * DAY, result: 'contradicts' }),
      observation({ observedAt: NOW - 1 * MINUTE, result: 'supports' }),
    ], NOW)
    // One success is a data point, not a cure: the history is still unreliable.
    expect(profile.verdict).not.toBe('restored')
    expect(profile.verdict).not.toBe('stable-ok')
    expect(profile.failures).toBe(3)
  })

  it('detects intermittent flapping from alternating observations', () => {
    // The reported symptom: the proxy works, then drops, then works again.
    const profile = summarizeAvailabilityWindow([
      observation({ observedAt: NOW - 10 * DAY, result: 'supports' }),
      observation({ observedAt: NOW - 9 * DAY, result: 'contradicts' }),
      observation({ observedAt: NOW - 8 * DAY, result: 'supports' }),
      observation({ observedAt: NOW - 7 * DAY, result: 'contradicts' }),
      observation({ observedAt: NOW - 6 * DAY, result: 'supports' }),
      observation({ observedAt: NOW - 5 * DAY, result: 'contradicts' }),
    ], NOW)
    expect(profile.verdict).toBe('intermittent')
    expect(profile.failures).toBeGreaterThanOrEqual(3)
    expect(profile.successes).toBeGreaterThanOrEqual(2)
    expect(profile.switches).toBeGreaterThanOrEqual(2)
  })

  it('detects a stable outage from consecutive failures over time', () => {
    const profile = summarizeAvailabilityWindow([
      observation({ observedAt: NOW - 120 * MINUTE, result: 'contradicts' }),
      observation({ observedAt: NOW - 60 * MINUTE, result: 'contradicts' }),
      observation({ observedAt: NOW - 5 * MINUTE, result: 'contradicts' }),
    ], NOW)
    expect(profile.verdict).toBe('stable-failing')
  })

  it('refuses a stable-outage verdict for failures squashed into one minute', () => {
    const profile = summarizeAvailabilityWindow([
      observation({ observedAt: NOW - 50 * 1000, result: 'contradicts' }),
      observation({ observedAt: NOW - 40 * 1000, result: 'contradicts' }),
      observation({ observedAt: NOW - 30 * 1000, result: 'contradicts' }),
    ], NOW)
    // Three retries in fifty seconds is one incident, not a proven pattern.
    expect(profile.verdict).not.toBe('stable-failing')
  })

  it('confirms recovery only after repeated successes across a day', () => {
    const profile = summarizeAvailabilityWindow([
      observation({ observedAt: NOW - 3 * DAY, result: 'contradicts' }),
      observation({ observedAt: NOW - 30 * MINUTE, result: 'supports' }),
      observation({ observedAt: NOW - 20 * MINUTE, result: 'supports' }),
      observation({ observedAt: NOW - 5 * MINUTE, result: 'supports' }),
    ], NOW)
    // Three successes inside one hour is still too early to declare recovery.
    expect(profile.verdict).not.toBe('restored')
  })

  it('ignores observations outside the window', () => {
    const profile = summarizeAvailabilityWindow([
      observation({ observedAt: NOW - 400 * DAY, result: 'contradicts' }),
      observation({ observedAt: NOW - 401 * DAY, result: 'contradicts' }),
      observation({ observedAt: NOW - 402 * DAY, result: 'contradicts' }),
    ], NOW)
    expect(profile.failures).toBe(0)
    expect(profile.verdict).toBe('unknown')
  })

  it('ignores unavailable observations instead of counting them as failures', () => {
    const profile = summarizeAvailabilityWindow([
      observation({ result: 'unavailable' }),
      observation({ result: 'inconclusive' }),
    ], NOW)
    expect(profile.failures).toBe(0)
    expect(profile.verdict).toBe('unknown')
  })
})

describe('classifyClaimConflict', () => {
  it('reports no conflict for unrelated records', () => {
    const decision = classifyClaimConflict(
      claim({ name: 'a', kind: 'configuration', volatility: 'versioned', text: 'dsh-ops is installed' }),
      claim({ name: 'b', kind: 'configuration', volatility: 'versioned', text: 'dsh-ops is installed' }),
      [],
      NOW,
    )
    expect(decision.kind).toBe('none')
  })

  it('treats mutually exclusive stable statements as a hard conflict', () => {
    const decision = classifyClaimConflict(
      claim({ name: 'dsh-ops-installed', kind: 'configuration', volatility: 'stable', text: 'dsh-ops is installed' }),
      claim({ name: 'dsh-ops-missing', kind: 'configuration', volatility: 'stable', text: 'dsh-ops is not installed' }),
      [],
      NOW,
    )
    expect(decision.kind).toBe('hard-conflict')
    // Nothing may be overwritten until a second independent source agrees.
    expect(decision.action).toBe('park')
  })

  it('treats a later state as evolution, not contradiction', () => {
    const decision = classifyClaimConflict(
      claim({
        name: 'dsh-ops-installed',
        kind: 'configuration',
        volatility: 'versioned',
        text: 'dsh-ops is installed',
        lastEvidenceAt: NOW - 30 * DAY,
      }),
      claim({
        name: 'dsh-ops-removed',
        kind: 'configuration',
        volatility: 'versioned',
        text: 'dsh-ops was uninstalled',
        lastEvidenceAt: NOW - DAY,
      }),
      [],
      NOW,
    )
    expect(decision.kind).toBe('temporal-evolution')
    expect(decision.action).toBe('supersede-older')
  })

  it('keeps both sides when they describe different environments', () => {
    const decision = classifyClaimConflict(
      claim({ name: 'a', environmentFingerprint: 'desktop/win32', text: 'QTS storage is used' }),
      claim({ name: 'b', environmentFingerprint: 'web/win32', text: 'Hero storage is used' }),
      [],
      NOW,
    )
    expect(decision.kind).toBe('environment-split')
    expect(decision.action).toBe('keep-both')
  })

  it('never resolves an availability flap by picking a winner', () => {
    // Six alternating observations: three failures, three successes, five
    // switches. This is the shape a flaky proxy actually produces.
    const decision = classifyClaimConflict(
      claim({ name: 'proxy-ok', kind: 'availability', volatility: 'intermittent', text: 'proxy works' }),
      claim({ name: 'proxy-fail', kind: 'availability', volatility: 'intermittent', text: 'proxy fails' }),
      [
        observation({ observedAt: NOW - 11 * DAY, result: 'supports' }),
        observation({ observedAt: NOW - 10 * DAY, result: 'contradicts' }),
        observation({ observedAt: NOW - 9 * DAY, result: 'supports' }),
        observation({ observedAt: NOW - 8 * DAY, result: 'contradicts' }),
        observation({ observedAt: NOW - 7 * DAY, result: 'supports' }),
        observation({ observedAt: NOW - 6 * DAY, result: 'contradicts' }),
      ],
      NOW,
    )
    expect(decision.kind).toBe('intermittent')
    // Neither side wins: they combine into one profile.
    expect(decision.action).toBe('merge-intermittent')
  })

  it('requires a second independent source before superseding a hard conflict', () => {
    const enabled = claim({
      name: 'feature-flag-enabled',
      kind: 'configuration',
      volatility: 'stable',
      text: 'the feature flag is enabled in the desktop profile',
    })
    const disabled = claim({
      name: 'feature-flag-not-enabled',
      kind: 'configuration',
      volatility: 'stable',
      text: 'the feature flag is not enabled in the desktop profile',
    })
    const pending = classifyClaimConflict(
      enabled,
      disabled,
      [observation({ result: 'contradicts', confidence: 'authoritative' })],
      NOW,
    )
    expect(pending.action).toBe('park')

    const resolved = classifyClaimConflict(
      enabled,
      disabled,
      [
        observation({ providerId: 'p1', result: 'contradicts', confidence: 'authoritative' }),
        observation({ providerId: 'p2', result: 'contradicts', confidence: 'strong' }),
      ],
      NOW,
    )
    expect(resolved.action).toBe('supersede-older')
  })

  it('never supersedes on two observations from the same provider', () => {
    const enabled = claim({
      name: 'feature-flag-enabled',
      kind: 'configuration',
      volatility: 'stable',
      text: 'the feature flag is enabled in the desktop profile',
    })
    const disabled = claim({
      name: 'feature-flag-not-enabled',
      kind: 'configuration',
      volatility: 'stable',
      text: 'the feature flag is not enabled in the desktop profile',
    })
    const decision = classifyClaimConflict(
      enabled,
      disabled,
      [
        observation({ providerId: 'p1', result: 'contradicts', confidence: 'authoritative' }),
        observation({ providerId: 'p1', result: 'contradicts', confidence: 'authoritative' }),
      ],
      NOW,
    )
    // Repeating one source is corroboration theatre, not verification.
    expect(decision.action).toBe('park')
  })

  it('parks when verification is unavailable', () => {
    const enabled = claim({
      name: 'feature-flag-enabled',
      kind: 'configuration',
      volatility: 'stable',
      text: 'the feature flag is enabled in the desktop profile',
    })
    const disabled = claim({
      name: 'feature-flag-not-enabled',
      kind: 'configuration',
      volatility: 'stable',
      text: 'the feature flag is not enabled in the desktop profile',
    })
    const decision = classifyClaimConflict(
      enabled,
      disabled,
      [observation({ result: 'unavailable' })],
      NOW,
    )
    expect(decision.kind).toBe('needs-verification')
    expect(decision.action).toBe('park')
  })
})
