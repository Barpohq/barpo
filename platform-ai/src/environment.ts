// The restricted execution environment — locks the tools into the working
// directory.
//
// pi-agent-core's `NodeExecutionEnv` has NO limits whatsoever: in testing it
// read /etc/passwd and managed a `cd /`. That is the right decision for pi (a
// trusted local CLI), but on the platform the text the LLM reads is
// untrusted — prompt injection can tell it "now read ~/.ssh".
//
// So this wrapper checks the path before every file operation:
//   inside the working directory → passes
//   outside                      → the user is asked for permission
//   denied                       → FileError("permission_denied")
//
// `canonicalPath` guards against escaping via a symlink: when the file
// exists its REAL location is checked, so a symlink inside the working
// directory pointing at /etc is caught too.
//
// LIMITATION: this is a protective layer, not a sandbox. Once a command run
// through `bash` has passed our check it is not restricted at the operating
// system level. Real isolation would mean rewriting ExecutionEnv on top of
// Docker — which is exactly why the interface delegates everything.

import {
  ExecutionError,
  FileError,
  NodeExecutionEnv,
  type ExecutionEnv,
  type FileInfo,
  type Result,
  type ShellExecOptions,
} from '@earendil-works/pi-agent-core/node'
import { existsSync, realpathSync } from 'node:fs'
import { assessCommand } from './command-analysis.ts'
import type { PermissionManager } from './permission.ts'

/**
 * The default timeout of the `bash` tool.
 *
 * Why is it needed? Without a timeout on `exec()` a command can hang
 * INDEFINITELY: `npm install` waits on the network, `vite dev` or `tail -f`
 * never finish at all, and an interactive command (`git rebase -i`, a
 * password prompt) sits waiting for input. In a CLI a human breaks out of
 * this with Ctrl+C — on a web platform there is nobody to do that: the agent
 * loop freezes on an `await`, the session stays frozen in the "answer
 * streaming" state, and the user's only way out is pressing "Stop".
 *
 * 2 minutes was chosen: `bun install`, `tsc` and an average test suite fit
 * within it, while it is still not an unbounded wait.
 *
 * IN FUTURE: this value will come from the config layer (some projects will
 * need it raised for longer builds). For now it is a constant — one place to
 * change is enough. It can already be overridden via
 * `RestrictedEnvOptions.buyruqTimeoutMs`; the config will simply supply that
 * value.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000

/** The error for an operation that failed the path check */
function denyError(yol: string, sabab: string): FileError {
  return new FileError('permission_denied', `Permission denied: ${sabab}`, yol)
}

export interface RestrictedEnvOptions {
  /** The directory the tools work in — everything outside it is asked about */
  workDir: string
  ruxsat: PermissionManager
  /** Replaces the inner environment, for tests */
  ichki?: ExecutionEnv
  /**
   * The default timeout for a command (ms). Defaults to
   * `DEFAULT_COMMAND_TIMEOUT_MS`. If the caller passes an explicit timeout to
   * `exec`, that one wins.
   */
  buyruqTimeoutMs?: number
}

export class RestrictedEnv implements ExecutionEnv {
  readonly cwd: string
  private ichki: ExecutionEnv
  private ruxsat: PermissionManager
  private buyruqTimeoutMs: number
  /** Paths already allowed in this stream — they are not asked about again */
  private allowed = new Set<string>()

  constructor(sozlama: RestrictedEnvOptions) {
    // The working directory ITSELF is canonicalised too.
    //
    // The reason: the path check compares against `canonicalPath`, so both
    // sides of the boundary have to be in the same form. On macOS `/var/...`
    // is really a symlink to `/private/var/...` — if the boundary stayed a raw
    // path, every file INSIDE the working directory would look "outside" and
    // the agent would ask permission even to read a file in its own directory.
    //
    // On error (the directory does not exist yet) the raw path stays — that
    // does not weaken the protection, because the check works by prefix
    // regardless.
    let cwd = sozlama.workDir
    try {
      cwd = realpathSync(sozlama.workDir)
    } catch {
      // the directory has not been created yet — carry on with the raw path
    }

    this.cwd = cwd
    this.ichki = sozlama.ichki ?? new NodeExecutionEnv({ cwd })
    this.ruxsat = sozlama.ruxsat
    this.buyruqTimeoutMs = sozlama.buyruqTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  }

  // -------------------------------------------------------------------------
  // The boundary check
  // -------------------------------------------------------------------------

  /** Whether the path is inside the working directory — textually (for files that do not exist) */
  private isInside(absolutYol: string): boolean {
    return absolutYol === this.cwd || absolutYol.startsWith(`${this.cwd}/`)
  }

  /**
   * Validates the path. If it is inside it passes straight through, otherwise
   * permission is requested. `amal` is which tool is asking (shown in the UI).
   */
  private async validatePath(yol: string, amal: string): Promise<Result<string, FileError>> {
    const absolute = await this.ichki.absolutePath(yol)
    if (!absolute.ok) return absolute

    let toCheck = absolute.value

    // Catch escapes via a symlink: when the file exists we take its real
    // location. When it does not (a new file) the textual path is enough —
    // its parent directory has to be inside regardless.
    const canonical = await this.ichki.canonicalPath(absolute.value)
    if (canonical.ok) toCheck = canonical.value

    if (this.isInside(toCheck)) return { ok: true, value: absolute.value }

    // Has it already been allowed in this stream?
    if (this.allowed.has(toCheck)) return { ok: true, value: absolute.value }

    const javob = await this.ruxsat.ask({
      kind: 'file',
      action: amal,
      target: toCheck,
      reason: 'a file outside the working directory',
      pattern: `${amal}:${toCheck}`,
    })

    if (javob === 'deny') {
      return { ok: false, error: denyError(toCheck, 'outside the working directory') }
    }
    this.allowed.add(toCheck)
    return { ok: true, value: absolute.value }
  }

  // -------------------------------------------------------------------------
  // FileSystem — reading
  // -------------------------------------------------------------------------

  async absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    // Resolving a path is safe in itself — the check happens on the real operation
    return this.ichki.absolutePath(path, abortSignal)
  }

  async joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.ichki.joinPath(parts, abortSignal)
  }

  async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const validated = await this.validatePath(path, 'read')
    if (!validated.ok) return validated
    return this.ichki.readTextFile(validated.value, abortSignal)
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>> {
    const validated = await this.validatePath(path, 'read')
    if (!validated.ok) return validated
    return this.ichki.readTextLines(validated.value, options)
  }

  async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    const validated = await this.validatePath(path, 'read')
    if (!validated.ok) return validated
    return this.ichki.readBinaryFile(validated.value, abortSignal)
  }

  async fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    const validated = await this.validatePath(path, 'read')
    if (!validated.ok) return validated
    return this.ichki.fileInfo(validated.value, abortSignal)
  }

  async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    const validated = await this.validatePath(path, 'read')
    if (!validated.ok) return validated
    return this.ichki.listDir(validated.value, abortSignal)
  }

  async canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.ichki.canonicalPath(path, abortSignal)
  }

  async exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    // `exists` is the most harmless operation, but it can be used to "feel
    // around" the file system. For a path outside we do not ask permission, we
    // simply return `false`: the agent should not learn what is out there.
    const absolute = await this.ichki.absolutePath(path, abortSignal)
    if (!absolute.ok) return absolute
    const canonical = await this.ichki.canonicalPath(absolute.value, abortSignal)
    const toCheck = canonical.ok ? canonical.value : absolute.value
    if (!this.isInside(toCheck) && !this.allowed.has(toCheck)) {
      return { ok: true, value: false }
    }
    return this.ichki.exists(absolute.value, abortSignal)
  }

  // -------------------------------------------------------------------------
  // FileSystem — writing
  // -------------------------------------------------------------------------

  async writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const validated = await this.validatePath(path, 'write')
    if (!validated.ok) return validated
    return this.ichki.writeFile(validated.value, content, abortSignal)
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const validated = await this.validatePath(path, 'write')
    if (!validated.ok) return validated
    return this.ichki.appendFile(validated.value, content, abortSignal)
  }

  async createDir(
    path: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    const validated = await this.validatePath(path, 'write')
    if (!validated.ok) return validated
    return this.ichki.createDir(validated.value, options)
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    // Deletion is always asked about, even inside the working directory.
    // There is no `remove` among the tools (read/write/edit/bash), but the
    // interface requires it and the protection stays for future tools.
    const absolute = await this.ichki.absolutePath(path, options?.abortSignal)
    if (!absolute.ok) return absolute

    const javob = await this.ruxsat.ask({
      kind: 'file',
      action: 'remove',
      target: absolute.value,
      reason: 'deletes a file or directory',
      pattern: `remove:${absolute.value}`,
    })
    if (javob === 'deny') {
      return { ok: false, error: denyError(absolute.value, 'the deletion was denied') }
    }
    return this.ichki.remove(absolute.value, options)
  }

  async createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.ichki.createTempDir(prefix, abortSignal)
  }

  async createTempFile(options?: {
    prefix?: string
    suffix?: string
    abortSignal?: AbortSignal
  }): Promise<Result<string, FileError>> {
    return this.ichki.createTempFile(options)
  }

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    const assessment = assessCommand(command, {
      workDir: this.cwd,
      // Does the `cp`/`mv` target already exist — if so it gets overwritten,
      // which means permission is asked. `existsSync` is fine here: the
      // analysis is synchronous, and the command waits in this process anyway.
      exists: (path) => existsSync(path),
    })

    // A hard deny — it reaches neither the classifier nor the user.
    // This is the one unconditional guarantee: every other defence is
    // probabilistic.
    if (assessment.category === 'forbidden') {
      // The decision is recorded so the user can see WHY the command did not
      // run. This is the only way — permission is never asked here at all.
      this.ruxsat.recordForbidden(assessment.pattern)
      return {
        ok: false,
        error: new ExecutionError(
          'spawn_error',
          `Forbidden command: ${assessment.reason ?? 'it would damage the system'}`,
        ),
      }
    }

    if (assessment.category !== 'safe') {
      const javob = await this.ruxsat.ask({
        tur: 'command',
        amal: 'bash',
        nishon: command,
        sabab: assessment.reason ?? 'an unvetted command',
        naqsh: assessment.pattern,
      })
      if (javob === 'deny') {
        return {
          ok: false,
          error: new ExecutionError(
            'spawn_error',
            `Permission denied: ${assessment.reason ?? 'the command was denied'}`,
          ),
        }
      }
    }

    // The command always starts in the working directory.
    //
    // Timeout: `ShellExecOptions.timeout` is IN SECONDS and by default absent
    // entirely (an unbounded wait). If the caller passed an explicit value it
    // stays, otherwise we apply the default limit — without it a command that
    // never finishes (`tail -f`, `vite dev`, one asking for a password) would
    // freeze the whole session.
    return this.ichki.exec(command, {
      ...options,
      cwd: options?.cwd ?? this.cwd,
      timeout: options?.timeout ?? Math.ceil(this.buyruqTimeoutMs / 1000),
    })
  }

  async cleanup(): Promise<void> {
    await this.ichki.cleanup()
  }
}
