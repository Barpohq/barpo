// The REST routes of the controls layer — the form and the actions.
//
// The `api.test.ts` pattern: an in-memory database, Hono `app.request`, no
// network.
//
// These tests enforce the protection boundaries:
//   - a secret value is NOT in the response (only the `isSet` flag)
//   - an empty secret DOES NOT WIPE the existing value
//   - a value that breaks the pattern NEVER reaches the server

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { AppManifest } from '@platforma/shared'
import { clearLocks, setSshFactory } from '../src/action-run.ts'
import { app } from '../src/app.ts'
import { openDb, setDb } from '../src/db.ts'
import type { AppSshApi } from '../src/app-ssh.ts'
import { clearCache } from '../src/state-cache.ts'
import { hub } from '../src/ws/hub.ts'
import { cleanupApps, publishManifest, useTempApps } from './app-fixture.ts'

let db: Database
let appsRoot: string
let envWrites: { path: string; values: Record<string, string> }[]
let commands: string[][]

function fakeSsh(): AppSshApi {
  return {
    async command(argv) {
      commands.push(argv)
      return { code: 0, stdout: '', stderr: '' }
    },
    async commandRaw(argv) {
      commands.push(argv)
      return { code: 0, stdout: '', stderr: '' }
    },
    async writeEnv(path, values) {
      envWrites.push({ path, values })
    },
    async readFile() {
      return null
    },
  }
}

/** An app that has settings and actions */
const BOT: AppManifest = {
  id: 'telegram-bot',
  icon: '🤖',
  name: 'Telegram bot',
  tagline: 'News bot',
  version: 'v1',
  service: 'helsinki-1 · docker',
  status: 'running',
  widgets: [{ type: 'note', text: 'The bot is running' }],
  states: [{ name: 'status', code: 'module.exports = async () => ({ active: true })', interval: 5 }],
  settings: {
    fields: [
      {
        key: 'token',
        kind: 'secret',
        label: 'Bot token',
        required: true,
        pattern: '^\\d+:[A-Za-z0-9_-]+$',
        patternHint: 'The token must look like `123456:ABC-DEF`',
      },
      { key: 'admin_id', kind: 'number', label: 'Admin ID' },
      { key: 'mode', kind: 'select', label: 'Mode', options: ['polling', 'webhook'] },
    ],
    write: `module.exports = async ({ values, ssh }) => {
      const env = {}
      if (values.token) env.TELEGRAM_TOKEN = values.token
      if (values.admin_id) env.ADMIN_ID = values.admin_id
      if (values.mode) env.MODE = values.mode
      await ssh('helsinki-1').writeEnv('/opt/bot/.env', env)
      await ssh('helsinki-1').command(['docker', 'restart', 'telegram-bot'])
      return { message: 'Saved and the bot was restarted' }
    }`,
    read: `module.exports = async () => ({ admin_id: '555', mode: 'polling', token: '789:SECRETVALUE' })`,
  },
  actions: [
    {
      name: 'restart',
      label: 'Restart the bot',
      risk: 'write',
      confirm: true,
      code: `module.exports = async ({ ssh }) => {
        await ssh('helsinki-1').command(['docker', 'restart', 'telegram-bot'])
        return { message: 'The bot was restarted' }
      }`,
      refresh: ['status'],
    },
    {
      name: 'crashes',
      label: 'An action that crashes',
      code: 'module.exports = async () => { throw new Error("container not found") }',
    },
  ],
}

beforeEach(async () => {
  db = openDb(':memory:')
  setDb(db)
  envWrites = []
  commands = []
  clearLocks()
  clearCache()
  setSshFactory(() => fakeSsh())
  appsRoot = useTempApps()
  await publishManifest(appsRoot, BOT, db)
})

afterEach(() => {
  setSshFactory(null)
  clearLocks()
  clearCache()
  setDb(null)
  hub.clear()
  db.close()
  cleanupApps(appsRoot)
})

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await app.request(path)
  return { status: response.status, body: (await response.json()) as T }
}

async function send<T>(
  path: string,
  method: 'PUT' | 'POST',
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await app.request(path, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  })
  return { status: response.status, body: (await response.json()) as T }
}

interface SettingsResponse {
  fields: { key: string; kind: string }[]
  values: Record<string, string>
  isSet: Record<string, boolean>
  warning?: string
}

describe('GET /api/apps/:id/settings', () => {
  test('the schema and the non-secret values come back', async () => {
    const { status, body } = await get<SettingsResponse>('/api/apps/telegram-bot/settings')

    expect(status).toBe(200)
    expect(body.fields).toHaveLength(3)
    expect(body.values.admin_id).toBe('555')
    expect(body.values.mode).toBe('polling')
  })

  // ┌──────────────────────────────────────────────────────────────┐
  // │ THE CENTRAL RULE OF THE LAYER. A token must not travel the   │
  // │ server → platform → browser path.                            │
  // └──────────────────────────────────────────────────────────────┘
  test('A SECRET VALUE is NOT in the response — only the `isSet` flag', async () => {
    const response = await app.request('/api/apps/telegram-bot/settings')
    const raw = await response.text()

    // The `read` code DID return the token, but it did not get past the filter
    expect(raw).not.toContain('SECRETVALUE')

    const body = JSON.parse(raw) as SettingsResponse
    expect(body.values.token).toBeUndefined()
    // The server returned that key — meaning it EXISTS on the server
    expect(body.isSet.token).toBe(true)
  })

  // Regression: `read` usually returns `{ token: v.TOKEN }`, and when the key
  // is absent from `.env` the value is `undefined` — but THE KEY is still in
  // the object. Counting it as "present" would show the user "✓ set" even with
  // no token, and they would not understand why the bot is not working.
  test('`isSet` is false when the server has NO token', async () => {
    await publishManifest(appsRoot, {
        ...BOT,
        settings: {
          ...BOT.settings!,
          read: 'module.exports = async () => ({ token: undefined, mode: "polling" })',
        },
      },
      db,
    )

    const { body } = await get<SettingsResponse>('/api/apps/telegram-bot/settings')
    expect(body.isSet.token).toBe(false)
    expect(body.values.mode).toBe('polling')
  })

  test('the form is shown ANYWAY when reading fails', async () => {
    await publishManifest(appsRoot, {
        ...BOT,
        settings: {
          ...BOT.settings!,
          read: 'module.exports = async () => { throw new Error("ssh went down") }',
        },
      },
      db,
    )

    const { status, body } = await get<SettingsResponse>('/api/apps/telegram-bot/settings')

    // The user can fix it by writing new values — the form does not close.
    expect(status).toBe(200)
    expect(body.fields).toHaveLength(3)
    expect(body.warning).toContain('ssh')
  })

  test('404 for an app without settings', async () => {
    await publishManifest(appsRoot, { ...BOT, id: 'no-settings', settings: undefined }, db)
    const { status } = await get('/api/apps/no-settings/settings')
    expect(status).toBe(404)
  })

  test('404 for a missing app', async () => {
    expect((await get('/api/apps/missing/settings')).status).toBe(404)
  })
})

describe('PUT /api/apps/:id/settings', () => {
  test('the values are written to the server', async () => {
    const { status, body } = await send<{ ok: boolean; message?: string }>(
      '/api/apps/telegram-bot/settings',
      'PUT',
      { values: { token: '789456:ABCdef-xyz', admin_id: '111', mode: 'webhook' } },
    )

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.message).toContain('Saved')

    // It was written into `.env` on the server
    expect(envWrites).toHaveLength(1)
    expect(envWrites[0]!.path).toBe('/opt/bot/.env')
    expect(envWrites[0]!.values.TELEGRAM_TOKEN).toBe('789456:ABCdef-xyz')
    // And the bot was restarted
    expect(commands[0]).toEqual(['docker', 'restart', 'telegram-bot'])
  })

  test('the body itself may be the values', async () => {
    const { status } = await send('/api/apps/telegram-bot/settings', 'PUT', { mode: 'webhook' })
    expect(status).toBe(200)
    expect(envWrites[0]!.values.MODE).toBe('webhook')
  })

  // ┌──────────────────────────────────────────────────────────────┐
  // │ AN EMPTY SECRET MEANS "I DID NOT CHANGE IT". The form shows  │
  // │ a secret field empty, so "I did not touch it" also arrives   │
  // │ as an empty string. Sending the empty one through would wipe │
  // │ the existing token.                                          │
  // └──────────────────────────────────────────────────────────────┘
  test('an EMPTY secret is not written (the existing token is kept)', async () => {
    const { status } = await send('/api/apps/telegram-bot/settings', 'PUT', {
      values: { token: '', mode: 'webhook' },
    })

    expect(status).toBe(200)
    // The token DID NOT land in the env — the old one stayed on the server
    expect(envWrites[0]!.values.TELEGRAM_TOKEN).toBeUndefined()
    expect(envWrites[0]!.values.MODE).toBe('webhook')
  })

  test('a value that breaks the pattern NEVER REACHES THE SERVER', async () => {
    const { status, body } = await send<{ ok: boolean; errors: string[] }>(
      '/api/apps/telegram-bot/settings',
      'PUT',
      { values: { token: 'completely-wrong' } },
    )

    expect(status).toBe(400)
    expect(body.errors[0]).toContain('123456:ABC-DEF')
    // The most important part: nothing was written
    expect(envWrites).toHaveLength(0)
    expect(commands).toHaveLength(0)
  })

  test('an injection attempt is stopped by the pattern', async () => {
    const { status } = await send('/api/apps/telegram-bot/settings', 'PUT', {
      values: { token: '123:abc"; rm -rf /; #' },
    })

    expect(status).toBe(400)
    expect(envWrites).toHaveLength(0)
  })

  test('a non-numeric value is rejected', async () => {
    const { status, body } = await send<{ errors: string[] }>(
      '/api/apps/telegram-bot/settings',
      'PUT',
      { values: { admin_id: 'hello' } },
    )
    expect(status).toBe(400)
    expect(body.errors[0]).toContain('number')
  })

  test('a key that is not in the schema is ignored', async () => {
    const { status } = await send('/api/apps/telegram-bot/settings', 'PUT', {
      values: { mode: 'polling', stranger: 'x' },
    })

    expect(status).toBe(200)
    // The code only sees the declared fields
    expect(Object.keys(envWrites[0]!.values)).toEqual(['MODE'])
  })

  test('400 when nothing changed', async () => {
    const { status } = await send('/api/apps/telegram-bot/settings', 'PUT', { values: {} })
    expect(status).toBe(400)
  })

  test('500 and a precise error when the write fails', async () => {
    await publishManifest(appsRoot, {
        ...BOT,
        settings: {
          ...BOT.settings!,
          write: 'module.exports = async () => { throw new Error("disk full") }',
        },
      },
      db,
    )

    const { status, body } = await send<{ ok: boolean; error: string }>(
      '/api/apps/telegram-bot/settings',
      'PUT',
      { values: { mode: 'polling' } },
    )

    expect(status).toBe(500)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('disk')
  })

  test('400 when the body is not JSON', async () => {
    const response = await app.request('/api/apps/telegram-bot/settings', {
      method: 'PUT',
      body: 'notjson',
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(400)
  })

  test('the KEY is written to the audit log, not the VALUE', async () => {
    await send('/api/apps/telegram-bot/settings', 'PUT', {
      values: { token: '789456:SECRETVALUE' },
    })

    const entries = db.query<{ action: string }, []>('SELECT action FROM audit_log').all()
    const text = JSON.stringify(entries)

    expect(text).toContain('token')
    // A secret must not land in the audit log — audit_log is backed up and can
    // be exported.
    expect(text).not.toContain('SECRETVALUE')
  })
})

describe('POST /api/apps/:id/action/:name', () => {
  test('the action runs and a message comes back', async () => {
    const { status, body } = await send<{ ok: boolean; message: string }>(
      '/api/apps/telegram-bot/action/restart',
      'POST',
    )

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.message).toBe('The bot was restarted')
    expect(commands[0]).toEqual(['docker', 'restart', 'telegram-bot'])
  })

  test('the states in `refresh` are refreshed FORCIBLY', async () => {
    const { body } = await send<{ states: Record<string, { ok: boolean; value: unknown }> }>(
      '/api/apps/telegram-bot/action/restart',
      'POST',
    )

    // When restart is pressed the status has to change immediately — the cache
    // must not wait for the interval to run out.
    expect(body.states.status.ok).toBe(true)
    expect(body.states.status.value).toEqual({ active: true })
  })

  test('a crashing action gives 200 and `ok: false` (not a server error)', async () => {
    const { status, body } = await send<{ ok: boolean; error: string }>(
      '/api/apps/telegram-bot/action/crashes',
      'POST',
    )

    // This is a data error, not a server error — the same decision as `states`.
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('container not found')
  })

  test('404 for a missing action', async () => {
    expect((await send('/api/apps/telegram-bot/action/missing', 'POST')).status).toBe(404)
  })

  test('404 for a missing app', async () => {
    expect((await send('/api/apps/missing/action/restart', 'POST')).status).toBe(404)
  })

  test('the action is written to the audit log', async () => {
    await send('/api/apps/telegram-bot/action/restart', 'POST')

    const entry = db
      .query<{ action: string; level: string; result: string }, []>(
        'SELECT action, level, result FROM audit_log ORDER BY rowid DESC LIMIT 1',
      )
      .get()

    expect(entry?.action).toContain('Restart the bot')
    expect(entry?.level).toBe('write')
    expect(entry?.result).toBe('OK')
  })

  test('a crashing action shows as "denied" in the audit log', async () => {
    await send('/api/apps/telegram-bot/action/crashes', 'POST')

    const entry = db
      .query<{ result: string }, []>('SELECT result FROM audit_log ORDER BY rowid DESC LIMIT 1')
      .get()
    expect(entry?.result).toBe('denied')
  })

  test('the non-secret setting values are handed to the action', async () => {
    await publishManifest(appsRoot, {
        ...BOT,
        actions: [
          {
            name: 'check',
            label: 'Check',
            code: 'module.exports = async ({ setting }) => ({ message: "mode=" + setting.mode })',
          },
        ],
      },
      db,
    )

    const { body } = await send<{ message: string }>(
      '/api/apps/telegram-bot/action/check',
      'POST',
    )
    // The non-secret value that came from `read`
    expect(body.message).toBe('mode=polling')
  })

  test('pressing in parallel collapses into ONE run', async () => {
    const [a, b] = await Promise.all([
      send<{ ok: boolean }>('/api/apps/telegram-bot/action/restart', 'POST'),
      send<{ ok: boolean }>('/api/apps/telegram-bot/action/restart', 'POST'),
    ])

    expect(a.body.ok).toBe(true)
    expect(b.body.ok).toBe(true)
    // One restart, not two
    expect(commands).toHaveLength(1)
  })
})
