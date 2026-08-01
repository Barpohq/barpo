// Tests for JSON Schema generation.
//
// The most important test is the one checking that `schema.json` is not
// stale. If `schema.ts` is edited and `bun run schema` is forgotten,
// editors show the old schema and flag a correctly written setting as an
// "error".

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { FIELDS } from '../src/schema.ts'
import { buildSchema } from '../src/schema-build.ts'
import { readByPath } from '../src/validate.ts'

describe('schema generation', () => {
  test('every field is present in the schema via properties', () => {
    const schema = buildSchema()
    for (const f of FIELDS) {
      // `agent.compaction.enabled` → properties.agent.properties.compaction.properties.enabled
      const schemaPath = f.path.split('.').join('.properties.')
      const node = readByPath(schema.properties, schemaPath)
      expect(node, `${f.path} is missing from the schema`).toBeDefined()
    }
  })

  test('hints carry over into the schema (the editor shows them)', () => {
    const schema = buildSchema()
    const node = readByPath(schema.properties, 'agent.properties.compaction.properties.enabled') as {
      description?: string
    }
    expect(node.description).toBeTruthy()
    expect(node.description).toBe(FIELDS.find((f) => f.path === 'agent.compaction.enabled')!.hint)
  })

  test('number ranges carry over into the schema', () => {
    const schema = buildSchema()
    const node = readByPath(
      schema.properties,
      'agent.properties.compaction.properties.reserveTokens',
    ) as { minimum?: number; maximum?: number }
    expect(node.minimum).toBe(1000)
    expect(node.maximum).toBe(200_000)
  })

  test('a select field has an enum', () => {
    const schema = buildSchema()
    const node = readByPath(schema.properties, 'permission.properties.mode') as { enum?: string[] }
    expect(node.enum).toEqual(['confirm', 'auto'])
  })

  test('a field that allows null has two types', () => {
    const schema = buildSchema()
    const node = readByPath(schema.properties, 'agent.properties.compaction.properties.model') as {
      type?: string[]
    }
    expect(node.type).toEqual(['string', 'null'])
  })

  test('an unknown field is forbidden (so a typo is visible)', () => {
    expect(buildSchema().additionalProperties).toBe(false)
  })

  test('the $schema field is allowed', () => {
    const schema = buildSchema()
    expect((schema.properties as Record<string, unknown>).$schema).toBeDefined()
  })
})

describe('the schema.json file', () => {
  test('the file matches the generated output (not stale)', () => {
    // This test catches `schema.ts` being edited with `bun run schema` forgotten
    const path = new URL('../schema.json', import.meta.url).pathname
    const onDisk = readFileSync(path, 'utf8')
    const expected = `${JSON.stringify(buildSchema(), null, 2)}\n`
    expect(
      onDisk,
      'schema.json is stale — run `bun run schema`',
    ).toBe(expected)
  })
})
