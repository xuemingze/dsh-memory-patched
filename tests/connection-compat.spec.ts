import { readFileSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const patch: Array<{ id?: string; name?: string; inject?: string[] }> = parse(
  readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'),
)
const compatibility = patch.find(entry => entry.id === 'connection')!

/** Mirrors Connection's caller-owned effect and provider-context service access.
 * Real DSH composition is additionally checked by scripts/check-memory-rpc.mjs.
 */
class ConnectionFixture extends Service {
  constructor(ctx: Context) { super(ctx, 'connection') }

  get rpc() {
    const owner = this.ctx as Context & { webServer: { register(channel: string): () => void } }
    return {
      handle: (channel: string) => owner.effect(() => owner.webServer.register(channel)),
    }
  }
}

describe('Web Connection compatibility', () => {
  it('targets only the standard Connection entry and preserves its Web startup dependency', () => {
    expect(compatibility).toEqual({
      id: 'connection', name: '@deepseek-ai/dsh-client-connection', inject: ['webStartup', 'webServer'],
    })
  })

  it.each([false, true])('registers and disposes RPC with compatibility=%s', async (patched) => {
    const ctx = new Context()
    const routes = new Set<string>()
    try {
      // Providers must be sibling plugins, not root.provide() mocks which bypass strict injection.
      await ctx.plugin({ apply(provider: Context) {
        provider.provide('credentials', {})
        provider.provide('webRuntime', {})
        provider.provide('webStartup', {})
        provider.provide('webServer', { register(channel: string) {
          routes.add(channel)
          return () => { routes.delete(channel) }
        } })
      } })
      await ctx.plugin({
        inject: ['credentials', ...(patched ? compatibility.inject! : ['webRuntime'])],
        apply(provider: Context) { new ConnectionFixture(provider) },
      })
      const consumer = ctx.plugin({ inject: ['connection'], apply(client: Context) {
        client.effect(() => client.connection.rpc.handle('/memory', async () => ({ ok: true, value: null }), { authority: 'loopback' }))
      } })
      if (patched) {
        await consumer.await()
        expect([...routes]).toEqual(['/memory'])
        await consumer.dispose()
        expect(routes.size).toBe(0)
      } else {
        await expect(consumer.await()).rejects.toThrow('cannot get property "webServer" without inject')
        expect(routes.size).toBe(0)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
