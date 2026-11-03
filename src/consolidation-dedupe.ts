/**
 * Deterministic text primitives for memory dedupe.
 *
 * Ported from alice-core's `memory-consolidation-sync` rules (heading demotion,
 * signpost-index stripping, word-chunk intersection for same-topic detection).
 * Pure functions, no I/O, no dependencies: the caller owns fallback semantics.
 */

/** A short text carrying pointer features is an index/signpost, not content. */
const SIGNPOST_PATTERN = /(详见|参见|见下|记忆入口|详细记忆|资料库\.md|记录日期)/
const SIGNPOST_MAX_CHARS = 900
/** Plain same-topic detection needs a solid chunk overlap... */
const TOPIC_MIN_INTERSECTION = 3
/** ...but a signpost only needs the pointer's topic echoed by the fuller text. */
const SIGNPOST_MIN_INTERSECTION = 2
/**
 * Containment guard: the shorter side's chunks must be mostly contained in the
 * longer side. Sibling records share domain vocabulary, so a bare intersection
 * count would merge records that merely live in the same domain.
 */
const TOPIC_CONTAINMENT = 0.5
/** One-line records collide on generic vocabulary; containment needs substance. */
const TOPIC_MIN_CHUNKS = 8

/** Lowercased ASCII words (≥2 chars) plus CJK bigrams; single CJK chars kept as-is. */
export function textChunks(text: string): Set<string> {
  const chunks = new Set<string>()
  const normalized = text.toLowerCase()
  for (const match of normalized.matchAll(/[a-z0-9]+/g)) {
    if (match[0].length >= 2) chunks.add(match[0])
  }
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0]
    if (run.length === 1) {
      chunks.add(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index++) chunks.add(run.slice(index, index + 2))
  }
  return chunks
}

/** Size of the intersection of two chunk sets. */
export function chunkIntersection(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
  let count = 0
  for (const chunk of smaller) {
    if (larger.has(chunk)) count++
  }
  return count
}

/** True for short pointer text ("详见 memory/x.md") — an index, not content. */
export function isSignpostText(text: string): boolean {
  return text.length < SIGNPOST_MAX_CHARS && SIGNPOST_PATTERN.test(text)
}

/**
 * Same-topic test over (shorter, longer) content. Same topic when the shorter
 * side's chunks are largely contained in the longer side, or when the shorter
 * side is a signpost whose topic the longer side echoes. The containment rule
 * needs substantial content: one-line records collide on generic vocabulary,
 * so below TOPIC_MIN_CHUNKS only the signpost rule may fire.
 */
export function isSameTopic(shorter: string, longer: string): boolean {
  const shortChunks = textChunks(shorter)
  const intersection = chunkIntersection(shortChunks, textChunks(longer))
  if (isSignpostText(shorter) && intersection >= SIGNPOST_MIN_INTERSECTION) return true
  if (shortChunks.size < TOPIC_MIN_CHUNKS) return false
  return intersection >= TOPIC_MIN_INTERSECTION && intersection / shortChunks.size >= TOPIC_CONTAINMENT
}

/**
 * Demote an absorbed document's headings by one level before merging it under
 * a surviving record: drop the document's own `#` title, deepen every ATX
 * heading (capped at `######`) so one topic stays one section.
 */
export function demoteHeadings(markdown: string): string {
  let droppedTitle = false
  const lines = markdown
    .split('\n')
    .map(line => {
      const match = /^(#{1,6})(\s.*)?$/.exec(line)
      if (!match) return line
      if (!droppedTitle && match[1].length === 1) {
        droppedTitle = true
        return null
      }
      const level = Math.min(match[1].length + 1, 6)
      return `${'#'.repeat(level)}${line.slice(match[1].length)}`
    })
    .filter((line): line is string => line !== null)
  return lines.join('\n')
}

interface TopLevelSection {
  readonly heading: string
  readonly body: string
  readonly raw: string
}

/** Split markdown into the preamble plus `##`-level sections, keeping raw text lossless. */
function splitTopLevelSections(markdown: string): TopLevelSection[] {
  const lines = markdown.split('\n')
  const sections: TopLevelSection[] = []
  let preamble: string[] = []
  let current: { heading: string; lines: string[] } | undefined
  for (const line of lines) {
    if (/^##(\s.*)?$/.test(line)) {
      if (current) sections.push(finishSection(current))
      current = { heading: line.replace(/^##\s*/, '').trim(), lines: [line] }
      continue
    }
    if (current) current.lines.push(line)
    else preamble.push(line)
  }
  if (current) sections.push(finishSection(current))
  const preambleRaw = preamble.length === 0 ? '' : `${preamble.join('\n')}${preamble[preamble.length - 1] === '' ? '' : '\n'}`
  return [{ heading: '', body: preambleRaw, raw: preambleRaw }, ...sections]
}

function finishSection(section: { heading: string; lines: string[] }): TopLevelSection {
  const raw = `${section.lines.join('\n')}\n`
  return { heading: section.heading, body: section.lines.slice(1).join('\n').trim(), raw }
}

/**
 * Drop `##` sections that are pure signposts when the same content already
 * carries a fuller same-topic section. A lone short section is never dropped:
 * without a fuller counterpart it is the only content there is.
 */
export function stripSignpostSections(markdown: string): string {
  const sections = splitTopLevelSections(markdown)
  const keep = sections.map((section, index) => {
    if (section.heading === '' || !isSignpostText(section.body)) return true
    return !sections.some(
      (other, otherIndex) =>
        otherIndex !== index && other.heading !== '' && other.body.length > section.body.length
        && isSameTopic(section.body, other.body),
    )
  })
  if (keep.every(Boolean)) return markdown
  return sections.filter((_, index) => keep[index]).map(section => section.raw).join('')
}
