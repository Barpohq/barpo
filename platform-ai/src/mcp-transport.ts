// The MCP transport layer — how messages get delivered.
//
// The client (`mcp-client.ts`) KNOWS NOTHING about transport details: it only
// sends JSON-RPC messages and listens for incoming ones. That is why stdio and
// HTTP work with the same client code.
//
// stdio — a local process (`npx`/`uvx`/`docker`), newline-delimited JSON over
//         stdin/stdout. Most of the ecosystem works this way.
// http  — a remote server (`streamable-http`/`sse`), added in stage 3.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NO SHELL IS USED. `Bun.spawn(argv)` takes an argv ARRAY — not a      │
// │ command line. Meaning text like `;rm -rf ~` inside an argument stays │
// │ a plain string and is never executed.                                │
// │                                                                      │
// │ This is the official MCP spec recommendation. The warning in the     │
// │ `Argument` definition: "Clients should prefer non-shell execution    │
// │ methods (e.g. posix_spawn) when possible to eliminate injection      │
// │ risks entirely."                                                     │
// │                                                                      │
// │ Arguments coming from the registry contain placeholders such as      │
// │ `{token}` — those too live INSIDE THIS ARRAY and are substituted     │
// │ with `String.replace` (`mcp-registry.ts`), so they never go near a   │
// │ shell.                                                               │
// └──────────────────────────────────────────────────────────────────────┘

import type { JsonRpcIncoming, JsonRpcRequest, JsonRpcNotification } from './mcp-protocol.ts'

export interface McpTransport {
  /** Sends a single JSON-RPC message (a request or a notification) */
  send(xabar: JsonRpcRequest | JsonRpcNotification): Promise<void>
  /** Listens for incoming messages. Returns a cancel function. */
  listen(fn: (xabar: JsonRpcIncoming) => void): () => void
  /**
   * Closes the transport — kills the process or drops the connection.
   *
   * NEVER THROWS: closing must run to completion in every case, otherwise the
   * process would be left orphaned.
   */
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Process abstraction (swapped out in tests)
// ---------------------------------------------------------------------------

/**
 * The surface of a spawned process that we actually need.
 *
 * A NARROW slice of what `Bun.spawn` returns. Deliberately narrow: the fake
 * process in a test has to implement only these five members, not the dozens
 * of fields on `Subprocess`.
 */
export interface McpProcess {
  /** Write to the server (stdin) */
  yoz(matn: string): void
  /** Text coming from the server (stdout) — a raw stream, not split into lines */
  chiqishniTingla(fn: (chunk: string) => void): void
  /** The diagnostic stream (stderr) — NOT part of the protocol */
  xatoOqiminiTingla(fn: (chunk: string) => void): void
  /** Graceful stop (SIGTERM) */
  toxtat(): void
  /** Forced kill (SIGKILL) */
  old(): void
  /** Wait for the process to finish */
  tugadi: Promise<number>
}

export type ProcessSpawner = (
  argv: string[],
  env: Record<string, string>,
) => McpProcess

/**
 * Env variables that can alter process behaviour — DENIED.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS LIST IS NEEDED — A REAL ATTACK PATH.                        │
 * │                                                                      │
 * │ An MCP server's `server.json` file DECLARES which env variables it   │
 * │ asks for (`environmentVariables[].name`), and that file is written   │
 * │ by a THIRD PARTY: it comes from the official registry or from a      │
 * │ scanned GitHub repo.                                                 │
 * │                                                                      │
 * │ Without the list the attack would go like this: the author of a      │
 * │ malicious entry points `command`/`args` at a TRUSTED package         │
 * │ (an official MCP server, say) — the user sees the command in the UI  │
 * │ and trusts it. But the entry also carries a "setting" that reads     │
 * │ `{"name": "NODE_OPTIONS", "default": "--require=/tmp/x.js"}`. The    │
 * │ default value would arrive PRE-FILLED into the UI input and would    │
 * │ even pass the "required field" check, meaning one button press by    │
 * │ the user would launch foreign code — inside the process of a         │
 * │ trusted package.                                                     │
 * │                                                                      │
 * │ That would break the platform's transparency guarantee of "we show   │
 * │ you which command runs": the command is visible, the env is NOT.     │
 * │                                                                      │
 * │ THE CHECK LIVES EXACTLY HERE — the last point before `spawn`. The    │
 * │ layers above (`mcp-connect.ts`, `routes/mcp.ts`) filter too, but     │
 * │ they can be bypassed; this one cannot (the same rule as "the check   │
 * │ goes inside the method" in `environment.ts`).                        │
 * └──────────────────────────────────────────────────────────────────────┘
 */
const TAQIQLANGAN_ENV = new Set([
  // Dynamic loader — runs arbitrary code
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  // Node/Bun: loads a module via `--require`
  'NODE_OPTIONS',
  'BUN_INSPECT',
  'BUN_INSPECT_CONNECT_TO',
  // Python: code such as `-c`, or swapping the import path
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  // Executable lookup — pointing at a fake `npx`
  'PATH',
  'NODE_PATH',
  // Code via a startup file if a shell is launched
  'BASH_ENV',
  'ENV',
  'SHELL',
  'IFS',
  // Perl/Ruby loaders
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
])

/**
 * Strips dangerous env keys.
 *
 * The comparison is UPPERCASED: `ld_preload` and `LD_PRELOAD` behave the same
 * way on some systems, so we do not rely on letter case.
 *
 * Exported — the test checks this exact function.
 */
export function sanitiseEnv(env: Record<string, string>): {
  toza: Record<string, string>
  tashlangan: string[]
} {
  const toza: Record<string, string> = {}
  const tashlangan: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (TAQIQLANGAN_ENV.has(name.toUpperCase())) {
      tashlangan.push(name)
      continue
    }
    toza[name] = value
  }
  return { toza, tashlangan }
}

/**
 * The default implementation on top of `Bun.spawn`.
 *
 * `env` IS MERGED WITH THE PROCESS ENV: MCP servers usually rely on `PATH`
 * (so that npx/uvx can be found) and on `HOME`. If we launched them with only
 * the given values, they would not come up at all.
 *
 * BUT the keys that alter process behaviour ARE STRIPPED (see the
 * `TAQIQLANGAN_ENV` note) — they keep their real value from `process.env`.
 */
const defaultProcessSpawner: ProcessSpawner = (argv, env) => {
  const { toza, tashlangan } = sanitiseEnv(env)
  if (tashlangan.length > 0) {
    // We do not drop them silently: the user needs to know why their setting
    // had no effect, and this log line helps spot a malicious entry.
    console.warn(
      `[mcp] dangerous env variables ignored: ${tashlangan.join(', ')}`,
    )
  }

  const proc = Bun.spawn(argv, {
    env: { ...process.env, ...toza },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const writer = proc.stdin

  return {
    yoz(text) {
      writer.write(text)
      writer.flush()
    },
    chiqishniTingla(fn) {
      void readStream(proc.stdout, fn)
    },
    xatoOqiminiTingla(fn) {
      void readStream(proc.stderr, fn)
    },
    toxtat() {
      proc.kill('SIGTERM')
    },
    old() {
      proc.kill('SIGKILL')
    },
    tugadi: proc.exited,
  }
}

/** Turns a ReadableStream into text chunks */
async function readStream(stream: ReadableStream<Uint8Array>, fn: (b: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  try {
    for await (const chunk of stream) {
      fn(decoder.decode(chunk, { stream: true }))
    }
  } catch {
    // The stream breaks when the process closes — that is normal, not an error
  }
}

let processSpawner: ProcessSpawner = defaultProcessSpawner

/**
 * For tests: swap the process spawner (`null` — the default).
 *
 * The same style as `setCommandRunner()` in `ssh.ts`.
 */
export function setProcessSpawner(s: ProcessSpawner | null): void {
  processSpawner = s ?? defaultProcessSpawner
}

// ---------------------------------------------------------------------------
// The live process registry — the last line of defence
// ---------------------------------------------------------------------------
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY IT IS NEEDED. Processes are closed at THREE LAYERS:              │
// │   1) `McpClient.disconnect()` — the normal path;                             │
// │   2) `cleanup()` in `agent.ts` — when the stream ends or is           │
// │      cancelled;                                                      │
// │   3) THIS REGISTRY — when the server receives `SIGTERM`.             │
// │                                                                      │
// │ The third one is essential, because `process.exit()` DOES NOT KILL   │
// │ child processes: they are orphaned, and the node processes spawned   │
// │ by `npx` keep running in the background. In production this slowly   │
// │ turns into dozens of orphaned processes.                             │
// └──────────────────────────────────────────────────────────────────────┘

const liveProcesses = new Set<McpProcess>()

/** How many MCP processes are currently considered live — for diagnostics */
export function liveProcessCount(): number {
  return liveProcesses.size
}

/**
 * Force-kills every live MCP process.
 *
 * `toxtat()` in `platform-server/src/index.ts` calls this. It DOES NOT WAIT
 * for SIGTERM: we have no time on our hands before the process goes down, so
 * it goes straight to SIGKILL.
 */
export function killAllMcpProcesses(): void {
  for (const proc of liveProcesses) {
    try {
      proc.old()
    } catch {
      // it may already be dead
    }
  }
  liveProcesses.clear()
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

/** The grace period allowed between SIGTERM and SIGKILL */
export const KILL_GRACE_MS = 2000

/**
 * The maximum number of characters kept from stderr.
 *
 * A server may write unbounded logs to stderr (some log every call). Keeping
 * all of it would be a memory leak, so only the LAST slice is retained — it is
 * exactly the final lines that are needed to explain a connection error.
 */
const MAX_STDERR = 4000

export function createStdioTransport(
  command: string,
  args: string[],
  env: Record<string, string> = {},
): McpTransport & { errorText(): string } {
  const proc = processSpawner([command, ...args], env)
  liveProcesses.add(proc)
  // Drop it from the registry even when the process dies on its own —
  // otherwise the `Set` would fill up with dead entries on a long-running
  // server.
  void proc.tugadi.then(
    () => liveProcesses.delete(proc),
    () => liveProcesses.delete(proc),
  )

  const listeners = new Set<(x: JsonRpcIncoming) => void>()
  let buffer = ''
  let stderrText = ''
  let closed = false

  proc.chiqishniTingla((chunk) => {
    buffer += chunk
    // Newline-delimited JSON: every complete line is one message.
    // The last (unfinished) chunk stays in the buffer.
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue

      let message: JsonRpcIncoming
      try {
        message = JSON.parse(line) as JsonRpcIncoming
      } catch {
        // A non-JSON line — the server may have written a log to stdout. It
        // does not break the protocol, so we skip it.
        continue
      }

      for (const fn of listeners) {
        try {
          fn(message)
        } catch {
          // A listener error must not break the stream
        }
      }
    }
  })

  proc.xatoOqiminiTingla((chunk) => {
    stderrText = (stderrText + chunk).slice(-MAX_STDERR)
  })

  return {
    async send(xabar) {
      if (closed) throw new Error('The MCP transport is closed')
      proc.yoz(`${JSON.stringify(xabar)}\n`)
    },

    listen(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },

    /**
     * Stops the process: SIGTERM → wait → SIGKILL.
     *
     * WHY TWO STEPS. SIGTERM gives the server a chance to clean up its own
     * resources (some of them close their child processes). But there are
     * servers that never respond to it — hence SIGKILL after 2 seconds. With
     * SIGKILL alone the server might orphan its grandchild processes; with
     * SIGTERM alone the process could hang around forever.
     */
    async close() {
      if (closed) return
      closed = true
      listeners.clear()
      liveProcesses.delete(proc)

      try {
        proc.toxtat()
      } catch {
        // it may already be dead
      }

      const killTimer = setTimeout(() => {
        try {
          proc.old()
        } catch {
          // fine if it died in the meantime
        }
      }, KILL_GRACE_MS)
      // Do not let the timer hold the process alive on Node/Bun
      killTimer.unref?.()

      try {
        await proc.tugadi
      } catch {
        // an exit error must not stop closing either
      } finally {
        clearTimeout(killTimer)
      }
    },

    /** To explain a connection error — the last slice of stderr */
    errorText() {
      return stderrText.trim()
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP transport (streamable-http va sse)
// ---------------------------------------------------------------------------
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THE FUNDAMENTAL DIFFERENCE FROM STDIO: NO STREAM, REQUEST-RESPONSE.  │
// │                                                                      │
// │ With stdio there is one continuous stream and responses are matched  │
// │ by `id`. Over HTTP every `send()` is a separate POST and the        │
// │ response comes back as the answer to EXACTLY THAT request.           │
// │                                                                      │
// │ To keep the client interface identical we read the response inside   │
// │ the POST and hand it to the `listen()` listeners — for the client    │
// │ this is indistinguishable from stdio. That is why not a single       │
// │ conditional had to be added to `mcp-client.ts`.                      │
// └──────────────────────────────────────────────────────────────────────┘
//
// TWO VARIANTS IN ONE CLASS. The difference between `streamable-http` (new)
// and `sse` (old) is the response format: the first is plain JSON, the second
// is `text/event-stream`. We detect it from `Content-Type`, so there is no
// need for a separate class. Both kinds show up in the registry.

/** The default timeout for an HTTP request */
export const HTTP_TIMEOUT_MS = 30_000

/**
 * Extracts JSON-RPC messages from an SSE response.
 *
 * Format: `data: {...}` lines, events separated by a blank line. We only need
 * `data` — the `event`/`id`/`retry` fields are not used in MCP.
 *
 * Exported because it is tested separately (SSE parsing is the most
 * error-prone spot).
 */
export function parseSseMessages(text: string): JsonRpcIncoming[] {
  const messages: JsonRpcIncoming[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      messages.push(JSON.parse(payload) as JsonRpcIncoming)
    } catch {
      // Non-JSON `data` — we skip it (the same rule as with stdio)
    }
  }
  return messages
}

export function createHttpTransport(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs: number = HTTP_TIMEOUT_MS,
): McpTransport & { errorText(): string } {
  const listeners = new Set<(x: JsonRpcIncoming) => void>()
  let closed = false
  let lastError = ''
  /**
   * The session id handed out by the server.
   *
   * Spec: if the server returns an `Mcp-Session-Id` header in the `initialize`
   * response, EVERY subsequent request must carry it. Without it the server
   * answers 400 with "no session".
   */
  let sessionId: string | undefined

  const dispatch = (message: JsonRpcIncoming) => {
    for (const fn of listeners) {
      try {
        fn(message)
      } catch {
        // A listener error must not break the transport
      }
    }
  }

  return {
    async send(xabar) {
      if (closed) throw new Error('The MCP transport is closed')

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // We accept both formats — the server picks
          Accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
          ...headers,
        },
        body: JSON.stringify(xabar),
        signal: AbortSignal.timeout(timeoutMs),
      })

      const newSession = response.headers.get('Mcp-Session-Id')
      if (newSession) sessionId = newSession

      if (!response.ok) {
        // The body may carry the reason for the error — we keep it for diagnostics
        lastError = (await response.text().catch(() => '')).slice(0, 500)
        throw new Error(`MCP HTTP error: ${response.status} ${response.statusText}`)
      }

      // For a notification (no `id`) the server returns 202 and an empty body
      if (response.status === 204 || !response.body) return

      const contentType = response.headers.get('Content-Type') ?? ''
      const text = await response.text()
      if (!text.trim()) return

      if (contentType.includes('text/event-stream')) {
        for (const x of parseSseMessages(text)) dispatch(x)
        return
      }

      try {
        const raw = JSON.parse(text) as JsonRpcIncoming | JsonRpcIncoming[]
        // The server may return a batch
        for (const x of Array.isArray(raw) ? raw : [raw]) dispatch(x)
      } catch {
        lastError = text.slice(0, 500)
        throw new Error('The MCP response is not JSON')
      }
    },

    listen(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },

    /**
     * Over HTTP there is no process to kill — we only clear the listeners and
     * stop accepting new requests.
     */
    async close() {
      closed = true
      listeners.clear()
    },

    errorText() {
      return lastError.trim()
    },
  }
}
