// Computing dashboard states — the live-data layer.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THE CORE RULE: THE AI DOES NOT WRITE NEW APIs.                       │
// │                                                                      │
// │ There is one endpoint and it is ready in advance:                    │
// │     GET /api/apps/:id/state/:name                                    │
// │ The AI only decides WHAT THAT ENDPOINT RETURNS — it writes the state │
// │ code, not the route. The frontend polls that single endpoint and     │
// │ receives the fresh values.                                           │
// └──────────────────────────────────────────────────────────────────────┘
//
// EVERY STATE IS INDEPENDENT. The CPU may refresh every 5 seconds and the disk
// every 30 — they have their own code, their own interval and their own cache.
// With a single shared object, the fastest-refreshing one would force the whole
// set to be recomputed (`df` would run every 5 seconds for no reason).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ ⚠️ TRUST LEVEL — A DELIBERATE, TEMPORARY DECISION                    │
// │                                                                      │
// │ State code runs IN THE SERVER PROCESS with the platform's full       │
// │ privileges (`child_process`, `fs`, the network — all open) and it is │
// │ repeated AUTOMATICALLY on its interval, without asking permission.   │
// │                                                                      │
// │ This differs from the `bash` tool: that goes through the permission  │
// │ layer on every call (`command-analysis.ts`, `permission.ts`), this   │
// │ does not.                                                            │
// │                                                                      │
// │ NEXT STEP: a classifier that inspects the code (prompt-injection     │
// │ protection). The hook-up point is `validateCode()` in this file. For │
// │ now it only looks at the syntax and the size.                        │
// └──────────────────────────────────────────────────────────────────────┘

/** The maximum size of a single state's code (characters) */
export const STATE_CODE_LIMIT = 64 * 1024

/** The maximum number of states in a single manifest */
export const STATE_COUNT_LIMIT = 20

/**
 * The shortest interval (seconds).
 *
 * If the AI writes `interval: 1`, `ssh` would run every second and put
 * needless load on both the server and the platform. 3 seconds is enough for
 * a live view without being abusive.
 */
export const MIN_INTERVAL = 3

/** The time limit for computing a single state (ms) */
export const STATE_TIMEOUT_MS = 20_000

/** The maximum size of the result JSON (characters) */
export const RESULT_LIMIT = 256 * 1024

export interface StateResult {
  ok: boolean
  /** On success — the value the code returned */
  value?: unknown
  /** On failure — the reason (shown in the UI, and read by the AI too) */
  error?: string
  /** When it was computed (ISO) */
  time: string
}

/**
 * Validates a state's code.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ THE FUTURE CLASSIFIER HOOKS IN HERE.                               │
 * │                                                                    │
 * │ The plan: hand the code to an LLM and ask "is this gathering data  │
 * │ for a dashboard, or is it something else?" — to catch malicious    │
 * │ code that arrived through prompt injection.                        │
 * │                                                                    │
 * │ For now only MECHANICAL checks: size and syntax. This is a         │
 * │ deliberate, temporary state of affairs (a GitHub issue is open).   │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * IT DOES NOT THROW — it returns a list of reasons (empty = valid).
 */
export function validateCode(code: string): string[] {
  const errors: string[] = []

  if (typeof code !== 'string' || code.trim().length === 0) {
    errors.push('The state code is empty')
    return errors
  }

  if (code.length > STATE_CODE_LIMIT) {
    errors.push(
      `State code too long: ${code.length} characters, limit ${STATE_CODE_LIMIT}`,
    )
  }

  // Catch syntax errors EARLY: otherwise the error would surface on the first
  // poll, once the user has already opened the page.
  try {
    new Function(code)
  } catch (error) {
    errors.push(`Syntax error: ${error instanceof Error ? error.message : String(error)}`)
  }

  return errors
}

/** Brings the interval within the allowed limits */
export function normaliseInterval(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0
  return Math.max(MIN_INTERVAL, Math.round(raw))
}

/**
 * Runs a state's code and returns the result.
 *
 * IT DOES NOT THROW: if the code falls over, `{ ok: false, error }` comes back
 * and the dashboard carries on with the previous value. That is the rule
 * across the whole project — a mistake by the AI does not take the platform
 * down.
 */
export async function runState(code: string, appId: string): Promise<StateResult> {
  const time = new Date().toISOString()

  const errors = validateCode(code)
  if (errors.length > 0) {
    return { ok: false, error: errors.join('; '), time }
  }

  try {
    // We support the `module.exports = async function () {...}` shape.
    // CommonJS is deliberate: it is the form the AI knows best, and `require`
    // works naturally in it too.
    const module: { exports: unknown } = { exports: {} }
    const factory = new Function('module', 'exports', 'require', '__appId', code)

    factory(module, module.exports, require, appId)

    const fn =
      typeof module.exports === 'function'
        ? module.exports
        : typeof (module.exports as { default?: unknown })?.default === 'function'
          ? (module.exports as { default: unknown }).default
          : null

    if (typeof fn !== 'function') {
      return {
        ok: false,
        error: 'The code did not provide `module.exports = async function () { ... }`',
        time,
      }
    }

    // A time limit: a hung `ssh` must not stall the entire polling chain.
    const value = await Promise.race([
      Promise.resolve((fn as () => unknown)()),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out (${STATE_TIMEOUT_MS / 1000}s)`)),
          STATE_TIMEOUT_MS,
        ),
      ),
    ])

    // The result MUST survive a round trip through JSON: it travels over WS as
    // well as over REST. A value that does not convert (a circular reference,
    // a function) would fall over later — at transmission time.
    let json: string
    try {
      json = JSON.stringify(value ?? null)
    } catch {
      return { ok: false, error: 'The result is not JSON-serialisable (circular reference?)', time }
    }

    if (json.length > RESULT_LIMIT) {
      return {
        ok: false,
        error: `Result too large: ${json.length} characters, limit ${RESULT_LIMIT}`,
        time,
      }
    }

    return { ok: true, value: JSON.parse(json), time }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      time,
    }
  }
}
