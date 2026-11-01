# Recovery convergence, receipt-owned targets, and bounded worker waits

## Problem

Four failure paths in the consolidation chain could not converge:

1. A `committing` receipt whose worker Session was lost or drifted made `recoverPending` throw on every retry — the receipt stayed `committing` forever and the source Session could never be consolidated again.
2. The coordinator's recovery path trusted the caller-presented workspace scope. Two empty Workspaces share one revision, so a swapped scope could commit a durable plan into the wrong Workspace directory.
3. One oversized turn text pushed the whole rendered input past `maxInputBytes`; with a deterministic review id every future attempt failed identically (`evidence-too-large`), so the Session could never be consolidated.
4. The worker waited on `whenIdle` with no abort fallback: a host that never settles would hang the run, skip flush/attach/dispose, and hold the review lock forever. A rejected `whenIdle` also bypassed the provider-error normalization and was misclassified as internal-error.

## Decision

- `recoverPending` isolates the recovery attempt: on failure (unless aborted) it converges the receipt to a terminal `internal-error` state, marks the latest attempt accordingly, records the cause in the debug log when enabled, and returns the classified result. The next run starts a fresh worker attempt. If an inner layer already converged the receipt, the error is rethrown without clobbering that state.
- The coordinator resolves the recovery target through `workspaceTargetForKey(receipt.workspaceKey)`; the caller-presented scope is no longer trusted.
- Each evidence text is capped at `MAX_EVIDENCE_TEXT_BYTES` (16 KiB) after redaction and fenced-block handling: the head is kept on a UTF-8 boundary and the dropped byte count is recorded inline as `[truncated N bytes]`. Sequence ranges are unaffected.
- The worker races `whenIdle` against the operation signal (caller abort or timeout). The losing side is prevented from becoming an unhandled rejection; cleanup (flush, attach, dispose) always runs. A rejected `whenIdle` with an observed agent failure is normalized to `ConsolidationProviderError`.

## Alternatives considered

- Bounded retries for recovery: the same deterministic inputs fail identically, so a retry cap only delays the terminal state.
- Dropping oversized turns entirely: loses evidence coverage and weakens the proposal's source anchoring; head truncation keeps the range valid.
- Failing the run when the abort wins the race against an already-settled `whenIdle`: the abort already decided the outcome via `throwIfAborted`.

## Consequences

- A `committing` receipt that cannot be replayed becomes a visible `internal-error` receipt; the next consolidation of the same source runs a fresh worker attempt instead of failing identically.
- Recovery can no longer be pointed at a different Workspace by the caller; the durable receipt is the single owner of the target.
- Very large single turns are represented by their head plus a truncation marker, so consolidation proceeds within the input budget; proposals anchored to truncated turns stay valid because ranges are sequence-based.
- A hung host now surfaces as `cancelled` (abort) instead of hanging the pipeline; review locks are released by the normal cleanup chain.
