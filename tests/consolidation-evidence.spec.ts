import { describe, expect, it } from 'vitest'
import {
  MAX_INLINE_CODE_BLOCK_BYTES,
  projectConsolidationEvidence,
  sanitizeConsolidationEvidenceText,
} from '../src/consolidation-evidence.ts'

describe('consolidation evidence projection', () => {
  it('keeps human text, the final assistant answer, and tool status while dropping runtime and event noise', () => {
    const hugeResult = 'tool-output-that-must-not-leak'.repeat(1_000)
    const evidence = projectConsolidationEvidence([
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'request/header', data: { secretConfig: hugeResult } },
      {
        seq: 2,
        type: 'user/message',
        surfaceOp: 'append',
        data: {
          source: { kind: 'plugin:dsh-memory' },
          content: [{ type: 'text', text: 'Previously injected memory must not be relearned.' }],
        },
      },
      {
        seq: 3,
        type: 'user/message',
        surfaceOp: 'append',
        data: {
          source: { kind: 'user' },
          content: [
            { type: 'text', text: 'Prefer focused tests. api_key=secret-value' },
            { type: 'image', data: hugeResult },
          ],
        },
      },
      {
        seq: 4,
        type: 'assistant/message',
        surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'I am still checking.' }] } },
      },
      { seq: 5, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: hugeResult } },
      {
        seq: 6,
        type: 'tool/result',
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: hugeResult }] },
        },
      },
      {
        seq: 7,
        type: 'assistant/message',
        surfaceOp: 'append',
        data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Use the smallest relevant unit test.' }] } },
      },
      { seq: 8, type: 'assistant/chunk', data: { chunk: hugeResult } },
      { seq: 9, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ])

    expect(evidence).toEqual([{
      fromSeq: 0,
      toSeq: 9,
      user: ['Prefer focused tests. api_key=[REDACTED]', '[omitted non-text content: image]'],
      summaries: [],
      assistantFinal: 'Use the smallest relevant unit test.',
      tools: [{ name: 'read_file', status: 'succeeded' }],
    }])
    const rendered = JSON.stringify(evidence)
    expect(rendered).not.toContain('Previously injected memory')
    expect(rendered).not.toContain('tool-output-that-must-not-leak')
    expect(rendered).not.toContain('I am still checking')
  })

  it('uses a surface replacement summary instead of its shadowed messages', () => {
    const evidence = projectConsolidationEvidence([
      {
        seq: 0,
        type: 'user/message',
        surfaceOp: 'append',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Long original question.' }] },
      },
      {
        seq: 1,
        type: 'assistant/message',
        surfaceOp: 'append',
        data: { message: { content: [{ type: 'text', text: 'Long original answer.' }] } },
      },
      {
        seq: 2,
        type: 'user/message',
        surfaceOp: { op: 'replace', start: 0, end: 1 },
        sourceEventSeqs: [0, 1],
        data: {
          source: { kind: 'plugin', plugin: 'compact' },
          content: [{ type: 'text', text: 'The user chose focused verification.' }],
        },
      },
    ])

    expect(evidence).toEqual([{
      fromSeq: 2,
      toSeq: 2,
      user: [],
      summaries: ['The user chose focused verification.'],
      assistantFinal: null,
      tools: [],
    }])
  })

  it('returns no evidence for lifecycle-only logs and replaces oversized fenced code', () => {
    expect(projectConsolidationEvidence([
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ])).toEqual([])

    const code = `\`\`\`text\n${'x'.repeat(MAX_INLINE_CODE_BLOCK_BYTES + 1)}\n\`\`\``
    expect(sanitizeConsolidationEvidenceText(`before\n${code}\nafter`)).toMatch(/omitted code block: \d+ bytes/u)
  })

  it('redacts quoted key-value pairs, bare JWTs, and PEM private key blocks', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'
    const text = sanitizeConsolidationEvidenceText([
      '"api_key": "super-secret-value"',
      'plain note mentioning token without a separator',
      jwt,
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n'))
    expect(text).toContain('"api_key": "[REDACTED]"')
    expect(text).not.toContain('super-secret-value')
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(text).toContain('[REDACTED]')
    expect(text).not.toContain('MIIEowIBAAKCAQEA')
    expect(text).toContain('-----BEGIN PRIVATE KEY----- [REDACTED] -----END PRIVATE KEY-----')
  })
})
