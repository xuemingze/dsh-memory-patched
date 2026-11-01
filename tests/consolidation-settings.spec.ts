import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConsolidationSettingsStore,
  readConsolidationModelCatalog,
  resolveConsolidationOutputTokens,
  selectionIsAvailable,
} from '../src/consolidation-settings.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(): { root: string; store: ConsolidationSettingsStore } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-settings-'))
  roots.push(root)
  return { root, store: new ConsolidationSettingsStore(root, { provider: 'default', model: 'cheap' }) }
}

describe('ConsolidationSettingsStore', () => {
  it('persists one CAS-checked model selection without credentials', () => {
    const { store } = setup()
    const initial = store.read()
    expect(initial.selection).toEqual({ provider: 'default', model: 'cheap' })
    expect(initial.debugEnabled).toBe(false)
    const committed = store.commit({
      expectedRevision: initial.revision,
      selection: { provider: 'openai', model: 'gpt-small' },
      debugEnabled: true,
    })
    expect(committed.status).toBe('committed')
    expect(store.read().selection).toEqual({ provider: 'openai', model: 'gpt-small' })
    expect(store.read().debugEnabled).toBe(true)
    expect(readFileSync(store.path, 'utf8')).toBe('format: 2\nprovider: openai\nmodel: gpt-small\ndebug: true\n')
    expect(store.commit({
      expectedRevision: initial.revision,
      selection: { provider: 'other', model: 'other' },
      debugEnabled: false,
    })).toMatchObject({ status: 'conflict' })
  })

  it('falls back to defaults when settings files are malformed and can self-heal on commit', () => {
    const { root, store } = setup()
    const corrupted = 'format: 1\nprovider: ok\nmodel: ok\nsecret: no\n'
    writeFileSync(join(root, 'settings.yml'), corrupted)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const view = store.read()
      expect(view.selection).toEqual({ provider: 'default', model: 'cheap' })
      expect(view.debugEnabled).toBe(false)
      expect(readFileSync(join(root, 'settings.yml'), 'utf8')).toBe(corrupted)
      expect(store.commit({
        expectedRevision: view.revision,
        selection: { provider: 'default', model: 'cheap' },
        debugEnabled: false,
      })).toMatchObject({ status: 'committed' })
      expect(readFileSync(join(root, 'settings.yml'), 'utf8'))
        .toBe('format: 2\nprovider: default\nmodel: cheap\ndebug: false\n')
    } finally {
      warn.mockRestore()
    }
  })

  it('reads format 1 settings with debug logging disabled', () => {
    const { root, store } = setup()
    writeFileSync(join(root, 'settings.yml'), 'format: 1\nprovider: existing\nmodel: cheap\n')
    expect(store.read()).toMatchObject({
      selection: { provider: 'existing', model: 'cheap' },
      debugEnabled: false,
    })
  })

  it('projects active text models and isolates one provider catalog failure', async () => {
    const { store } = setup()
    const catalog = await readConsolidationModelCatalog({
      listProviders: () => [{ id: 'active', name: 'Active' }, { id: 'broken', name: 'Broken' }],
      async listModels(provider) {
        if (provider === 'broken') throw new Error('catalog offline')
        return [
          { provider, id: 'text', name: 'Text', inputModalities: ['text'] },
          { provider, id: 'image', name: 'Image', inputModalities: ['image'] },
        ]
      },
      async resolveModelInfo() { return {} },
    }, store)
    expect(catalog.providers).toEqual([{ id: 'active', name: 'Active', models: [{ id: 'text', name: 'Text' }] }])
    expect(catalog.failures).toEqual([{ provider: 'broken', message: 'catalog offline' }])
    expect(selectionIsAvailable(catalog, { provider: 'active', model: 'text' })).toBe(true)
    expect(selectionIsAvailable(catalog, { provider: 'active', model: 'image' })).toBe(false)
  })

  it('caps the desired output budget at each selected model adapter limit', async () => {
    const calls: unknown[] = []
    const llm = {
      listProviders: () => [],
      async listModels() { return [] },
      async resolveModelInfo(provider: string, model: string, signal?: AbortSignal) {
        calls.push({ provider, model, signal })
        if (model === 'unknown-cap') return {}
        return { defaultMaxTokens: model === 'small' ? 2048 : 16384 }
      },
    }
    const signal = new AbortController().signal
    await expect(resolveConsolidationOutputTokens(
      llm,
      { provider: 'provider-a', model: 'small' },
      8192,
      signal,
    )).resolves.toBe(2048)
    await expect(resolveConsolidationOutputTokens(
      llm,
      { provider: 'provider-a', model: 'large' },
      8192,
      signal,
    )).resolves.toBe(8192)
    await expect(resolveConsolidationOutputTokens(
      llm,
      { provider: 'provider-a', model: 'unknown-cap' },
      8192,
      signal,
    )).resolves.toBe(8192)
    expect(calls).toEqual([
      { provider: 'provider-a', model: 'small', signal },
      { provider: 'provider-a', model: 'large', signal },
      { provider: 'provider-a', model: 'unknown-cap', signal },
    ])
  })

  it('rejects invalid adapter-owned output limits', async () => {
    await expect(resolveConsolidationOutputTokens({
      listProviders: () => [],
      async listModels() { return [] },
      async resolveModelInfo() { return { defaultMaxTokens: 0 } },
    }, { provider: 'provider-a', model: 'broken' }, 8192)).rejects.toThrow(/model output-token limit/)
  })
})
