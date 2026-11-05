/**
 * The boundary around GLOBAL memory.
 *
 * GLOBAL is injected into every Session, so a bad edit there is not a local
 * mistake: it changes how every future conversation behaves. Dream may therefore
 * only *append* one line inside a section a human already created. It may not
 * add sections, restructure the document, or replace it.
 *
 * Everything here is a string transformation. Nothing writes a file, so a
 * promotion can be reviewed before it is committed.
 */

/** Prefix on every promoted line so it can be traced back to its run. */
export const GLOBAL_PROMOTION_MARKER = '<!-- dream-promoted -->'

/** A promotion may not become a second copy of memory. */
export const MAX_PROMOTION_CHARS = 1_000

export class GlobalGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GlobalGuardError'
  }
}

export interface GlobalPromotion {
  readonly section: string
  readonly text: string
  readonly source: string
  readonly runId: string
}

/** Level-2 headings, which are the only ones that start a GLOBAL section. */
const SECTION_LINE = /^##\s+(.+?)\s*$/u
/** Any heading at all, used to reject text that would restructure the file. */
const ANY_HEADING = /^#{1,6}\s/mu

/**
 * Section titles in document order.
 *
 * Only level-2 headings count: a `###` sub-item inside `## DSH…` is detail, not
 * a section, and treating it as one would let a promotion land in the middle of
 * an unrelated block.
 */
export function parseGlobalSections(content: string): string[] {
  const sections: string[] = []
  for (const line of content.split('\n')) {
    const match = SECTION_LINE.exec(line)
    if (match !== null) sections.push(match[1]!)
  }
  return sections
}

/**
 * Append one promoted line inside an existing section.
 *
 * The result is byte-identical everywhere else: existing lines are never
 * removed, reordered, or rewritten. Idempotent for the same promotion so a
 * retried approval cannot duplicate the line.
 */
export function applyGlobalPromotion(content: string, promotion: GlobalPromotion): string {
  const text = promotion.text.trim()
  if (text === '') throw new GlobalGuardError('promoted text must not be empty')
  if (text.length > MAX_PROMOTION_CHARS) {
    throw new GlobalGuardError(
      `promoted text exceeds ${MAX_PROMOTION_CHARS} characters (${text.length})`,
    )
  }
  // A promoted line carrying a heading would silently restructure GLOBAL, and a
  // newline would let one promotion become several lines of content.
  if (text.includes('\n') || ANY_HEADING.test(text)) {
    throw new GlobalGuardError(
      'promoted text must be a single line and must not contain a heading or a document body',
    )
  }

  const sections = parseGlobalSections(content)
  if (!sections.includes(promotion.section)) {
    throw new GlobalGuardError(
      `global section "${promotion.section}" does not exist; Dream may not create sections`,
    )
  }

  const entry = `- ${text} ${GLOBAL_PROMOTION_MARKER} source:${promotion.source} run:${promotion.runId}`
  // Idempotence: an identical promotion already present is a no-op, so retrying
  // an approval cannot add the line twice.
  if (content.includes(entry)) return content

  const lines = content.split('\n')
  const start = lines.findIndex(line => {
    const match = SECTION_LINE.exec(line)
    return match !== null && match[1] === promotion.section
  })
  // Insert before the next level-2 heading, after the section's trailing blank
  // line, so the new entry joins the list rather than orphaning it.
  let insertAt = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (SECTION_LINE.test(lines[index]!)) { insertAt = index; break }
  }
  let cursor = insertAt - 1
  while (cursor > start && lines[cursor]!.trim() === '') cursor -= 1
  const at = cursor + 1

  const next = [...lines.slice(0, at), entry, ...lines.slice(at)]
  return normalizeEnding(next.join('\n'))
}

/** Exactly one trailing newline, so repeated edits cannot accumulate blanks. */
function normalizeEnding(content: string): string {
  return `${content.replace(/\n+$/u, '')}\n`
}
