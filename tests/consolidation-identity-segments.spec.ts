import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { workerSessionIdOf } from '../src/consolidation-identity.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('workerSessionIdOf with segments', () => {
  const reviewId = `review-${'a'.repeat(64)}`

  it('keeps the historical id for segment 0 and when no segment is given', () => {
    const base = `session-memory-review-${'a'.repeat(64)}-attempt-1`
    expect(workerSessionIdOf(reviewId, 1)).toBe(base)
    expect(workerSessionIdOf(reviewId, 1, 0)).toBe(base)
  })

  it('suffixes later segments deterministically', () => {
    expect(workerSessionIdOf(reviewId, 2, 1)).toBe(`session-memory-review-${'a'.repeat(64)}-attempt-2-seg-1`)
    expect(workerSessionIdOf(reviewId, 2, 12)).toBe(`session-memory-review-${'a'.repeat(64)}-attempt-2-seg-12`)
  })

  it('round-trips through the segment regex used by replay', () => {
    const id = workerSessionIdOf(reviewId, 3, 7)
    const match = /^session-memory-review-([a-f0-9]{64})-attempt-(\d+)(?:-seg-(\d+))?$/u.exec(id)
    expect(match).not.toBeNull()
    expect(`review-${match![1]}`).toBe(reviewId)
    expect(Number(match![2])).toBe(3)
    expect(Number(match![3])).toBe(7)
  })

  it('parses the segment-0 form without a suffix', () => {
    const id = workerSessionIdOf(reviewId, 1, 0)
    const match = /^session-memory-review-([a-f0-9]{64})-attempt-(\d+)(?:-seg-(\d+))?$/u.exec(id)
    expect(match).not.toBeNull()
    expect(match![3]).toBeUndefined()
  })
})
