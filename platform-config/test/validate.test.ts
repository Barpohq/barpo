// Tests for config validation.
//
// The core mandated behaviour: validation NEVER throws. Whatever garbage
// goes in, a complete, working config comes out. These tests check that —
// because the platform's ability to start depends on it.

import { describe, expect, test } from 'bun:test'
import {
  mergeConfigs,
  validateConfig,
  validateField,
  defaultConfig,
  readByPath,
  writeByPath,
} from '../src/validate.ts'
import { FIELDS, type Config } from '../src/schema.ts'

describe('working with paths', () => {
  test('reads from a nested path', () => {
    const source = { agent: { compaction: { enabled: true } } }
    expect(readByPath(source, 'agent.compaction.enabled')).toBe(true)
  })

  test('a path that does not exist returns undefined', () => {
    expect(readByPath({ a: 1 }, 'b.c.d')).toBeUndefined()
  })

  test('does not descend into a primitive', () => {
    expect(readByPath({ a: 5 }, 'a.b')).toBeUndefined()
  })

  test('writing to a path creates the intermediate objects', () => {
    const target: Record<string, unknown> = {}
    writeByPath(target, 'x.y.z', 42)
    expect(target).toEqual({ x: { y: { z: 42 } } })
  })

  test('an object is created in place of a primitive', () => {
    const target: Record<string, unknown> = { x: 'text' }
    writeByPath(target, 'x.y', 1)
    expect(target).toEqual({ x: { y: 1 } })
  })
})

describe('field validation', () => {
  const numberField = { path: 't', kind: 'number', default: 10, hint: '', range: { min: 1, max: 100 } } as const

  test('an unspecified field takes the default value, with no warning', () => {
    const r = validateField(numberField, undefined)
    expect(r.value).toBe(10)
    expect(r.reason).toBeUndefined()
  })

  test('a wrong kind falls back to the default', () => {
    const r = validateField(numberField, 'hello')
    expect(r.value).toBe(10)
    expect(r.reason).toContain('expected a number')
  })

  test('a value below the range is CLAMPED, not reset to the default', () => {
    // The user's intent is clear — we simply bring it into the allowed range
    const r = validateField(numberField, -5)
    expect(r.value).toBe(1)
    expect(r.reason).toContain('too small')
  })

  test('a value above the range is clamped', () => {
    const r = validateField(numberField, 1e9)
    expect(r.value).toBe(100)
  })

  test('NaN and Infinity are not numbers', () => {
    expect(validateField(numberField, Number.NaN).value).toBe(10)
    expect(validateField(numberField, Number.POSITIVE_INFINITY).value).toBe(10)
  })

  test('null is only accepted on fields that allow it', () => {
    expect(validateField(numberField, null).value).toBe(10)
    const nullableField = { path: 't', kind: 'text', default: null, hint: '', nullable: true } as const
    expect(validateField(nullableField, null).value).toBeNull()
  })

  test('a select rejects a value outside its option list', () => {
    const selectField = {
      path: 't',
      kind: 'select',
      default: 'a',
      hint: '',
      options: ['a', 'b'],
    } as const
    expect(validateField(selectField, 'b').value).toBe('b')
    const r = validateField(selectField, 'c')
    expect(r.value).toBe('a')
    expect(r.reason).toContain('options')
  })

  test('bad elements in a list are dropped, not the whole list', () => {
    const listField = { path: 't', kind: 'stringList', default: [], hint: '' } as const
    const r = validateField(listField, ['read', 42, 'bash', null])
    expect(r.value).toEqual(['read', 'bash'])
    expect(r.reason).toContain('dropped')
  })
})

describe('the full config', () => {
  test('a complete config is built from an empty object', () => {
    const { config, warnings } = validateConfig({})
    expect(warnings).toEqual([])
    expect(config.agent.compaction.enabled).toBe(true)
    expect(config.permission.mode).toBe('confirm')
    expect(config.agent.tools.enabled).toContain('grep')
  })

  test('even garbage input yields a working config', () => {
    // The point of this test: no input whatsoever may throw
    for (const garbage of [null, 42, 'text', [], { agent: 'a string, not an object' }, { a: { b: { c: 1 } } }]) {
      const { config } = validateConfig(garbage)
      expect(config.agent.compaction.reserveTokens).toBeGreaterThan(0)
      expect(['confirm', 'auto']).toContain(config.permission.mode)
    }
  })

  test('an unknown field produces a warning (a typo must not vanish)', () => {
    const { warnings } = validateConfig({ agent: { compaction: { enabeld: true } } })
    expect(warnings.some((w) => w.path === 'agent.compaction.enabeld')).toBe(true)
  })

  test('$schema does not count as an unknown field', () => {
    const { warnings } = validateConfig({ $schema: './schema.json' })
    expect(warnings).toEqual([])
  })

  test('defaultConfig returns a fresh object on every call', () => {
    // Otherwise one session changing the config would affect another
    const a = defaultConfig()
    const b = defaultConfig()
    a.agent.tools.enabled.push('bogus')
    expect(b.agent.tools.enabled).not.toContain('bogus')
  })
})

describe('merging', () => {
  test('the upper layer overrides the lower one', () => {
    const r = mergeConfigs(
      { permission: { mode: 'confirm', waitSeconds: 300 } },
      { permission: { mode: 'auto' } },
    )
    expect(r.permission?.mode).toBe('auto')
    // An unspecified field stays from the lower layer
    expect(r.permission?.waitSeconds).toBe(300)
  })

  test('undefined does not erase the lower layer', () => {
    const r = mergeConfigs(
      { permission: { mode: 'auto' } },
      { permission: { mode: undefined } },
    )
    expect(r.permission?.mode).toBe('auto')
  })

  test('an array is replaced wholesale, not concatenated', () => {
    // A "read only" restriction must not pull the global bash back in
    const r = mergeConfigs(
      { agent: { tools: { enabled: ['read', 'bash'], bashTimeoutSeconds: 120, resultLimit: 2000 } } },
      { agent: { tools: { enabled: ['read'] } as Config['agent']['tools'] } },
    )
    expect(r.agent?.tools?.enabled).toEqual(['read'])
  })
})

describe('schema integrity', () => {
  test('FIELDS and the Config type match', () => {
    // Every declared path must exist on the real config.
    // The two are kept in sync by hand — this test enforces it.
    const config = defaultConfig()
    for (const f of FIELDS) {
      expect(readByPath(config, f.path), `${f.path} is missing from the config`).not.toBeUndefined()
    }
  })

  test('every field has a hint (the web UI shows it)', () => {
    for (const f of FIELDS) {
      expect(f.hint.length, `${f.path} has no hint`).toBeGreaterThan(10)
    }
  })

  test('paths are not duplicated', () => {
    const paths = FIELDS.map((f) => f.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  test('select fields have options and their default is among them', () => {
    for (const f of FIELDS) {
      if (f.kind !== 'select') continue
      expect(f.options, `${f.path} has no options`).toBeDefined()
      // `options` is a `readonly` literal array, and `toContain` expects its
      // exact element type. The meaning of the check is preserved.
      expect(f.options as readonly string[]).toContain(f.default as string)
    }
  })

  test('default values are within their own ranges', () => {
    for (const f of FIELDS) {
      const r = validateField(f, f.default)
      expect(r.reason, `the default of ${f.path} failed its own validation`).toBeUndefined()
    }
  })
})
