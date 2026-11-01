import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MarkdownMemoryStore,
  MemoryConflictError,
  MemoryValidationError,
} from '../src/memory-store.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function store(): MarkdownMemoryStore {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  roots.push(root)
  return new MarkdownMemoryStore(new Context(), root)
}

describe('MarkdownMemoryStore', () => {
  it.each(['global', 'workspace'])('rejects one competing %s write within the same Store', async (kind) => {
    const memory = store()
    memory.initialize()
    const scope = memory.scopeForCwd('/work/concurrent')
    const revision = kind === 'global'
      ? (await memory.readGlobal()).revision
      : (await memory.readWorkspace(scope)).revision
    const outcomes = await Promise.allSettled(['first', 'second'].map(name => kind === 'global'
      ? memory.commitGlobal({ expectedRevision: revision, content: name })
      : memory.commitWorkspace({ scope, expectedRevision: revision, changes: [{ action: 'put', record: {
        name, description: name, type: 'project', content: name,
      } }] })))
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find(result => result.status === 'rejected')
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(MemoryConflictError)
    if (kind === 'global') expect((await memory.readGlobal()).content).toBe('first\n')
    else expect((await memory.readWorkspace(scope)).records.map(record => record.name)).toEqual(['first'])
  })

  it.each(['memory', 'MEMORY', 'Memory'])('rejects reserved index name %s without changing a generation', async (name) => {
    const memory = store()
    memory.initialize()
    const scope = memory.scopeForCwd('/work/reserved')
    await memory.commitWorkspace({ scope, expectedRevision: (await memory.readWorkspace(scope)).revision,
      changes: [{ action: 'put', record: { name: 'existing-note', description: 'Keep this.', type: 'project', content: 'Original.' } }],
    })
    const before = await memory.readWorkspace(scope)
    await expect(memory.commitWorkspace({ scope, expectedRevision: before.revision,
      changes: [
        { action: 'delete', name: 'existing-note' },
        { action: 'put', record: { name, description: 'Invalid.', type: 'project', content: 'Must not publish.' } },
      ],
    })).rejects.toThrow(/reserved/)
    expect(await memory.readWorkspace(scope)).toEqual(before)
    expect(readFileSync(join(scope.directory, 'MEMORY.md'), 'utf8')).toBe(before.index)
  })

  it('initializes and revision-checks GLOBAL.md', async () => {
    const memory = store()
    memory.initialize()
    const initial = await memory.readGlobal()
    expect(initial.content).toContain('# Global Memory')

    const committed = await memory.commitGlobal({
      expectedRevision: initial.revision,
      content: '# Global Memory\n\n- Prefer Chinese.\n\n',
    })
    expect(committed.revision).not.toBe(initial.revision)
    expect((await memory.readGlobal()).content).toBe('# Global Memory\n\n- Prefer Chinese.\n')

    await expect(memory.commitGlobal({
      expectedRevision: initial.revision,
      content: '# stale\n',
    })).rejects.toBeInstanceOf(MemoryConflictError)
  })

  it('publishes validated Workspace records with a generated index', async () => {
    const memory = store()
    memory.initialize()
    const scope = memory.scopeForCwd('/work/example')
    const empty = await memory.readWorkspace(scope)

    const committed = await memory.commitWorkspace({
      scope,
      expectedRevision: empty.revision,
      changes: [{
        action: 'put',
        record: {
          name: 'review-before-publish',
          description: 'Run focused checks before publishing.',
          type: 'feedback',
          content: 'Run the smallest relevant checks before publishing.\n\n**Why:** Avoid preventable regressions.\n\n**How to apply:** Select checks from the changed surface.\n',
        },
      }],
    })
    const view = await memory.readWorkspace(scope)
    expect(view.revision).toBe(committed.revision)
    expect(view.records).toHaveLength(1)
    expect(view.index).toContain('[review-before-publish](review-before-publish.md)')
    expect(readFileSync(join(scope.directory, 'MEMORY.md'), 'utf8')).toBe(view.index)
    expect(readFileSync(join(scope.directory, 'review-before-publish.md'), 'utf8')).toContain('type: feedback')
  })

  it('isolates one unreadable record file instead of failing the whole Workspace', async () => {
    const memory = store()
    memory.initialize()
    const scope = memory.scopeForCwd('/work/tolerant')
    const empty = await memory.readWorkspace(scope)
    await memory.commitWorkspace({
      scope,
      expectedRevision: empty.revision,
      changes: [{ action: 'put', record: {
        name: 'healthy-record',
        description: 'Survives a broken sibling file.',
        type: 'project',
        content: 'Keep reading the rest of the directory.\n',
      } }],
    })
    writeFileSync(join(scope.directory, 'broken-record.md'), 'not frontmatter at all\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const view = await memory.readWorkspace(scope)
      expect(view.records).toMatchObject([{ name: 'healthy-record' }])
      expect(view.index).toContain('[healthy-record](healthy-record.md)')
      expect(view.index).not.toContain('broken-record')
    } finally {
      warn.mockRestore()
    }
  })

  it('parses hand-edited CRLF record files', async () => {
    const memory = store()
    memory.initialize()
    const scope = memory.scopeForCwd('/work/crlf')
    mkdirSync(scope.directory, { recursive: true })
    writeFileSync(join(scope.directory, 'crlf-record.md'), [
      '---',
      'name: crlf-record',
      'description: Written by a CRLF editor.',
      'metadata:',
      '  type: project',
      '---',
      '',
      'CRLF body.',
      '',
    ].join('\r\n'))
    expect(await memory.readWorkspace(scope)).toMatchObject({
      records: [{ name: 'crlf-record', type: 'project', content: 'CRLF body.\n' }],
    })
  })

  it('discovers Workspaces through opaque ids without exposing Host paths', async () => {
    const memory = store()
    memory.initialize()
    const scopes = [memory.scopeForCwd('/work/zeta-project'), memory.scopeForCwd('/work/alpha-project')]
    for (const [index, scope] of scopes.entries()) {
      const empty = await memory.readWorkspace(scope)
      await memory.commitWorkspace({
        scope,
        expectedRevision: empty.revision,
        changes: [{ action: 'put', record: {
          name: `project-note-${index}`,
          description: `Project note ${index}.`,
          type: 'project',
          content: `Workspace ${index}.\n`,
        } }],
      })
    }

    const catalog = memory.listWorkspaces()
    expect(catalog.workspaces.map(entry => entry.displayName)).toEqual(['alpha-project', 'zeta-project'])
    expect(catalog.workspaces.every(entry => /^workspace:[a-f0-9]{64}$/u.test(entry.workspaceId))).toBe(true)
    expect(JSON.stringify(catalog)).not.toContain(scopes[0]!.key)
    expect(JSON.stringify(catalog)).not.toContain(scopes[0]!.directory)

    const selected = catalog.workspaces[0]!
    const view = memory.readWorkspaceById(selected.workspaceId)
    expect(view).toMatchObject({
      workspaceId: selected.workspaceId,
      displayName: 'alpha-project',
      recordCount: 1,
      records: [{ name: 'project-note-1', type: 'project' }],
    })
    expect(JSON.stringify(view)).not.toContain(scopes[1]!.directory)
    expect(memory.readWorkspaceById(`workspace:${'f'.repeat(64)}` as typeof selected.workspaceId)).toBeUndefined()
  })

  it('commits one canonical Workspace batch through an opaque id', async () => {
    const memory = store()
    memory.initialize()
    const scope = memory.scopeForCwd('/work/browser-edit')
    const empty = await memory.readWorkspace(scope)
    await memory.commitWorkspace({
      scope,
      expectedRevision: empty.revision,
      changes: [{ action: 'put', record: {
        name: 'old-record',
        description: 'Will be replaced.',
        type: 'project',
        content: 'Old.\n',
      } }],
    })
    const summary = memory.listWorkspaces().workspaces[0]!
    const before = memory.readWorkspaceById(summary.workspaceId)!
    const committed = await memory.commitWorkspaceById({
      workspaceId: summary.workspaceId,
      expectedRevision: before.revision,
      changes: [
        { action: 'delete', name: 'old-record' },
        { action: 'put', record: {
          name: 'new-record',
          description: 'Created in the same generation.',
          type: 'feedback',
          content: 'New.\n',
        } },
      ],
    })
    expect(committed?.revision).not.toBe(before.revision)
    expect(memory.readWorkspaceById(summary.workspaceId)?.records).toEqual([{
      name: 'new-record',
      description: 'Created in the same generation.',
      type: 'feedback',
      content: 'New.\n',
    }])

    await expect(memory.commitWorkspaceById({
      workspaceId: summary.workspaceId,
      expectedRevision: before.revision,
      changes: [{ action: 'put', record: {
        name: 'stale-record',
        description: 'Must conflict.',
        type: 'project',
        content: 'Stale.\n',
      } }],
    })).rejects.toBeInstanceOf(MemoryConflictError)

    const stable = memory.readWorkspaceById(summary.workspaceId)!
    await expect(memory.commitWorkspaceById({
      workspaceId: summary.workspaceId,
      expectedRevision: stable.revision,
      changes: [
        { action: 'put', record: {
          name: 'out-of-order',
          description: 'Must not publish.',
          type: 'project',
          content: 'Invalid batch.\n',
        } },
        { action: 'delete', name: 'new-record' },
      ],
    })).rejects.toBeInstanceOf(MemoryValidationError)
    expect(memory.readWorkspaceById(summary.workspaceId)?.revision).toBe(stable.revision)
  })

  it('deletes a record as one revision-checked Workspace generation', async () => {
    const memory = store()
    memory.initialize()
    const scope = memory.scopeForCwd('/work/delete')
    const empty = await memory.readWorkspace(scope)
    const created = await memory.commitWorkspace({
      scope,
      expectedRevision: empty.revision,
      changes: [{ action: 'put', record: {
        name: 'temporary-reference',
        description: 'A reference that will be removed.',
        type: 'reference',
        content: 'https://example.com\n',
      } }],
    })
    const deleted = await memory.commitWorkspace({
      scope,
      expectedRevision: created.revision,
      changes: [{ action: 'delete', name: 'temporary-reference' }],
    })
    expect(deleted.operation).toBe('delete')
    expect((await memory.readWorkspace(scope)).records).toEqual([])
  })

  it('rejects unsafe record names before writing', async () => {
    const memory = store()
    memory.initialize()
    const scope = memory.scopeForCwd('/work/reject')
    const empty = await memory.readWorkspace(scope)
    await expect(memory.commitWorkspace({
      scope,
      expectedRevision: empty.revision,
      changes: [{ action: 'put', record: {
        name: '../escape',
        description: 'Must not leave the Workspace directory.',
        type: 'project',
        content: 'unsafe\n',
      } }],
    })).rejects.toBeInstanceOf(MemoryValidationError)
  })

  it('resolves only canonical receipt-owned Workspace keys', () => {
    const memory = store()
    const scope = memory.scopeForCwd('/work/recovery-target')
    expect(memory.workspaceTargetForKey(scope.key)).toEqual({
      key: scope.key,
      directory: scope.directory,
    })
    expect(() => memory.workspaceTargetForKey('../escape')).toThrow(MemoryValidationError)
    expect(() => memory.workspaceTargetForKey('not-a-workspace-key')).toThrow(MemoryValidationError)
  })

  it('keeps a non-ASCII Workspace slug readable', () => {
    const memory = store()
    const cwd = join(tmpdir(), '闲聊及灵感')
    const scope = memory.scopeForCwd(cwd)
    expect(scope.key).toMatch(/^闲聊及灵感-[a-f0-9]{16}$/u)
    expect(memory.workspaceDisplayNameForCwd(cwd)).toBe('闲聊及灵感')
    expect(memory.workspaceReferenceForCwd(cwd).displayName).toBe('闲聊及灵感')
    expect(memory.workspaceTargetForKey(scope.key)).toEqual({
      key: scope.key,
      directory: scope.directory,
    })
  })

  it('keeps an ASCII Workspace slug unchanged and still accepts a legacy key', () => {
    const memory = store()
    const cwd = join(tmpdir(), 'my-project')
    expect(memory.scopeForCwd(cwd).key).toMatch(/^my-project-[a-f0-9]{16}$/u)
    expect(memory.workspaceDisplayNameForCwd(cwd)).toBe('my-project')
    expect(() => memory.workspaceTargetForKey('workspace-0df2b2b7c62357a9')).not.toThrow()
  })

  it('renders only Global memory when a Session has no cwd', () => {
    const memory = store()
    memory.initialize()
    expect(memory.renderContext()).toContain('### Global Memory')
    expect(memory.renderContext()).not.toContain('### Current Workspace Memory Index')
    expect(memory.renderContext()).not.toContain('Revision:')
    expect(memory.renderContext()).not.toContain('sha256:')
  })
})
