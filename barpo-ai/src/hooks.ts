// Tool hooks — the point where you can intervene before and after a tool call.
//
// In pi these are `beforeToolCall` / `afterToolCall` (agent-core) and the
// extension `tool_call` / `tool_result` hooks. Here they are exposed to the
// platform: several hooks are registered, they run IN SEQUENCE and each one
// may modify the result.
//
// Why they are needed:
//   - hiding secrets in a tool result (API keys, tokens);
//   - shortening a very long result (saving context);
//   - extra policy: "writing to this folder is forbidden";
//   - observation and auditing (without blocking).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ IMPORTANT: a hook DOES NOT REPLACE THE SECURITY LAYER.               │
// │                                                                      │
// │ The hard deny list (`command-analysis.ts`), the working-directory    │
// │ boundary (`environment.ts`) and the classifier run BEFORE the hooks  │
// │ and cannot be overridden through a hook. A hook can only add an      │
// │ EXTRA restriction — it cannot widen a permission.                    │
// │                                                                      │
// │ The reason: a hook comes from configuration, and the configuration   │
// │ may have been written by a stranger through a project file.          │
// └──────────────────────────────────────────────────────────────────────┘
//
// A hook error BLOCKS THE TOOL (fail-closed). The reason: a hook may have been
// put there to hide secrets — if it does not run, letting the result through
// unfiltered is more dangerous. pi does the same ("Extension failed, blocking
// execution").

/** What a hook sees about a tool call */
export interface ToolCallContext {
  name: string
  args: unknown
  /** Which folder the tool is running in */
  workDir: string
  sessionId: string
}

/** What a hook sees about a tool result */
export interface ToolResultContext extends ToolCallContext {
  /** The result text (joined together if there were several parts) */
  result: string
  isError: boolean
}

/** The answer of a `before` hook. `undefined` — do not intervene. */
export interface BeforeResult {
  /** Block the tool */
  block?: boolean
  /** The reason for blocking — shown to the agent as the error text */
  reason?: string
}

/** The answer of an `after` hook. `undefined` — do not intervene. */
export interface AfterResult {
  /** Replace the result text */
  result?: string
  /** Change the error flag */
  isError?: boolean
}

export interface ToolHook {
  /** For diagnostics and error messages */
  name: string
  /** Before the tool runs. May block it. */
  before?: (c: ToolCallContext) => BeforeResult | undefined | Promise<BeforeResult | undefined>
  /** After the tool has run. May modify the result. */
  after?: (c: ToolResultContext) => AfterResult | undefined | Promise<AfterResult | undefined>
}

// ---------------------------------------------------------------------------
// The hook chain
// ---------------------------------------------------------------------------

/**
 * Runs the hooks in sequence.
 *
 * `before`: the FIRST hook that blocks wins — the rest are not called.
 * The reason: the decision has already been made, and the remaining hooks
 * cannot override it (otherwise hook ordering would affect security).
 */
export async function beforeChain(
  hooks: readonly ToolHook[],
  context: ToolCallContext,
): Promise<BeforeResult | undefined> {
  for (const hook of hooks) {
    if (!hook.before) continue
    let result: BeforeResult | undefined
    try {
      result = await hook.before(context)
    } catch (error) {
      // Fail-closed: if the hook does not run we block the tool
      return {
        block: true,
        reason: `hook "${hook.name}" failed: ${errorText(error)}`,
      }
    }
    if (result?.block) {
      return { block: true, reason: result.reason ?? `hook "${hook.name}" blocked it` }
    }
  }
  return undefined
}

/**
 * Runs the `after` hooks in sequence.
 *
 * Each hook sees the result of the previous one — it is modified as a chain
 * (for example the secrets are hidden first, then the length is shortened).
 *
 * A hook error does not block the tool here — the result has already been
 * obtained and throwing it away is pointless. But the result comes back
 * UNMODIFIED and the error is appended to it, so it does not pass silently.
 */
export async function afterChain(
  hooks: readonly ToolHook[],
  context: ToolResultContext,
): Promise<{ result: string; isError: boolean }> {
  let current = { result: context.result, isError: context.isError }

  for (const hook of hooks) {
    if (!hook.after) continue
    try {
      const answer = await hook.after({ ...context, ...current })
      if (!answer) continue
      current = {
        result: answer.result ?? current.result,
        isError: answer.isError ?? current.isError,
      }
    } catch (error) {
      current = {
        result: `${current.result}\n\n⚠︎ hook "${hook.name}" failed: ${errorText(error)}`,
        isError: current.isError,
      }
    }
  }

  return current
}

// ---------------------------------------------------------------------------
// Ready-made hooks
// ---------------------------------------------------------------------------

/**
 * Hides strings that look like secrets.
 *
 * If `read` or `bash` returns a `.env` file or the output of `env`, the keys
 * land in the LLM context and are sent to the provider. This hook replaces them.
 *
 * LIMITATION: this is a pattern-based filter, not a guarantee. If a key is
 * written in some other shape (in pieces, say) it slips through. The real
 * protection is to never let secret files be read at all.
 */
export function redactSecretsHook(): ToolHook {
  return {
    name: 'redact-secrets',
    after: ({ result }) => {
      const updated = redactSecrets(result)
      return updated === result ? undefined : { result: updated }
    },
  }
}

/**
 * Replaces values that look like secrets inside a piece of text.
 *
 * Exported SEPARATELY from the hook, because it is needed somewhere other than
 * tool results too: on an MCP tool call the ARGUMENTS land in the permission
 * request (`PermissionRequest.target`) and are shown to the user in the UI
 * (`mcp-manager.ts`). The same patterns have to apply there as well — with two
 * different filters in two places, one would get updated and the other would
 * fall behind.
 *
 * The LIMITATION in the comment above applies: this is a pattern-based filter,
 * not a guarantee.
 */
export function redactSecrets(text: string): string {
  // The `KEY=value` and `"key": "value"` shapes. If the key name contains
  // key/token/secret/password the value is hidden.
  //
  // The patterns are recreated ON EVERY CALL: with the `g` flag a RegExp keeps
  // its `lastIndex` state, and reusing one object across several strings would
  // corrupt the result (the hook used to use a single object for its whole
  // lifetime, but `replace` resets `lastIndex` to zero on every call — since
  // this function is now called from the outside too, we remove that risk
  // entirely).
  const keyValue = /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(\S+)/gi
  const jsonKey =
    /(["']?[\w.-]*(?:key|token|secret|password|credential)[\w.-]*["']?\s*:\s*)(["'])([^"']{4,})\2/gi
  // Recognised key shapes — regardless of the name
  const known: RegExp[] = [
    /\b(sk-[A-Za-z0-9_-]{16,})/g,
    /\b(ghp_[A-Za-z0-9]{20,})/g,
    /\b(xox[baprs]-[A-Za-z0-9-]{10,})/g,
  ]

  let updated = text
  updated = updated.replace(keyValue, (_m, key: string) => `${key}=‹redacted›`)
  updated = updated.replace(
    jsonKey,
    (_m, prefix: string, quote: string) => `${prefix}${quote}‹redacted›${quote}`,
  )
  for (const pattern of known) {
    updated = updated.replace(pattern, '‹redacted›')
  }
  return updated
}

/**
 * Truncates the result at the given length.
 *
 * How it differs from the UI limit in `agent.ts`: this applies to the result
 * the LLM sees and is driven from the config.
 */
export function lengthHook(limit: number): ToolHook {
  return {
    name: 'length',
    after: ({ result }) => {
      if (result.length <= limit) return undefined
      const remaining = result.length - limit
      return {
        result: `${result.slice(0, limit)}\n… (${remaining} characters truncated)`,
      }
    },
  }
}

/**
 * Checks the extra forbidden commands from the config.
 *
 * This is IN ADDITION to the built-in hard deny list — it does not replace it.
 * If the user says "`docker` must not run on this machine at all", it is
 * handled here.
 */
export function extraDenyHook(denied: readonly string[]): ToolHook {
  const set = new Set(denied.map((d) => d.trim().toLowerCase()).filter(Boolean))

  return {
    name: 'extra-deny',
    before: ({ name, args }) => {
      if (set.size === 0) return undefined
      if (name !== 'bash') return undefined
      const command = (args as { command?: unknown })?.command
      if (typeof command !== 'string') return undefined

      // We split out the command name roughly — the exact analysis lives in
      // `command-analysis.ts`, this is only an extra filter
      const words = command.toLowerCase().split(/[\s;|&()]+/).filter(Boolean)
      for (const word of words) {
        const base = word.split('/').pop() ?? word
        if (set.has(base)) {
          return { block: true, reason: `\`${base}\` is forbidden in the settings` }
        }
      }
      return undefined
    },
  }
}

/**
 * An observer hook — it does not block, it only reports.
 * The orchestrator hooks in through this to write the audit log.
 */
export function observerHook(
  listener: (c: ToolCallContext) => void,
): ToolHook {
  return {
    name: 'observer',
    before: (c) => {
      try {
        listener(c)
      } catch {
        // An observation error must not block the tool — it is for auditing,
        // not for policy
      }
      return undefined
    },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
