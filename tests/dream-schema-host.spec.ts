import { describe, expect, it } from 'vitest'
import { dreamProposalTool } from '../src/memory-dream-agent.ts'

/**
 * The packaged host's two schema gates, reimplemented from its source:
 *   1. compileValueSchema(allowRequired: false) — the root may not carry
 *      `required`; a property may, and it is lifted to the parent.
 *   2. assertSupportedJsonSchema / checkSchemaNode — the compiled form must be
 *      raw JSON Schema: only type/oneOf/properties/required/additionalProperties/
 *      items/enum/const plus annotations.
 *
 * If the tool's output schema passes both here, it passes in the host too.
 */
const DSL_KEYS = new Set(['description', 'title', 'default', 'examples'])

function compile(spec: Record<string, unknown>, path: string, allowRequired: boolean): void {
  if (Object.hasOwn(spec, 'required')) {
    if (!allowRequired) throw new Error(`${path}.required is not supported by the value schema DSL`)
    if (spec.required !== true) throw new Error(`${path}.required must be true when present`)
  }
  const allowed = new Set([...DSL_KEYS, ...(allowRequired ? ['required'] : []), 'type', 'properties', 'additionalProperties', 'items', 'enum', 'const', 'oneOf'])
  for (const key of Object.keys(spec)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported by the value schema DSL`)
  }
  if (spec.type === 'object') {
    if (typeof spec.additionalProperties !== 'boolean') throw new Error(`${path}.additionalProperties must be explicitly true or false`)
    for (const [key, child] of Object.entries((spec.properties ?? {}) as Record<string, Record<string, unknown>>)) {
      compile(child, `${path}.properties.${key}`, true)
    }
  }
}

describe('Output schema satisfies the packaged host', () => {
  it('compiles under the host DSL rules', () => {
    const tool = dreamProposalTool(() => ({ accepted: true, message: 'ok', concluded: true })) as Record<string, unknown>
    const schema = (tool.output as Record<string, unknown>).schema as Record<string, unknown>
    expect(() => compile(schema, 'schema', false)).not.toThrow()
  })

  it('also passes the raw-schema keyword subset', () => {
    const tool = dreamProposalTool(() => ({ accepted: true, message: 'ok', concluded: true })) as Record<string, unknown>
    const schema = (tool.output as Record<string, unknown>).schema as Record<string, unknown>
    // checkSchemaNode: every key must be a constraint keyword or annotation.
    const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
    const ANNOTATION = new Set(['description', 'title', 'default', 'examples'])
    const walk = (node: Record<string, unknown>, path: string): void => {
      for (const key of Object.keys(node)) {
        expect(CONSTRAINT.has(key) || ANNOTATION.has(key), `${path}.${key}`).toBe(true)
      }
      const properties = node.properties as Record<string, Record<string, unknown>> | undefined
      if (properties !== undefined) {
        for (const [key, child] of Object.entries(properties)) walk(child, `${path}.properties.${key}`)
      }
      if (Object.hasOwn(node, 'required')) {
        const required = node.required as string[]
        for (const name of required) expect(Object.hasOwn(properties ?? {}, name)).toBe(true)
      }
    }
    expect(() => walk(schema, 'schema')).not.toThrow()
  })
})