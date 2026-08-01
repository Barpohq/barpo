// The action and settings execution layer.
//
// Three things are enforced:
//   1) THE LOCK — the same action does not run twice in parallel (two restarts)
//   2) NO SECRET LEAKS — a token shows up neither in the error text nor in the result
//   3) ERROR ISOLATION — if the AI code crashes the result is `ok: false`, not a throw

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AppAction, AppSettings } from '@barpo/shared'
import {
  ACTION_TIMEOUT_MS,
  clearLocks,
  isActionBusy,
  readAppSettings,
  redactSecretValues,
  runAction,
  setSshFactory,
  writeAppSettings,
} from '../src/action-run.ts'
import type { AppSshApi } from '../src/app-ssh.ts'

const context = { appId: 'telegram-bot', setting: {} }

/** A fake ssh — it records the calls */
let sshCalls: { kind: string; arg: unknown }[]

function fakeSsh(overrides: Partial<AppSshApi> = {}): AppSshApi {
  return {
    async command(argv: string[]) {
      sshCalls.push({ kind: 'command', arg: argv })
      return { code: 0, stdout: '', stderr: '' }
    },
    async commandRaw(argv: string[]) {
      sshCalls.push({ kind: 'commandRaw', arg: argv })
      return { code: 0, stdout: '', stderr: '' }
    },
    async writeEnv(path: string, values: Record<string, string>) {
      sshCalls.push({ kind: 'writeEnv', arg: { path, values } })
    },
    async readFile() {
      return null
    },
    ...overrides,
  }
}

beforeEach(() => {
  sshCalls = []
  clearLocks()
  setSshFactory(() => fakeSsh())
})

afterEach(() => {
  setSshFactory(null)
  clearLocks()
})

function action(code: string, overrides: Partial<AppAction> = {}): AppAction {
  return { name: 'restart', label: 'Restart', code, ...overrides }
}

describe('runAction — the main flow', () => {
  test('a successful action returns `ok: true`', async () => {
    const r = await runAction(
      action('module.exports = async () => ({ message: "Done" })'),
      context,
    )

    expect(r.ok).toBe(true)
    expect(r.message).toBe('Done')
    expect(r.time).toMatch(/^\d{4}-/)
  })

  test('code returning a string is accepted too', async () => {
    // The AI returns it in various shapes — rejecting would happen AFTER the
    // action has ALREADY run.
    const r = await runAction(action('module.exports = async () => "Ready"'), context)
    expect(r.message).toBe('Ready')
  })

  test('code returning nothing still succeeds', async () => {
    const r = await runAction(action('module.exports = async () => {}'), context)
    expect(r.ok).toBe(true)
    expect(r.message).toBeUndefined()
  })

  test('`ssh` is handed to the code and called with the server name', async () => {
    await runAction(
      action('module.exports = async ({ ssh }) => { await ssh("helsinki-1").command(["docker","restart","bot"]) }'),
      context,
    )

    expect(sshCalls).toHaveLength(1)
    expect(sshCalls[0]!.arg).toEqual(['docker', 'restart', 'bot'])
  })

  test('`setting` is handed to the code', async () => {
    const r = await runAction(
      action('module.exports = async ({ setting }) => ({ message: setting.mode })'),
      { appId: 'bot', setting: { mode: 'webhook' } },
    )
    expect(r.message).toBe('webhook')
  })

  test('`appId` is handed to the code', async () => {
    const r = await runAction(
      action('module.exports = async ({ appId }) => ({ message: appId })'),
      context,
    )
    expect(r.message).toBe('telegram-bot')
  })
})

describe('error isolation — the AI code must not take the platform down', () => {
  test('crashing code DOES NOT THROW', async () => {
    const r = await runAction(
      action('module.exports = async () => { throw new Error("crashed") }'),
      context,
    )

    expect(r.ok).toBe(false)
    expect(r.error).toContain('crashed')
  })

  test('a syntax error is caught at run time, not at publish time', async () => {
    const r = await runAction(action('module.exports = async () => { ('), context)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  test('code that does not return a function is rejected', async () => {
    const r = await runAction(action('const x = 1'), context)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('module.exports')
  })

  test('empty code is rejected', async () => {
    const r = await runAction(action('   '), context)
    expect(r.ok).toBe(false)
  })

  test('misusing `ssh` gives an understandable error', async () => {
    setSshFactory(null)
    const r = await runAction(
      action('module.exports = async ({ ssh }) => { await ssh("").command(["x"]) }'),
      context,
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/server name/i)
  })

  test('the timeout limit is set', () => {
    // 20s (state) is not enough: restart + healthcheck takes longer.
    expect(ACTION_TIMEOUT_MS).toBeGreaterThan(20_000)
  })
})

describe('the lock — two restarts must not tread on each other', () => {
  test('parallel calls collapse into ONE run', async () => {
    let count = 0
    setSshFactory(() =>
      fakeSsh({
        async command(argv: string[]) {
          count++
          await new Promise((resolve) => setTimeout(resolve, 30))
          sshCalls.push({ kind: 'command', arg: argv })
          return { code: 0, stdout: '', stderr: '' }
        },
      }),
    )

    const a = action('module.exports = async ({ ssh }) => { await ssh("h").command(["restart"]) }')

    // The button was pressed twice
    const [r1, r2] = await Promise.all([
      runAction(a, context),
      runAction(a, context),
    ])

    // Both succeed, BUT the command went out only once
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(count).toBe(1)
  })

  test('the lock is released after the run', async () => {
    const a = action('module.exports = async () => ({ message: "ok" })')

    await runAction(a, context)
    expect(isActionBusy('telegram-bot', 'restart')).toBe(false)

    // A second press is a new run
    const r = await runAction(a, context)
    expect(r.ok).toBe(true)
  })

  test('the lock is released after a crash too', async () => {
    const a = action('module.exports = async () => { throw new Error("x") }')
    await runAction(a, context)
    // Otherwise the app would stay "busy" forever.
    expect(isActionBusy('telegram-bot', 'restart')).toBe(false)
  })

  test('different actions do not wait for each other', async () => {
    const slow = action('module.exports = async () => { await new Promise(r => setTimeout(r, 50)); return "a" }', {
      name: 'slow',
    })
    const fast = action('module.exports = async () => "b"', { name: 'fast' })

    const started = Date.now()
    const [, r2] = await Promise.all([
      runAction(slow, context),
      runAction(fast, context),
    ])

    expect(r2.message).toBe('b')
    // "fast" did not wait for "slow"
    expect(Date.now() - started).toBeLessThan(200)
  })

  test('the same action on different apps does not wait', async () => {
    let count = 0
    const a = action(`module.exports = async () => { return "x" }`)

    await Promise.all([
      runAction(a, { appId: 'bot-1', setting: {} }).then(() => count++),
      runAction(a, { appId: 'bot-2', setting: {} }).then(() => count++),
    ])

    expect(count).toBe(2)
  })
})

describe('redactSecretValues', () => {
  test('a secret value is masked', () => {
    expect(redactSecretValues('Error: 7891234:AAHsecret was rejected', ['7891234:AAHsecret'])).toBe(
      'Error: ••• was rejected',
    )
  })

  test('every occurrence is masked', () => {
    expect(redactSecretValues('a SECRETVALUE b SECRETVALUE', ['SECRETVALUE'])).toBe('a ••• b •••')
  })

  // Masking short values would make the message unreadable:
  // `1`, `bot`, `true` occur naturally in text.
  test('short values are NOT redacted', () => {
    expect(redactSecretValues('bot started', ['bot'])).toBe('bot started')
    expect(redactSecretValues('status: 1', ['1'])).toBe('status: 1')
  })

  test('regex characters cause no trouble', () => {
    // `split`/`join` sidesteps regex escaping entirely. The value must be
    // longer than 8 characters (the short-value limit — see the test above).
    expect(redactSecretValues('x $(a).b*[c]+d y', ['$(a).b*[c]+d'])).toBe('x ••• y')
  })

  test('text without secrets is unchanged', () => {
    expect(redactSecretValues('plain text', [])).toBe('plain text')
  })
})

describe('writeAppSettings — no secret leaks', () => {
  const settings: AppSettings = {
    fields: [
      { key: 'token', kind: 'secret', label: 'Token' },
      { key: 'mode', kind: 'text', label: 'Mode' },
    ],
    write:
      'module.exports = async ({ values, ssh }) => { await ssh("h").writeEnv("/opt/bot/.env", { TOKEN: values.token }); return { message: "Saved" } }',
  }

  test('the values are passed to the code and written to the server', async () => {
    const r = await writeAppSettings(settings, { token: '789:SECRETVALUE' }, context)

    expect(r.ok).toBe(true)
    expect(r.message).toBe('Saved')
    expect(sshCalls[0]!.kind).toBe('writeEnv')
    expect((sshCalls[0]!.arg as { values: object }).values).toEqual({
      TOKEN: '789:SECRETVALUE',
    })
  })

  // ┌──────────────────────────────────────────────────────────────┐
  // │ THE MOST IMPORTANT TEST. If the bot errors with              │
  // │ "Invalid token: 789...", that text would travel to the audit │
  // │ log, to WS and to the browser.                               │
  // └──────────────────────────────────────────────────────────────┘
  test('a token IN THE ERROR TEXT is masked', async () => {
    const r = await writeAppSettings(
      {
        ...settings,
        write: 'module.exports = async ({ values }) => { throw new Error("Invalid token: " + values.token) }',
      },
      { token: '789:SECRETVALUE' },
      context,
    )

    expect(r.ok).toBe(false)
    expect(r.error).not.toContain('SECRETVALUE')
    expect(r.error).toContain('•••')
  })

  test('a token IN THE RESULT is masked too', async () => {
    const r = await writeAppSettings(
      {
        ...settings,
        write: 'module.exports = async ({ values }) => ({ message: "Written: " + values.token })',
      },
      { token: '789:SECRETVALUE' },
      context,
    )

    expect(r.message).not.toContain('SECRETVALUE')
  })

  test('a non-secret field is not masked', async () => {
    const r = await writeAppSettings(
      {
        ...settings,
        write: 'module.exports = async ({ values }) => ({ message: "Mode: " + values.mode })',
      },
      { mode: 'webhook-polling' },
      context,
    )
    // The mode is not a secret — the user has to see it
    expect(r.message).toBe('Mode: webhook-polling')
  })

  test('a failed write DOES NOT THROW', async () => {
    const r = await writeAppSettings(
      { ...settings, write: 'module.exports = async () => { throw new Error("disk full") }' },
      {},
      context,
    )
    expect(r.ok).toBe(false)
    expect(r.error).toContain('disk')
  })
})

describe('readAppSettings — secrets are NOT RETURNED', () => {
  const settings: AppSettings = {
    fields: [
      { key: 'token', kind: 'secret', label: 'Token' },
      { key: 'mode', kind: 'text', label: 'Mode' },
      { key: 'admin_id', kind: 'number', label: 'Admin' },
    ],
    write: 'module.exports = async () => {}',
  }

  test('without `read` the values are empty — not an error', async () => {
    const r = await readAppSettings(settings, context)
    expect(r.ok).toBe(true)
    expect(r.values).toEqual({})
  })

  test('non-secret values come back', async () => {
    const r = await readAppSettings(
      { ...settings, read: 'module.exports = async () => ({ mode: "webhook", admin_id: 123 })' },
      context,
    )

    expect(r.ok).toBe(true)
    // A number is turned into a string — form inputs work with strings
    expect(r.values).toEqual({ mode: 'webhook', admin_id: '123' })
  })

  // ┌──────────────────────────────────────────────────────────────┐
  // │ THE CORE RULE OF THE LAYER. The AI thinks returning the      │
  // │ token is NATURAL — so the filter does not trust the code.    │
  // └──────────────────────────────────────────────────────────────┘
  test('a RETURNED secret key is dropped', async () => {
    const r = await readAppSettings(
      {
        ...settings,
        read: 'module.exports = async () => ({ token: "789:SECRET", mode: "polling" })',
      },
      context,
    )

    expect(r.values.token).toBeUndefined()
    expect(r.values.mode).toBe('polling')
    expect(r.dropped).toEqual(['token'])
    // There WAS a value — so it is marked as "set on the server"
    expect(r.isSet).toEqual(['token'])
  })

  // ┌──────────────────────────────────────────────────────────────┐
  // │ THE RECOMMENDED ROUTE: a BOOLEAN for a secret.               │
  // │                                                              │
  // │ Then the token never enters the platform's memory at all,    │
  // │ yet the "✓ set" marker still works.                          │
  // └──────────────────────────────────────────────────────────────┘
  test('`true` for a secret — "set" without a value', async () => {
    const r = await readAppSettings(
      { ...settings, read: 'module.exports = async () => ({ token: true, mode: "x" })' },
      context,
    )

    expect(r.isSet).toEqual(['token'])
    // No value came back, so nothing was "dropped" either — not an AI mistake
    expect(r.dropped).toBeUndefined()
    expect(r.values.token).toBeUndefined()
  })

  test('`false` for a secret — not set', async () => {
    const r = await readAppSettings(
      { ...settings, read: 'module.exports = async () => ({ token: false, mode: "x" })' },
      context,
    )
    expect(r.isSet).toBeUndefined()
    expect(r.dropped).toBeUndefined()
  })

  // ┌──────────────────────────────────────────────────────────────┐
  // │ REGRESSION GUARD. `read` usually returns `{ token: v.TOKEN }` │
  // │ — when the key is absent from `.env` the value is            │
  // │ `undefined`, but THE KEY is still in the object. Counting it  │
  // │ as "present" would show the user "✓ set" with no token.      │
  // └──────────────────────────────────────────────────────────────┘
  test('an EMPTY secret value is not counted as "set"', async () => {
    for (const code of [
      'module.exports = async () => ({ token: undefined, mode: "x" })',
      'module.exports = async () => ({ token: null, mode: "x" })',
      'module.exports = async () => ({ token: "", mode: "x" })',
    ]) {
      const r = await readAppSettings({ ...settings, read: code }, context)
      expect(r.isSet).toBeUndefined()
      expect(r.values.mode).toBe('x')
    }
  })

  test('a key that is not in the schema is dropped too', async () => {
    const r = await readAppSettings(
      { ...settings, read: 'module.exports = async () => ({ stranger: "x", mode: "y" })' },
      context,
    )
    // The form does not display it — passing it on would be extra data leaking.
    expect(r.values).toEqual({ mode: 'y' })
  })

  test('code that does not return an object is rejected', async () => {
    for (const code of [
      'module.exports = async () => "string"',
      'module.exports = async () => [1,2]',
      'module.exports = async () => null',
    ]) {
      const r = await readAppSettings({ ...settings, read: code }, context)
      expect(r.ok).toBe(false)
    }
  })

  test('a crashing `read` DOES NOT THROW', async () => {
    const r = await readAppSettings(
      { ...settings, read: 'module.exports = async () => { throw new Error("ssh went down") }' },
      context,
    )
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ssh')
    expect(r.values).toEqual({})
  })
})
