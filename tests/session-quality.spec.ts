import { describe, expect, it } from 'vitest'
import {
  classifySessionQuality,
  sessionGroupFingerprint,
} from '../src/session-quality.ts'

/** Minimal event builders mirroring the real Session v4 log shape. */
function userMessage(text: string, source: unknown = { kind: 'user' }) {
  return { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text }], source } }
}

function assistantAttempt(parts: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  finish?: unknown
  text?: string
}) {
  const stream: unknown[] = []
  if (parts.text !== undefined) stream.push({ type: 'chunk', chunk: { type: 'text', text: parts.text } })
  stream.push({
    type: 'chunk',
    chunk: {
      type: 'usage',
      usage: {
        inputTokens: parts.inputTokens ?? 0,
        outputTokens: parts.outputTokens ?? 0,
        totalTokens: parts.totalTokens ?? 0,
      },
    },
  })
  if (parts.finish !== undefined) stream.push({ type: 'chunk', chunk: { type: 'finish', reason: parts.finish } })
  return { type: 'assistant/attempt', seq: 2, data: { turn: 1, step: 1, stream } }
}

function turnEnd(reason: unknown) {
  return { type: 'turn/end', seq: 3, data: { turn: 1, reason } }
}

const NO_API_KEY = {
  kind: 'error',
  failure: { message: 'No API key for provider: minimax-direct', code: 'PI_AI_ERROR' },
}

/** The exact shape of the three "请只回复两个字：成功" Sessions in the report. */
function zeroOutputFailure() {
  return [
    { type: 'session', seq: 0, data: {} },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 2, data: {} },
    userMessage('请只回复两个字：成功'),
    userMessage('Current runtime context...', { kind: 'runtime-context', form: 'snapshot' }),
    userMessage('<system-reminder>skills</system-reminder>', { kind: 'skill-catalog', form: 'catalog' }),
    assistantAttempt({ finish: NO_API_KEY }),
    turnEnd(NO_API_KEY),
  ]
}

describe('classifySessionQuality', () => {
  it('classifies a zero-output failed Session', () => {
    const result = classifySessionQuality(zeroOutputFailure())
    expect(result.class).toBe('failed-zero-output')
    expect(result.totalOutputTokens).toBe(0)
    expect(result.assistantTextBytes).toBe(0)
    expect(result.successfulToolCalls).toBe(0)
    expect(result.firstUserText).toBe('请只回复两个字：成功')
    expect(result.terminalErrors).toEqual([
      { code: 'PI_AI_ERROR', message: 'No API key for provider: minimax-direct' },
    ])
  })

  it('keeps a Session that failed and then succeeded', () => {
    const events = [
      ...zeroOutputFailure(),
      { type: 'turn/start', seq: 4, data: { turn: 2 } },
      assistantAttempt({ inputTokens: 10, outputTokens: 3, totalTokens: 13, finish: { kind: 'stop' }, text: '成功' }),
      turnEnd({ kind: 'stop' }),
    ]
    const result = classifySessionQuality(events)
    expect(result.class).toBe('meaningful')
    expect(result.totalOutputTokens).toBe(3)
  })

  it('keeps a short but real answer', () => {
    const result = classifySessionQuality([
      userMessage('请只回复两个字：成功'),
      assistantAttempt({ inputTokens: 8, outputTokens: 2, totalTokens: 10, finish: { kind: 'stop' }, text: '成功' }),
      turnEnd({ kind: 'stop' }),
    ])
    expect(result.class).toBe('meaningful')
    expect(result.assistantTextBytes).toBeGreaterThan(0)
  })

  it('keeps a Session whose only success was a tool call', () => {
    const events = [
      userMessage('run the tests'),
      assistantAttempt({ finish: NO_API_KEY }),
      { type: 'tool/call', seq: 4, data: { name: 'pwsh', arguments: '{}' } },
      { type: 'tool/result', seq: 5, data: { name: 'pwsh', ok: true } },
      turnEnd(NO_API_KEY),
    ]
    const result = classifySessionQuality(events)
    expect(result.class).toBe('meaningful')
    expect(result.successfulToolCalls).toBe(1)
  })

  it('never treats injected context as the user request', () => {
    const result = classifySessionQuality(zeroOutputFailure())
    expect(result.firstUserText).toBe('请只回复两个字：成功')
    expect(result.firstUserText).not.toContain('runtime context')
    expect(result.firstUserText).not.toContain('system-reminder')
  })

  it('does not classify a Session with no attempt as failed', () => {
    const result = classifySessionQuality([
      { type: 'session', seq: 0, data: {} },
      userMessage('hello'),
    ])
    expect(result.class).not.toBe('failed-zero-output')
  })

  it('does not classify a cancelled-but-answered Session as failed', () => {
    const result = classifySessionQuality([
      userMessage('hello'),
      assistantAttempt({ inputTokens: 5, outputTokens: 4, totalTokens: 9, finish: { kind: 'cancelled' }, text: 'hi there' }),
      turnEnd({ kind: 'cancelled' }),
    ])
    expect(result.class).toBe('meaningful')
  })

  it('fails open on malformed events', () => {
    const result = classifySessionQuality([
      null,
      'not an event',
      42,
      { type: 'assistant/attempt', data: { stream: 'not-an-array' } },
      userMessage('real question'),
    ] as unknown[])
    expect(result.class).toBe('meaningful')
  })

  it('reports an empty event list as empty, not as a failure', () => {
    // No events means nothing ran; that is the existing `empty` concern and
    // must never be reported as a zero-output model failure.
    expect(classifySessionQuality([]).class).toBe('empty')
  })
})

describe('sessionGroupFingerprint', () => {
  const base = {
    workspaceKey: 'agents-4ccfa4917b3d3231',
    title: '请只回复两个字：成功',
    firstUserText: '请只回复两个字：成功',
    quality: 'failed-zero-output' as const,
    errorCode: 'PI_AI_ERROR',
  }

  it('is stable for identical failures', () => {
    expect(sessionGroupFingerprint(base)).toBe(sessionGroupFingerprint({ ...base }))
  })

  it('separates different workspaces', () => {
    expect(sessionGroupFingerprint(base)).not.toBe(
      sessionGroupFingerprint({ ...base, workspaceKey: 'other-workspace' }),
    )
  })

  it('separates different error codes', () => {
    expect(sessionGroupFingerprint(base)).not.toBe(
      sessionGroupFingerprint({ ...base, errorCode: 'OTHER' }),
    )
  })

  it('separates different outcomes', () => {
    expect(sessionGroupFingerprint(base)).not.toBe(
      sessionGroupFingerprint({ ...base, quality: 'trivial-automation' }),
    )
  })

  it('tolerates a missing title or error code', () => {
    expect(() => sessionGroupFingerprint({
      ...base,
      title: null,
      errorCode: undefined,
    })).not.toThrow()
  })
})
