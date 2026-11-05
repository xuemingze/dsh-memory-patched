/**
 * Reversible visibility for prompt assembly.
 *
 * Archived and superseded records must leave the prompt without leaving the
 * disk. Filtering the rendered index — rather than rewriting `MEMORY.md` — keeps
 * the Markdown authoritative and the Settings page complete, and means a missing
 * or corrupt sidecar simply restores full visibility.
 */

import type { Lifecycle } from './memory-governance-types.ts'

/** Decides which records the model may see right now. */
export interface MemoryVisibilityPolicy {
  /**
   * True when the governance sidecar could not be read. A degraded policy must
   * pass everything through: losing metadata may cost ranking quality, but it
   * must never hide a memory.
   */
  readonly degraded: boolean
  readonly lifecycleOf: (recordName: string) => Lifecycle
}

/** Lifecycle states that stay out of the default prompt. */
const HIDDEN: ReadonlySet<Lifecycle> = new Set<Lifecycle>(['archived', 'superseded'])

/** One generated index entry: `- [name](name.md) — description`. */
const INDEX_LINE = /^-\s+\[(?<label>[^\]]+)\]\((?<file>[^)]+)\)/u

/**
 * Remove hidden entries from a rendered index.
 *
 * Only real index lines are considered: headers and prose pass through, because
 * guessing at anything else would risk dropping content that was never governed.
 */
export function filterIndexByVisibility(
  index: string,
  policy: MemoryVisibilityPolicy | undefined,
): string {
  if (policy === undefined || policy.degraded) return index
  const kept: string[] = []
  let removed = 0
  for (const line of index.split('\n')) {
    const match = INDEX_LINE.exec(line)
    if (match?.groups === undefined) {
      kept.push(line)
      continue
    }
    const recordName = recordNameOf(match.groups)
    if (recordName !== undefined && HIDDEN.has(policy.lifecycleOf(recordName))) {
      removed += 1
      continue
    }
    kept.push(line)
  }
  if (removed === 0) return index
  // Collapse the blank runs a removal can leave behind.
  return kept.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()
}

/** Prefer the link target's basename; fall back to the label. */
function recordNameOf(groups: Record<string, string | undefined>): string | undefined {
  const file = groups.file
  if (file !== undefined) {
    const base = file.replace(/^.*[\\/]/u, '').replace(/\.md$/iu, '')
    if (base !== '') return base
  }
  const label = groups.label?.trim()
  return label === undefined || label === '' ? undefined : label
}
