# Hand-edited files degrade instead of failing their pipeline

## Problem

`$DSH_HOME/memory` files are deliberately user-editable Markdown, but every reader treated one broken file as fatal:

- A workspace record with invalid frontmatter broke prompt assembly for its whole cwd (`memory-observation` renders context on every turn) and made the settings-page Workspace list fail.
- One corrupt receipt file — or one saved with CRLF line endings, which the strict `^---\n` frontmatter regex rejects — made every consolidation receipt scan throw, disabling consolidation for all Sessions.
- A corrupt `settings.yml` failed the runner's inject effect, so the whole consolidation feature stayed unmounted until the file was deleted by hand.

## Decision

- Workspace record reads isolate per file: unreadable or invalid records are skipped with a `console.warn` naming the exact file, and the Workspace revision covers only the parseable records. `parseWorkspaceRecord` normalizes CRLF to LF before parsing, so files saved by Windows editors parse instead of being skipped.
- Receipt batch scans skip unreadable files with a warning; direct `read(reviewId)` stays strict, so a targeted commit still fails loudly. Receipt frontmatter parsing tolerates CRLF.
- `ConsolidationSettingsStore.read()` falls back to the built-in defaults with a warning instead of throwing. The corrupt file is left untouched, and the next CAS commit from the settings page rewrites it (self-heal).

## Alternatives considered

- Deleting invalid files automatically: destructive on user-authored content and hides the mistake.
- A validation/repair UI: larger surface; unnecessary while skipping is safe and visible.

## Consequences

- A broken record disappears from the model-facing index and the Browser list until it is fixed or removed; the warning names the exact file, so the fix is one editor session away.
- A corrupt settings file makes consolidation run on defaults; the UI shows the fallback values and saving repairs the file.
- CRLF normalization means a hand-edited file's parsed content matches what the plugin itself would have written (LF).
