// @vitest-environment jsdom
/** Render-level tests for the Memory settings section (G1 coverage gap). */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { MemorySection, type MemoryApi } from '../src/client/MemorySection.tsx'

const disposers: Array<() => void> = []

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  cleanup()
  vi.restoreAllMocks()
})

const statusView = { enabled: true, root: 'C:\\memory', workspaceCount: 2, globalBytes: 48 }
const globalView = { content: '# Global Memory\n\n- Prefer concise answers.\n', revision: 'sha256:global-1' }

function makeApi(overrides: Partial<MemoryApi> = {}): MemoryApi {
  return {
    status: vi.fn(async () => statusView),
    readGlobal: vi.fn(async () => globalView),
    replaceGlobal: vi.fn(async () => ({ status: 'committed', revision: 'sha256:global-2' })),
    listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
    readWorkspace: vi.fn(async () => ({ workspaceId: `workspace:${'c'.repeat(64)}`, displayName: 'probe', revision: 'sha256:probe', recordCount: 0, index: '', records: [] })),
    commitWorkspace: vi.fn(async () => ({ status: 'committed', revision: 'sha256:ws-2' })),
    listSessions: vi.fn(async () => ({ available: false, sessions: [] })),
    consolidateSession: vi.fn(async () => ({ status: 'no-change', recovered: false, reviewId: `review-${'d'.repeat(64)}`, attempt: 1, changeCount: 0, debugLoggingEnabled: false })),
    readModels: vi.fn(async () => ({ available: false, selection: { provider: 'default', model: 'cheap' }, debugEnabled: false, revision: 'sha256:models', providers: [], failures: [] })),
    selectModel: vi.fn(async () => ({ status: 'committed', revision: 'sha256:selected' })),
    ...overrides,
  } as unknown as MemoryApi
}

function renderSection(api: MemoryApi, loopback = true): void {
  const { unmount } = render(<MemorySection api={api} loopback={loopback} t={key => en[key]} />)
  disposers.push(unmount)
}

const refreshButton = (): HTMLElement => screen.getByRole('button', { name: en.refresh })

describe('MemorySection rendering', () => {
  it('renders the loaded Global memory and status after mount', async () => {
    const api = makeApi()
    renderSection(api)
    expect(screen.getByText(en.loading)).toBeDefined()
    const editor = await screen.findByRole('textbox')
    expect((editor as HTMLTextAreaElement).value).toContain('Prefer concise answers.')
    expect(screen.getByText(en.enabled)).toBeDefined()
    expect(api.status).toHaveBeenCalledTimes(1)
    expect(api.readGlobal).toHaveBeenCalledTimes(1)
  })

  it('renders the error banner when a Host call fails', async () => {
    renderSection(makeApi({ status: vi.fn(async () => { throw new Error('rpc exploded') }) }))
    await screen.findByText(/rpc exploded/)
    expect(screen.queryByText(en.enabled)).toBeNull()
  })

  it('renders the loopback-only notice without touching the Host', async () => {
    const api = makeApi()
    renderSection(api, false)
    await screen.findByText(en.loopbackOnly)
    expect(api.status).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('disables Refresh while the Global draft has unsaved edits', async () => {
    renderSection(makeApi())
    const editor = (await screen.findByRole('textbox')) as HTMLTextAreaElement
    expect(refreshButton().hasAttribute('disabled')).toBe(false)
    fireEvent.change(editor, { target: { value: '# Global Memory\n\n- Hand edited.\n' } })
    expect(refreshButton().hasAttribute('disabled')).toBe(true)
  })

  it('surfaces a Global save conflict as a recoverable banner', async () => {
    const api = makeApi({
      replaceGlobal: vi.fn(async () => ({ status: 'conflict', currentRevision: 'sha256:global-2' })),
    })
    renderSection(api)
    await screen.findByRole('textbox')
    fireEvent.click(screen.getByRole('button', { name: en.saveGlobal }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(en.conflict)
    expect(api.replaceGlobal).toHaveBeenCalledTimes(1)
  })

  it('renders the Workspaces tab through its own list call', async () => {
    const api = makeApi()
    renderSection(api)
    await screen.findByRole('textbox')
    expect(api.listWorkspaces).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.workspacesTab }))
    await screen.findByText(en.workspaceEmpty)
    expect(api.listWorkspaces).toHaveBeenCalledTimes(1)
  })
})
