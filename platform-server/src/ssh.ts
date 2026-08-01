// SSH layer — the whole mechanism behind passwordless connections to servers.
//
// The model:
//
//   1) PLATFORM KEY — ~/.barpo/ssh/id_ed25519 (+ .pub). DELIBERATELY kept
//      separate from the user's personal key: revoking the platform means
//      removing this one key from the server, the personal key is untouched.
//
//   2) MANAGED CONFIG — ~/.barpo/ssh/config. One Host block per server
//      (alias, host, port, user, key). Only a SINGLE `Include` line is added
//      to ~/.ssh/config — nothing else in the user's file is touched. That is
//      also why `ssh <server-name>` works straight from the terminal.
//
//   3) KEY INSTALL — on the first connection the public key is appended to
//      root's authorized_keys. Two routes: if the user's existing key already
//      gets in (BatchMode), no password is needed at all; otherwise a one-off
//      password is passed via sshpass (the SSHPASS env var — it never appears
//      in argv and is NEVER WRITTEN to the database).
//
// Every external command goes through `CommandRunner` — tests swap it for a
// fake runner (the same style as `setDb`).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Server, ServerMetrics } from '@barpo/shared'

// ---------------------------------------------------------------------------
// Command runner (swapped out in tests)
// ---------------------------------------------------------------------------

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Options for running a command.
 *
 * `stdin` — THE CHANNEL FOR SECRET DATA. A token passed as an argument would
 * show up in the server's `ps` output and in the shell history; stdin goes
 * only to the process itself (`ssh.writeEnv()` relies on this).
 *
 * `timeoutMs` — to override the default limit: `docker restart` plus a
 * healthcheck does not fit into 20 seconds (`action-run.ts`).
 */
export interface CommandOptions {
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export type CommandRunner = (
  argv: string[],
  options?: CommandOptions,
) => Promise<CommandResult>

/** Keep an SSH session from hanging — a JS-side limit on top of ConnectTimeout */
const COMMAND_TIMEOUT_MS = 20_000

const defaultRunner: CommandRunner = async (argv, options) => {
  const stdin = options?.stdin

  const proc = Bun.spawn(argv, {
    env: { ...process.env, ...options?.env },
    stdout: 'pipe',
    stderr: 'pipe',
    // When not supplied, `ignore` — the previous behaviour is preserved (so
    // the process does not hang waiting on stdin).
    stdin: stdin === undefined ? 'ignore' : 'pipe',
  })

  // Start writing IMMEDIATELY, without `await`: with a large stdin and a full
  // pipe, waiting for the write to finish without draining the output would
  // deadlock — both sides would be waiting for each other.
  if (stdin !== undefined) {
    const write = (async () => {
      try {
        proc.stdin!.write(stdin)
        await proc.stdin!.end()
      } catch {
        // The process may have exited without reading stdin (EPIPE) — that
        // does not invalidate the command result, the exit code speaks for
        // itself.
      }
    })()
    // Make sure the error is not swallowed silently
    void write
  }

  const timer = setTimeout(() => proc.kill(), options?.timeoutMs ?? COMMAND_TIMEOUT_MS)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

let runner: CommandRunner = defaultRunner

/** For tests: install a fake runner (null — restore the default) */
export function setCommandRunner(r: CommandRunner | null): void {
  runner = r ?? defaultRunner
}

/**
 * Runs a command through the current runner.
 *
 * Exposed for `app-ssh.ts`: it also has to go through the FAKE runner,
 * otherwise app-action tests would call the real `ssh`. Referring to this
 * module's `runner` variable directly would capture a copy at import time
 * (and `setCommandRunner` would then have no effect).
 */
export function sshRun(
  argv: string[],
  options?: CommandOptions,
): Promise<CommandResult> {
  return runner(argv, options)
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The platform SSH directory (key + config + known_hosts). Relocatable via env in tests. */
export function sshRoot(): string {
  const env = process.env.PLATFORM_SSH?.trim()
  if (env) return env
  return join(homedir(), '.barpo', 'ssh')
}

/** The user's ~/.ssh/config file. Relocatable via env in tests. */
export function userSshConfigPath(): string {
  const env = process.env.PLATFORM_USER_SSH_CONFIG?.trim()
  if (env) return env
  return join(homedir(), '.ssh', 'config')
}

export function keyPath(): string {
  return join(sshRoot(), 'id_ed25519')
}

export function managedConfigPath(): string {
  return join(sshRoot(), 'config')
}

function knownHostsPath(): string {
  return join(sshRoot(), 'known_hosts')
}

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

/**
 * Guarantees the platform key pair exists and returns the PUBLIC key text.
 * The key is generated once, without a passphrase (`-N ''`) — with one, the
 * whole point of "passwordless connections" would disappear.
 */
export async function ensureKey(): Promise<string> {
  const secret = keyPath()
  const publicKey = `${secret}.pub`

  mkdirSync(sshRoot(), { recursive: true, mode: 0o700 })

  if (!existsSync(publicKey)) {
    const r = await runner([
      'ssh-keygen',
      '-t', 'ed25519',
      '-N', '',
      '-C', 'barpo',
      '-f', secret,
      '-q',
    ])
    if (r.code !== 0) {
      throw new Error(`ssh-keygen error: ${r.stderr.trim() || r.stdout.trim()}`)
    }
  }

  return readFileSync(publicKey, 'utf-8').trim()
}

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

/**
 * Rewrites the managed config IN FULL from the server list in the database.
 * The database is the source of truth — hand edits to the file are lost on
 * the next write (the same rule as `.barpo/skills/` for skills).
 *
 * `UserKnownHostsFile` + `accept-new` live here: the host key is not asked
 * for on the first connection (an interactive prompt would hang the server)
 * and the user's ~/.ssh/known_hosts is left alone as well.
 */
export function writeManagedConfig(servers: Server[]): void {
  mkdirSync(sshRoot(), { recursive: true, mode: 0o700 })

  const header =
    '# Managed by the platform — DO NOT EDIT BY HAND.\n' +
    '# Rewritten in full from the server list in the database on every save.\n'

  const blocks = servers.map((s) =>
    [
      `Host ${s.name}`,
      `  HostName ${s.host}`,
      `  User ${s.username}`,
      `  Port ${s.port}`,
      `  IdentityFile ${keyPath()}`,
      '  IdentitiesOnly yes',
      `  UserKnownHostsFile ${knownHostsPath()}`,
      '  StrictHostKeyChecking accept-new',
    ].join('\n'),
  )

  writeFileSync(managedConfigPath(), `${header}\n${blocks.join('\n\n')}\n`, { mode: 0o600 })
}

/**
 * Adds the `Include` line at the TOP of ~/.ssh/config (once).
 *
 * IT MUST BE AT THE TOP: in OpenSSH an `Include` that comes AFTER some `Host`
 * block belongs to that block and does not apply globally. The existing
 * contents stay unchanged below it.
 */
export function ensureInclude(): void {
  const path = userSshConfigPath()
  const line = `Include ${managedConfigPath()}`

  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : ''
  if (existing.split('\n').some((l) => l.trim() === line)) return

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const note = '# Platform servers (line added automatically)\n'
  writeFileSync(path, `${note}${line}\n\n${existing}`)
  chmodSync(path, 0o600)
}

// ---------------------------------------------------------------------------
// Installing the key on a server
// ---------------------------------------------------------------------------

/** Shared ssh options — during the install step the server is not in the config yet */
function connectionOptions(port: number): string[] {
  return [
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${knownHostsPath()}`,
    '-p', String(port),
  ]
}

/**
 * The script that appends the public key to the remote user's authorized_keys.
 * Idempotent: if the key is already there it is not written again (grep -qxF).
 * An ed25519 key consists only of [A-Za-z0-9+/= -] characters — safe inside a
 * single pair of quotes.
 */
function installScript(publicKey: string): string {
  return (
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ' +
    'touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ' +
    `{ grep -qxF '${publicKey}' ~/.ssh/authorized_keys || echo '${publicKey}' >> ~/.ssh/authorized_keys; }`
  )
}

export interface InstallTarget {
  host: string
  port: number
  username: string
}

/**
 * Installs the platform public key on a server.
 *
 * The order:
 *   1) try without a password — if the user's existing keys (ssh-agent,
 *      ~/.ssh/id_*) already get in, no password is needed at all;
 *   2) if a password was supplied — a one-off authentication via sshpass.
 *
 * On failure it throws a precise error meant to be shown to the user.
 */
export async function installKey(target: InstallTarget, password?: string): Promise<void> {
  const publicKey = await ensureKey()
  const script = installScript(publicKey)
  const destination = `${target.username}@${target.host}`

  // 1) Try with the existing keys. BatchMode — do not ask for a password
  // (the prompt would hang unanswered inside the server process).
  const withKey = await runner([
    'ssh',
    '-o', 'BatchMode=yes',
    ...connectionOptions(target.port),
    destination,
    script,
  ])
  if (withKey.code === 0) return

  if (!password) {
    throw new Error(
      `Could not log in to ${destination} with your existing SSH keys. ` +
        `Enter a password or install your key on the server first. ` +
        `(ssh: ${withKey.stderr.trim().split('\n').pop() ?? 'unknown error'})`,
    )
  }

  // 2) With a password — sshpass is required.
  if (!Bun.which('sshpass')) {
    throw new Error(
      "Connecting with a password requires 'sshpass' to be installed " +
        '(brew install sshpass or apt install sshpass).',
    )
  }

  // The password travels via the SSHPASS env var (-e): it never appears in
  // argv, so `ps` cannot see it either.
  const withPassword = await runner(
    [
      'sshpass',
      '-e',
      'ssh',
      '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'PubkeyAuthentication=no',
      ...connectionOptions(target.port),
      destination,
      script,
    ],
    { env: { SSHPASS: password } },
  )
  if (withPassword.code !== 0) {
    const reason = withPassword.stderr.trim().split('\n').pop() ?? ''
    if (withPassword.code === 5 || /denied/i.test(reason)) {
      throw new Error(`Wrong password, or ${destination} does not allow password logins.`)
    }
    throw new Error(
      `Could not connect to ${destination}: ${reason || `exit code ${withPassword.code}`}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Checks and metrics
// ---------------------------------------------------------------------------

/**
 * Confirms that a passwordless connection works through the managed config.
 * With `-F` ONLY the platform config is read — the user's personal settings
 * (ProxyJump and so on) cannot interfere with the platform's behaviour.
 */
export async function checkConnection(name: string): Promise<void> {
  const r = await runner([
    'ssh',
    '-F', managedConfigPath(),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    name,
    'true',
  ])
  if (r.code !== 0) {
    throw new Error(r.stderr.trim().split('\n').pop() ?? `ssh exit code ${r.code}`)
  }
}

/**
 * All the metrics in a single SSH call. The output lines are KEY=value, so
 * the parser does not depend on their order and a missing line simply leaves
 * that metric field empty.
 */
const METRICS_SCRIPT = [
  `echo "UPTIME=$(uptime -p 2>/dev/null || uptime)"`,
  `echo "LOAD=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"`,
  `echo "NPROC=$(nproc 2>/dev/null || echo 1)"`,
  `free -b 2>/dev/null | awk '/^Mem:/{print "RAM="$2" "$3}'`,
  `df -kP / 2>/dev/null | awk 'NR==2{print "DISK="$2" "$3}'`,
].join('; ')

/** "up 3 days, 4 hours" → "3 days 4 hours" — tidies up the uptime output */
function formatUptime(raw: string): string {
  return raw
    .replace(/^up\s+/, '')
    .replace(/,/g, '')
    .trim()
}

function percent(used: number, total: number): number | undefined {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return undefined
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)))
}

/** Turns METRICS_SCRIPT output into ServerMetrics (kept separate for tests) */
export function parseMetrics(stdout: string): ServerMetrics {
  const values = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) values.set(line.slice(0, i), line.slice(i + 1).trim())
  }

  const m: ServerMetrics = { status: 'connected' }

  const uptime = values.get('UPTIME')
  if (uptime) m.uptime = formatUptime(uptime)

  const load = Number(values.get('LOAD'))
  const nproc = Number(values.get('NPROC'))
  if (Number.isFinite(load) && Number.isFinite(nproc) && nproc > 0) {
    m.cpu = Math.min(100, Math.max(0, Math.round((load / nproc) * 100)))
  }

  const ram = values.get('RAM')?.split(' ').map(Number)
  if (ram?.length === 2) m.ram = percent(ram[1]!, ram[0]!)

  const disk = values.get('DISK')?.split(' ').map(Number)
  if (disk?.length === 2) m.disk = percent(disk[1]!, disk[0]!)

  return m
}

/** Reads a server's live status. If it cannot connect, status='error' is returned (it does NOT throw). */
export async function fetchMetrics(name: string): Promise<ServerMetrics> {
  let r: CommandResult
  try {
    r = await runner([
      'ssh',
      '-F', managedConfigPath(),
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      name,
      METRICS_SCRIPT,
    ])
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }

  if (r.code !== 0) {
    return {
      status: 'error',
      error: r.stderr.trim().split('\n').pop() ?? `ssh exit code ${r.code}`,
    }
  }

  return parseMetrics(r.stdout)
}
