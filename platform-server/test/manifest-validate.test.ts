// The manifest validator — the first defensive layer of the dynamic dashboard.
//
// These tests have a single purpose: to force a malformed manifest written by
// the AI not to bring the PLATFORM down. That is why so many cases are phrased
// as "it must not throw, the result must be `ok: false`".

import { describe, expect, test } from 'bun:test'
import {
  DATA_LIMIT,
  CODE_LIMIT,
  WIDGET_LIMIT,
  validateManifest,
  sanitiseWidget,
} from '@barpo/shared'

/** The smallest valid manifest */
const base = {
  id: 'test-app',
  name: 'Test app',
  widgets: [{ type: 'note', text: 'hello' }],
}

describe('validateManifest — the basic shape', () => {
  test('a valid manifest passes and comes back sanitised', () => {
    const r = validateManifest(base)
    expect(r.ok).toBe(true)
    expect(r.value?.id).toBe('test-app')
    // Fields that were left out get a default value, so the AI is not forced
    // to write all of them.
    expect(r.value?.icon).toBe('📦')
    expect(r.value?.status).toBe('running')
  })

  test('input that is not an object DOES NOT throw', () => {
    for (const raw of [null, undefined, 42, 'string', [], true]) {
      const r = validateManifest(raw)
      expect(r.ok).toBe(false)
      expect(r.value).toBeNull()
      expect(r.errors.length).toBeGreaterThan(0)
    }
  })

  test('a missing or malformed id is rejected', () => {
    expect(validateManifest({ ...base, id: '' }).ok).toBe(false)
    // The id ends up in a URL path and a folder name — this pattern closes off
    // path traversal
    expect(validateManifest({ ...base, id: '../etc' }).ok).toBe(false)
    expect(validateManifest({ ...base, id: 'Upper-Case' }).ok).toBe(false)
    expect(validateManifest({ ...base, id: 'a'.repeat(65) }).ok).toBe(false)
  })

  test('a manifest with nothing to display is rejected', () => {
    const r = validateManifest({ ...base, widgets: [] })
    expect(r.ok).toBe(false)
  })

  test('no widgets but a view is enough to pass', () => {
    const r = validateManifest({
      ...base,
      widgets: [],
      view: { code: 'export default () => null' },
    })
    expect(r.ok).toBe(true)
    expect(r.value?.view?.code).toContain('export default')
  })
})

describe('sanitiseWidget — partial damage does not cost the whole dashboard', () => {
  test('a broken widget is dropped and the healthy ones stay', () => {
    const r = validateManifest({
      ...base,
      widgets: [
        { type: 'note', text: 'first' },
        { type: 'no-such-type', text: 'broken' },
        null,
        { type: 'note', text: 'last' },
      ],
    })
    expect(r.ok).toBe(true)
    expect(r.value?.widgets).toHaveLength(2)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  test('bars: an item whose value is not a number is dropped', () => {
    const warnings: string[] = []
    const w = sanitiseWidget(
      { type: 'bars', title: 'T', items: [{ label: 'a', value: 'hundred' }, { label: 'b', value: 10 }] },
      warnings,
    )
    // 'hundred' would give NaN and the bar would not render — silent breakage
    expect(w).toEqual({ type: 'bars', title: 'T', items: [{ label: 'b', value: 10 }] })
  })

  test('table: rows are forced to match the column count', () => {
    const warnings: string[] = []
    const w = sanitiseWidget(
      { type: 'table', title: 'T', columns: ['a', 'b'], rows: [['1'], ['1', '2', '3']] },
      warnings,
    )
    expect(w).toEqual({ type: 'table', title: 'T', columns: ['a', 'b'], rows: [['1', ''], ['1', '2']] })
  })

  test('deploy: the javascript: scheme is rejected (an XSS route)', () => {
    const warnings: string[] = []
    expect(sanitiseWidget({ type: 'deploy', url: 'javascript:alert(1)' }, warnings)).toBeNull()
    expect(sanitiseWidget({ type: 'deploy', url: 'https://a.uz', server: 's' }, warnings)).not.toBeNull()
  })

  test('the number of widgets is capped', () => {
    const many = Array.from({ length: WIDGET_LIMIT + 10 }, (_, i) => ({ type: 'note', text: `n${i}` }))
    const r = validateManifest({ ...base, widgets: many })
    expect(r.value?.widgets).toHaveLength(WIDGET_LIMIT)
  })
})

describe('data — snapshot limits', () => {
  test('valid data is kept', () => {
    const r = validateManifest({ ...base, data: { clusters: 247, posts: ['a'] } })
    expect(r.value?.data).toEqual({ clusters: 247, posts: ['a'] })
  })

  test('data that is not an object is rejected', () => {
    expect(validateManifest({ ...base, data: [1, 2] }).ok).toBe(false)
    expect(validateManifest({ ...base, data: 'string' }).ok).toBe(false)
  })

  test('data over the size limit is rejected', () => {
    const r = validateManifest({ ...base, data: { big: 'x'.repeat(DATA_LIMIT) } })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('too large')
  })

  test('a circular reference DOES NOT throw', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const r = validateManifest({ ...base, data: circular })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('JSON')
  })
})

describe('view — the shape of the code', () => {
  test('empty code is rejected', () => {
    expect(validateManifest({ ...base, view: { code: '   ' } }).ok).toBe(false)
  })

  test('code over the length limit is rejected', () => {
    const r = validateManifest({ ...base, view: { code: 'x'.repeat(CODE_LIMIT + 1) } })
    expect(r.ok).toBe(false)
  })
})
