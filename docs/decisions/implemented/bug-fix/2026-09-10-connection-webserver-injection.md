# Restore the standard Web Connection registration dependency

> Superseded in part on 2026-10-30: on DSH >= 0.2.1-rc.2 the retained Web runtime service is `webStartup`, not `webRuntime`. See [DSH 0.2.1-rc.2 compatibility](2026-10-30-dsh-021-rc2-compatibility.md).

## Problem

DSH commit `2ef85b1e17591fb9fadc78549726413c56f38dfa`, merged into master by `ba05b7d49de63106afdd7efcf741cca1985fae18`, removed `webServer` from Connection's provider dependencies. Generic `connection.rpc.handle()` still accesses that service through the provider context. The memory RPC child fails with `cannot get property "webServer" without inject`, while the parent plugin remains active. Unmatched POST requests then reach the static fallback and return HTTP 405.

Root-provided service mocks hide this failure. The reproduction requires sibling provider plugins and explicitly awaiting failed child fibers, not just the parent entry.

## Decision

Add a Bundle override guarded by both the standard `connection` id and `@deepseek-ai/dsh-client-connection` package name. Set its entry-level `inject` to `[webRuntime, webServer]`: retain the standard Web config's dependency and restore HTTP registration access. Loader still merges module-level dependencies such as `credentials`. Do not modify DSH source, user configuration, authentication, RPC envelopes, or memory semantics.

Keep a Cordis regression test and a separate real-DSH source-checkout check using the shipped YAML, official patch algorithm, actual HostConnectionService, and built memory entry. Cover missing/mismatched targets, credentials/config preservation, failing unpatched registration, successful patched registration, disposal, and Headless loading.

## Alternatives considered

- Adding `webServer` only to the memory consumer does not repair the provider-context access.
- Direct HTTP registration would duplicate transport and security responsibilities.
- An upstream fix is preferable long-term, but this repair must stay within this repository.

## Consequences

Restart Web to recompose the Bundle. A Headless composition without Connection emits a skipped-patch warning but gains no Web dependency. This workaround targets the standard Web row; a renamed row is not patched. Because entry `inject` is replaced, deployments with custom extra dependencies must retain them in a later user patch. Connection without a Web server is outside this compatibility override's supported use.

Remove the override once the supported DSH baseline fixes generic registration ownership and passes the same sibling-provider regression. Keep using the host's existing authentication; this workaround does not restore or change older host interpretations of the `authority` option.
