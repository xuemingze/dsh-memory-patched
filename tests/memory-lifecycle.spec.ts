import { describe, expect, it } from 'vitest'
import {
  nextLifecycle,
  shouldReview,
  type LifecycleInput,
} from '../src/memory-lifecycle.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-11-05T12:00:00Z').getTime()

function input(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  return {
    lifecycle: 'active',
    importanceClass: 'working',
    volatility: 'stable',
    lastEvidenceAt: NOW - 1 * DAY,
    lastUsedAt: null,
    superseded: false,
    hasExtractedSop: false,
    now: NOW,
    ...overrides,
  }
}

describe('nextLifecycle', () => {
  it('never cools a critical claim, however old', () => {
    const result = nextLifecycle(input({
      importanceClass: 'critical',
      lastEvidenceAt: NOW - 2000 * DAY,
    }))
    expect(result.lifecycle).toBe('active')
    expect(result.reason).toBe('protected')
  })

  it('keeps a recently evidenced claim active', () => {
    expect(nextLifecycle(input({ lastEvidenceAt: NOW - 5 * DAY })).lifecycle).toBe('active')
  })

  it('cools working memory after 60 days without evidence', () => {
    expect(nextLifecycle(input({
      importanceClass: 'working',
      lastEvidenceAt: NOW - 61 * DAY,
    })).lifecycle).toBe('cooled')
  })

  it('archives cooled working memory after another 120 days', () => {
    expect(nextLifecycle(input({
      lifecycle: 'cooled',
      importanceClass: 'working',
      lastEvidenceAt: NOW - 200 * DAY,
    })).lifecycle).toBe('archived')
  })

  it('never auto-archives durable memory', () => {
    // Durable claims only ever reach review: they are the ones worth keeping.
    const result = nextLifecycle(input({
      importanceClass: 'durable',
      lastEvidenceAt: NOW - 5000 * DAY,
    }))
    expect(result.lifecycle).not.toBe('archived')
    expect(result.reason).toMatch(/review/u)
  })

  it('cools transient memory quickly', () => {
    expect(nextLifecycle(input({
      importanceClass: 'transient',
      volatility: 'transient',
      lastEvidenceAt: NOW - 8 * DAY,
    })).lifecycle).toBe('cooled')
  })

  it('archives transient memory after 30 days', () => {
    expect(nextLifecycle(input({
      lifecycle: 'cooled',
      importanceClass: 'transient',
      volatility: 'transient',
      lastEvidenceAt: NOW - 31 * DAY,
    })).lifecycle).toBe('archived')
  })

  it('excludes a superseded claim from default visibility at once', () => {
    const result = nextLifecycle(input({ superseded: true }))
    expect(result.lifecycle).toBe('superseded')
    expect(result.visible).toBe(false)
  })

  it('keeps a cooled claim visible because it may still be needed', () => {
    const result = nextLifecycle(input({
      lifecycle: 'cooled',
      importanceClass: 'working',
      lastEvidenceAt: NOW - 70 * DAY,
    }))
    expect(result.visible).toBe(true)
  })

  it('hides an archived claim from default visibility', () => {
    const result = nextLifecycle(input({
      lifecycle: 'archived',
      importanceClass: 'working',
      lastEvidenceAt: NOW - 300 * DAY,
    }))
    expect(result.visible).toBe(false)
  })

  it('restores an archived claim when new evidence arrives', () => {
    const result = nextLifecycle(input({
      lifecycle: 'archived',
      importanceClass: 'working',
      lastEvidenceAt: NOW - 1 * DAY,
    }))
    expect(result.lifecycle).toBe('active')
  })

  it('counts a recent use as evidence of life', () => {
    const result = nextLifecycle(input({
      lifecycle: 'cooled',
      importanceClass: 'working',
      lastEvidenceAt: NOW - 200 * DAY,
      lastUsedAt: NOW - 2 * DAY,
    }))
    // Something that was actually used must not be archived as if forgotten.
    expect(result.lifecycle).toBe('active')
  })

  it('archives an incident only after its lesson has been extracted', () => {
    const notYet = nextLifecycle(input({
      lifecycle: 'cooled',
      importanceClass: 'working',
      volatility: 'transient',
      lastEvidenceAt: NOW - 40 * DAY,
      hasExtractedSop: false,
      isIncident: true,
    }))
    expect(notYet.lifecycle).not.toBe('archived')
    expect(notYet.reason).toBe('awaiting-sop')

    const ready = nextLifecycle(input({
      lifecycle: 'cooled',
      importanceClass: 'working',
      volatility: 'transient',
      lastEvidenceAt: NOW - 40 * DAY,
      hasExtractedSop: true,
      isIncident: true,
    }))
    expect(ready.lifecycle).toBe('archived')
  })

  it('never reports purge as an automatic outcome', () => {
    // Physical deletion is a separate, explicitly confirmed step.
    for (const lifecycle of ['active', 'cooled', 'archived', 'contested'] as const) {
      const result = nextLifecycle(input({
        lifecycle,
        importanceClass: 'transient',
        lastEvidenceAt: NOW - 10000 * DAY,
      }))
      expect(result.lifecycle).not.toBe('purge')
    }
  })

  it('is deterministic for the same inputs', () => {
    const value = input({ importanceClass: 'working', lastEvidenceAt: NOW - 70 * DAY })
    expect(nextLifecycle(value)).toEqual(nextLifecycle({ ...value }))
  })
})

describe('shouldReview', () => {
  it('asks for review of durable memory after 180 days', () => {
    expect(shouldReview(input({
      importanceClass: 'durable',
      lastEvidenceAt: NOW - 181 * DAY,
    }))).toBe(true)
  })

  it('does not ask for review of fresh durable memory', () => {
    expect(shouldReview(input({
      importanceClass: 'durable',
      lastEvidenceAt: NOW - 10 * DAY,
    }))).toBe(false)
  })

  it('never asks to review critical memory for forgetting purposes', () => {
    expect(shouldReview(input({
      importanceClass: 'critical',
      lastEvidenceAt: NOW - 5000 * DAY,
    }))).toBe(false)
  })
})
