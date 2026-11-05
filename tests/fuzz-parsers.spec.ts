import { describe, expect, it } from 'vitest'
import { parseDreamProposal, DreamProposalError, type DreamProposalContext } from '../src/memory-dream-proposal.ts'
import {
  parseDreamPanelResponse,
  parseDreamPlanResponse,
  parseDreamRunResponse,
  DreamProtocolError,
} from '../src/protocol.ts'
import { ConsolidationSettingsStore } from '../src/consolidation-settings.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Malformed-input fuzzing for the three parsers that read untrusted data:
 * a model proposal, a browser payload, and a settings file.
 *
 * The contract in every case is the same: reject with a typed error, never throw
 * a TypeError from an unchecked property access, and never accept silently.
 */

const NOW = 1_793_860_469_791

function context(): DreamProposalContext {
  return {
    scopeKey: 'scope-a',
    claims: [{
      name: 'alpha', scopeKey: 'scope-a', kind: 'procedure', volatility: 'stable',
      lifecycle: 'active', importanceClass: 'working', importanceScore: 60,
      text: 'summary', environmentFingerprint: '', evidenceCount: 1,
      lastEvidenceAt: NOW, lastVerifiedAt: null, lastUsedAt: null,
      supersedes: [], sourcePlugins: [],
    }],
    globalSections: ['User Profile'],
    now: NOW,
  }
}

/** Values chosen to break naive property access. */
const HOSTILE: unknown[] = [
  null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '', '   ',
  'null', 'undefined', '[]', '{}', true, false,
  [], [null], [undefined], [[]], [{}, {}, {}],
  {}, { actions: null }, { actions: 'x' }, { actions: {} },
  { actions: [null] }, { actions: [{}] }, { actions: [1] },
  Object.create(null),
  { __proto__: { polluted: true } },
  { actions: [{ action: '__proto__', target: 'alpha' }] },
  { actions: [{ action: 'cool', target: '__proto__' }] },
  { actions: [{ action: 'cool', target: 'alpha', extra: 1 }] },
  { actions: [{ action: 'constructor', target: 'alpha' }] },
]

describe('Fuzz: proposal parser', () => {
  it('rejects every hostile input with a typed error', () => {
    for (const input of HOSTILE) {
      expect(
        () => parseDreamProposal(input, context()),
        `input ${JSON.stringify(input)?.slice(0, 60)}`,
      ).toThrow(DreamProposalError)
    }
  })

  it('never pollutes Object.prototype', () => {
    for (const input of HOSTILE) {
      try { parseDreamProposal(input, context()) } catch { /* expected */ }
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('target')
  })

  it('rejects an oversized action list without hanging', () => {
    const huge = { actions: Array.from({ length: 10_000 }, () => ({ action: 'cool', target: 'alpha' })) }
    const started = Date.now()
    expect(() => parseDreamProposal(huge, context())).toThrow(/too many/u)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('Fuzz: protocol parsers', () => {
  const parsers = [
    ['plan', parseDreamPlanResponse],
    ['run', parseDreamRunResponse],
    ['panel', parseDreamPanelResponse],
  ] as const

  it('rejects every hostile input with a typed error', () => {
    for (const [name, parse] of parsers) {
      for (const input of HOSTILE) {
        expect(() => parse(input), `${name} <- ${JSON.stringify(input)?.slice(0, 40)}`)
          .toThrow(DreamProtocolError)
      }
    }
  })

  it('rejects an unknown format version rather than reading it optimistically', () => {
    // A future version may mean something different by the same field names.
    expect(() => parseDreamRunResponse({
      format: 99, runId: 'r', scopeKey: 's', state: 'committed', risk: 'metadata-only',
      proposalHash: 'h', beforeRevision: 'a', afterRevision: 'b', changes: [], createdAt: 1,
    })).toThrow(DreamProtocolError)
  })

  it('rejects deeply nested junk without a stack overflow', () => {
    let nested: unknown = { actions: [] }
    for (let depth = 0; depth < 500; depth += 1) nested = { actions: nested }
    expect(() => parseDreamPlanResponse(nested)).toThrow(DreamProtocolError)
  })
})

describe('Fuzz: settings reader', () => {
  function withFile(content: string | undefined, check: (store: ConsolidationSettingsStore) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'settings-fuzz-'))
    try {
      if (content !== undefined) writeFileSync(join(dir, 'settings.yml'), content, 'utf8')
      // defaults are constructor-supplied; the store has no zero-arg form.
      check(new ConsolidationSettingsStore(dir, { provider: 'p', model: 'm' }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('falls back instead of throwing on malformed input', () => {
    // Settings are read on every startup; a corrupt file must degrade, not crash.
    for (const content of ['', 'nope', '[]', '{"format":"x"}', '{"format":2}', 'format: 2', ':::not yaml:::']) {
      withFile(content, store => {
        expect(() => store.read()).not.toThrow()
        expect(store.read().dream).toBe('shadow')
      })
    }
  })

  it('ignores an unknown dream mode rather than trusting it', () => {
    const text = ['format: 2', 'provider: p', 'model: m', 'debug: false',
      'dedupe: off', 'candidates: off', 'forgetting: shadow', 'dream: autonomous'].join('\n')
    withFile(text, store => {
      // An unknown value falls back to the safe default: silently treating it as
      // manual would let a typo enable writes.
      expect(store.read().dream).toBe('shadow')
    })
  })

  it('reads a well-formed file without falling back', () => {
    const text = ['format: 2', 'provider: p', 'model: m', 'debug: false',
      'dedupe: off', 'candidates: off', 'forgetting: shadow', 'dream: manual'].join('\n')
    withFile(text, store => {
      expect(store.read().dream).toBe('manual')
    })
  })
})
