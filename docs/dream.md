# Dream: cross-record governance proposals

Dream looks at the records that already exist and proposes how to organise them.
It is a librarian, not an author.

This document defines what Dream may do, what it may not do, and how a proposal
reaches your memory. It is the contract; the code enforces it.

---

## What Dream is not

Dream is **not** a background rewriter. It does not edit memory on its own, on a
timer, or in response to a Session ending. With `dream: shadow` (the default) it
can plan and show, and nothing else.

Dream is also **not** a fact-checker. It cannot prove whether a statement about
the world is true. It reasons about relationships between records: two records
that describe the same thing, one that replaced another, one that contradicts
another.

---

## The action vocabulary

Dream may propose exactly these eight actions. Anything else is rejected by the
parser before it is looked at.

| Action | What it means | Changes a body? |
|---|---|---|
| `merge` | Combine several records into one | yes |
| `supersede` | Mark an older record as replaced by a newer one | yes |
| `extract-sop` | Lift a reusable procedure out of an incident | yes |
| `promote-global` | Copy a record into one existing GLOBAL section | yes |
| `mark-contested` | Record that two records disagree, without deciding | no |
| `set-priority` | Revise how important a record is | no |
| `cool` | Lower a record's visibility | no |
| `archive` | Move a record out of the default prompt, keeping it on disk | no |

**There is no `delete` and no `purge`.** Removal is a separate act that requires
you to ask for it in so many words. No Dream code path produces one.

---

## What the parser enforces

Every proposal is validated against the records the model was actually shown.
The rules exist because a bad proposal fails silently: a hallucinated record name
or a plausible-looking merge would corrupt memory with no error surfacing.

1. **Unknown names are rejected.** A merge citing `invented-record` fails. This
   is the single most dangerous output, because it looks reasonable.
2. **Priority is recomputed.** The model's own score is ignored; the
   deterministic scorer decides. Priority drives what gets forgotten, so the
   model must not be able to promote a memory out of forgetting's reach.
3. **GLOBAL may only be appended to.** `promote-global` must name a section that
   already exists. It may not create sections or replace the document.
4. **Cycles are rejected.** `alpha → beta` plus `beta → alpha` is reported as a
   circular supersede chain, not as an ambiguous duplicate.
5. **One action per record.** Two actions may not target the same record, because
   which one won would depend on array order rather than on intent.
6. **An empty plan is valid.** "Nothing here needs reorganising" is a real answer.
   Refusing it would push the model to invent work to satisfy the schema.

---

## Two-phase approval

```
dream/status            read the panel: mode, pending plans, recent runs
dream/run               plan only; writes no memory (manual trigger in V1)
dream/proposal/read     read one staged plan
dream/proposal/approve  apply the actions you ticked
dream/proposal/reject   decline, with a reason code
```

Planning stages the plan under `<memory-root>/dream/pending/`. **No receipt is
written while a plan is pending**, because a pending plan is not a run: it has
not happened, and a killed process must not leave a receipt claiming work that
never occurred.

The pending copy is consumed only after the write succeeds. A crash mid-way
leaves the plan available to retry.

### Per-action approval

Approval is per action, not per plan. An all-or-nothing yes would force you to
accept one bad action to get the good ones, and people respond to that by
approving without reading.

Each action carries a fingerprint of `action + target + sources`, deliberately
excluding its position in the array. A re-rendered or re-ordered plan therefore
cannot approve a different action than the one you ticked.

### Reject reasons

A rejection stores one of four codes:

| Code | Meaning |
|---|---|
| `wrong-merge` | These records are not about the same thing |
| `disagree` | The record is correct as it stands |
| `not-important` | True, but not worth keeping |
| `already-known` | The fact is recorded elsewhere |

The code is not bookkeeping. Without it, the next run over the same snapshot
re-proposes exactly what you just dismissed, and you learn to ignore the panel.
A declined action comes back marked and disabled.

---

## Modes

`settings.yml` carries `dream: off | shadow | manual`. The default is `shadow`.

| Mode | Behaviour |
|---|---|
| `off` | Dream cannot plan |
| `shadow` | Plan and display; nothing is written without a click |
| `manual` | Metadata-only actions may be applied directly; content actions still need a click |

`manual` treats the two risk classes differently on purpose. Cooling or
re-ranking is undone by another metadata action, so a wrong call is cheap. A
wrong merge cannot be reconstructed from what is left.

**No mode auto-applies content changes.**

---

## Where a plan is applied

Dream never writes Markdown itself. It produces a validated plan, and the caller
applies it through the existing APIs:

- **Workspace metadata** goes through the governance sidecar commit, which
  carries a revision check. A plan whose snapshot moved is reported as
  `stale-scope` rather than written against records the model never saw.
- **GLOBAL.md** goes through the guard in `memory-global-guard.ts`, the single
  place the append-only rule lives. All promotions in one plan are applied to an
  in-memory copy and committed once: two promotions in two commits would leave
  GLOBAL half-updated if the second were rejected. A missing section refuses the
  whole batch rather than dropping what came after the bad one.

If the GLOBAL write fails after the sidecar commit succeeded, the failure is
returned in the response as `promotionError`. You approved a change; you must
learn if it never reached the document.

---

## Receipts

Every run writes one receipt under `<memory-root>/dream/<run-id>.json`, including
failures. Without one, a run that changed nothing and a run that crashed look
identical later, and that distinction is exactly what you need before trusting
the store.

A receipt carries handles and never a body. Storing prose would make it a second
source of truth that can drift from Markdown.

---

## Failure codes

| Code | Meaning | Remedy |
|---|---|---|
| `missing-proposal` | The model never submitted | prompt again |
| `output-truncated` | Token budget ran out | shrink the input |
| `input-too-large` | Rendered input exceeded the byte ceiling | slice the record set |
| `provider-failed` | The call threw | retry later |
| `stale-scope` | The store moved between plan and apply | plan again |
| `rejected` | No valid proposal after the attempt limit | inspect the prompt |

Truncation and provider failure are kept apart because their remedies differ.
Retrying a truncated run with the same input will truncate again.

---

## What Dream does not decide

- Whether a statement is factually true.
- Whether a record is important to you. It scores from observable signals;
  your own rule in GLOBAL overrides it.
- Whether to remove anything.
