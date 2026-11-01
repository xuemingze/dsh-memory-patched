/** Deterministic, compact model-facing projection of one logical Session log. */

import { foldSurface } from '@deepseek-ai/dsh-session'

import { redactCredentials } from './redact.ts'

export const MAX_INLINE_CODE_BLOCK_BYTES = 4_096

export interface ConsolidationEvidenceTool {
  readonly name: string
  readonly status: 'succeeded' | 'failed'
}

/** One compact turn whose range remains anchored to the authoritative source log. */
export interface ConsolidationEvidenceTurn {
  readonly fromSeq: number
  readonly toSeq: number
  readonly user: readonly string[]
  readonly summaries: readonly string[]
  readonly assistantFinal: string | null
  readonly tools: readonly ConsolidationEvidenceTool[]
}

interface MutableTurn {
  fromSeq: number
  toSeq: number
  user: string[]
  summaries: string[]
  assistantFinal: string | null
  tools: ConsolidationEvidenceTool[]
}

/**
 * Keep only durable conversational evidence from the current DSH message surface.
 * Raw events remain Host-only for stability, receipt coverage, and audit.
 */
export function projectConsolidationEvidence(events: readonly unknown[]): ConsolidationEvidenceTurn[] {
  if (events.length === 0) return []
  const records = events.map((event, index) => requireEvent(event, index))
  const surfaceNodes = effectiveSurfaceNodes(records)
  const callNames = toolCallNames(records)
  const turns: ConsolidationEvidenceTurn[] = []
  let current: MutableTurn | undefined

  const finish = (): void => {
    if (current !== undefined && hasEvidence(current)) turns.push(freezeTurn(current))
    current = undefined
  }

  for (const event of records) {
    const seq = event.seq as number
    if (event.type === 'turn/start') {
      finish()
      current = emptyTurn(seq)
      continue
    }
    if (current !== undefined) current.toSeq = seq

    if (surfaceNodes.has(seq)) {
      const target = current ?? emptyTurn(seq)
      projectSurfaceEvent(event, target, callNames)
      if (current === undefined && hasEvidence(target)) turns.push(freezeTurn(target))
    }

    if (event.type === 'turn/end') finish()
  }
  finish()
  return turns
}

/** Text-only normalization that removes credentials and replaces very large fenced code blocks. */
export function sanitizeConsolidationEvidenceText(value: string): string {
  return redactCredentials(value).replace(/```[^\n]*\n[\s\S]*?```/gu, block => (
    Buffer.byteLength(block, 'utf8') > MAX_INLINE_CODE_BLOCK_BYTES
      ? `[omitted code block: ${Buffer.byteLength(block, 'utf8')} bytes]`
      : block
  ))
}

function effectiveSurfaceNodes(events: readonly Record<string, unknown>[]): Set<number> {
  const surfaceEvents = events.filter(event => isMessageEvent(event.type))
  if (surfaceEvents.every(event => event.surfaceOp === undefined)) {
    return new Set(surfaceEvents.map(event => event.seq as number))
  }
  const folded = foldSurface(events as never[])
  return new Set(folded.nodes)
}

function projectSurfaceEvent(
  event: Record<string, unknown>,
  turn: MutableTurn,
  callNames: ReadonlyMap<string, string>,
): void {
  const data = recordOf(event.data)
  if (event.type === 'user/message') {
    const texts = messageTexts(data, true)
    const source = recordOf(data?.source)
    if (source?.kind === 'user') turn.user.push(...texts)
    else if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') turn.summaries.push(...texts)
    return
  }
  if (event.type === 'assistant/message') {
    const text = messageTexts(recordOf(data?.message), false).join('\n').trim()
    if (text !== '') turn.assistantFinal = text
    return
  }
  if (event.type === 'tool/result') {
    const message = recordOf(data?.message)
    const source = recordOf(message?.source)
    const callId = typeof source?.callId === 'string' ? source.callId : undefined
    const name = callId === undefined ? undefined : callNames.get(callId)
    if (name !== undefined) turn.tools.push({ name, status: data?.error === undefined ? 'succeeded' : 'failed' })
  }
}

function messageTexts(message: Record<string, unknown> | undefined, placeholders: boolean): string[] {
  if (message === undefined) return []
  if (typeof message.content === 'string') {
    const text = sanitizeConsolidationEvidenceText(message.content).trim()
    return text === '' ? [] : [text]
  }
  if (!Array.isArray(message.content)) return []
  return message.content.flatMap((candidate) => {
    const block = recordOf(candidate)
    if (block?.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeConsolidationEvidenceText(block.text).trim()
      return text === '' ? [] : [text]
    }
    if (placeholders && typeof block?.type === 'string') return [`[omitted non-text content: ${block.type}]`]
    return []
  })
}

function toolCallNames(events: readonly Record<string, unknown>[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = recordOf(event.data)
    if (typeof data?.callId === 'string' && typeof data.name === 'string' && data.name.trim() !== '') {
      names.set(data.callId, data.name)
    }
  }
  return names
}

function requireEvent(value: unknown, index: number): Record<string, unknown> & { seq: number; type: string } {
  const event = recordOf(value)
  if (event === undefined || !Number.isSafeInteger(event.seq) || event.seq !== index || typeof event.type !== 'string') {
    throw new TypeError(`sourceEvents[${index}] must have contiguous seq and a string type`)
  }
  return event as Record<string, unknown> & { seq: number; type: string }
}

function emptyTurn(seq: number): MutableTurn {
  return { fromSeq: seq, toSeq: seq, user: [], summaries: [], assistantFinal: null, tools: [] }
}

function hasEvidence(turn: MutableTurn): boolean {
  return turn.user.length > 0 || turn.summaries.length > 0 || turn.assistantFinal !== null || turn.tools.length > 0
}

function freezeTurn(turn: MutableTurn): ConsolidationEvidenceTurn {
  return {
    fromSeq: turn.fromSeq,
    toSeq: turn.toSeq,
    user: [...turn.user],
    summaries: [...turn.summaries],
    assistantFinal: turn.assistantFinal,
    tools: turn.tools.map(tool => ({ ...tool })),
  }
}

function isMessageEvent(type: unknown): boolean {
  return type === 'user/message' || type === 'assistant/message' || type === 'tool/result'
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

