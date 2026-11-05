/** Manual consolidation orchestration across preparation, worker, receipt, and commit. */

import { ConsolidationProposalError, type ConsolidationProposalPlan } from './consolidation-proposal.ts'
import type { ConsolidationCandidateEntry, ConsolidationCandidatePool } from './consolidation-candidates.ts'
import {
  ConsolidationCommitCoordinator,
  createFailedConsolidationReceipt,
  type ConsolidationCommitResult,
  type ConsolidationReceipt,
  type ConsolidationReceiptState,
  type ConsolidationReceiptStore,
} from './consolidation-receipt.ts'
import type { ConsolidationPlanReplay } from './consolidation-replay.ts'
import {
  ConsolidationEvidenceTooLargeError,
  ConsolidationProviderError,
  ConsolidationWorkerError,
  ConsolidationWorkerRuntimeError,
  type ConsolidationWorkerConfig,
  type ConsolidationWorkerResult,
} from './consolidation-worker.ts'
import { workerSessionIdOf } from './consolidation-identity.ts'
import { SessionConsolidationError, type SessionConsolidator } from './session-consolidator.ts'
import type { MarkdownMemoryStore } from './memory-store.ts'
import type { ConsolidationDebugStore } from './consolidation-debug.ts'

export type ConsolidationRunOutcome = ConsolidationCommitResult['outcome']
  | 'cancelled'
  | 'source-changed'
  | 'invalid-proposal'
  | 'output-truncated'
  | 'provider-failed'
  | 'evidence-too-large'
  | 'internal-error'

export interface ConsolidationRunResult {
  readonly outcome: ConsolidationRunOutcome
  readonly recovered: boolean
  readonly receipt: ConsolidationReceipt
}

export interface ConsolidationWorkerDriver {
  readonly config: ConsolidationWorkerConfig
  run(input: Parameters<SessionConsolidator['planProposal']>[0], attempt: number, signal?: AbortSignal): Promise<ConsolidationWorkerResult>
}

/** Keep the review lock across the worker run and final commit barrier. */
export class SessionConsolidationRunner {
  constructor(
    private readonly consolidator: SessionConsolidator,
    private readonly worker: ConsolidationWorkerDriver,
    private readonly receipts: ConsolidationReceiptStore,
    private readonly commits: ConsolidationCommitCoordinator,
    private readonly replay: ConsolidationPlanReplay,
    private readonly memory: MarkdownMemoryStore,
    private readonly debug?: ConsolidationDebugStore,
    private readonly candidatePool?: ConsolidationCandidatePool,
  ) {}

  async run(sessionId: string, signal?: AbortSignal): Promise<ConsolidationRunResult> {
    const pending = this.receipts.listCommittingBySourceSession(sessionId)[0]
    if (pending !== undefined) return this.recoverPending(pending, signal)
    const input = await this.consolidator.prepare(sessionId, signal)
    return this.receipts.withReviewLock(input.reviewId, async () => {
      const existing = this.receipts.read(input.reviewId)
      if (existing?.state === 'committed' || existing?.state === 'no-change') {
        return { outcome: existing.state, recovered: true, receipt: existing }
      }
      if (existing?.state === 'committing') {
        const attempt = existing.attempts.at(-1)
        if (attempt === undefined || attempt.workerSessionId === null) {
          throw new SessionConsolidationRunError('pending-recovery', 'committing receipt has no worker attempt')
        }
        const plan = await this.replay.loadPlan(attempt.workerSessionId, input, signal)
        const result = await this.commits.commitWithinReviewLock({
          input,
          plan,
          attempt: attempt.attempt,
          workerSessionId: attempt.workerSessionId,
          workerConfig: { provider: attempt.provider, model: attempt.model },
          ...(signal === undefined ? {} : { signal }),
        })
        if (result.outcome === 'committed' || result.outcome === 'no-change') {
          this.settleCandidates(input.workspace.scope.key, plan, input.pendingCandidates)
        }
        return result
      }

      const attempt = nextAttempt(existing)
      const workerSessionId = workerSessionIdOf(input.reviewId, attempt)
      const workerConfig = { ...this.worker.config }
      const debugIdentity = { reviewId: input.reviewId, attempt }
      this.debug?.record(debugIdentity, 'runner-attempt', {
        sourceSessionId: input.source.sessionId,
        provider: workerConfig.provider,
        model: workerConfig.model,
      })
      if (input.source.evidence.length === 0) {
        const plan = this.consolidator.planProposal(input, { outcome: 'no-change', changes: [] })
        const result = await this.commits.commitWithinReviewLock({
          input,
          plan,
          attempt,
          workerSessionId: null,
          workerConfig,
          ...(signal === undefined ? {} : { signal }),
        })
        if (result.outcome === 'committed' || result.outcome === 'no-change') {
          this.settleCandidates(input.workspace.scope.key, plan, input.pendingCandidates)
        }
        return result
      }
      try {
        const produced = await this.worker.run(input, attempt, signal)
        // A segmented run reports the id of its LAST segment, so the guard can
        // no longer demand segment 0 verbatim: it must still prove the id belongs
        // to this review and this attempt, which rules out a cross-review mixup.
        if (!isWorkerSessionOf(produced.workerSessionId, workerSessionId)) {
          throw new SessionConsolidationRunError('worker-mismatch', 'worker returned an unexpected Session id')
        }
        if (produced.plan.staleChanges !== undefined) {
          this.debug?.record(debugIdentity, 'temporal-guard', { stale: produced.plan.staleChanges })
        }
        try {
          const result = await this.commits.commitWithinReviewLock({
            input,
            plan: produced.plan,
            attempt,
            // Store the segment the worker finished with, not segment 0: an
            // oversized segment is split again mid-run, so only the last
            // Session records the final segment count that recovery needs.
            workerSessionId: produced.workerSessionId,
            workerConfig,
            ...(signal === undefined ? {} : { signal }),
          })
          if (result.outcome === 'committed' || result.outcome === 'no-change') {
            this.settleCandidates(input.workspace.scope.key, produced.plan, input.pendingCandidates)
          }
          return result
        } catch (error: unknown) {
          if (this.receipts.read(input.reviewId)?.state === 'committing'
            || error instanceof SessionConsolidationError) throw error
          throw new SessionConsolidationRunError('commit-failed', 'consolidation commit failed before durable intent')
        }
      } catch (error: unknown) {
        const current = this.receipts.read(input.reviewId)
        if (current?.state === 'committing') throw error
        const state = classifyFailure(error, signal)
        this.debug?.failure(debugIdentity, `runner-${state}`, error)
        const receipt = createFailedConsolidationReceipt({
          input,
          attempt,
          workerSessionId,
          workerConfig,
          state,
        }, this.receipts.timestamp(), current ?? existing)
        this.receipts.write(receipt)
        return { outcome: state, recovered: false, receipt }
      }
    })
  }

  private recoverPending(
    pending: ConsolidationReceipt,
    signal?: AbortSignal,
  ): Promise<ConsolidationRunResult> {
    return this.receipts.withReviewLock(pending.reviewId, async () => {
      signal?.throwIfAborted()
      const receipt = this.receipts.read(pending.reviewId)
      if (receipt === undefined) throw new SessionConsolidationRunError('pending-recovery', 'pending receipt disappeared')
      if (receipt.state === 'committed' || receipt.state === 'no-change' || receipt.state === 'target-conflict') {
        return { outcome: receipt.state, recovered: true, receipt }
      }
      if (receipt.state !== 'committing') {
        throw new SessionConsolidationRunError('pending-recovery', 'pending receipt changed to a non-recoverable state')
      }
      const attempt = receipt.attempts.at(-1)
      if (attempt?.workerSessionId === undefined || attempt.workerSessionId === null) {
        throw new SessionConsolidationRunError('pending-recovery', 'committing receipt has no worker Session')
      }
      try {
        const target = this.memory.workspaceTargetForKey(receipt.workspaceKey)
        const workspace = await this.memory.readWorkspace(target)
        const plan = await this.replay.loadRecoveryPlan(attempt.workerSessionId, receipt, workspace, signal)
        const result = await this.commits.recoverReceiptWithinReviewLock(receipt, target, plan)
        if (result.outcome === 'committed' || result.outcome === 'no-change') {
          this.settleCandidates(receipt.workspaceKey, plan)
        }
        return result
      } catch (error: unknown) {
        if (signal?.aborted) throw error
        const current = this.receipts.read(pending.reviewId)
        if (current?.state !== 'committing') throw error
        // The durable intent cannot be replayed (worker Session lost or drifted).
        // Converge to a terminal state so the next run starts a fresh attempt
        // instead of failing the same way on every retry.
        this.debug?.failure({ reviewId: receipt.reviewId, attempt: attempt.attempt }, 'recovery-failed', error)
        const attempts = receipt.attempts.map((entry, index) => index === receipt.attempts.length - 1
          ? { ...entry, status: 'internal-error' as const }
          : entry)
        const converged: ConsolidationReceipt = {
          ...receipt,
          state: 'internal-error',
          completedAt: this.receipts.timestamp(),
          attempts,
        }
        this.receipts.write(converged)
        return { outcome: 'internal-error', recovered: false, receipt: converged }
      }
    })
  }
  private settleCandidates(
    workspaceKey: string,
    plan: ConsolidationProposalPlan,
    inputPendingCandidates?: readonly ConsolidationCandidateEntry[],
  ): void {
    if (this.candidatePool === undefined) return
    try {
      if (plan.parked !== undefined && plan.parked.length > 0) {
        this.candidatePool.park(workspaceKey, plan.parked)
      }
      if (inputPendingCandidates !== undefined && inputPendingCandidates.length > 0) {
        this.candidatePool.remove(workspaceKey, inputPendingCandidates.map(c => c.id))
      }
    } catch (cause: unknown) {
      console.warn(`[dsh-memory] failed to settle candidate pool for ${workspaceKey}:`, cause)
    }
  }

}

export type SessionConsolidationRunErrorCode = 'pending-recovery' | 'worker-mismatch' | 'commit-failed'

export class SessionConsolidationRunError extends Error {
  constructor(readonly code: SessionConsolidationRunErrorCode, message: string) {
    super(message)
    this.name = 'SessionConsolidationRunError'
  }
}

/**
 * True when `produced` is the segment-0 worker Session id of this
 * review/attempt or one of its `-seg-N` siblings. Segment ids are derived from
 * the same review id, so prefix equality with a segment suffix is the exact
 * contract; anything else is a real mismatch.
 */
function isWorkerSessionOf(produced: string, base: string): boolean {
  if (produced === base) return true
  const prefix = `${base}-seg-`
  if (!produced.startsWith(prefix)) return false
  const suffix = produced.slice(prefix.length)
  return /^[1-9][0-9]*$/u.test(suffix)
}

function nextAttempt(receipt: ConsolidationReceipt | undefined): number {
  const latest = receipt?.attempts.at(-1)?.attempt ?? 0
  if (!Number.isSafeInteger(latest) || latest < 0 || latest >= Number.MAX_SAFE_INTEGER) {
    throw new SessionConsolidationRunError('worker-mismatch', 'receipt attempt history is invalid')
  }
  return latest + 1
}

function classifyFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): Exclude<ConsolidationReceiptState, 'committing' | 'committed' | 'no-change' | 'target-conflict'> {
  if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return 'cancelled'
  if (error instanceof ConsolidationWorkerError && error.code === 'output-truncated') {
    return 'output-truncated'
  }
  if (error instanceof ConsolidationProposalError || error instanceof ConsolidationWorkerError) {
    return 'invalid-proposal'
  }
  if (error instanceof SessionConsolidationError) return 'source-changed'
  if (error instanceof SessionConsolidationRunError || error instanceof ConsolidationWorkerRuntimeError) return 'internal-error'
  if (error instanceof ConsolidationProviderError) return 'provider-failed'
  if (error instanceof ConsolidationEvidenceTooLargeError) return 'evidence-too-large'
  return 'internal-error'
}
