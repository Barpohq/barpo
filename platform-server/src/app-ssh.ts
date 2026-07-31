// The SSH layer for app controls — the `ssh` object handed to the AI's code.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY A SEPARATE LAYER. `ssh.ts` holds the platform primitives         │
// │ (installing a key, reading metrics): THE PLATFORM calls them and     │
// │ writes the arguments itself. The functions in this file, by          │
// │ contrast, are called by THE AI'S CODE, and USER INPUT (a token, a    │
// │ container name) lands in their arguments.                            │
// │                                                                      │
// │ In other words this is where an untrusted caller and untrusted data  │
// │ meet. That is why the defences are gathered here.                    │
// └──────────────────────────────────────────────────────────────────────┘
//
// INJECTION PROTECTION — TWO LAYERS (the third is the `pattern` validation in
// `manifest-validate.ts`):
//
//   1) `command()` only ever accepts an argv array. Passing a string throws.
//      No shell is involved at all, which means `;`, `|` and `$(...)` carry
//      no meaning — they stay ordinary argument text.
//
//   2) `writeEnv()` passes the value through STDIN. As an argument the token
//      would be visible in `ps` output on the server and in the shell history.
//
// WHY THE AI IS NOT GIVEN `exec`. The tempting option is to hand the AI a full
// shell and say "let it work it out". But the token the user typed goes into
// that shell — which would make every token entry a potential command
// execution. Hence the boundary: the AI says WHAT to do, the platform knows
// HOW it is done.

import type { CommandResult } from './ssh.ts'
import { managedConfigPath, sshRun } from './ssh.ts'

/** The time limit for a single SSH call inside an action (ms) */
export const APP_COMMAND_TIMEOUT_MS = 45_000

/**
 * The maximum size that may be written to a `.env` file at once.
 *
 * A configuration file is dozens of lines. Anything bigger is a mistake or an
 * abuse.
 */
export const ENV_SIZE_LIMIT = 64 * 1024

/**
 * The `ssh` object handed to the AI's code.
 *
 * This is a NARROW interface: only a slice of the platform's SSH capabilities.
 * Widening it must be a DELIBERATE step, which is why we do not pass `ssh.ts`
 * through wholesale.
 */
export interface AppSshApi {
  /**
   * Runs a command on the server.
   *
   * ┌──────────────────────────────────────────────────────────────────┐
   * │ IT THROWS ON FAILURE (exit code ≠ 0).                            │
   * │                                                                  │
   * │ This is a DELIBERATE DEPARTURE from the project-wide "does not   │
   * │ throw" rule. The reason: the AI's code DOES NOT CHECK the result │
   * │ —                                                                │
   * │     await ssh('h').command(['docker','restart','bot'])           │
   * │     return { message: 'The bot was restarted' }                  │
   * │ looks natural and the model writes it that way almost every      │
   * │ time. If we returned a result, the user would see "The bot was   │
   * │ restarted" even when `ssh` failed — a SILENT lie.                │
   * │                                                                  │
   * │ A thrown error, on the other hand, is caught in `runAction` and  │
   * │ comes back as `{ ok: false, error }` — the user sees the truth   │
   * │ and the platform stays up.                                       │
   * │                                                                  │
   * │ For code that wants to handle the exit code ITSELF there is      │
   * │ `commandRaw()`.                                                  │
   * └──────────────────────────────────────────────────────────────────┘
   *
   * @param argv The command and its arguments — it MUST be an ARRAY.
   *             Passing a string throws (to prevent shell injection).
   */
  command(argv: string[]): Promise<CommandResult>
  /**
   * The same as `command`, but it DOES NOT THROW on an exit code ≠ 0.
   *
   * For checks like "does this container exist?": `docker inspect` returns 1
   * for a missing container, and that is not an ERROR, it is an ANSWER.
   */
  commandRaw(argv: string[]): Promise<CommandResult>
  /**
   * Writes keys into a `.env`-shaped file (replacing the ones that exist,
   * appending the ones that do not).
   *
   * The values travel over stdin — they do not show up in `ps`.
   */
  writeEnv(path: string, values: Record<string, string>): Promise<void>
  /** Reads a file. Returns `null` when it does not exist (it does not throw). */
  readFile(path: string): Promise<string | null>
}

/**
 * Validates a `.env` key.
 *
 * `manifest-validate.ts` already enforces `SETTING_KEY_PATTERN`, but this
 * layer is called DIRECTLY from the AI's code — that is, the code can supply a
 * name it made up rather than one of the manifest's keys. This second check
 * closes that hole.
 */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Reassembles a `.env` file with the new values.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ WHY WE DO NOT APPEND (`>>`).                                       │
 * │                                                                    │
 * │ Appending is the simplest solution, but the old value STAYS IN THE  │
 * │ FILE. Most `.env` readers take the last value, some take the FIRST  │
 * │ — meaning that after the token is updated the bot may carry on      │
 * │ using the old one. That is a silently broken failure.               │
 * │                                                                    │
 * │ So the file is REASSEMBLED: an existing key is replaced in place    │
 * │ (order and comments are preserved), a missing one is appended at    │
 * │ the end.                                                            │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Comments (`#`) and blank lines are preserved: the file is configuration a
 * human reads, and scrubbing it would throw away the user's work.
 */
export function updateEnvLines(
  existing: string,
  values: Record<string, string>,
): string {
  const remaining = new Map(Object.entries(values))
  const lines = existing.length > 0 ? existing.split('\n') : []
  const result: string[] = []

  for (const line of lines) {
    const equals = line.indexOf('=')
    // A comment or a line with no `=` — it is left as it is
    if (equals <= 0 || line.trimStart().startsWith('#')) {
      result.push(line)
      continue
    }

    const key = line.slice(0, equals).trim()
    if (remaining.has(key)) {
      result.push(`${key}=${escapeEnvValue(remaining.get(key)!)}`)
      remaining.delete(key)
    } else {
      result.push(line)
    }
  }

  // Drop the trailing blank line — new keys appended after it would leave a
  // gap in the middle of the file.
  while (result.length > 0 && result[result.length - 1]!.trim() === '') result.pop()

  for (const [key, value] of remaining) {
    result.push(`${key}=${escapeEnvValue(value)}`)
  }

  return result.join('\n') + '\n'
}

/**
 * Brings a `.env` value into a safe form.
 *
 * `.env` files may be `source`d by a shell, which means a `$(...)` or a
 * backtick inside the value would be executed as a COMMAND. Inside single
 * quotes (`'...'`) the shell interprets nothing — that is the strongest form
 * of escaping.
 *
 * A `'` inside the value becomes `'\''` (close the quote, add an escaped
 * quote, open it again) — the only correct way to do it in POSIX.
 */
export function escapeEnvValue(value: string): string {
  // A newline would split the value across two keys — newlines are removed.
  const cleaned = value.replace(/[\r\n]+/g, ' ')

  // A plain value (letters, digits, a few symbols) needs no quotes, and the
  // file stays comfortable to read.
  if (/^[A-Za-z0-9_./:@+-]*$/.test(cleaned)) return cleaned

  return `'${cleaned.replace(/'/g, "'\\''")}'`
}

/**
 * Builds the `ssh` object for app actions.
 *
 * `serverName` is the host name in the managed config. THE AI'S CODE cannot
 * change it: it is locked inside the closure, so the code cannot wander off to
 * another server.
 */
export function createAppSsh(serverName: string): AppSshApi {
  /** Internal: an ssh call using the managed config */
  async function ssh(parts: string[], stdin?: string): Promise<CommandResult> {
    return sshRun(
      [
        'ssh',
        '-F', managedConfigPath(),
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        serverName,
        ...parts,
      ],
      { ...(stdin !== undefined ? { stdin } : {}), timeoutMs: APP_COMMAND_TIMEOUT_MS },
    )
  }

  /**
   * Validates argv, escapes it and passes it to SSH.
   *
   * ┌──────────────────────────────────────────────────────────────────┐
   * │ THE FIRST LAYER OF INJECTION PROTECTION.                         │
   * │                                                                  │
   * │ If we accepted a string, the AI would write                      │
   * │ \`docker restart ${name}\` and the `name` the user typed would   │
   * │ land in a shell. An array, by contrast, is passed without a      │
   * │ shell — `;` and `$(...)` stay ordinary text.                     │
   * └──────────────────────────────────────────────────────────────────┘
   */
  async function runRaw(argv: string[], name: string): Promise<CommandResult> {
    if (!Array.isArray(argv)) {
      throw new TypeError(
        `ssh.${name}() expects an ARRAY of argv, not a string — for example ` +
          "['docker', 'restart', 'bot']. A shell string is deliberately not accepted.",
      )
    }
    if (argv.length === 0) throw new TypeError(`ssh.${name}(): argv is empty`)

    const cleaned = argv.map((a) => {
      if (typeof a === 'string') return a
      if (typeof a === 'number' || typeof a === 'boolean') return String(a)
      throw new TypeError(`ssh.${name}(): argument must be a string, got ${typeof a}`)
    })

    // The arguments travel over SSH to a remote shell, which means they need
    // escaping once — otherwise an argument containing a space would be split
    // in two.
    return ssh(cleaned.map((a) => escapeEnvValue(a)))
  }

  return {
    async command(argv) {
      const r = await runRaw(argv, 'command')

      // A failed command comes out as an ERROR — see the interface comment
      // above (the AI's code does not check the exit code).
      if (r.code !== 0) {
        const reason =
          r.stderr.trim().split('\n').filter(Boolean).pop() ??
          r.stdout.trim().split('\n').filter(Boolean).pop() ??
          ''
        throw new Error(
          `The command failed (exit code ${r.code})` + (reason ? `: ${reason}` : ''),
        )
      }

      return r
    },

    async commandRaw(argv) {
      return runRaw(argv, 'commandRaw')
    },

    async readFile(path) {
      const r = await ssh(['cat', '--', escapeEnvValue(path)])
      // The file is missing — that is not an ERROR, it is normal on the first
      // configuration.
      if (r.code !== 0) return null
      return r.stdout
    },

    async writeEnv(path, values) {
      for (const key of Object.keys(values)) {
        // `.env` keys are conventionally UPPERCASE, whereas a manifest key is
        // lowercase (`SETTING_KEY_PATTERN`) — the conversion happens on the
        // caller's side, here only the shape is checked.
        if (!ENV_KEY_PATTERN.test(key)) {
          throw new TypeError(
            `ssh.writeEnv(): "${key}" is not a valid env key ` +
              '(letters, digits and `_` only, starting with a letter or `_`)',
          )
        }
      }

      const existing = (await this.readFile(path)) ?? ''
      const updated = updateEnvLines(existing, values)

      if (updated.length > ENV_SIZE_LIMIT) {
        throw new Error(
          `The configuration file has grown too large: ${updated.length} characters, ` +
            `limit ${ENV_SIZE_LIMIT}`,
        )
      }

      // ┌──────────────────────────────────────────────────────────────┐
      // │ AN ATOMIC WRITE — a temporary file plus `mv`.                 │
      // │                                                              │
      // │ Writing directly would leave the file HALF-WRITTEN if the     │
      // │ process were cut off midway (the network dropped, the disk    │
      // │ filled up) and the bot would not come back up. `mv` within    │
      // │ one filesystem is atomic: the file is either the old one or   │
      // │ the new one.                                                  │
      // │                                                              │
      // │ The permissions are 600, as befits a `.env`: it holds a token.│
      // └──────────────────────────────────────────────────────────────┘
      const escapedPath = escapeEnvValue(path)
      const temporary = escapeEnvValue(`${path}.platform-new`)

      const r = await ssh(
        [
          // `cat > file` — the values arrive over STDIN, they do not appear in argv
          `umask 177 && cat > ${temporary} && `+
            // Copy ownership and permissions from the existing file: the bot
            // may run under a different user, and a `root:root 600` file
            // would not be readable by it.
            `{ [ -f ${escapedPath} ] && chown --reference=${escapedPath} ${temporary} 2>/dev/null; true; } && ` +
            `mv -f ${temporary} ${escapedPath}`,
        ],
        updated,
      )

      if (r.code !== 0) {
        // Do not leave the temporary file behind
        await ssh([`rm -f ${temporary}`]).catch(() => undefined)
        throw new Error(
          r.stderr.trim().split('\n').pop() ?? `Could not write the file (exit code ${r.code})`,
        )
      }
    },
  }
}
