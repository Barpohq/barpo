// App manifests — the "Apps" section of the UI sidebar and AppView are both
// fed from these endpoints.

import { Hono } from 'hono'
import {
  isActionBusy,
  runAction,
  readAppSettings,
  writeAppSettings,
} from '../action-run.ts'
import { deleteApp } from '../app-delete.ts'
import { auditWrite } from '../audit.ts'
import { readApp, readApps } from '../repo.ts'
import { normaliseInterval } from '../state-run.ts'
import { getState } from '../state-cache.ts'

export const appsRoutes = new Hono()

/** The actor recorded in the audit log. A single user for now. */
const ACTOR = 'user'

// The list of manifests — the UI only expects manifests, not DB metadata.
//
// This now reads every app's FOLDER, which is why it is async. That is the
// price of the files-are-the-truth model, and it is what makes a hand-edited
// `view.jsx` show up with nothing more than a page refresh.
appsRoutes.get('/apps', async (c) => {
  const apps = await readApps()
  return c.json({ apps: apps.map((a) => a.manifest) })
})

appsRoutes.get('/apps/:id', async (c) => {
  const record = await readApp(c.req.param('id'))
  if (!record) return c.json({ error: 'App not found' }, 404)
  return c.json({
    manifest: record.manifest,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    // The folder path and any read errors go to the UI: the user edits these
    // files by hand, so they need to know where they are and what is wrong.
    ...(record.dir ? { dir: record.dir } : {}),
    ...(record.errors ? { errors: record.errors } : {}),
  })
})

/**
 * Deletes an app — the publish record AND its folder.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ THIS ROUTE ERASES FILES AND CANNOT BE UNDONE.                      │
 * │                                                                    │
 * │ The confirmation lives in the UI (a modal naming the app and the   │
 * │ folder). As with `confirm` on an action, that guards against an    │
 * │ ACCIDENTAL click rather than against an attack — code calling this │
 * │ endpoint directly skips it. What the platform guarantees instead   │
 * │ is that the path really is inside the apps root (`app-delete.ts`). │
 * └────────────────────────────────────────────────────────────────────┘
 */
appsRoutes.delete('/apps/:id', (c) => {
  const result = deleteApp(c.req.param('id'), ACTOR)
  if (!result.ok) return c.json(result, 404)
  return c.json(result)
})

// ---------------------------------------------------------------------------
// Live states
// ---------------------------------------------------------------------------
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THIS IS A READY-MADE API THE AI DOES NOT WRITE.                      │
// │                                                                      │
// │ The agent never adds a new endpoint. It only writes state CODE       │
// │ (`manifest.states`); the two routes below never change. The frontend │
// │ polls them and gets the new values.                                  │
// └──────────────────────────────────────────────────────────────────────┘

/**
 * A single state value.
 *
 * The cache works on the interval: requests arriving inside the interval get
 * the stored result and the code is not re-run (`state-cache.ts`).
 * `?force=1` bypasses the cache (for the "refresh" button).
 */
appsRoutes.get('/apps/:id/state/:name', async (c) => {
  const appId = c.req.param('id')
  const name = c.req.param('name')

  const record = await readApp(appId)
  if (!record) return c.json({ error: 'App not found' }, 404)

  const state = record.manifest.states?.find((s) => s.name === name)
  if (!state) return c.json({ error: `State not found: ${name}` }, 404)

  const result = await getState(
    appId,
    state.name,
    state.code,
    normaliseInterval(state.interval),
    c.req.query('force') === '1',
  )

  // Even when the code fails this is HTTP 200: it is a data error, not a
  // server error. The frontend sees `ok: false`, keeps the previous value and
  // does not take the dashboard down with it.
  return c.json(result)
})

/**
 * Every state in one request.
 *
 * Used WHEN THE PAGE OPENS: one request instead of six for six states.
 * Subsequent refreshes go per state, because their intervals differ (CPU 5s,
 * disk 30s).
 */
appsRoutes.get('/apps/:id/state', async (c) => {
  const appId = c.req.param('id')
  const record = await readApp(appId)
  if (!record) return c.json({ error: 'App not found' }, 404)

  const states = record.manifest.states ?? []
  // In parallel: a slow state (`ssh`, say) must not hold up the rest.
  const results = await Promise.all(
    states.map(async (s) => ({
      name: s.name,
      result: await getState(appId, s.name, s.code, normaliseInterval(s.interval)),
    })),
  )

  const response: Record<string, unknown> = {}
  for (const { name, result } of results) response[name] = result
  return c.json({ states: response })
})

// ---------------------------------------------------------------------------
// The controls layer — settings (a form) and actions (a button)
// ---------------------------------------------------------------------------
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THIS IS ALSO A READY-MADE API THE AI DOES NOT WRITE.                 │
// │                                                                      │
// │ The same rule as for `states`: the three routes never change, the AI  │
// │ only supplies CODE (`settings.write`, `settings.read`,                │
// │ `actions[].code`).                                                    │
// │                                                                      │
// │ THE SERVER IS THE SOURCE OF TRUTH. Values are written into the app's  │
// │ own configuration on the server, NOT into the platform database (see  │
// │ the controls-layer note in `types.ts`).                               │
// └──────────────────────────────────────────────────────────────────────┘

/**
 * The settings schema and the current values.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ SECRET VALUES ARE NEVER RETURNED — only the `isSet` flag.          │
 * │                                                                    │
 * │ This is the central rule of the layer: a token never travels the    │
 * │ server → platform → browser path. The user does not see the current │
 * │ token, they only write a new one.                                   │
 * └────────────────────────────────────────────────────────────────────┘
 */
appsRoutes.get('/apps/:id/settings', async (c) => {
  const appId = c.req.param('id')
  const record = await readApp(appId)
  if (!record) return c.json({ error: 'App not found' }, 404)

  const settings = record.manifest.settings
  if (!settings) return c.json({ error: 'This app has no settings' }, 404)

  const read = await readAppSettings(settings, { appId, setting: {} })

  // For secret fields: not the value, but the STATE. The value itself is
  // dropped inside `readAppSettings`; `isSet` only carries the flag "there is
  // a non-empty value on the server".
  const isSet: Record<string, boolean> = {}
  for (const field of settings.fields) {
    if (field.kind !== 'secret') continue
    isSet[field.key] = (read.isSet ?? []).includes(field.key)
  }

  return c.json({
    fields: settings.fields,
    values: read.values,
    isSet,
    // If reading failed the form is shown ANYWAY (with empty values): the user
    // can fix it by writing new values.
    ...(read.ok ? {} : { warning: read.error }),
  })
})

/**
 * Writes the setting values to the server.
 *
 * AN EMPTY SECRET MEANS "I DID NOT CHANGE IT": the form shows a secret field
 * empty, so the "I did not touch it" state also arrives as an empty string. If
 * we sent the empty one through, the existing token would be wiped (the same
 * decision as in `mcp-credentials.ts`).
 */
appsRoutes.put('/apps/:id/settings', async (c) => {
  const appId = c.req.param('id')
  const record = await readApp(appId)
  if (!record) return c.json({ error: 'App not found' }, 404)

  const settings = record.manifest.settings
  if (!settings) return c.json({ error: 'This app has no settings' }, 404)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Expected JSON' }, 400)
  }

  const raw =
    body && typeof body === 'object' && !Array.isArray(body)
      ? ((body as { values?: unknown }).values ?? body)
      : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return c.json({ error: '`values` must be an object' }, 400)
  }

  const input = raw as Record<string, unknown>
  const values: Record<string, string> = {}
  const errors: string[] = []

  for (const field of settings.fields) {
    const given = input[field.key]

    // A field that did not arrive was not touched. Keys absent from the schema
    // also fall out here: the code only ever sees declared fields.
    if (given === undefined || given === null) {
      if (field.required && field.kind !== 'secret') {
        // For a secret this is NOT an error: it may already be on the server.
        errors.push(`"${field.label}" is required`)
      }
      continue
    }

    const value =
      typeof given === 'string'
        ? given
        : typeof given === 'number' || typeof given === 'boolean'
          ? String(given)
          : null

    if (value === null) {
      errors.push(`"${field.label}": value must be text`)
      continue
    }

    // An empty secret means "I did not change it" (see the note above)
    if (field.kind === 'secret' && value.length === 0) continue

    if (field.required && value.trim().length === 0) {
      errors.push(`"${field.label}" is required`)
      continue
    }

    // ┌────────────────────────────────────────────────────────────────┐
    // │ THE THIRD LAYER OF INJECTION PROTECTION.                       │
    // │                                                                │
    // │ The pattern is checked BEFORE anything is sent to the server — │
    // │ a malformed value never reaches `.env` at all.                 │
    // └────────────────────────────────────────────────────────────────┘
    if (field.pattern && value.length > 0) {
      let matches = false
      try {
        matches = new RegExp(field.pattern).test(value)
      } catch {
        // The pattern was already checked in `manifest-validate.ts`, so an
        // invalid one should never get here. If one does, we SKIP the
        // validation: locking the user out with an error they cannot fix
        // themselves is worse.
        matches = true
      }
      if (!matches) {
        errors.push(field.patternHint || `"${field.label}" does not match the required format`)
        continue
      }
    }

    if (field.kind === 'number' && value.trim().length > 0 && !Number.isFinite(Number(value))) {
      errors.push(`"${field.label}" must be a number`)
      continue
    }

    values[field.key] = value
  }

  if (errors.length > 0) return c.json({ ok: false, errors }, 400)

  if (Object.keys(values).length === 0) {
    return c.json({ ok: false, errors: ['No values changed'] }, 400)
  }

  const result = await writeAppSettings(settings, values, { appId, setting: {} })

  // Audit: a settings change alters state, so it MUST be recorded. The KEYS
  // are written, the VALUES are not — a secret must never reach the audit log.
  auditWrite(
    ACTOR,
    `Settings saved: ${Object.keys(values).join(', ')}`,
    appId,
    'write',
    result.ok ? 'OK' : 'denied',
  )

  // If the write fails this is NOT a 200: the form has to show the user a
  // precise error.
  return c.json(result, result.ok ? 200 : 500)
})

/**
 * Runs an action.
 *
 * `confirm` is asked for on the UI side — this route DOES NOT check it. The
 * reason is written down in `types.ts`: confirmation guards against an
 * accidental click, not against an attack.
 */
appsRoutes.post('/apps/:id/action/:name', async (c) => {
  const appId = c.req.param('id')
  const name = c.req.param('name')

  const record = await readApp(appId)
  if (!record) return c.json({ error: 'App not found' }, 404)

  const action = record.manifest.actions?.find((a) => a.name === name)
  if (!action) return c.json({ error: `Action not found: ${name}` }, 404)

  // A 409 if it is busy: the UI disables the button, but two browser windows
  // or a slow network can still send two requests at once. The lock exists
  // inside `runAction` as well — this response is simply more precise.
  const wasBusy = isActionBusy(appId, name)

  // The non-secret setting values are handed to the code — the container name,
  // for instance.
  const schema = record.manifest.settings
  const setting = schema
    ? (await readAppSettings(schema, { appId, setting: {} })).values
    : {}

  const result = await runAction(action, { appId, setting })

  auditWrite(
    ACTOR,
    `Action executed: ${action.label}`,
    appId,
    action.risk ?? 'write',
    result.ok ? 'OK' : 'denied',
  )

  // The states listed on the action are refreshed FORCIBLY afterwards: when
  // restart is pressed the status has to change immediately, not wait for the
  // cache interval to run out.
  const refreshed: Record<string, unknown> = {}
  if (result.ok && action.refresh?.length) {
    const states = record.manifest.states ?? []
    await Promise.all(
      action.refresh.map(async (stateName) => {
        const state = states.find((s) => s.name === stateName)
        if (!state) return
        refreshed[stateName] = await getState(
          appId,
          state.name,
          state.code,
          normaliseInterval(state.interval),
          true,
        )
      }),
    )
  }

  return c.json({
    ...result,
    ...(wasBusy ? { wasBusy: true } : {}),
    ...(Object.keys(refreshed).length > 0 ? { states: refreshed } : {}),
  })
})
