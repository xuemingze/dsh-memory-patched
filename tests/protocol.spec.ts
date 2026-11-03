import { describe, expect, it } from 'vitest'
import {
  parseEmptyPayload,
  parseGlobalMemoryView,
  parseGlobalReplacePayload,
  parseGlobalReplaceResponse,
  parseMemoryStatus,
  parseSessionListResponse,
  parseSessionConsolidatePayload,
  parseSessionConsolidateResponse,
  parseConsolidationModelCatalogResponse,
  parseConsolidationModelSelectPayload,
  parseConsolidationModelSelectResponse,
  parseWorkspaceCommitPayload,
  parseWorkspaceCommitResponse,
  parseWorkspaceListResponse,
  parseWorkspaceReadPayload,
  parseWorkspaceReadResponse,
} from '../src/protocol.ts'

const WORKSPACE_ID = `workspace:${'a'.repeat(64)}`

describe('Memory RPC protocol', () => {
  it('accepts closed valid values', () => {
    expect(parseEmptyPayload({})).toEqual({})
    expect(parseGlobalReplacePayload({ expectedRevision: 'sha256:abc', content: '# Memory\n' })).toEqual({
      expectedRevision: 'sha256:abc',
      content: '# Memory\n',
    })
    expect(parseMemoryStatus({ enabled: true, root: '/memory', globalBytes: 10, workspaceCount: 2 })).toEqual({
      enabled: true,
      root: '/memory',
      globalBytes: 10,
      workspaceCount: 2,
    })
    expect(parseGlobalMemoryView({ content: '# Memory\n', revision: 'sha256:abc' })).toEqual({
      content: '# Memory\n',
      revision: 'sha256:abc',
    })
    expect(parseGlobalReplaceResponse({ status: 'committed', revision: 'sha256:def' })).toEqual({
      status: 'committed',
      revision: 'sha256:def',
    })
    expect(parseWorkspaceReadPayload({ workspaceId: WORKSPACE_ID })).toEqual({ workspaceId: WORKSPACE_ID })
    expect(parseWorkspaceListResponse({ workspaces: [{
      workspaceId: WORKSPACE_ID,
      displayName: 'dsh-memory',
      revision: 'sha256:abc',
      recordCount: 1,
    }] })).toEqual({ workspaces: [{
      workspaceId: WORKSPACE_ID,
      displayName: 'dsh-memory',
      revision: 'sha256:abc',
      recordCount: 1,
    }] })
    expect(parseWorkspaceReadResponse({
      workspaceId: WORKSPACE_ID,
      displayName: 'dsh-memory',
      revision: 'sha256:abc',
      recordCount: 1,
      index: '- [project-rule](project-rule.md)',
      records: [{
        name: 'project-rule',
        description: 'One project rule.',
        type: 'project',
        content: 'Keep it local.\n',
      }],
    })).toMatchObject({ workspaceId: WORKSPACE_ID, recordCount: 1 })
    expect(parseWorkspaceReadResponse({
      workspaceId: WORKSPACE_ID,
      displayName: 'dsh-memory',
      revision: 'sha256:abc',
      recordCount: 1,
      index: '- [stamped](stamped.md)',
      records: [{
        name: 'stamped',
        description: 'Carries a temporal stamp.',
        type: 'project',
        content: 'Git works now.\n',
        lastEvidenceTime: 1_790_000_000_000,
      }],
    })).toMatchObject({ records: [{ name: 'stamped', lastEvidenceTime: 1_790_000_000_000 }] })
    expect(() => parseWorkspaceCommitPayload({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 'sha256:abc',
      changes: [{ action: 'put', record: {
        name: 'forged-stamp',
        description: 'Must not be accepted from callers.',
        type: 'project',
        content: 'Forged.\n',
        lastEvidenceTime: 1_790_000_000_000,
      } }],
    })).toThrow(/exactly/)
    expect(parseWorkspaceCommitPayload({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 'sha256:abc',
      changes: [
        { action: 'delete', name: 'old-record' },
        { action: 'put', record: {
          name: 'new-record',
          description: 'A replacement record.',
          type: 'project',
          content: 'Replacement.\n',
        } },
      ],
    })).toMatchObject({ workspaceId: WORKSPACE_ID, changes: [{ action: 'delete' }, { action: 'put' }] })
    expect(parseWorkspaceCommitResponse({ status: 'conflict', currentRevision: 'sha256:newer' }))
      .toEqual({ status: 'conflict', currentRevision: 'sha256:newer' })
    expect(parseSessionListResponse({ available: true, sessions: [{
      sessionId: 'session-1',
      title: 'Memory design',
      createdAt: 42,
      workspaceId: WORKSPACE_ID,
      workspaceName: 'dsh-memory',
      eligible: true,
      reason: null,
      latestReceipt: null,
    }] })).toMatchObject({ available: true, sessions: [{ sessionId: 'session-1', eligible: true }] })
    expect(parseSessionListResponse({ available: true, sessions: [{
      sessionId: 'session-archived',
      title: null,
      createdAt: 43,
      workspaceId: WORKSPACE_ID,
      workspaceName: 'dsh-memory',
      eligible: true,
      reason: null,
      latestReceipt: null,
      archived: true,
    }] })).toMatchObject({ sessions: [{ sessionId: 'session-archived', archived: true }] })
    expect(parseSessionListResponse({ available: true, sessions: [{
      sessionId: 'session-legacy',
      title: null,
      createdAt: 44,
      workspaceId: null,
      workspaceName: null,
      eligible: false,
      reason: 'live',
      latestReceipt: null,
    }] })).toMatchObject({ sessions: [{ sessionId: 'session-legacy', archived: false }] })
    expect(parseSessionConsolidatePayload({ sessionId: 'session-1' })).toEqual({ sessionId: 'session-1' })
    expect(parseSessionConsolidateResponse({
      status: 'committed',
      recovered: false,
      reviewId: `review-${'a'.repeat(64)}`,
      attempt: 1,
      changeCount: 2,
      debugLoggingEnabled: true,
    })).toMatchObject({ status: 'committed', attempt: 1, changeCount: 2 })
    expect(parseSessionConsolidateResponse({
      status: 'evidence-too-large',
      recovered: false,
      reviewId: `review-${'c'.repeat(64)}`,
      attempt: 1,
      changeCount: 0,
      debugLoggingEnabled: false,
    })).toMatchObject({ status: 'evidence-too-large' })
    expect(parseSessionListResponse({ available: true, sessions: [{
      sessionId: 'session-2',
      title: null,
      createdAt: 43,
      workspaceId: WORKSPACE_ID,
      workspaceName: 'dsh-memory',
      eligible: true,
      reason: null,
      latestReceipt: {
        reviewId: `review-${'b'.repeat(64)}`,
        state: 'committed',
        attempt: 1,
        current: false,
        completedAt: '2026-08-31T00:00:00.000Z',
      },
    }] }).sessions[0]?.latestReceipt).toMatchObject({ state: 'committed', current: false })
    expect(parseConsolidationModelCatalogResponse({
      available: true,
      selection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      debugEnabled: false,
      revision: 'sha256:models',
      providers: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{
        id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'Fast model.',
      }] }],
      failures: [],
    })).toMatchObject({ providers: [{ id: 'deepseek-official', models: [{ id: 'deepseek-v4-flash' }] }] })
    expect(parseConsolidationModelSelectPayload({
      expectedRevision: 'sha256:models', provider: 'deepseek-official', model: 'deepseek-v4-flash', debugEnabled: true,
    })).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(parseConsolidationModelSelectResponse({ status: 'committed', revision: 'sha256:new-model' }))
      .toEqual({ status: 'committed', revision: 'sha256:new-model' })
  })

  it('rejects unknown fields on both requests and responses', () => {
    expect(() => parseEmptyPayload({ extra: true })).toThrow(/exactly/)
    expect(() => parseGlobalReplacePayload({ expectedRevision: 'sha256:abc', content: '', path: '/tmp' })).toThrow(/exactly/)
    expect(() => parseMemoryStatus({ enabled: true, root: '/memory', globalBytes: 0, workspaceCount: 0, secret: true })).toThrow(/exactly/)
    expect(() => parseWorkspaceReadPayload({ workspaceId: WORKSPACE_ID, path: '/memory/workspaces/internal' })).toThrow(/exactly/)
    expect(() => parseWorkspaceReadPayload({ workspaceId: 'internal-key' })).toThrow(/opaque/)
    expect(() => parseWorkspaceListResponse({ workspaces: [{
      workspaceId: WORKSPACE_ID,
      displayName: 'dsh-memory',
      revision: 'sha256:abc',
      recordCount: 0,
      internalKey: 'dsh-memory-deadbeefdeadbeef',
    }] })).toThrow(/exactly/)
    expect(() => parseWorkspaceReadResponse({
      workspaceId: WORKSPACE_ID,
      displayName: 'dsh-memory',
      revision: 'sha256:abc',
      recordCount: 2,
      index: '',
      records: [],
    })).toThrow(/match/)
    expect(() => parseWorkspaceCommitPayload({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 'sha256:abc',
      changes: [],
    })).toThrow(/non-empty/)
    expect(() => parseWorkspaceCommitPayload({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 'sha256:abc',
      changes: [
        { action: 'put', record: { name: 'valid', description: 'Valid.', type: 'project', content: 'Valid.\n' } },
        { action: 'delete', name: 'old-record' },
      ],
    })).toThrow(/delete before/)
    expect(() => parseWorkspaceCommitPayload({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 'sha256:abc',
      changes: [{ action: 'put', record: {
        name: '../escape',
        description: 'Unsafe.',
        type: 'project',
        content: 'Unsafe.\n',
      } }],
    })).toThrow(/kebab-case/)
    expect(() => parseWorkspaceCommitPayload({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 'sha256:abc',
      changes: [{ action: 'put', record: {
        name: 'memory',
        description: 'Reserved index name.',
        type: 'project',
        content: 'Reserved.\n',
      } }],
    })).toThrow(/reserved/)
    expect(() => parseWorkspaceCommitResponse({ status: 'committed', revision: 'sha256:new', path: '/tmp' }))
      .toThrow(/exactly/)
    expect(() => parseSessionListResponse({ available: false, sessions: [{ sessionId: 'hidden' }] })).toThrow(/empty/)
    expect(() => parseSessionListResponse({ available: true, sessions: [{
      sessionId: 'session-1',
      title: 'Memory design',
      createdAt: 42,
      workspaceId: WORKSPACE_ID,
      workspaceName: 'dsh-memory',
      eligible: true,
      reason: 'live',
      latestReceipt: null,
    }] })).toThrow(/null/)
    expect(() => parseSessionListResponse({ available: true, sessions: [{
      sessionId: 'session-1',
      title: 'Memory design',
      createdAt: 42,
      workspaceId: WORKSPACE_ID,
      workspaceName: 'dsh-memory',
      eligible: false,
      reason: 'unknown',
      latestReceipt: null,
    }] })).toThrow(/explain/)
    expect(() => parseSessionListResponse({ available: true, sessions: [{
      sessionId: 'session-1',
      title: null,
      createdAt: 42,
      workspaceId: WORKSPACE_ID,
      workspaceName: null,
      eligible: false,
      reason: 'workspace-unavailable',
      latestReceipt: null,
    }] })).toThrow(/both be null/)
    expect(parseSessionListResponse({ available: true, sessions: [{
      sessionId: 'session-sub',
      title: null,
      createdAt: 45,
      workspaceId: WORKSPACE_ID,
      workspaceName: 'dsh-memory',
      eligible: false,
      reason: 'subagent',
      latestReceipt: null,
    }] })).toMatchObject({ sessions: [{ sessionId: 'session-sub', reason: 'subagent' }] })
    expect(parseSessionListResponse({ available: true, sessions: [{
      sessionId: 'session-empty',
      title: null,
      createdAt: 46,
      workspaceId: WORKSPACE_ID,
      workspaceName: 'dsh-memory',
      eligible: false,
      reason: 'empty',
      latestReceipt: null,
    }] })).toMatchObject({ sessions: [{ sessionId: 'session-empty', reason: 'empty' }] })
    expect(() => parseSessionConsolidatePayload({ sessionId: 'session-1', cwd: '/private' })).toThrow(/exactly/)
    expect(() => parseSessionConsolidateResponse({
      status: 'committing',
      recovered: false,
      reviewId: `review-${'a'.repeat(64)}`,
      attempt: 1,
      changeCount: 0,
      debugLoggingEnabled: false,
    })).toThrow(/terminal/)
    expect(() => parseConsolidationModelCatalogResponse({
      available: false,
      selection: { provider: 'p', model: 'm' },
      debugEnabled: false,
      revision: 'sha256:models',
      providers: [{ id: 'p', name: 'P', models: [] }],
      failures: [],
    })).toThrow(/must not contain/)
    expect(() => parseConsolidationModelSelectPayload({
      expectedRevision: 'sha256:models', provider: 'p', model: 'm', debugEnabled: false, apiKey: 'secret',
    })).toThrow(/exactly/)
    expect(() => parseConsolidationModelSelectPayload({
      expectedRevision: 'sha256:models', provider: 'p', model: 'm', debugEnabled: 'yes',
    })).toThrow(/boolean/)
  })
})
