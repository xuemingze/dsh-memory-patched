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
})
