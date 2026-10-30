# DSH 0.2.1-rc.2 compatibility: producer-owned source kind and `webStartup`

## Problem

DSH 0.2.1-rc.2 tightened v4 Session row admission: a `user/message` row whose `source.kind` is the bare producer word `plugin` is rejected with `format v4 message requires a producer-owned source kind`. The Consolidation worker injects its input and task messages with exactly that wrapper, so its first message never reaches the Session log. Every consolidation run then reports `provider-failed` even though the model was never called, and the worker Session stays empty.

The same release renamed the Web runtime service from `webRuntime` to `webStartup`. The Bundle override that keeps the standard Connection row's Web config dependency therefore no longer resolves, which breaks generic RPC registration for the memory settings page (`/memory`), surfacing as HTTP 405 from the static fallback.

## Decision

- Inject Consolidation worker messages with the canonical producer-owned kind `plugin:dsh-memory` (the Host's own mapping for unknown plugin names is `plugin:<plugin>`), and accept exactly that kind when replaying worker evidence. Drop the retired `{ kind: 'plugin', plugin: 'dsh-memory' }` shape; it is rejected before persistence, so no readable worker Session can contain it.
- Set the standard `connection` row override to `inject: [webStartup, webServer]`, keeping the Web config dependency on the service name the supported DSH baseline actually provides.
- Keep one Cordis regression test for the Connection override, one for worker replay evidence, and the evidence-projection fixture aligned with the produced kind.

Memory semantics, scopes, revisions, receipts, and the Host/Browser wire are unchanged.

## Alternatives considered

- Adding `plugin` to a Host rename table is not possible from a plugin; the Host owns producer admission and rejects the word before any mapping applies.
- Accepting both the old and the new source kind in replay adds a compatibility branch for rows that could never be persisted on the supported baseline.
- Reading `webRuntime` with a fallback would mask an unavailable service instead of declaring the real dependency.

## Consequences

- Worker Sessions created before this patch are not replayable; those runs failed at admission and contain no evidence message.
- The patch must be shipped built: `lib/` is committed so `github:` installs need no consumer-side build.
- Restart the Host after installing; Bundle patches and the Host ESM entry are composed only at boot.
- Remove the source-kind change once the upstream package publishes a release that admits `plugin:<name>` rows; remove the `webStartup` dependency once the upstream `cordis.patch.yml` matches the supported DSH baseline.
