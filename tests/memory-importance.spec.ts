import { describe, expect, it } from 'vitest'
import {
  scoreImportance,
  type ImportanceSignals,
} from '../src/memory-importance.ts'
import { importanceClassOf } from '../src/memory-governance-types.ts'

function signals(overrides: Partial<ImportanceSignals> = {}): ImportanceSignals {
  return {
    kind: 'procedure',
    volatility: 'stable',
    evidenceCount: 1,
    distinctSources: 1,
    workspaceCount: 1,
    sourcePlugins: [],
    userStated: false,
    hasProcedure: false,
    superseded: false,
    ...overrides,
  }
}

describe('scoreImportance', () => {
  it('keeps a user-stated rule in the critical band', () => {
    const score = scoreImportance(signals({
      kind: 'preference',
      userStated: true,
      evidenceCount: 4,
      distinctSources: 2,
    }))
    // A rule the user stated explicitly must never be auto-cooled.
    expect(score).toBeGreaterThanOrEqual(80)
    expect(importanceClassOf(score)).toBe('critical')
  })

  it('keeps a user-stated identity in the critical band', () => {
    const score = scoreImportance(signals({ kind: 'identity', userStated: true }))
    expect(importanceClassOf(score)).toBe('critical')
  })

  it('ranks a cross-plugin SOP above single-plugin version detail', () => {
    const sop = scoreImportance(signals({
      kind: 'procedure',
      hasProcedure: true,
      workspaceCount: 3,
      distinctSources: 3,
      evidenceCount: 5,
    }))
    const detail = scoreImportance(signals({
      kind: 'configuration',
      volatility: 'versioned',
      sourcePlugins: ['dsh-ops'],
      evidenceCount: 1,
    }))
    expect(sop).toBeGreaterThan(detail)
  })

  it('demotes a single-plugin version detail into the working band or below', () => {
    const score = scoreImportance(signals({
      kind: 'configuration',
      volatility: 'versioned',
      sourcePlugins: ['dsh-ops'],
    }))
    expect(score).toBeLessThan(80)
  })

  it('keeps an intermittent availability profile without making it a universal fact', () => {
    const score = scoreImportance(signals({
      kind: 'availability',
      volatility: 'intermittent',
      evidenceCount: 6,
      distinctSources: 2,
    }))
    // Retained, but ranked below a stable cross-project rule.
    expect(score).toBeLessThan(80)
    expect(score).toBeGreaterThan(0)
  })

  it('ranks a transient diagnostic below everything durable', () => {
    const transient = scoreImportance(signals({ kind: 'diagnostic', volatility: 'transient' }))
    const durable = scoreImportance(signals({ kind: 'decision', volatility: 'stable', evidenceCount: 3 }))
    expect(transient).toBeLessThan(durable)
    expect(importanceClassOf(transient)).toBe('transient')
  })

  it('pushes a superseded claim to the bottom', () => {
    const score = scoreImportance(signals({ superseded: true, evidenceCount: 5 }))
    expect(score).toBeLessThan(30)
  })

  it('never leaves the 0-100 range', () => {
    const max = scoreImportance(signals({
      kind: 'identity',
      userStated: true,
      evidenceCount: 100,
      distinctSources: 100,
      workspaceCount: 100,
      hasProcedure: true,
    }))
    const min = scoreImportance(signals({
      kind: 'diagnostic',
      volatility: 'transient',
      superseded: true,
    }))
    expect(max).toBeLessThanOrEqual(100)
    expect(min).toBeGreaterThanOrEqual(0)
  })

  it('never lets inferred knowledge outrank a stated user rule', () => {
    const stated = scoreImportance(signals({
      kind: 'preference',
      userStated: true,
      evidenceCount: 2,
      distinctSources: 1,
    }))
    const inferred = scoreImportance(signals({
      kind: 'procedure',
      hasProcedure: true,
      evidenceCount: 100,
      distinctSources: 100,
      workspaceCount: 100,
    }))
    // A well-evidenced SOP must not tie or beat what the user said outright,
    // or an automatic pass could treat the two as interchangeable.
    expect(inferred).toBeLessThan(stated)
  })

  it('is deterministic for identical signals', () => {
    const input = signals({ kind: 'decision', evidenceCount: 3, workspaceCount: 2 })
    expect(scoreImportance(input)).toBe(scoreImportance({ ...input }))
  })

  it('rewards repeated evidence but saturates instead of growing forever', () => {
    const once = scoreImportance(signals({ evidenceCount: 1 }))
    const many = scoreImportance(signals({ evidenceCount: 100 }))
    expect(many).toBeGreaterThan(once)
    // Evidence cannot alone promote anything into critical.
    expect(many).toBeLessThan(80)
  })

  it('does not depend on any usage provider', () => {
    // With no usage signal at all the score still separates durable from noise.
    const durable = scoreImportance(signals({ kind: 'preference', userStated: true }))
    const noise = scoreImportance(signals({ kind: 'diagnostic', volatility: 'transient' }))
    expect(durable).toBeGreaterThan(noise)
  })
})

describe('importance bands', () => {
  it('maps boundary values to the documented bands', () => {
    expect(importanceClassOf(29)).toBe('transient')
    expect(importanceClassOf(30)).toBe('working')
    expect(importanceClassOf(54)).toBe('working')
    expect(importanceClassOf(55)).toBe('durable')
    expect(importanceClassOf(79)).toBe('durable')
    expect(importanceClassOf(80)).toBe('critical')
  })
})
