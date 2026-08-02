// Background process management — the layer behind the `process*` tools.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY THIS EXISTS. The `bash` tool ALWAYS waits for the command to     │
// │ finish and enforces a timeout (see `environment.ts`). That is the    │
// │ right behaviour for `bun test` or `git status` — but it makes an     │
// │ entire class of work impossible: `vite dev`, `bun run watch`, any    │
// │ server the user should be able to OPEN IN THE BROWSER while the      │
// │ conversation continues. Through `bash` those either freeze the       │
// │ session or get killed by the timeout after two minutes.              │
// │                                                                      │
// │ This manager runs such commands DETACHED FROM THE TOOL CALL: the     │
// │ tool returns as soon as the process is up, the process keeps running │
// │ between messages, and its output is buffered so the agent can come   │
// │ back and read it later.                                              │
// └──────────────────────────────────────────────────────────────────────┘
//
// LIFECYCLE. A process belongs to a SESSION, not to a single agent stream:
// `cleanup()` in `agent.ts` deliberately does NOT touch it — a dev server
// must survive the turn that started it. It dies in exactly three ways:
//   1) `processStop` — the agent (or the user through the agent) stops it;
//   2) the session registry evicts an idle session (TTL below);
//   3) the server shuts down — `killAllBackgroundProcesses()` is called
//      from `stop()` in `barpo-server`, the same last line of defence as
//      `killAllMcpProcesses()`. Without it `process.exit()` orphans every
//      child and dev servers pile up in the background.
//
// SECURITY. This module does NOT decide whether a command may run — the
// tool layer (`process-tools.ts`) routes every start through the very same
// `assessCommand` + `permission.ask()` chain as `bash`. By the time
// `start()` is called the command has already been vetted.

import { spawn, type ChildProcess } from 'node:child_process'
import { SessionRegistry } from './registry.ts'

/**
 * How many processes one session may keep alive at once.
 *
 * A generous bound: a real project needs a dev server, maybe a watcher and a
 * database — three or four. Hitting eight almost always means the agent is
 * starting duplicates instead of checking `processList`, and the error text
 * tells it exactly that.
 */
export const MAX_PROCESSES = 8

/**
 * How much output (characters) is kept per process — the TAIL, not the head.
 *
 * A dev server logs every request; keeping it all would be a memory leak on
 * a long-running platform. The tail is what diagnoses a problem ("what did
 * it print just now?"), so the oldest text is dropped first and the reader
 * is told how much was lost.
 */
export const MAX_OUTPUT_CHARS = 200_000

/** The grace period between SIGTERM and SIGKILL — same value as the MCP layer */
export const PROCESS_KILL_GRACE_MS = 2000

/**
 * How long an idle session keeps its processes.
 *
 * DELIBERATELY LONGER than the 30-minute default of the other registries.
 * Permission state can be rebuilt on the next request at zero cost; a dev
 * server cannot — evicting it means the user's link goes dead while they
 * are still looking at the page. Two hours of inactivity is a reasonable
 * signal that the session is really over.
 */
export const PROCESS_TTL_MS = 2 * 60 * 60 * 1000

export type ProcessStatus = 'running' | 'exited' | 'killed'

/** One background process, as the tool layer (and the agent) sees it */
export interface ProcessSnapshot {
  id: string
  /** The label shown to the user — the agent picks it, e.g. "dev server" */
  name: string
  command: string
  pid?: number
  status: ProcessStatus
  /** Present once the process has finished */
  exitCode?: number
  startedAt: string
  /** Local URLs detected in the output — the reason most servers are started */
  urls: string[]
}

/** What `readNew()` returns — the output since the previous read */
export interface ProcessOutput {
  snapshot: ProcessSnapshot
  /** New text since the last read (already capped) */
  text: string
  /** Characters lost to the buffer cap BEFORE they were ever read */
  lost: number
}

/**
 * Finds local server URLs in process output.
 *
 * ONLY local addresses are matched. Dev servers print plenty of remote links
 * too (documentation, "read more at https://vitejs.dev/…") — reporting those
 * as "your server is here" would send the user to the wrong place. A host
 * of `0.0.0.0` or `[::]` means "every interface"; a browser cannot open
 * that, so it is rewritten to `localhost`.
 */
export function detectUrls(text: string): string[] {
  const pattern =
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s"'<>)\]]*)?/g
  const found = new Set<string>()
  for (const match of text.matchAll(pattern)) {
    const url = match[0]
      .replace('0.0.0.0', 'localhost')
      .replace('[::1]', 'localhost')
      .replace('[::]', 'localhost')
      // A trailing dot or comma is sentence punctuation, not part of the URL
      .replace(/[.,]$/, '')
    found.add(url)
  }
  return [...found]
}

interface Managed {
  id: string
  name: string
  command: string
  child: ChildProcess
  status: ProcessStatus
  exitCode?: number
  startedAt: string
  /** The kept tail of stdout+stderr, interleaved in arrival order */
  output: string
  /** How many characters have been dropped off the front of `output` */
  dropped: number
  /** The absolute offset up to which the agent has already read */
  cursor: number
  urls: Set<string>
  /** Notified on every output chunk and on exit — `waitForReady` listens here */
  listeners: Set<() => void>
}

// ---------------------------------------------------------------------------
// The live-process set — the last line of defence
// ---------------------------------------------------------------------------
//
// The same pattern as `liveProcesses` in `mcp-transport.ts`, and needed for
// the same reason: `process.exit()` does not kill children. The server's
// `stop()` calls `killAllBackgroundProcesses()` so a restart never leaves a
// dev server behind, holding its port hostage from the next run.

const liveChildren = new Set<ChildProcess>()

/** How many background processes are alive right now — for diagnostics */
export function liveBackgroundProcessCount(): number {
  return liveChildren.size
}

/**
 * Force-kills every background process. No SIGTERM grace — this runs while
 * the server itself is going down, there is no time to wait.
 */
export function killAllBackgroundProcesses(): void {
  for (const child of liveChildren) {
    killTree(child, 'SIGKILL')
  }
  liveChildren.clear()
}

/**
 * Kills the whole process tree, not just the shell.
 *
 * The command runs as `sh -c "…"` — killing only the shell would orphan the
 * actual server underneath it. On POSIX the child is spawned `detached`, so
 * it owns a process GROUP and `kill(-pid)` reaches every descendant (the
 * same mechanism pi-agent-core uses for the bash timeout). Windows has no
 * process groups — `taskkill /T` walks the tree instead.
 */
function killTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
    } else {
      process.kill(-pid, signal)
    }
  } catch {
    // Already dead — exactly the outcome we wanted
  }
}

/**
 * The background processes of ONE session.
 *
 * `Closable`, so it can live in a `SessionRegistry`: eviction kills every
 * process the session left behind.
 */
export class ProcessManager {
  private processes = new Map<string, Managed>()
  private counter = 0

  /** Snapshots of every process, running or finished */
  list(): ProcessSnapshot[] {
    return [...this.processes.values()].map((m) => this.snapshot(m))
  }

  /** How many are RUNNING right now (finished ones do not count to the limit) */
  get runningCount(): number {
    let count = 0
    for (const m of this.processes.values()) if (m.status === 'running') count += 1
    return count
  }

  /**
   * Starts a command in the background. Throws when the per-session limit is
   * reached — the tool layer turns that into a readable error for the agent.
   */
  start(command: string, options: { cwd: string; name?: string }): ProcessSnapshot {
    if (this.runningCount >= MAX_PROCESSES) {
      throw new Error(
        `The session already has ${MAX_PROCESSES} background processes running. ` +
          'Stop one with processStop (check processList) before starting another.',
      )
    }

    const child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      // Its own process group on POSIX, so the whole tree can be killed —
      // the same choice pi-agent-core makes in `NodeExecutionEnv`.
      detached: process.platform !== 'win32',
      // stdin is IGNORED on purpose: a background process asking for input
      // will read EOF and fail fast, instead of waiting forever on a prompt
      // nobody can see.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    })

    this.counter += 1
    const managed: Managed = {
      id: `p${this.counter}`,
      name: options.name ?? command.split(/\s+/).slice(0, 3).join(' '),
      command,
      child,
      status: 'running',
      startedAt: new Date().toISOString(),
      output: '',
      dropped: 0,
      cursor: 0,
      urls: new Set(),
      listeners: new Set(),
    }

    liveChildren.add(child)
    child.stdout?.on('data', (chunk: Buffer) => this.append(managed, chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => this.append(managed, chunk.toString()))
    // `error` fires when the shell itself could not spawn — surface it as
    // output, the same place the agent already looks for problems.
    child.on('error', (error: Error) => {
      this.append(managed, `[spawn error: ${error.message}]\n`)
    })
    child.on('exit', (code: number | null) => {
      liveChildren.delete(child)
      // `killed` set by `stop()` wins — a SIGTERM exit is not a natural one
      if (managed.status === 'running') managed.status = 'exited'
      managed.exitCode = code ?? undefined
      this.notify(managed)
    })

    this.processes.set(managed.id, managed)
    return this.snapshot(managed)
  }

  /**
   * Waits until the process looks READY: a local URL appeared in its output,
   * OR it exited (failed fast — the agent needs to see that immediately, not
   * after the full wait), OR the timeout passed. Resolves with the current
   * snapshot in every case — this never throws.
   *
   * Waiting on the URL rather than a fixed sleep matters for UX: a Vite
   * server prints its address in ~300 ms, and the tool returns right then
   * instead of sitting out the whole timeout.
   */
  waitForReady(id: string, timeoutMs: number): Promise<ProcessSnapshot> {
    const managed = this.processes.get(id)
    if (!managed) return Promise.reject(new Error(`Unknown process id: ${id}`))

    return new Promise((resolve) => {
      const settled = () => managed.status !== 'running' || managed.urls.size > 0

      const finish = () => {
        managed.listeners.delete(check)
        clearTimeout(timer)
        resolve(this.snapshot(managed))
      }
      const check = () => {
        if (settled()) finish()
      }

      const timer = setTimeout(finish, timeoutMs)
      // The timer must not keep the server process alive
      timer.unref?.()

      if (settled()) {
        finish()
        return
      }
      managed.listeners.add(check)
    })
  }

  /**
   * The output produced since the previous read.
   *
   * A CURSOR, not the whole buffer: the agent polls a server repeatedly, and
   * re-sending the same 200 KB of logs every time would flood the context
   * window with text it has already seen.
   */
  readNew(id: string): ProcessOutput | undefined {
    const managed = this.processes.get(id)
    if (!managed) return undefined

    const total = managed.dropped + managed.output.length
    // If the buffer cap dropped text the agent never read, say how much —
    // silence would read as "the process printed nothing".
    const lost = Math.max(0, managed.dropped - managed.cursor)
    const from = Math.max(0, managed.cursor - managed.dropped)
    const text = managed.output.slice(from)
    managed.cursor = total
    return { snapshot: this.snapshot(managed), text, lost }
  }

  /**
   * Stops a process: SIGTERM → grace → SIGKILL, the same two-step dance as
   * the MCP transport and for the same reason — SIGTERM lets a server close
   * its port cleanly, SIGKILL guards against the ones that ignore it.
   */
  stop(id: string): ProcessSnapshot | undefined {
    const managed = this.processes.get(id)
    if (!managed) return undefined
    if (managed.status !== 'running') return this.snapshot(managed)

    managed.status = 'killed'
    killTree(managed.child, 'SIGTERM')
    const timer = setTimeout(() => killTree(managed.child, 'SIGKILL'), PROCESS_KILL_GRACE_MS)
    timer.unref?.()
    managed.child.on('exit', () => clearTimeout(timer))
    return this.snapshot(managed)
  }

  /** Kills everything — registry eviction and tests come through here */
  close(): void {
    for (const managed of this.processes.values()) {
      if (managed.status !== 'running') continue
      managed.status = 'killed'
      // No grace period: eviction means nobody is coming back for this
      // session, there is nothing left to shut down politely.
      killTree(managed.child, 'SIGKILL')
      liveChildren.delete(managed.child)
    }
    this.processes.clear()
  }

  private snapshot(managed: Managed): ProcessSnapshot {
    return {
      id: managed.id,
      name: managed.name,
      command: managed.command,
      ...(managed.child.pid !== undefined ? { pid: managed.child.pid } : {}),
      status: managed.status,
      ...(managed.exitCode !== undefined ? { exitCode: managed.exitCode } : {}),
      startedAt: managed.startedAt,
      urls: [...managed.urls],
    }
  }

  private append(managed: Managed, chunk: string): void {
    managed.output += chunk
    if (managed.output.length > MAX_OUTPUT_CHARS) {
      const excess = managed.output.length - MAX_OUTPUT_CHARS
      managed.output = managed.output.slice(excess)
      managed.dropped += excess
    }
    // A URL can be split across two chunks, so the scan covers the fresh
    // chunk plus a small carry-over window — not the whole 200 KB buffer on
    // every write.
    const window = managed.output.slice(-(chunk.length + 200))
    for (const url of detectUrls(window)) managed.urls.add(url)
    this.notify(managed)
  }

  private notify(managed: Managed): void {
    for (const listener of [...managed.listeners]) {
      try {
        listener()
      } catch {
        // A listener error must not break the output stream
      }
    }
  }
}

/**
 * The registry of managers, keyed by session — the same TTL+LRU mechanism as
 * `permission.ts` and `mode.ts` (rationale in `registry.ts`), with the longer
 * TTL explained on `PROCESS_TTL_MS`.
 */
const managers = new SessionRegistry<ProcessManager>(
  () => new ProcessManager(),
  PROCESS_TTL_MS,
)

export function processManager(sessionId: string): ProcessManager {
  return managers.get(sessionId)
}

export function closeProcessManager(sessionId: string): void {
  managers.close(sessionId)
}

/** How many process managers are currently held — for diagnostics */
export function processManagerCount(): number {
  return managers.count
}

/** For tests: kill everything and clear every manager */
export function clearProcessManagers(): void {
  managers.clear()
}
