// Validating an app manifest — the FIRST protective layer of the dynamic
// dashboard.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY THIS IS NEEDED. The manifest is written by the AI and lands in   │
// │ the database as JSON (`apps.manifest`). On read, the result of       │
// │ `JSON.parse(...)` used to be CAST directly `as AppManifest` — that   │
// │ is, the type check existed only at compile time, NOT at runtime.     │
// │                                                                      │
// │ The consequence: if `null` arrived instead of `widgets`, or `rows`   │
// │ was not an array, the error surfaced in the UI — during `AppView`    │
// │ render — and took down the entire page. The user's requirement is    │
// │ clear: when the AI gets it wrong ONLY the dashboard should break,    │
// │ the platform must stay whole.                                        │
// │                                                                      │
// │ That is why validation sits AT THE BOUNDARY: on write (`appPublish`) │
// │ and on read (`repo.ts`). Both use this module.                       │
// └──────────────────────────────────────────────────────────────────────┘
//
// THE PHILOSOPHY is the same as in `skill-file.ts`: IT NEVER THROWS.
// The result comes back as `{ ok, errors }` and the caller decides what to do.
// `appPublish` returns the errors to the AI (which fixes them), while
// `repo.ts` drops the broken record (the user sees one fewer app in the list,
// not a crashed page).
//
// SANITISING IS PARTICULARLY IMPORTANT: a partially broken manifest is not
// rejected outright — the broken WIDGET is dropped and the rest is shown.
// Losing 7 of 8 widgets because one of them is wrong would harm the user.

import type {
  AppAction,
  AppManifest,
  AppSettings,
  AppState,
  AppView,
  AuditLevel,
  SettingField,
  SettingKind,
  StatItem,
  Widget,
} from './types.ts'

/**
 * The maximum size of the `data` snapshot (in JSON characters).
 *
 * WHY A LIMIT IS NEEDED: the snapshot is written into the database inside the
 * manifest and is sent to the browser in full on EVERY open. If the AI dumped
 * in "all of today's logs", a single app would sink both the database and the
 * page.
 *
 * 256 KB — a table of ~5000 rows fits, a log archive does not. That is
 * deliberate: a dashboard shows a SUMMARY, not an archive.
 */
export const DATA_LIMIT = 256 * 1024

/**
 * The maximum size of the view code (characters).
 *
 * 128 KB — far larger than any hand-written dashboard component. The limit is
 * not about logic but about RESOURCE protection: the compilation happens on
 * the server.
 */
export const CODE_LIMIT = 128 * 1024

/** The maximum number of widgets in one manifest */
export const WIDGET_LIMIT = 50

/** The maximum number of rows in a table/list widget */
export const ROW_LIMIT = 1000

/** `id` may only take this shape — it lands in a URL path and a file name */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

const WIDGET_KINDS = ['stats', 'bars', 'table', 'logs', 'note', 'deploy', 'git'] as const

export interface ValidationResult<T> {
  ok: boolean
  /** The sanitised value when `ok`, otherwise `null` */
  value: T | null
  /** The reasons for rejection — this text is what goes back to the AI */
  errors: string[]
  /** Places that were fixed/dropped. Does not cause a rejection. */
  warnings: string[]
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

/** An object (not an array and not `null`) */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Coerces a value into a safe string.
 *
 * The AI may send a number or `null` — that is not corruption, merely
 * carelessness. Coercing is better than rejecting.
 */
function toText(v: unknown): string {
  if (isString(v)) return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

function sanitiseStat(v: unknown): StatItem | null {
  if (!isObject(v)) return null
  const label = toText(v.label)
  if (!label) return null
  return {
    label,
    value: toText(v.value),
    ...(isString(v.hint) ? { hint: v.hint } : {}),
    ...(isString(v.accent) ? { accent: v.accent } : {}),
  }
}

/**
 * Validates and sanitises one widget. Returns `null` when it is unusable.
 *
 * Every kind is handled separately, because `Widget` is a discriminated union
 * and each variant has different required fields. A generic "all fields
 * present" check would not work here.
 */
export function sanitiseWidget(raw: unknown, warnings: string[]): Widget | null {
  if (!isObject(raw)) {
    warnings.push('Widget is not an object — dropped')
    return null
  }

  const kind = raw.type
  if (!isString(kind) || !(WIDGET_KINDS as readonly string[]).includes(kind)) {
    warnings.push(`Unknown widget type: ${JSON.stringify(kind)} — dropped`)
    return null
  }

  switch (kind) {
    case 'stats': {
      if (!Array.isArray(raw.items)) {
        warnings.push("`items` in the 'stats' widget is not an array — dropped")
        return null
      }
      const items = raw.items.slice(0, ROW_LIMIT).map(sanitiseStat).filter((s): s is StatItem => s !== null)
      if (items.length === 0) {
        warnings.push("the 'stats' widget has no valid items — dropped")
        return null
      }
      return { type: 'stats', items }
    }

    case 'bars': {
      if (!Array.isArray(raw.items)) {
        warnings.push("`items` in the 'bars' widget is not an array — dropped")
        return null
      }
      const items = raw.items
        .slice(0, ROW_LIMIT)
        .map((i: unknown) => {
          if (!isObject(i)) return null
          const label = toText(i.label)
          // `value` MUST be a number: `AppView` uses it to compute the width
          // (`value / max * 100`). A string would produce NaN and the bar
          // would not show up at all — a silent breakage.
          const value = typeof i.value === 'number' && Number.isFinite(i.value) ? i.value : null
          if (!label || value === null) return null
          return { label, value, ...(isString(i.note) ? { note: i.note } : {}) }
        })
        .filter((i): i is { label: string; value: number; note?: string } => i !== null)
      if (items.length === 0) {
        warnings.push("the 'bars' widget has no valid items — dropped")
        return null
      }
      return {
        type: 'bars',
        title: toText(raw.title),
        items,
        ...(isString(raw.suffix) ? { suffix: raw.suffix } : {}),
      }
    }

    case 'table': {
      if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) {
        warnings.push("`columns`/`rows` in the 'table' widget is not an array — dropped")
        return null
      }
      const columns = raw.columns.map(toText)
      if (columns.length === 0) {
        warnings.push("the 'table' widget has no columns — dropped")
        return null
      }
      // Rows are FORCED to match the column count: missing cells are padded
      // with empty ones and extra cells are cut. Otherwise the table "breaks"
      // — the HTML structure falls apart.
      const rows = raw.rows.slice(0, ROW_LIMIT).map((r: unknown) => {
        const rawRow = Array.isArray(r) ? r : [r]
        return columns.map((_, i) => toText(rawRow[i]))
      })
      return { type: 'table', title: toText(raw.title), columns, rows }
    }

    case 'logs': {
      if (!Array.isArray(raw.lines)) {
        warnings.push("`lines` in the 'logs' widget is not an array — dropped")
        return null
      }
      return {
        type: 'logs',
        title: toText(raw.title),
        lines: raw.lines.slice(0, ROW_LIMIT).map(toText),
      }
    }

    case 'note': {
      const text = toText(raw.text)
      if (!text) {
        warnings.push("the 'note' widget has no text — dropped")
        return null
      }
      return { type: 'note', text }
    }

    case 'deploy': {
      const url = toText(raw.url)
      if (!url) {
        warnings.push("the 'deploy' widget has no `url` — dropped")
        return null
      }
      // `AppView` puts this into an `<a href>`. The `javascript:` scheme is
      // cut here — otherwise it would be XSS by way of the manifest.
      if (!/^https?:\/\//i.test(url)) {
        warnings.push("`url` in the 'deploy' widget is not http(s) — dropped")
        return null
      }
      return {
        type: 'deploy',
        url,
        kind: raw.kind === 'domain' ? 'domain' : 'port',
        server: toText(raw.server),
        ...(isString(raw.ssl) ? { ssl: raw.ssl } : {}),
        ...(isString(raw.extra) ? { extra: raw.extra } : {}),
      }
    }

    case 'git': {
      if (!Array.isArray(raw.commits)) {
        warnings.push("`commits` in the 'git' widget is not an array — dropped")
        return null
      }
      const commits = raw.commits
        .slice(0, ROW_LIMIT)
        .map((c: unknown) => {
          if (!isObject(c)) return null
          const hash = toText(c.hash)
          if (!hash) return null
          return { hash, msg: toText(c.msg), time: toText(c.time) }
        })
        .filter((c): c is { hash: string; msg: string; time: string } => c !== null)
      return { type: 'git', repo: toText(raw.repo), branch: toText(raw.branch), commits }
    }
  }

  return null
}

/**
 * Validates the `data` snapshot.
 *
 * The CONTENT is not checked — the AI decides its shape and it differs per
 * app. Only two things matter: (1) that it is an object, and (2) that it
 * serialises to JSON without exceeding the size limit.
 *
 * JSON-serialisability is checked SEPARATELY, because both `postMessage` and
 * writing to the database rely on serialisation. A non-serialisable value
 * (a circular reference, a `BigInt`) would blow up later — after it had
 * already been stored.
 */
export function validateData(raw: unknown, errors: string[]): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw)) {
    errors.push('`data` must be an object (not an array or a scalar)')
    return null
  }

  let json: string
  try {
    json = JSON.stringify(raw)
  } catch {
    errors.push('`data` is not JSON-serialisable — is there a circular reference or a BigInt?')
    return null
  }

  if (json.length > DATA_LIMIT) {
    errors.push(
      `\`data\` is too large: ${json.length} characters, limit ${DATA_LIMIT}. ` +
        'A dashboard should show a summary, not a full archive.',
    )
    return null
  }

  return raw
}

/**
 * The state name lands in a URL path, so it is strictly constrained.
 *
 * `GET /api/apps/:id/state/:name` — this pattern completely closes off path
 * traversal (`../`) and encoding problems.
 */
export const STATE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

/** The maximum number of states in one manifest */
export const STATE_COUNT_LIMIT = 20

/** The maximum size of one state's code (characters) */
export const STATE_CODE_LIMIT = 64 * 1024

/**
 * Validates and sanitises the `states` list.
 *
 * An invalid state is REJECTED (not the whole manifest) — losing an entire
 * dashboard over one broken state would harm the user. Only CRITICAL errors
 * (a duplicate name) reject the manifest, because then it would be unclear
 * which code should run.
 */
export function validateStates(
  raw: unknown,
  errors: string[],
  warnings: string[],
): AppState[] | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) {
    warnings.push('`states` is not an array — ignored')
    return null
  }

  if (raw.length > STATE_COUNT_LIMIT) {
    warnings.push(
      `${raw.length} states were given, the first ${STATE_COUNT_LIMIT} were kept`,
    )
  }

  const result: AppState[] = []
  const seenNames = new Set<string>()

  for (const el of raw.slice(0, STATE_COUNT_LIMIT)) {
    if (!isObject(el)) {
      warnings.push('State is not an object — dropped')
      continue
    }

    const name = toText(el.name).trim()
    if (!STATE_NAME_PATTERN.test(name)) {
      warnings.push(
        `Invalid state name: ${JSON.stringify(el.name)} — it must start with a lowercase ` +
          'letter and contain only `a-z0-9_` (it becomes part of a URL path)',
      )
      continue
    }

    // A DUPLICATE name rejects the manifest: `data[name]` is a single slot,
    // so which code's result survived would come down to chance.
    if (seenNames.has(name)) {
      errors.push(`Duplicate state name: "${name}"`)
      continue
    }
    seenNames.add(name)

    const code = el.code
    if (!isString(code) || code.trim().length === 0) {
      warnings.push(`State "${name}": the code is empty — dropped`)
      continue
    }
    if (code.length > STATE_CODE_LIMIT) {
      warnings.push(
        `State "${name}": the code is too long (${code.length} characters) — dropped`,
      )
      continue
    }

    const interval =
      typeof el.interval === 'number' && Number.isFinite(el.interval) && el.interval > 0
        ? Math.round(el.interval)
        : 0

    result.push({ name, code, ...(interval > 0 ? { interval } : {}) })
  }

  return result.length > 0 ? result : null
}

/** Validates the view code (BEFORE compilation — this is only about shape) */
export function validateView(raw: unknown, errors: string[]): AppView | null {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw)) {
    errors.push('`view` must be an object')
    return null
  }

  const code = raw.code
  if (!isString(code) || code.trim().length === 0) {
    errors.push('`view.code` must be a non-empty string')
    return null
  }
  if (code.length > CODE_LIMIT) {
    errors.push(`\`view.code\` is too long: ${code.length} characters, limit ${CODE_LIMIT}`)
    return null
  }

  return { code, hash: isString(raw.hash) ? raw.hash : '' }
}

// ---------------------------------------------------------------------------
// The controls layer — settings and actions
// ---------------------------------------------------------------------------

/**
 * The setting key — it is written into the configuration on the server.
 *
 * The same shape as `STATE_NAME_PATTERN`, but longer (64): `.env` keys can be
 * long (`TELEGRAM_WEBHOOK_SECRET`).
 *
 * The pattern is strict because the key becomes a KEY in an `.env` file: an
 * `=`, a space or a newline in the key would break the file's structure.
 */
export const SETTING_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/** The action name — it lands in a URL path (same reason as `STATE_NAME_PATTERN`) */
export const ACTION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

/** The maximum number of setting fields in one manifest */
export const SETTING_COUNT_LIMIT = 30

/** The maximum number of actions in one manifest */
export const ACTION_COUNT_LIMIT = 20

/** The maximum number of options in a `select` field */
export const OPTION_LIMIT = 50

const SETTING_KINDS = ['text', 'secret', 'number', 'select', 'toggle', 'textarea'] as const

const AUDIT_LEVELS = ['read', 'write', 'dangerous'] as const

/**
 * Validates a pattern string — it MUST convert into a `RegExp`.
 *
 * An invalid pattern is DROPPED (the field stays): a field without validation
 * still works, whereas a `new RegExp` error would take down the whole form.
 *
 * We also bound the ReDoS risk — an excessively long pattern is not accepted.
 */
function validatePattern(raw: unknown, warnings: string[], key: string): string | null {
  if (raw === undefined || raw === null) return null
  if (!isString(raw) || raw.trim().length === 0) return null

  if (raw.length > 500) {
    warnings.push(`Setting "${key}": \`pattern\` is too long — dropped`)
    return null
  }

  try {
    new RegExp(raw)
  } catch {
    warnings.push(`Setting "${key}": \`pattern\` is not a valid regex — dropped`)
    return null
  }

  return raw
}

/**
 * Validates and sanitises the setting fields.
 *
 * An invalid field is DROPPED (not the whole form) — the same decision as in
 * `validateStates`. But a DUPLICATE key rejects the form: which value gets
 * written would come down to chance.
 */
export function validateSettingFields(
  raw: unknown,
  errors: string[],
  warnings: string[],
): SettingField[] | null {
  if (!Array.isArray(raw)) {
    errors.push('`settings.fields` must be an array')
    return null
  }

  if (raw.length > SETTING_COUNT_LIMIT) {
    warnings.push(
      `${raw.length} settings were given, the first ${SETTING_COUNT_LIMIT} were kept`,
    )
  }

  const result: SettingField[] = []
  const seenKeys = new Set<string>()

  for (const el of raw.slice(0, SETTING_COUNT_LIMIT)) {
    if (!isObject(el)) {
      warnings.push('Setting field is not an object — dropped')
      continue
    }

    const key = toText(el.key).trim()
    if (!SETTING_KEY_PATTERN.test(key)) {
      warnings.push(
        `Invalid setting key: ${JSON.stringify(el.key)} — it must start with a ` +
          'lowercase letter and contain only `a-z0-9_` (it becomes a configuration key)',
      )
      continue
    }

    if (seenKeys.has(key)) {
      errors.push(`Duplicate setting key: "${key}"`)
      continue
    }
    seenKeys.add(key)

    const kind = SETTING_KINDS.includes(el.kind as (typeof SETTING_KINDS)[number])
      ? (el.kind as SettingKind)
      : 'text'
    if (el.kind !== undefined && kind !== el.kind) {
      warnings.push(
        `Setting "${key}": type ${JSON.stringify(el.kind)} was not recognised — treated as \`text\``,
      )
    }

    // Without a label the key itself is used: a form works with an unlabelled
    // field too, so rejecting it would be excessive strictness.
    const label = toText(el.label).trim() || key

    // A `select` without options is meaningless — an empty select would trap
    // the user, so it is downgraded to plain text.
    let options: string[] | undefined
    if (kind === 'select') {
      const rawOptions = Array.isArray(el.options)
        ? el.options.map((v) => toText(v)).filter((v) => v.length > 0)
        : []
      if (rawOptions.length === 0) {
        warnings.push(
          `Setting "${key}": no options given for \`select\` — treated as \`text\``,
        )
      } else {
        options = rawOptions.slice(0, OPTION_LIMIT)
      }
    }

    const pattern = validatePattern(el.pattern, warnings, key)

    // For `secret` the `default` is DELIBERATELY dropped: a default value sits
    // in the manifest in the clear and is written to the database — for a
    // secret that is a contradiction.
    const defaultValue = isString(el.default) && kind !== 'secret' ? el.default : undefined
    if (isString(el.default) && kind === 'secret') {
      warnings.push(
        `Setting "${key}": a \`secret\` field cannot have a \`default\` — dropped`,
      )
    }

    result.push({
      key,
      kind: options === undefined && kind === 'select' ? 'text' : kind,
      label,
      ...(toText(el.hint).trim() ? { hint: toText(el.hint).trim() } : {}),
      ...(el.required === true ? { required: true } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(options ? { options } : {}),
      ...(pattern ? { pattern } : {}),
      ...(pattern && toText(el.patternHint).trim()
        ? { patternHint: toText(el.patternHint).trim() }
        : {}),
    })
  }

  return result.length > 0 ? result : null
}

/**
 * Validates the `settings` block.
 *
 * IT REJECTS (the whole manifest) when the `write` code is missing or empty.
 * The reason: a form that has a schema but no code MISLEADS the user — they
 * enter a value, press "Save" and nothing happens. Not showing it is better.
 */
export function validateSettings(
  raw: unknown,
  errors: string[],
  warnings: string[],
): AppSettings | null {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw)) {
    errors.push('`settings` must be an object')
    return null
  }

  const fields = validateSettingFields(raw.fields, errors, warnings)
  if (!fields) {
    // The error was already recorded (not an array) or everything was dropped.
    if (Array.isArray(raw.fields)) {
      errors.push('no valid field is left in `settings.fields`')
    }
    return null
  }

  const write = raw.write
  if (!isString(write) || write.trim().length === 0) {
    errors.push(
      '`settings.write` is required: without code that writes the values to the server ' +
        'the form misleads the user (they type something, but nothing happens)',
    )
    return null
  }
  if (write.length > STATE_CODE_LIMIT) {
    errors.push(
      `\`settings.write\` is too long: ${write.length} characters, limit ${STATE_CODE_LIMIT}`,
    )
    return null
  }

  // `read` is OPTIONAL and an invalid one is DROPPED: without it the form
  // opens empty, which is a working state.
  let read: string | undefined
  if (raw.read !== undefined && raw.read !== null) {
    if (!isString(raw.read) || raw.read.trim().length === 0) {
      warnings.push('`settings.read` is not a string — dropped')
    } else if (raw.read.length > STATE_CODE_LIMIT) {
      warnings.push('`settings.read` is too long — dropped')
    } else {
      read = raw.read
    }
  }

  return { fields, write, ...(read ? { read } : {}) }
}

/**
 * Validates and sanitises the actions.
 *
 * An invalid action is DROPPED; a duplicate name rejects the manifest (there
 * is only one URL path — which code runs would be unclear).
 */
export function validateActions(
  raw: unknown,
  errors: string[],
  warnings: string[],
): AppAction[] | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) {
    warnings.push('`actions` is not an array — ignored')
    return null
  }

  if (raw.length > ACTION_COUNT_LIMIT) {
    warnings.push(
      `${raw.length} actions were given, the first ${ACTION_COUNT_LIMIT} were kept`,
    )
  }

  const result: AppAction[] = []
  const seenNames = new Set<string>()

  for (const el of raw.slice(0, ACTION_COUNT_LIMIT)) {
    if (!isObject(el)) {
      warnings.push('Action is not an object — dropped')
      continue
    }

    const name = toText(el.name).trim()
    if (!ACTION_NAME_PATTERN.test(name)) {
      warnings.push(
        `Invalid action name: ${JSON.stringify(el.name)} — it must start with a lowercase ` +
          'letter and contain only `a-z0-9_` (it becomes part of a URL path)',
      )
      continue
    }

    if (seenNames.has(name)) {
      errors.push(`Duplicate action name: "${name}"`)
      continue
    }
    seenNames.add(name)

    const code = el.code
    if (!isString(code) || code.trim().length === 0) {
      warnings.push(`Action "${name}": the code is empty — dropped`)
      continue
    }
    if (code.length > STATE_CODE_LIMIT) {
      warnings.push(`Action "${name}": the code is too long (${code.length} characters) — dropped`)
      continue
    }

    // When the risk level is not recognised it becomes `write` — the SAFEST
    // default. Taking it as `read` would make a state-changing action appear
    // at a low level in the audit log; taking it as `dangerous` would put a
    // warning on every button.
    const risk = AUDIT_LEVELS.includes(el.risk as (typeof AUDIT_LEVELS)[number])
      ? (el.risk as AuditLevel)
      : 'write'

    const refresh = Array.isArray(el.refresh)
      ? el.refresh
          .map((n) => toText(n).trim())
          .filter((n) => STATE_NAME_PATTERN.test(n))
          .slice(0, STATE_COUNT_LIMIT)
      : []

    result.push({
      name,
      label: toText(el.label).trim() || name,
      ...(toText(el.hint).trim() ? { hint: toText(el.hint).trim() } : {}),
      risk,
      ...(el.confirm === true ? { confirm: true } : {}),
      code,
      ...(refresh.length > 0 ? { refresh } : {}),
    })
  }

  return result.length > 0 ? result : null
}

/**
 * Validates and sanitises the full manifest.
 *
 * REJECTED cases (`ok: false`) — the app cannot be shown at all:
 *   - `id` is missing or malformed (it lands in a URL path and a folder name)
 *   - `name` is missing
 *   - the shape of `data`/`view` is broken or exceeds the limit
 *
 * DROPPED cases (`ok: true`, with a warning) — the app is shown, just without
 * the broken part:
 *   - an invalid widget
 *   - widgets beyond the limit
 *
 * The distinction is deliberate: losing the whole dashboard over a single
 * broken widget would harm the user.
 */
export function validateManifest(raw: unknown): ValidationResult<AppManifest> {
  const errors: string[] = []
  const warnings: string[] = []

  if (!isObject(raw)) {
    return { ok: false, value: null, errors: ['The manifest is not an object'], warnings }
  }

  const id = toText(raw.id).trim()
  if (!id) {
    errors.push('`id` is required')
  } else if (!ID_PATTERN.test(id)) {
    errors.push(
      '`id` may contain only lowercase letters, digits and `-` ' +
        '(starting with a letter or digit, at most 64 characters)',
    )
  }

  const name = toText(raw.name).trim()
  if (!name) errors.push('`name` is required')

  // Widgets: when it is not an array it is treated as EMPTY rather than
  // rejected — with a `view` the dashboard works fully without widgets.
  let widgets: Widget[] = []
  if (Array.isArray(raw.widgets)) {
    const rawWidgets = raw.widgets
    if (rawWidgets.length > WIDGET_LIMIT) {
      warnings.push(
        `${rawWidgets.length} widgets — the first ${WIDGET_LIMIT} were kept`,
      )
    }
    widgets = rawWidgets
      .slice(0, WIDGET_LIMIT)
      .map((w) => sanitiseWidget(w, warnings))
      .filter((w): w is Widget => w !== null)
  } else if (raw.widgets !== undefined) {
    warnings.push('`widgets` is not an array — treated as empty')
  }

  const data = validateData(raw.data, errors)
  const view = validateView(raw.view, errors)
  const states = validateStates(raw.states, errors, warnings)
  const settings = validateSettings(raw.settings, errors, warnings)
  const actions = validateActions(raw.actions, errors, warnings)

  // If there is NOTHING to display, this is not an app. That situation usually
  // means the AI sent the result in the wrong shape, so the error text points
  // it in the right direction.
  //
  // Settings and actions COUNT too: a control panel alone (a form + a restart
  // button) is a perfectly meaningful app, and forcing a widget on it would be
  // excessive strictness.
  if (widgets.length === 0 && !view && !settings && !actions) {
    errors.push(
      'The manifest has nothing to display: `widgets`, `view`, `settings` and ' +
        '`actions` are all empty',
    )
  }

  // `actions[].refresh` must point at an existing state — otherwise the
  // "refresh" after the action would silently do nothing.
  if (actions) {
    const stateNames = new Set((states ?? []).map((s) => s.name))
    for (const action of actions) {
      const missing = (action.refresh ?? []).filter((n) => !stateNames.has(n))
      if (missing.length > 0) {
        warnings.push(
          `Action "${action.name}": \`refresh\` refers to states that do not exist: ${missing.join(', ')}`,
        )
        action.refresh = (action.refresh ?? []).filter((n) => stateNames.has(n))
        if (action.refresh.length === 0) delete action.refresh
      }
    }
  }

  if (errors.length > 0) return { ok: false, value: null, errors, warnings }

  return {
    ok: true,
    value: {
      id,
      name,
      icon: toText(raw.icon) || '📦',
      tagline: toText(raw.tagline),
      version: toText(raw.version) || 'v1',
      service: toText(raw.service),
      status: raw.status === 'idle' ? 'idle' : 'running',
      widgets,
      ...(data ? { data } : {}),
      ...(states ? { states } : {}),
      ...(view ? { view } : {}),
      ...(settings ? { settings } : {}),
      ...(actions ? { actions } : {}),
    },
    errors,
    warnings,
  }
}
