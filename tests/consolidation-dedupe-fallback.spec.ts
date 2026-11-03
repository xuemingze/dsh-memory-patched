import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/consolidation-dedupe.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/consolidation-dedupe.ts')>()
  return { ...actual, isSameTopic: () => { throw new Error('boom') } }
})

import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConsolidationProposal } from '../src/consolidation-proposal.ts'
import { MarkdownMemoryStore } from '../src/memory-store.ts'

const roots: string[] = []
const evidence = [{ fromSeq: 0, toSeq: 0, time: 0, user: ['first'], summaries: [], assistantFinal: null, tools: [] }]

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('dedupe failure fallback', () => {
  it('falls back to the original proposal when dedupe throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-memory-dedupe-fallback-'))
    roots.push(root)
    const store = new MarkdownMemoryStore(new Context(), join(root, 'memory'))
    store.initialize()
    const scope = store.scopeForCwd('/work/fallback')
    const empty = await store.readWorkspace(scope)
    await store.commitWorkspace({
      scope,
      expectedRevision: empty.revision,
      changes: [{ action: 'put', record: { name: 'dsh-ops-reinstall', description: 'dsh-ops 插件重装记录，安装命令与验证步骤。', type: 'project', content: 'dsh-ops 插件重装完成，安装命令与验证步骤已复核' } }],
    })
    const view = await store.readWorkspace(scope)

    const planned = parseConsolidationProposal({
      outcome: 'changes',
      changes: [{
        action: 'put',
        record: { name: 'dsh-ops-reinstall-note', description: '跟进。', type: 'project', content: 'dsh-ops 插件重装完成，安装命令与验证步骤已复核' },
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    }, { sourceEvidence: evidence, global: await store.readGlobal(), workspace: view })

    expect(planned.proposal.changes[0]).toMatchObject({ action: 'put', record: { name: 'dsh-ops-reinstall-note' } })
    expect(planned.dedupe).toEqual([{ kind: 'dedupe-failed', error: expect.stringContaining('boom') }])
  })
})
