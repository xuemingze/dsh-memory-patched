import { describe, expect, it } from 'vitest'
import {
  DREAM_WORKER_SESSION_PREFIX,
  dreamWorkerSessionIdOf,
  isConsolidationWorkerSessionId,
} from '../src/consolidation-identity.ts'

describe('Dream worker sessions are internal', () => {
  it('builds an id the catalog can recognise', () => {
    const id = dreamWorkerSessionIdOf('dream-abc123')
    expect(id).toBe(`${DREAM_WORKER_SESSION_PREFIX}dream-abc123`)
  })

  it('is excluded from the Session catalog', () => {
    // A Dream worker session once appeared in the Session list marked
    // "consolidated", and the catalog offered it back for review. The run is
    // internal; it is not a conversation.
    expect(isConsolidationWorkerSessionId(dreamWorkerSessionIdOf('dream-abc123'))).toBe(true)
  })

  it('still recognises consolidation worker sessions', () => {
    const review = `review-${'a'.repeat(64)}`
    expect(isConsolidationWorkerSessionId(`session-memory-review-${'a'.repeat(64)}-attempt-1`)).toBe(true)
    expect(isConsolidationWorkerSessionId(review)).toBe(false)
  })

  it('does not exclude ordinary sessions', () => {
    expect(isConsolidationWorkerSessionId('session-56616cf0-4705-4a95-8b3c-ce4e4cc52fa1')).toBe(false)
    expect(isConsolidationWorkerSessionId('dream-abc123')).toBe(false)
  })
})