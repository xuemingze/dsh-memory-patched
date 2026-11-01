# Unicode Workspace slug stays readable

## Problem

`slugify` stripped every character outside `[a-z0-9]`, so a cwd whose basename contains no ASCII letters or digits (for example a Chinese project directory such as `D:\项目\闲聊及灵感`) produced the literal slug `workspace`. `workspaceDisplayNameForCwd` derives the Browser label from that slug, so every such Workspace was displayed as `workspace` and could only be told apart by its opaque id. The directory name was equally uninformative (`workspaces/workspace-<hash>`).

## Decision

- Keep Unicode letters and digits in the slug: `slugify` now replaces runs of characters outside `\p{L}\p{N}` with `-` instead of stripping everything outside `[a-z0-9]`. The empty-slug fallback to `workspace` and the leading/trailing `-` trim are unchanged.
- Widen `WORKSPACE_KEY_PATTERN` to the same character classes so keys derived from non-ASCII basenames validate and parse, while ASCII keys and legacy `workspace-<hash>` keys keep matching.
- Record names keep `NAME_PATTERN` (`[a-z0-9-]`); only the Workspace identity changes.
- Cover the behavior with unit tests for a readable non-ASCII slug, an unchanged ASCII slug, and legacy-key acceptance.

## Alternatives considered

- Transliterating non-ASCII basenames keeps directories ASCII but invents a name the user never chose and needs a transliteration table per script.
- Hash-only keys (`<sha256>` without a slug) are opaque everywhere and lose the readable prefix entirely.
- A per-Workspace display-name override would fix the label but not the directory name, and adds Host-persisted state outside the key rule.

## Consequences

- Existing Workspaces whose basename slug changed keep their old `workspace-<hash>` key on disk. The plugin cannot recover the original basename from the hash, so it does not rename them: the directory stays a valid Workspace (the widened pattern still matches) and keeps displaying as `workspace` until it is renamed by hand to `<new-slug>-<hash>`. The 16-hex digest is part of the key and does not change, so a manual rename only replaces the slug prefix.
- Workspaces with an ASCII basename are unaffected: key, directory, and opaque id are identical.
- The Browser derives the opaque id from the key, so a manually renamed directory shows up under a new id with the readable label; no persisted Browser state references old ids, and receipts that still name the old key keep validating but resolve to a directory that no longer exists until renamed.
- `lib/` is committed so `github:` installs need no consumer-side build; restart the Host after installing.
