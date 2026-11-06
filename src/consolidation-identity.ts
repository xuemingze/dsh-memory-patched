/** Stable identities shared by consolidation storage, RPC, workers, and catalogs. */

export const REVIEW_ID_PATTERN = /^review-[a-f0-9]{64}$/u
const WORKER_SESSION_ID_PATTERN = /^session-memory-review-[a-f0-9]{64}-attempt-[1-9][0-9]*(?:-seg-[1-9][0-9]*)?$/u

export function isConsolidationReviewId(value: unknown): value is string {
  return typeof value === 'string' && REVIEW_ID_PATTERN.test(value)
}

export function workerSessionIdOf(reviewId: string, attempt: number, segment?: number): string {
  const suffix = reviewId.startsWith('review-') ? reviewId.slice('review-'.length) : reviewId
  const base = `session-memory-review-${suffix}-attempt-${attempt}`
  // Segment 0 keeps the historical id so existing receipts and replay stay valid.
  return segment === undefined || segment === 0 ? base : `${base}-seg-${segment}`
}

/** Identify internal audit Sessions so they are never offered as source evidence. */
/** Dream worker sessions carry this prefix so they can be told apart. */
export const DREAM_WORKER_SESSION_PREFIX = 'session-memory-dream-'

/** The Session id a Dream run creates. */
export function dreamWorkerSessionIdOf(runId: string): string {
  return `${DREAM_WORKER_SESSION_PREFIX}${runId}`
}

/**
 * Identify internal audit Sessions so they are never offered as source evidence.
 *
 * Dream runs are internal too. Without this, a Dream worker session showed up in
 * the Session list marked "consolidated", and the catalog offered it back as if
 * it were a conversation worth reviewing.
 */
export function isConsolidationWorkerSessionId(sessionId: string): boolean {
  return WORKER_SESSION_ID_PATTERN.test(sessionId) || sessionId.startsWith(DREAM_WORKER_SESSION_PREFIX)
}
