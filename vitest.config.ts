import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-agent': fileURLToPath(new URL('./tests/stubs/dsh-agent.ts', import.meta.url)),
      '@deepseek-ai/dsh-llm': fileURLToPath(new URL('./tests/stubs/dsh-llm.ts', import.meta.url)),
      '@deepseek-ai/dsh-session': fileURLToPath(new URL('./tests/stubs/dsh-session.ts', import.meta.url)),
      '@deepseek-ai/dsh-tools': fileURLToPath(new URL('./tests/stubs/dsh-tools.ts', import.meta.url)),
      '@deepseek-ai/schemastery': fileURLToPath(new URL('./tests/stubs/schemastery.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}', 'benchmark/locomo/tests/**/*.test.mjs'],
    environment: 'node',
  },
})
