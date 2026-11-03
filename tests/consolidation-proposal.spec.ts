import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConsolidationProposalError,
  parseConsolidationProposal,
} from '../src/consolidation-proposal.ts'
import { MarkdownMemoryStore, type WorkspaceMemoryView } from '../src/memory-store.ts'

const roots: string[] = []
const evidence = [
  { fromSeq: 0, toSeq: 0, user: ['first'], summaries: [], assistantFinal: null, tools: [] },
  { fromSeq: 1, toSeq: 1, user: ['second'], summaries: [], assistantFinal: null, tools: [] },
  { fromSeq: 2, toSeq: 3, user: ['third'], summaries: [], assistantFinal: null, tools: [] },
]

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function workspace(): Promise<{
  store: MarkdownMemoryStore
  scope: ReturnType<MarkdownMemoryStore['scopeForCwd']>
  view: WorkspaceMemoryView
}> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-proposal-'))
  roots.push(root)
  const store = new MarkdownMemoryStore(new Context(), join(root, 'memory'))
  store.initialize()
  const scope = store.scopeForCwd('/work/proposal')
  const empty = await store.readWorkspace(scope)
  await store.commitWorkspace({
    scope,
    expectedRevision: empty.revision,
    changes: [
      { action: 'put', record: {
        name: 'obsolete-rule',
        description: 'An obsolete project rule.',
        type: 'project',
        content: 'Old rule.\n',
      } },
      { action: 'put', record: {
        name: 'stable-rule',
        description: 'A stable project rule.',
        type: 'feedback',
        content: 'Keep this.\n',
      } },
    ],
  })
  return { store, scope, view: await store.readWorkspace(scope) }
}

describe('consolidation proposal planning', () => {
  it('previews a Global replacement alongside Workspace changes', async () => {
    const target = await workspace()
    const global = await target.store.readGlobal()
    const planned = parseConsolidationProposal({
      outcome: 'changes',
      changes: [{
        action: 'replace-global',
        content: `${global.content}\n- Prefer concise answers.`,
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    }, { sourceEvidence: evidence, global, workspace: target.view })

    expect(planned.globalPreview).toMatchObject({ changed: true, content: expect.stringContaining('Prefer concise answers') })
    expect(planned.preview).toMatchObject({ changed: false, revision: target.view.revision })
  })

  it('closes the schema, canonicalizes changes, and previews the committed revision', async () => {
    const target = await workspace()
    const planned = parseConsolidationProposal({
      outcome: 'changes',
      changes: [
        {
          action: 'put',
          record: {
            name: 'new-guidance',
            description: 'New durable guidance.',
            type: 'feedback',
            content: 'Prefer the narrow verification path.',
          },
          evidence: [{ fromSeq: 2, toSeq: 3 }, { fromSeq: 0, toSeq: 0 }],
        },
        {
          action: 'delete',
          name: 'obsolete-rule',
          evidence: [{ fromSeq: 1, toSeq: 1 }],
        },
      ],
    }, { sourceEvidence: evidence, global: await target.store.readGlobal(), workspace: target.view })

    expect(planned.proposal).toEqual({
      outcome: 'changes',
      changes: [
        {
          action: 'delete',
          name: 'obsolete-rule',
          evidence: [{ fromSeq: 1, toSeq: 1 }],
        },
        {
          action: 'put',
          record: {
            name: 'new-guidance',
            description: 'New durable guidance.',
            type: 'feedback',
            content: 'Prefer the narrow verification path.',
          },
          evidence: [{ fromSeq: 0, toSeq: 0 }, { fromSeq: 2, toSeq: 3 }],
        },
      ],
    })
    expect(planned.preview).toMatchObject({
      changed: true,
      revision: expect.stringMatching(/^sha256:/u),
      records: [{ name: 'new-guidance' }, { name: 'stable-rule' }],
    })

    if (planned.proposal.outcome !== 'changes') throw new Error('expected changes')
    const committed = await target.store.commitWorkspace({
      scope: target.scope,
      expectedRevision: target.view.revision,
      changes: planned.proposal.changes.filter(change => change.action !== 'replace-global').map(change => change.action === 'put'
        ? { action: 'put', record: change.record }
        : { action: 'delete', name: change.name }),
    })
    expect(committed.revision).toBe(planned.preview.revision)
    expect((await target.store.readWorkspace(target.scope)).records).toEqual(planned.preview.records)
  })

  it('normalizes a semantically identical put to no-change without changing revision', async () => {
    const target = await workspace()
    const stable = target.view.records.find(record => record.name === 'stable-rule')!
    const planned = parseConsolidationProposal({
      outcome: 'changes',
      changes: [{
        action: 'put',
        record: { ...stable, content: stable.content.trimEnd() },
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    }, { sourceEvidence: evidence, global: await target.store.readGlobal(), workspace: target.view })

    expect(planned.proposal).toEqual({ outcome: 'no-change', changes: [] })
    expect(planned.preview).toMatchObject({ changed: false, revision: target.view.revision })
  })

  it('accepts an explicit no-change for an empty source without invoking change validation', async () => {
    const target = await workspace()
    expect(parseConsolidationProposal(
      { outcome: 'no-change', changes: [] },
      { sourceEvidence: [], global: await target.store.readGlobal(), workspace: target.view },
    )).toMatchObject({
      proposal: { outcome: 'no-change', changes: [] },
      preview: { changed: false, revision: target.view.revision },
    })
  })

  it.each([
    ['unknown proposal field', { outcome: 'no-change', changes: [], revision: 'sha256:unsafe' }, /exactly/],
    ['changes attached to no-change', { outcome: 'no-change', changes: [{}] }, /must be empty/],
    ['empty changes outcome', { outcome: 'changes', changes: [] }, /non-empty/],
    ['unknown change field', {
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'obsolete-rule', evidence: [{ fromSeq: 0, toSeq: 0 }], path: '/tmp' }],
    }, /exactly/],
    ['missing evidence', {
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'obsolete-rule', evidence: [] }],
    }, /non-empty/],
    ['reversed evidence', {
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'obsolete-rule', evidence: [{ fromSeq: 2, toSeq: 1 }] }],
    }, /must not exceed/],
    ['unsupplied evidence range', {
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'obsolete-rule', evidence: [{ fromSeq: 0, toSeq: 4 }] }],
    }, /supplied evidence turn/],
    ['invalid record', {
      outcome: 'changes',
      changes: [{
        action: 'put',
        record: { name: '../escape', description: 'Unsafe.', type: 'project', content: 'Unsafe.' },
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    }, /kebab-case/],
    ['missing delete target', {
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'missing-rule', evidence: [{ fromSeq: 0, toSeq: 0 }] }],
    }, /does not exist/],
    ['same-name put and delete', {
      outcome: 'changes',
      changes: [
        { action: 'delete', name: 'stable-rule', evidence: [{ fromSeq: 0, toSeq: 0 }] },
        {
          action: 'put',
          record: { name: 'stable-rule', description: 'Replacement.', type: 'project', content: 'Replacement.' },
          evidence: [{ fromSeq: 1, toSeq: 1 }],
        },
      ],
    }, /more than one change/],
  ])('rejects %s', async (_name, value, pattern) => {
    const target = await workspace()
    const global = await target.store.readGlobal()
    expect(() => parseConsolidationProposal(value, {
      sourceEvidence: evidence,
      global,
      workspace: target.view,
    }))
      .toThrow(pattern as RegExp)
  })

  it('rejects malformed evidence ranges separately from model proposal validation', async () => {
    const target = await workspace()
    const global = await target.store.readGlobal()
    expect(() => parseConsolidationProposal({
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'obsolete-rule', evidence: [{ fromSeq: 0, toSeq: 0 }] }],
    }, {
      sourceEvidence: [evidence[1]!, evidence[0]!],
      global,
      workspace: target.view,
    })).toThrow(TypeError)
    expect(() => parseConsolidationProposal({
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'obsolete-rule', evidence: [{ fromSeq: 0, toSeq: 0 }] }],
    }, {
      sourceEvidence: [evidence[1]!, evidence[0]!],
      global,
      workspace: target.view,
    })).not.toThrow(ConsolidationProposalError)
  })
})

describe('consolidation proposal dedupe', () => {
  const fullContent = 'dsh-ops 插件从 npm 华为云源重装 0.4.4，runtime 三件齐，受限沙箱可用。安装命令与验证步骤都已记录，bash 执行器路径覆盖已配置，回退只需删除 bashPath。'

  async function dedupeWorkspace() {
    const target = await workspace()
    await target.store.commitWorkspace({
      scope: target.scope,
      expectedRevision: target.view.revision,
      changes: [
        { action: 'put', record: { name: 'dsh-ops-reinstall', description: 'dsh-ops 插件重装记录，安装命令与验证步骤。', type: 'project', content: fullContent } },
        { action: 'put', record: { name: 'free-model-plugin', description: '免费模型插件安装记录。', type: 'project', content: 'dsh-our-free-model 免费模型插件，npm 作用域名与裸包名互斥，用 alias 装法修好，客户端重复注册会启动失败。' } },
      ],
    })
    return { ...target, view: await target.store.readWorkspace(target.scope) }
  }

  async function signpostWorkspace() {
    const target = await workspace()
    await target.store.commitWorkspace({
      scope: target.scope,
      expectedRevision: target.view.revision,
      changes: [
        { action: 'put', record: { name: 'dsh-ops-reinstall', description: 'dsh-ops 插件重装记录。', type: 'project', content: 'dsh-ops 插件重装记录，详见 memory/dsh-ops-removal.md。记录日期 2026-11-03。' } },
      ],
    })
    return { ...target, view: await target.store.readWorkspace(target.scope) }
  }

  it('merges a same-topic put into the existing record name and emits merged-put', async () => {
    const target = await dedupeWorkspace()
    const planned = parseConsolidationProposal({
      outcome: 'changes',
      changes: [{
        action: 'put',
        record: {
          name: 'dsh-ops-reinstall-note',
          description: 'dsh-ops 重装记录跟进。',
          type: 'project',
          content: 'dsh-ops 插件重装完成，安装命令与验证步骤已复核',
        },
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    }, { sourceEvidence: evidence, global: await target.store.readGlobal(), workspace: target.view })

    const puts = planned.proposal.changes.filter(change => change.action === 'put')
    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({ record: { name: 'dsh-ops-reinstall' } })
    expect((puts[0] as { record: { content: string } }).record.content).toContain('已复核')
    expect(planned.dedupe).toEqual([
      { kind: 'merged-put', kept: 'dsh-ops-reinstall', absorbed: 'dsh-ops-reinstall-note', intersection: expect.any(Number) },
    ])
    const merged = planned.preview.records.find(record => record.name === 'dsh-ops-reinstall')
    expect(merged?.content).toContain('已复核')
    expect(planned.preview.records.filter(record => record.name.includes('dsh-ops'))).toHaveLength(1)
  })

  it('folds an exact-duplicate put without doubling the record content', async () => {
    const target = await dedupeWorkspace()
    const planned = parseConsolidationProposal({
      outcome: 'changes',
      changes: [
        {
          action: 'put',
          record: {
            name: 'dsh-ops-reinstall-note',
            description: 'dsh-ops 插件重装记录。',
            type: 'project',
            content: 'dsh-ops 插件从 npm 华为云源重装 0.4.4，runtime 三件齐，受限沙箱可用。安装命令与验证步骤都已记录，bash 执行器路径覆盖已配置，回退只需删除 bashPath。',
          },
          evidence: [{ fromSeq: 0, toSeq: 0 }],
        },
        {
          action: 'put',
          record: {
            name: 'niu-bash-executor',
            description: 'bash 执行器切换记录。',
            type: 'project',
            content: 'dsh-ops 的 bash 执行器换成 niu.exe，受限模式只认 pinned MSYS',
          },
          evidence: [{ fromSeq: 0, toSeq: 0 }],
        },
      ],
    }, { sourceEvidence: evidence, global: await target.store.readGlobal(), workspace: target.view })

    expect(planned.proposal.outcome).toBe('changes')
    const reinstall = planned.preview.records.find(record => record.name === 'dsh-ops-reinstall')
    expect(reinstall?.content).toBe('dsh-ops 插件从 npm 华为云源重装 0.4.4，runtime 三件齐，受限沙箱可用。安装命令与验证步骤都已记录，bash 执行器路径覆盖已配置，回退只需删除 bashPath。\n')
    expect(reinstall?.content).not.toContain('\n\n')
    expect(planned.dedupe?.some(event => event.kind === 'merged-put')).toBe(true)
  })

  it('collapses a lone exact-duplicate put into a no-change plan', async () => {
    const target = await dedupeWorkspace()
    const planned = parseConsolidationProposal({
      outcome: 'changes',
      changes: [{
        action: 'put',
        record: {
          name: 'dsh-ops-reinstall-note',
          description: 'dsh-ops 插件重装记录。',
          type: 'project',
          content: 'dsh-ops 插件从 npm 华为云源重装 0.4.4，runtime 三件齐，受限沙箱可用。安装命令与验证步骤都已记录，bash 执行器路径覆盖已配置，回退只需删除 bashPath。',
        },
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    }, { sourceEvidence: evidence, global: await target.store.readGlobal(), workspace: target.view })
    expect(planned.proposal.outcome).toBe('no-change')
    expect(planned.preview.changed).toBe(false)
  })

  it('leaves sibling records and plain updates untouched', async () => {
    const target = await dedupeWorkspace()
    const planned = parseConsolidationProposal({
      outcome: 'changes',
      changes: [{
        action: 'put',
        record: {
          name: 'niu-bash-executor',
          description: 'bash 执行器切换记录。',
          type: 'project',
          content: 'dsh-ops 的 bash 执行器换成 niu.exe，受限模式只认 pinned MSYS',
        },
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    }, { sourceEvidence: evidence, global: await target.store.readGlobal(), workspace: target.view })
    expect(planned.proposal.changes[0]).toMatchObject({ action: 'put', record: { name: 'niu-bash-executor' } })
    expect(planned.dedupe).toBeUndefined()

    const update = parseConsolidationProposal({
      outcome: 'changes',
      changes: [{
        action: 'put',
        record: { name: 'dsh-ops-reinstall', description: '更新。', type: 'project', content: '同名更新内容' },
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    }, { sourceEvidence: evidence, global: await target.store.readGlobal(), workspace: target.view })
    expect(update.proposal.changes[0]).toMatchObject({ action: 'put', record: { name: 'dsh-ops-reinstall' } })
    expect(update.dedupe).toBeUndefined()
  })

  it('strips signpost sections from a Global replacement', async () => {
    const target = await dedupeWorkspace()
    const content = [
      '# Global Memory',
      '',
      '## User Preferences',
      '- Prefer concise answers.',
      '',
      '## dsh-ops 重装记录',
      fullContent,
      '',
      '## dsh-ops 索引',
      'dsh-ops 插件重装记录，详见 memory/dsh-ops-removal.md。记录日期 2026-11-03。',
      '',
    ].join('\n')
    const planned = parseConsolidationProposal({
      outcome: 'changes',
      changes: [{ action: 'replace-global', content, evidence: [{ fromSeq: 0, toSeq: 0 }] }],
    }, { sourceEvidence: evidence, global: await target.store.readGlobal(), workspace: target.view })

    expect(planned.globalPreview.content).toContain('## dsh-ops 重装记录')
    expect(planned.globalPreview.content).toContain('## User Preferences')
    expect(planned.globalPreview.content).not.toContain('## dsh-ops 索引')
    expect(planned.dedupe).toEqual([
      { kind: 'dropped-signpost-section', heading: 'dsh-ops 索引' },
    ])
  })

  it('honors dedupe off mode', async () => {
    const target = await dedupeWorkspace()
    const planned = parseConsolidationProposal({
      outcome: 'changes',
      changes: [{
        action: 'put',
        record: {
          name: 'dsh-ops-reinstall-note',
          description: 'dsh-ops 重装记录跟进。',
          type: 'project',
          content: 'dsh-ops 插件重装完成，安装命令与验证步骤已复核',
        },
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    }, { sourceEvidence: evidence, global: await target.store.readGlobal(), workspace: target.view, dedupe: 'off' })
    expect(planned.proposal.changes[0]).toMatchObject({ action: 'put', record: { name: 'dsh-ops-reinstall-note' } })
    expect(planned.dedupe).toBeUndefined()
  })

  it('merge-delete lets the fuller new record win with a synthesized delete', async () => {
    const target = await signpostWorkspace()
    const changes = [{
      action: 'put' as const,
      record: {
        name: 'dsh-ops-reinstall-full',
        description: 'dsh-ops 插件重装完整记录。',
        type: 'project' as const,
        content: fullContent,
      },
      evidence: [{ fromSeq: 0, toSeq: 0 }],
    }]
    const aggressive = parseConsolidationProposal({ outcome: 'changes', changes }, {
      sourceEvidence: evidence,
      global: await target.store.readGlobal(),
      workspace: target.view,
      dedupe: 'merge-delete',
    })
    expect(aggressive.proposal.changes.map(change => change.action)).toEqual(['delete', 'put'])
    expect(aggressive.proposal.changes).toContainEqual(expect.objectContaining({ action: 'delete', name: 'dsh-ops-reinstall' }))
    expect(aggressive.proposal.changes).toContainEqual(expect.objectContaining({ action: 'put', record: expect.objectContaining({ name: 'dsh-ops-reinstall-full' }) }))
    expect(aggressive.dedupe?.[0]).toMatchObject({ kind: 'merged-put', kept: 'dsh-ops-reinstall-full', absorbed: 'dsh-ops-reinstall' })

    const conservative = parseConsolidationProposal({ outcome: 'changes', changes }, {
      sourceEvidence: evidence,
      global: await target.store.readGlobal(),
      workspace: target.view,
    })
    const conservativePuts = conservative.proposal.changes.filter(change => change.action === 'put')
    expect(conservativePuts).toHaveLength(1)
    expect(conservativePuts[0]).toMatchObject({ record: { name: 'dsh-ops-reinstall' } })
  })
})
