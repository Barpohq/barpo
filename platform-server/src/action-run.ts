// Running app actions and settings — the heart of the controls layer.
//
// The same pattern as `state-run.ts` (`new Function`, CommonJS, a timeout, IT
// DOES NOT THROW), but with three important differences:
//
//   1) THE LOCK. A state is a read, and calling it in parallel is harmless. An
//      action CHANGES STATE: if two "restart" calls went off at the same time
//      they would tread on each other and the outcome would be down to chance.
//
//   2) THE AUDIT. The rule from `audit.ts`: every action that changes state
//      MUST be written to the audit log. A state read is not written (it runs
//      thousands of times on its interval), whereas an action is written on
//      every press.
//
//   3) A LONGER TIMEOUT. `docker restart` plus a healthcheck does not fit into
//      20 seconds.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ ⚠️ TRUST LEVEL — THE SAME AS `states`, A CONSCIOUS DECISION.        │
// │                                                                      │
// │ The code runs with the platform's full privileges and DOES NOT go    │
// │ through the permission layer (unlike the `bash` tool). The           │
// │ mitigating factors:                                                  │
// │   - it runs WHEN THE USER PRESSES, it does not repeat automatically  │
// │   - it lands in the audit log (who, when, with what result)          │
// │   - when `confirm: true` the UI warns first                          │
// │                                                                      │
// │ NEXT STAGE: a prompt injection classifier — the hook point is        │
// │ `validateActionCode()` in this file.                                 │
// └──────────────────────────────────────────────────────────────────────┘
//
// USER INPUT — A NEW RISK. In `states` there was NO input, here there IS (a
// token, a container name). That is why the AI is not given `exec`: it gets an
// `ssh` object (`app-ssh.ts`), which forces an argv array and passes the
// secret over stdin.

import type { AppAction, AppSettings } from '@barpo/shared'
import { createAppSsh, type AppSshApi } from './app-ssh.ts'
import { serverByName } from './repo.ts'
import { validateCode } from './state-run.ts'

/**
 * The time limit for running an action (ms).
 *
 * Longer than `STATE_TIMEOUT_MS` (20s): when a restart and a healthcheck run
 * one after the other 20 seconds is not enough, and an action that actually
 * succeeded would look like it "timed out".
 */
export const ACTION_TIMEOUT_MS = 90_000

/** The maximum length of the result text — it has to fit in a UI toast */
export const MESSAGE_LIMIT = 2000

export interface ActionResult {
  ok: boolean
  /** The message shown to the user (a toast) */
  message?: string
  /** On failure — the reason. Secrets are redacted. */
  error?: string
  /** When it ran (ISO) */
  time: string
}

/**
 * Validates the action code.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ THE FUTURE CLASSIFIER GETS WIRED IN HERE.                          │
 * │                                                                    │
 * │ The same plan as `validateCode()` in `state-run.ts`: hand the code  │
 * │ to an LLM and ask "is this managing the app, or something else?".   │
 * │ For now it is only a mechanical check (size, syntax).               │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function validateActionCode(code: string): string[] {
  return validateCode(code)
}

// ---------------------------------------------------------------------------
// Redacting secrets
// ---------------------------------------------------------------------------

/**
 * Removes secret values from a piece of text.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ WHY IT IS NEEDED. A secret is not stored on the platform, but      │
 * │ while it is being WRITTEN it passes through the process memory. If │
 * │ a server command returns an error, the error text may contain the  │
 * │ token: for example a bot that fails to start writes                │
 * │ `Invalid token: 789...`. That text would then travel on to the     │
 * │ audit log, to WS and to the browser.                               │
 * │                                                                    │
 * │ In other words the secret is NOT STORED on the platform, but it    │
 * │ CAN LEAK — and this function closes that path.                     │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Short values (< 8 characters) are NOT redacted: values such as `1`, `true`
 * or `bot` occur naturally in text, and masking them would make the message
 * unreadable.
 */
export function redactSecretValues(text: string, secrets: string[]): string {
  let result = text
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue
    // `split`/`join` — this sidesteps the regex escaping problem entirely
    result = result.split(secret).join('•••')
  }
  return result
}

/** Turns an error into text and redacts the secrets */
function redactError(error: unknown, secrets: string[]): string {
  const raw = error instanceof Error ? error.message : String(error)
  return redactSecretValues(raw, secrets).slice(0, MESSAGE_LIMIT)
}

// ---------------------------------------------------------------------------
// The lock — one action does not run twice at the same time
// ---------------------------------------------------------------------------

/**
 * The actions currently running: `appId:name` → Promise.
 *
 * WHY BY APP+NAME RATHER THAN BY APP. Within a single app "restart" and "show
 * the logs" may well run at the same time without getting in each other's way.
 * Pressing the same action twice, on the other hand, is a problem.
 */
const running = new Map<string, Promise<ActionResult>>()

/** Is this action running at this very moment */
export function isActionBusy(appId: string, name: string): boolean {
  return running.has(`${appId}:${name}`)
}

/** For tests: clear the locks */
export function clearLocks(): void {
  running.clear()
}

// ---------------------------------------------------------------------------
// Running the code
// ---------------------------------------------------------------------------

/** The context handed to the code */
export interface ActionContext {
  appId: string
  /** Secret-free setting values — the secrets are NOT here (they live on the server) */
  setting: Record<string, string>
}

/**
 * The `ssh` factory handed to the code.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ WHY A FACTORY RATHER THAN A READY-MADE OBJECT.                     │
 * │                                                                    │
 * │ The manifest has NO field saying "which server this app is on" —   │
 * │ `service` is free text (`"helsinki-1 · docker · uptime 31 days"`)  │
 * │ and parsing it would be brittle. An app may also live on several   │
 * │ servers.                                                            │
 * │                                                                    │
 * │ So THE CODE picks the server: `ssh('helsinki-1')`. The name is     │
 * │ checked against THE DATABASE, though — the code cannot write an    │
 * │ arbitrary host and send a command to a stranger's server in the    │
 * │ managed config.                                                     │
 * └────────────────────────────────────────────────────────────────────┘
 */
export type SshFactory = (serverName: string) => AppSshApi

/**
 * The default factory — it checks the name against the database.
 *
 * If the name is not found it THROWS: were we to return `undefined`, the code
 * would get a baffling "undefined is not a function" at `ssh(...).command`.
 */
function createSshFactory(): SshFactory {
  return (serverName: string) => {
    if (typeof serverName !== 'string' || serverName.trim().length === 0) {
      throw new TypeError("ssh() expects a server name — for example ssh('helsinki-1')")
    }

    const server = serverByName(serverName.trim())
    if (!server) {
      throw new Error(
        `Server not found: "${serverName}". Use a name from the list of servers ` +
          'connected to the platform.',
      )
    }

    return createAppSsh(server.name)
  }
}

/**
 * The factory tests swap out (the `setCommandRunner` pattern).
 *
 * `null` — go back to the default.
 */
let sshFactory: SshFactory | null = null

export function setSshFactory(f: SshFactory | null): void {
  sshFactory = f
}

/**
 * Runs the code — the same shape as `runState` in `state-run.ts`.
 *
 * IT DOES NOT THROW: the outcome comes back as `{ ok: false, error }`.
 */
async function runCode(
  code: string,
  context: ActionContext,
  secrets: string[],
  extra: Record<string, unknown> = {},
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const errors = validateActionCode(code)
  if (errors.length > 0) return { ok: false, error: errors.join('; ') }

  try {
    const module: { exports: unknown } = { exports: {} }
    const factory = new Function('module', 'exports', 'require', '__appId', code)
    factory(module, module.exports, require, context.appId)

    const fn =
      typeof module.exports === 'function'
        ? module.exports
        : typeof (module.exports as { default?: unknown })?.default === 'function'
          ? (module.exports as { default: unknown }).default
          : null

    if (typeof fn !== 'function') {
      return { ok: false, error: 'The code did not return `module.exports = async function () { ... }`' }
    }

    const arg = {
      appId: context.appId,
      setting: context.setting,
      ssh: sshFactory ?? createSshFactory(),
      ...extra,
    }

    const value = await Promise.race([
      Promise.resolve((fn as (a: unknown) => unknown)(arg)),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out (${ACTION_TIMEOUT_MS / 1000}s)`)),
          ACTION_TIMEOUT_MS,
        ),
      ),
    ])

    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: redactError(error, secrets) }
  }
}

/**
 * Extracts the message shown to the user from whatever the code returned.
 *
 * The AI may return it in various shapes (`{ message }`, a string, nothing at
 * all) — we accept them all, because rejecting would happen AFTER the action
 * has ALREADY run, and the user would see an "error" and press again.
 */
function extractMessage(value: unknown, secrets: string[]): string | undefined {
  let raw: string | undefined

  if (typeof value === 'string') raw = value
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.message === 'string') raw = o.message
  }

  if (!raw) return undefined
  return redactSecretValues(raw, secrets).slice(0, MESSAGE_LIMIT) || undefined
}

/**
 * Runs an action.
 *
 * THE LOCK: if the same action is already running, a NEW call is not started —
 * the existing result is awaited. That turns a double click of the button into
 * a single run (rather than two restarts).
 *
 * IT DOES NOT THROW.
 */
export function runAction(
  action: AppAction,
  context: ActionContext,
): Promise<ActionResult> {
  const key = `${context.appId}:${action.name}`

  const existing = running.get(key)
  if (existing) return existing

  const job = (async (): Promise<ActionResult> => {
    const time = new Date().toISOString()
    // Setting values go on the redaction list even when they are not secret:
    // some of them (a webhook's secret word) are close enough to a secret in
    // practice.
    const secrets = Object.values(context.setting)

    const result = await runCode(action.code, context, secrets)

    if (!result.ok) {
      return { ok: false, error: result.error ?? 'Unknown error', time }
    }

    return {
      ok: true,
      ...(extractMessage(result.value, secrets) !== undefined
        ? { message: extractMessage(result.value, secrets) }
        : {}),
      time,
    }
  })().finally(() => {
    running.delete(key)
  })

  running.set(key, job)
  return job
}

// ---------------------------------------------------------------------------
// Settings — writing and reading
// ---------------------------------------------------------------------------

export interface SettingsWriteResult {
  ok: boolean
  message?: string
  error?: string
  time: string
}

/**
 * Writes the setting values TO THE SERVER.
 *
 * The values are handed to the code as `values` — the code writes them into
 * the configuration on the server with `ssh.writeEnv()` and restarts the app.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ SECRETS PASS THROUGH THIS FUNCTION, BUT THEY ARE NOT STORED.       │
 * │                                                                    │
 * │ They sit in the process memory only for the duration of the write  │
 * │ and are redacted from the result (`redactSecretValues`). They do   │
 * │ not reach the database, the log or WS.                             │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function writeAppSettings(
  settings: AppSettings,
  values: Record<string, string>,
  context: ActionContext,
): Promise<SettingsWriteResult> {
  const time = new Date().toISOString()

  // The values of the secret fields — the redaction list
  const secretKeys = new Set(
    settings.fields.filter((f) => f.kind === 'secret').map((f) => f.key),
  )
  const secrets = Object.entries(values)
    .filter(([k]) => secretKeys.has(k))
    .map(([, v]) => v)

  const result = await runCode(settings.write, context, secrets, { values })

  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Unknown error', time }
  }

  return {
    ok: true,
    ...(extractMessage(result.value, secrets) !== undefined
      ? { message: extractMessage(result.value, secrets) }
      : {}),
    time,
  }
}

export interface SettingsReadResult {
  ok: boolean
  /** The current secret-free values */
  values: Record<string, string>
  error?: string
  /**
   * The secret keys that HAVE A VALUE on the server.
   *
   * The UI builds its "✓ set" marker from this list. The value ITSELF is not
   * returned — only the fact that there is one.
   *
   * DELIBERATELY kept apart from `dropped` (an AI mistake): with both in one
   * field, "a secret was returned" and "a secret exists" would get mixed up.
   */
  isSet?: string[]
  /**
   * The secret keys the `read` code handed back — a sign of an AI mistake.
   *
   * They are dropped regardless; this list is for diagnostics.
   */
  dropped?: string[]
}

/**
 * Reads the current values FROM THE SERVER.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ A RETURNED SECRET IS DROPPED.                                      │
 * │                                                                    │
 * │ The core rule of this layer: a token does not travel the           │
 * │ server → platform → browser path. The AI may well hand the token   │
 * │ back in its `read` code (it thinks doing so is NATURAL), so the    │
 * │ filter lives here — we do not put our trust in the code.           │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function readAppSettings(
  settings: AppSettings,
  context: ActionContext,
): Promise<SettingsReadResult> {
  if (!settings.read) return { ok: true, values: {} }

  const result = await runCode(settings.read, context, [])
  if (!result.ok) {
    return { ok: false, values: {}, error: result.error ?? 'Unknown error' }
  }

  if (!result.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
    return { ok: false, values: {}, error: 'The `read` code did not return an object' }
  }

  const secretKeys = new Set(
    settings.fields.filter((f) => f.kind === 'secret').map((f) => f.key),
  )
  const knownKeys = new Set(settings.fields.map((f) => f.key))

  const values: Record<string, string> = {}
  const dropped: string[] = []
  const isSet: string[] = []

  for (const [key, value] of Object.entries(result.value as Record<string, unknown>)) {
    if (secretKeys.has(key)) {
      // ┌──────────────────────────────────────────────────────────────┐
      // │ TWO KINDS OF ANSWER ARE ACCEPTED FOR A SECRET.               │
      // │                                                              │
      // │   `true` / `false`  — THE RECOMMENDED route: the code says   │
      // │                       whether the secret EXISTS, not what it │
      // │                       is.                                     │
      // │   a string          — the code handed the secret back (an AI │
      // │                       mistake). The value is DROPPED, but a  │
      // │                       non-empty one still means "set".        │
      // │                                                              │
      // │ The second is needed because the AI thinks returning the     │
      // │ token is NATURAL. If we quietly turned that into "not set",  │
      // │ the user would see an existing token as missing.             │
      // │                                                              │
      // │ AN EMPTY VALUE ("", null, undefined) means "not set" in BOTH │
      // │ cases: in `{ token: v.TOKEN }` the value is `undefined` when │
      // │ the key is absent from `.env`, yet THE KEY is still there in │
      // │ the object.                                                   │
      // └──────────────────────────────────────────────────────────────┘
      if (typeof value === 'boolean') {
        if (value) isSet.push(key)
      } else if (value !== undefined && value !== null && String(value).length > 0) {
        // A real value came back — that is an AI mistake, we record it
        dropped.push(key)
        isSet.push(key)
      }
      continue
    }
    // A key that is not declared in the schema is dropped too: the form does
    // not display it, so passing it on would be nothing but extra data leaking
    // out.
    if (!knownKeys.has(key)) continue

    if (typeof value === 'string') values[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') {
      values[key] = String(value)
    }
  }

  return {
    ok: true,
    values,
    ...(isSet.length > 0 ? { isSet } : {}),
    ...(dropped.length > 0 ? { dropped } : {}),
  }
}
