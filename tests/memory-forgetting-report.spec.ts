import { describe, expect, it } from 'vitest'
import { buildForgettingReport, type ForgettingRecordInput } from '../src/memory-forgetting-report.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-11-05T12:00:00Z').getTime()

function record(overrides: Partial<ForgettingRecordInput> = {}): ForgettingRecordInput {
  return {
    name: 'old-record',
    kind: 'configuration',
    volatility: 'versioned',
    importanceScore: 40,
    lifecycle: 'active',
    lastEvidenceAt: NOW - 100 * DAY,
    lastUsedAt: null,
    superseded: false,
    hasExtractedSop: false,
    ...overrides,
  }
}

describe('buildForgettingReport', () => {
  it('reports nothing for fresh records', () => {
    const report = buildForgettingReport([record({ lastEvidenceAt: NOW - 1 * DAY })], NOW)
    expect(report.changes).toEqual([])
    expect(report.protectedCount).toBe(0)
  })

  it('reports a record that would cool, with its reason', () => {
    const report = buildForgettingReport([record({ lastEvidenceAt: NOW - 70 * DAY })], NOW)
    expect(report.changes).toHaveLength(1)
    expect(report.changes[0]).toMatchObject({
      name: 'old-record',
      from: 'active',
      to: 'cooled',
    })
    expect(report.changes[0]?.reason.length).toBeGreaterThan(0)
  })

  it('never proposes a change that deletes anything', () => {
    const report = buildForgettingReport([
      record({ lifecycle: 'archived', lastEvidenceAt: NOW - 5000 * DAY }),
    ], NOW)
    // Physical purge is a separate act requiring explicit consent.
    for (const change of report.changes) {
      expect(['cooled', 'archived', 'active', 'superseded', 'contested']).toContain(change.to)
    }
  })

  it('counts protected critical records instead of proposing them', () => {
    const report = buildForgettingReport([
      record({ name: 'user-rule', importanceScore: 95, lastEvidenceAt: NOW - 5000 * DAY }),
    ], NOW)
    expect(report.changes).toEqual([])
    expect(report.protectedCount).toBe(1)
  })

  it('reports a restore for a record that gained recent evidence', () => {
    const report = buildForgettingReport([
      record({ lifecycle: 'archived', lastEvidenceAt: NOW - 1 * DAY }),
    ], NOW)
    expect(report.changes[0]).toMatchObject({ from: 'archived', to: 'active' })
  })

  it('sorts proposed changes by score so the least valuable goes first', () => {
    const report = buildForgettingReport([
      record({ name: 'keep-longer', importanceScore: 50, lastEvidenceAt: NOW - 70 * DAY }),
      record({ name: 'drop-first', importanceScore: 20, lastEvidenceAt: NOW - 70 * DAY }),
    ], NOW)
    expect(report.changes.map(change => change.name)).toEqual(['drop-first', 'keep-longer'])
  })

  it('summarizes counts by target state', () => {
    const report = buildForgettingReport([
      record({ name: 'a', importanceScore: 20, lastEvidenceAt: NOW - 70 * DAY }),
      record({ name: 'b', importanceScore: 20, lifecycle: 'cooled', lastEvidenceAt: NOW - 300 * DAY }),
    ], NOW)
    expect(report.counts.cooled).toBe(1)
    expect(report.counts.archived).toBe(1)
  })

  it('is stable across repeated runs on the same input', () => {
    const input = [record({ name: 'x', lastEvidenceAt: NOW - 70 * DAY })]
    expect(buildForgettingReport(input, NOW)).toEqual(buildForgettingReport(input, NOW))
  })

  it('handles an empty record set', () => {
    expect(buildForgettingReport([], NOW)).toEqual({
      changes: [],
      counts: { cooled: 0, archived: 0, restored: 0 },
      protectedCount: 0,
    })
  })
})
