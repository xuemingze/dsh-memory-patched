# Governance providers

dsh-memory does not verify the outside world. Networks flake, proxies drop,
models go unavailable, plugins get installed and removed. Proving that is
someone else's job.

This document defines the contract for modules that supply those verdicts. The
principle is **collaboration over completeness**: each module's contract is
narrow, its failure is isolated, and it can be replaced or removed without
touching memory.

---

## Why this boundary exists

A memory system that tries to diagnose its own network will be wrong in ways
nobody can debug. Worse, it will treat a transient outage as evidence about a
record's truth, and demote a perfectly good memory because the proxy was down.

So dsh-memory consumes **observations**: statements with a source, a time, and an
environment fingerprint. It classifies conflicts. It never probes.

---

## The provider interface

A provider is a function that receives claims and returns observations.

```ts
interface MemoryVerificationProvider {
  readonly id: string
  verify(
    batch: VerificationBatch,
    signal: AbortSignal,
  ): Promise<readonly Observation[]>
}
```

### Input: `VerificationBatch`

```ts
interface VerificationBatch {
  readonly scopeKey: string
  readonly claims: readonly GovernanceClaim[]
  readonly now: number
}
```

Claims carry their summary text, kind, volatility, and evidence counts. Bodies
are not included: a provider reasons about what a memory *is*, not what it says
in full.

### Output: `Observation`

```ts
interface Observation {
  readonly claim: string          // the record name this is about
  readonly verdict: Verdict
  readonly detail?: string
  readonly environment?: string   // e.g. "proxy-on", "cn-region"
  readonly at?: number
}
```

| Verdict | Meaning |
|---|---|
| `supports` | This record held up |
| `contradicts` | This record did not hold up |
| `unknown` | The provider could not tell |

`unknown` must be a real option. A provider that cannot say "I don't know" will
guess, and a guess about availability becomes a false contradiction.

---

## Operational rules

These are enforced by the registry, not left to providers:

| Rule | Value | Why |
|---|---|---|
| Timeout per call | 10 s | A slow provider must not hold the panel |
| Concurrency ceiling | 4 | Twelve providers at once is a stampede |
| Failure isolation | `unavailable` | One broken provider does not fail the batch |
| Unknown verdicts | counted, not dropped | Silence and disagreement are different |

### Failure isolation

A provider that throws, times out, or returns garbage is marked `unavailable`
for that batch. Its claims are reported as unverified, **not** as contradicted.

The registry counts coverage precisely, by claim identity rather than by counting
observations. Counting rows would let a provider that returns two observations
for one claim look like it covered two.

### Registering

Providers are registered by id. A provider id may override the payload id, so a
plugin can supply a stable name regardless of what its caller passed.

```ts
registry.register({ id: 'my-verifier', verify: async (batch) => [...] })
```

### Unloading

Removing a provider is a registry operation, not a memory operation:

```ts
registry.unregister('my-verifier')
```

Claims it previously verified keep their stored observations. Removing a provider
must never invalidate past evidence — it only stops new observations arriving.

---

## What dsh-memory does with observations

Observations feed the conflict classifier, which sorts a disagreement into one of
four kinds. **The classification decides what happens to the records**, so the
distinction matters more than the verdict itself.

| Kind | When | Action |
|---|---|---|
| `hard-conflict` | Two records make exclusive claims, both stable | `park` both, ask |
| `temporal-evolution` | One claim is newer and replaces the other | `supersede-older` |
| `environment-split` | Both hold, in different environments | `keep-both` |
| `intermittent` | Evidence alternates with no settled state | `merge-intermittent` |

### `intermittent` versus `hard-conflict`

This is the distinction the whole boundary exists for.

A flaky proxy produces *both* successes and failures over days, clustering
around outages. That is `intermittent`. The correct response is **not** to decide
which record is right, and **not** to mark anything as broken. It is to record
"there is an intermittent problem, here is when it last recovered, here is what
to check first when it fails".

A genuine `hard-conflict` is two stable claims that cannot both be true. Both
raised no error; they simply disagree.

The classifier reads the availability window (14 days), stable-failure spread
(30 minutes), and restored spread (24 hours) to tell these apart. Language
generated from `intermittent` never says "working" or "broken" — only that the
problem recurs and when it last came back.

---

## Trigger providers

An optional second kind: a provider that decides *when* a governance pass should
run. Same shape — narrow, isolated, removable.

```ts
interface MemoryTriggerProvider {
  readonly id: string
  shouldRun(context: TriggerContext): Promise<boolean>
}
```

A trigger that throws is treated as "no". The absence of a trigger means manual
operation, which is the default.

---

## Writing a provider: minimum viable example

```ts
export const provider = {
  id: 'reachability',
  async verify(batch, signal) {
    return Promise.all(batch.claims.map(async claim => {
      try {
        const response = await fetch(claim.text, { signal })
        return { claim: claim.name, verdict: response.ok ? 'supports' : 'contradicts' }
      } catch (cause) {
        // A network error is not evidence about the record. Saying `unknown`
        // keeps a flaky link from demoting a good memory.
        if (signal.aborted) throw cause
        return { claim: claim.name, verdict: 'unknown', detail: String(cause) }
      }
    }))
  },
}
```

Note what it does *not* do: it does not retry internally, does not cache, and
does not decide what a failure means. Those belong to the registry and to the
classifier.

---

## Contract summary

- Providers return observations, never decisions.
- A thrown provider degrades to `unavailable`; it cannot block reads or writes.
- `unknown` is a first-class answer.
- Removing a provider stops new observations; it never invalidates old ones.
- The classifier, not the provider, decides whether a disagreement is a conflict,
  an evolution, an environment split, or a flake.
