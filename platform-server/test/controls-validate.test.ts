// The controls-layer validator — settings (the form) and actions (the button).
//
// The same goal as `manifest-validate.test.ts`: a broken manifest written by
// the AI must not take the platform down. But this layer carries a NEW risk —
// USER INPUT. Hence the special attention on the key/name patterns: they turn
// into a `.env` key on the server and into a URL path.

import { describe, expect, test } from 'bun:test'
import {
  ACTION_COUNT_LIMIT,
  ACTION_NAME_PATTERN,
  SETTING_COUNT_LIMIT,
  SETTING_KEY_PATTERN,
  validateActions,
  validateManifest,
  validateSettings,
} from '@platforma/shared'

/** The smallest valid settings block */
const settingsBase = {
  fields: [{ key: 'token', kind: 'secret', label: 'Bot token' }],
  write: 'module.exports = async () => {}',
}

/** The smallest valid action */
const actionBase = { name: 'restart', label: 'Restart', code: 'module.exports = async () => {}' }

describe('validateSettings — the basic shape', () => {
  test('a valid block passes', () => {
    const errors: string[] = []
    const warnings: string[] = []
    const r = validateSettings(settingsBase, errors, warnings)

    expect(errors).toEqual([])
    expect(r?.fields).toHaveLength(1)
    expect(r?.fields[0]?.key).toBe('token')
    expect(r?.fields[0]?.kind).toBe('secret')
  })

  test('a block that is not given is `null` — not an error', () => {
    const errors: string[] = []
    for (const raw of [undefined, null]) {
      expect(validateSettings(raw, errors, [])).toBeNull()
    }
    expect(errors).toEqual([])
  })

  test('a non-object block is REJECTED', () => {
    const errors: string[] = []
    expect(validateSettings([1, 2], errors, [])).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
  })

  // The `write` code is the POINT of the form. A form with a schema but no code
  // misleads the user: they type something, save, and nothing happens.
  test('a missing `write` code is REJECTED', () => {
    for (const write of [undefined, null, '', '   ', 42]) {
      const errors: string[] = []
      const r = validateSettings({ ...settingsBase, write }, errors, [])
      expect(r).toBeNull()
      expect(errors.some((e) => e.includes('write'))).toBe(true)
    }
  })

  test('an invalid `read` is DROPPED, the block stays', () => {
    const warnings: string[] = []
    const r = validateSettings({ ...settingsBase, read: 42 }, [], warnings)

    // The block is kept: without `read` the form opens empty — a working state.
    expect(r).not.toBeNull()
    expect(r?.read).toBeUndefined()
    expect(warnings.some((w) => w.includes('read'))).toBe(true)
  })
})

describe('the setting key — it becomes a configuration key', () => {
  test('the pattern forces a lowercase first letter', () => {
    expect(SETTING_KEY_PATTERN.test('token')).toBe(true)
    expect(SETTING_KEY_PATTERN.test('admin_id')).toBe(true)
    expect(SETTING_KEY_PATTERN.test('a1_b2')).toBe(true)

    expect(SETTING_KEY_PATTERN.test('Token')).toBe(false)
    expect(SETTING_KEY_PATTERN.test('1token')).toBe(false)
    expect(SETTING_KEY_PATTERN.test('_token')).toBe(false)
  })

  // THE MOST IMPORTANT TEST. The key lands in a `.env` file AS A KEY — `=`, a
  // newline or a space would break the structure of the file.
  test('keys that break the file structure are REJECTED', () => {
    const dangerous = [
      'to=ken',
      'to ken',
      'to\nken',
      'to\rken',
      'token#comment',
      'token"',
      "token'",
      'token$',
      'token`',
      '../token',
      'token;rm -rf /',
    ]

    for (const key of dangerous) {
      expect(SETTING_KEY_PATTERN.test(key)).toBe(false)

      const warnings: string[] = []
      const r = validateSettings(
        { ...settingsBase, fields: [{ key, kind: 'text', label: 'X' }] },
        [],
        warnings,
      )
      // No valid field is left — the block falls away
      expect(r).toBeNull()
    }
  })

  test('a DUPLICATE key rejects the manifest', () => {
    const errors: string[] = []
    validateSettings(
      {
        ...settingsBase,
        fields: [
          { key: 'token', kind: 'secret', label: 'A' },
          { key: 'token', kind: 'text', label: 'B' },
        ],
      },
      errors,
      [],
    )
    // Which value gets written would come down to chance — hence an error.
    expect(errors.some((e) => e.includes('Duplicate'))).toBe(true)
  })
})

describe('setting field kinds', () => {
  test('an unrecognised kind falls back to `text` with a warning', () => {
    const warnings: string[] = []
    const r = validateSettings(
      { ...settingsBase, fields: [{ key: 'x', kind: 'bogus', label: 'X' }] },
      [],
      warnings,
    )
    expect(r?.fields[0]?.kind).toBe('text')
    expect(warnings.some((w) => w.includes('not recognised'))).toBe(true)
  })

  test('a `select` without options falls back to `text`', () => {
    const warnings: string[] = []
    const r = validateSettings(
      { ...settingsBase, fields: [{ key: 'mode', kind: 'select', label: 'M' }] },
      [],
      warnings,
    )
    // An empty select would trap the user.
    expect(r?.fields[0]?.kind).toBe('text')
    expect(r?.fields[0]?.options).toBeUndefined()
  })

  test('a `select` with options is kept', () => {
    const r = validateSettings(
      {
        ...settingsBase,
        fields: [
          { key: 'mode', kind: 'select', label: 'M', options: ['polling', 'webhook'] },
        ],
      },
      [],
      [],
    )
    expect(r?.fields[0]?.kind).toBe('select')
    expect(r?.fields[0]?.options).toEqual(['polling', 'webhook'])
  })

  // A `default` for a secret is a contradiction: the default value sits in the
  // manifest IN THE CLEAR and is written to the database.
  test('a `default` on a `secret` field is DROPPED', () => {
    const warnings: string[] = []
    const r = validateSettings(
      {
        ...settingsBase,
        fields: [{ key: 'token', kind: 'secret', label: 'T', default: '123:ABC' }],
      },
      [],
      warnings,
    )
    expect(r?.fields[0]?.default).toBeUndefined()
    expect(warnings.some((w) => w.includes('default'))).toBe(true)
  })

  test('the key itself is used when there is no label', () => {
    const r = validateSettings(
      { ...settingsBase, fields: [{ key: 'admin_id', kind: 'number' }] },
      [],
      [],
    )
    expect(r?.fields[0]?.label).toBe('admin_id')
  })

  test('fields beyond the limit are cut', () => {
    const many = Array.from({ length: SETTING_COUNT_LIMIT + 5 }, (_, i) => ({
      key: `field_${i}`,
      kind: 'text',
      label: `F${i}`,
    }))
    const warnings: string[] = []
    const r = validateSettings({ ...settingsBase, fields: many }, [], warnings)

    expect(r?.fields).toHaveLength(SETTING_COUNT_LIMIT)
    expect(warnings.some((w) => w.includes('were kept'))).toBe(true)
  })
})

describe('the pattern — the third layer of injection protection', () => {
  test('a valid regex is kept', () => {
    const r = validateSettings(
      {
        ...settingsBase,
        fields: [
          { key: 'token', kind: 'secret', label: 'T', pattern: '^\\d+:[A-Za-z0-9_-]+$' },
        ],
      },
      [],
      [],
    )
    expect(r?.fields[0]?.pattern).toBe('^\\d+:[A-Za-z0-9_-]+$')
  })

  // A broken regex would blow up in `new RegExp` — the pattern is dropped and
  // the field stays, so the whole form is not lost.
  test('a broken regex is DROPPED, the field stays', () => {
    const warnings: string[] = []
    const r = validateSettings(
      { ...settingsBase, fields: [{ key: 'x', kind: 'text', label: 'X', pattern: '([' }] },
      [],
      warnings,
    )
    expect(r?.fields).toHaveLength(1)
    expect(r?.fields[0]?.pattern).toBeUndefined()
    expect(warnings.some((w) => w.includes('pattern'))).toBe(true)
  })

  test('an excessively long pattern is DROPPED (the ReDoS limit)', () => {
    const warnings: string[] = []
    const r = validateSettings(
      {
        ...settingsBase,
        fields: [{ key: 'x', kind: 'text', label: 'X', pattern: 'a'.repeat(600) }],
      },
      [],
      warnings,
    )
    expect(r?.fields[0]?.pattern).toBeUndefined()
    expect(warnings.some((w) => w.includes('too long'))).toBe(true)
  })

  test('without a pattern the `patternHint` is not kept either', () => {
    const r = validateSettings(
      {
        ...settingsBase,
        fields: [{ key: 'x', kind: 'text', label: 'X', patternHint: 'Wrong format' }],
      },
      [],
      [],
    )
    // A hint is meaningless without a pattern — it would never be shown.
    expect(r?.fields[0]?.patternHint).toBeUndefined()
  })
})

describe('validateActions', () => {
  test('a valid action passes', () => {
    const r = validateActions([actionBase], [], [])
    expect(r).toHaveLength(1)
    expect(r?.[0]?.name).toBe('restart')
    // When the risk is not given — the SAFEST default.
    expect(r?.[0]?.risk).toBe('write')
  })

  test('`actions` that is not given — not an error', () => {
    const errors: string[] = []
    for (const raw of [undefined, null]) {
      expect(validateActions(raw, errors, [])).toBeNull()
    }
    expect(errors).toEqual([])
  })

  test('a non-array is ignored (not rejected)', () => {
    const errors: string[] = []
    const warnings: string[] = []
    expect(validateActions({ name: 'x' }, errors, warnings)).toBeNull()
    expect(errors).toEqual([])
    expect(warnings.length).toBeGreaterThan(0)
  })

  // The action name lands in a URL path — path traversal must be fully closed.
  test('names that break the URL path are REJECTED', () => {
    const dangerous = ['../restart', 'res/tart', 'Restart', 'restart?x=1', 'res tart', '']
    for (const name of dangerous) {
      expect(ACTION_NAME_PATTERN.test(name)).toBe(false)
      const warnings: string[] = []
      expect(validateActions([{ ...actionBase, name }], [], warnings)).toBeNull()
      expect(warnings.length).toBeGreaterThan(0)
    }
  })

  test('a DUPLICATE name rejects the manifest', () => {
    const errors: string[] = []
    validateActions([actionBase, { ...actionBase, label: 'Another' }], errors, [])
    expect(errors.some((e) => e.includes('Duplicate'))).toBe(true)
  })

  test('an action without code is DROPPED, the rest still works', () => {
    const warnings: string[] = []
    const r = validateActions(
      [{ name: 'broken', label: 'B' }, actionBase],
      [],
      warnings,
    )
    // Losing the other action over one broken one would harm the user.
    expect(r).toHaveLength(1)
    expect(r?.[0]?.name).toBe('restart')
    expect(warnings.some((w) => w.includes('code'))).toBe(true)
  })

  test('an unrecognised risk level falls back to `write`', () => {
    const r = validateActions([{ ...actionBase, risk: 'bogus' }], [], [])
    expect(r?.[0]?.risk).toBe('write')
  })

  test('a correct risk level is kept', () => {
    const r = validateActions([{ ...actionBase, risk: 'dangerous' }], [], [])
    expect(r?.[0]?.risk).toBe('dangerous')
  })

  test('`confirm` is kept only when it is exactly `true`', () => {
    expect(validateActions([{ ...actionBase, confirm: true }], [], [])?.[0]?.confirm).toBe(true)
    // A "truthy" value is not enough: confirm is a safety marker, it has to be explicit.
    expect(validateActions([{ ...actionBase, confirm: 'yes' }], [], [])?.[0]?.confirm).toBeUndefined()
  })

  test('actions beyond the limit are cut', () => {
    const many = Array.from({ length: ACTION_COUNT_LIMIT + 3 }, (_, i) => ({
      ...actionBase,
      name: `action_${i}`,
    }))
    const warnings: string[] = []
    expect(validateActions(many, [], warnings)).toHaveLength(ACTION_COUNT_LIMIT)
    expect(warnings.some((w) => w.includes('were kept'))).toBe(true)
  })
})

describe('together with the manifest', () => {
  const base = { id: 'bot', name: 'Bot' }

  test('a manifest with only settings PASSES (a widget is not required)', () => {
    // A control panel is a perfectly meaningful app. Forcing a widget would be
    // excessive.
    const r = validateManifest({ ...base, settings: settingsBase })
    expect(r.ok).toBe(true)
    expect(r.value?.settings?.fields).toHaveLength(1)
  })

  test('a manifest with only actions PASSES', () => {
    const r = validateManifest({ ...base, actions: [actionBase] })
    expect(r.ok).toBe(true)
    expect(r.value?.actions).toHaveLength(1)
  })

  test('a manifest with everything empty is REJECTED', () => {
    const r = validateManifest(base)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('nothing to display'))).toBe(true)
  })

  test('a `refresh` pointing at a missing state is CLEANED UP', () => {
    const r = validateManifest({
      ...base,
      states: [{ name: 'status', code: 'module.exports = async () => 1' }],
      actions: [{ ...actionBase, refresh: ['status', 'missing_state'] }],
    })

    expect(r.ok).toBe(true)
    // The existing one stays, the missing one falls away — otherwise "refresh"
    // would silently do nothing.
    expect(r.value?.actions?.[0]?.refresh).toEqual(['status'])
    expect(r.warnings.some((w) => w.includes('missing_state'))).toBe(true)
  })

  test('the field falls away entirely when every state in `refresh` is missing', () => {
    const r = validateManifest({
      ...base,
      actions: [{ ...actionBase, refresh: ['missing'] }],
    })
    expect(r.ok).toBe(true)
    expect(r.value?.actions?.[0]?.refresh).toBeUndefined()
  })

  test('a broken settings block rejects the whole manifest', () => {
    // The form is USER INPUT. A half-working form would silently lead to data
    // loss.
    const r = validateManifest({
      ...base,
      widgets: [{ type: 'note', text: 'x' }],
      settings: { fields: [{ key: 'token', kind: 'secret' }] },
    })
    expect(r.ok).toBe(false)
  })
})
