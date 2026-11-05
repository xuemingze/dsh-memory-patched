import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { filterIndexByVisibility, type MemoryVisibilityPolicy } from '../src/memory-visibility.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function store(): MarkdownMemoryStore {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-visibility-'))
  roots.push(root)
  const value = new MarkdownMemoryStore(new Context(), join(root, 'memory'))
  value.initialize()
  return value
}

const INDEX = [
  '- [active-record](active-record.md) — still current',
  '- [cooled-record](cooled-record.md) — lowered but readable',
  '- [archived-record](archived-record.md) — hidden from prompt',
  '- [superseded-record](superseded-record.md) — replaced by a newer one',
].join('\n')

describe('filterIndexByVisibility', () => {
  it('passes everything through when no policy is supplied', () => {
    expect(filterIndexByVisibility(INDEX, undefined)).toBe(INDEX)
  })

  it('passes everything through when governance data is unavailable', () => {
    // Losing the sidecar may cost ranking quality; it must never hide a memory.
    const policy: MemoryVisibilityPolicy = { degraded: true, lifecycleOf: () => 'archived' }
    expect(filterIndexByVisibility(INDEX, policy)).toBe(INDEX)
  })

  it('keeps active and cooled records visible', () => {
    const policy: MemoryVisibilityPolicy = {
      degraded: false,
      lifecycleOf: name => name === 'cooled-record' ? 'cooled' : 'active',
    }
    const filtered = filterIndexByVisibility(INDEX, policy)
    expect(filtered).toContain('active-record')
    expect(filtered).toContain('cooled-record')
  })

  it('hides archived records', () => {
    const policy: MemoryVisibilityPolicy = {
      degraded: false,
      lifecycleOf: name => name === 'archived-record' ? 'archived' : 'active',
    }
    expect(filterIndexByVisibility(INDEX, policy)).not.toContain('archived-record')
  })

  it('hides superseded records', () => {
    const policy: MemoryVisibilityPolicy = {
      degraded: false,
      lifecycleOf: name => name === 'superseded-record' ? 'superseded' : 'active',
    }
    expect(filterIndexByVisibility(INDEX, policy)).not.toContain('superseded-record')
  })

  it('leaves lines it cannot attribute untouched', () => {
    const policy: MemoryVisibilityPolicy = { degraded: false, lifecycleOf: () => 'archived' }
    const filtered = filterIndexByVisibility('# Header\n\nnot an index line\n', policy)
    // Only real index entries are filtered: headers and prose survive.
    expect(filtered).toContain('# Header')
    expect(filtered).toContain('not an index line')
  })

  it('returns an empty string when every record is hidden', () => {
    const policy: MemoryVisibilityPolicy = { degraded: false, lifecycleOf: () => 'archived' }
    expect(filterIndexByVisibility(INDEX, policy).trim()).toBe('')
  })

  it('does not add or reorder visible entries', () => {
    const policy: MemoryVisibilityPolicy = {
      degraded: false,
      lifecycleOf: name => name === 'cooled-record' ? 'archived' : 'active',
    }
    expect(filterIndexByVisibility(INDEX, policy).split('\n')).toEqual([
      '- [active-record](active-record.md) — still current',
      '- [archived-record](archived-record.md) — hidden from prompt',
      '- [superseded-record](superseded-record.md) — replaced by a newer one',
    ])
  })
})

describe('prompt assembly with a visibility policy', () => {
  it('keeps the on-disk index complete while filtering the prompt', async () => {
    const memory = store()
    const scope = memory.scopeForCwd(process.cwd())
    const view = await memory.readWorkspace(scope)
    await memory.commitWorkspace({
      scope,
      expectedRevision: view.revision,
      changes: [
        { action: 'put', record: { name: 'archived-record', description: 'old', type: 'project', content: 'old body' } },
        { action: 'put', record: { name: 'live-record', description: 'new', type: 'project', content: 'new body' } },
      ],
    })

    const policy: MemoryVisibilityPolicy = {
      degraded: false,
      lifecycleOf: name => name === 'archived-record' ? 'archived' : 'active',
    }

    const filtered = memory.renderContextSnapshot(process.cwd(), policy).text
    expect(filtered).toContain('live-record')
    expect(filtered).not.toContain('archived-record')

    // The Markdown itself is untouched: the Settings page can still read it.
    const unfiltered = memory.renderContextSnapshot(process.cwd()).text
    expect(unfiltered).toContain('archived-record')
  })
})
