// A connection to one MCP server: handshake, tool list, tool call.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ ERROR ISOLATION — the PRIMARY job of this class.                     │
// │                                                                      │
// │ An MCP server is third-party code: it may fail to start, fail to     │
// │ answer, or die midway. In such cases THE SESSION MUST KEEP WORKING — │
// │ the user must not lose the chat because of one broken server.        │
// │                                                                      │
// │ That is why every `McpClient` is independent: its error comes back   │
// │ to the caller as an `Error` (`McpManager` catches it and marks that  │
// │ server as "not working"), and never spreads to the other servers or  │
// │ to the agent stream.                                                 │
// └──────────────────────────────────────────────────────────────────────┘
//
// NO PERMISSION IS ASKED HERE. `call()` does protocol work only. The
// permission layer sits one level above — inside `McpManager.call()`
// (`mcp-manager.ts`). Reason: this class knows nothing about the session or
// the user, it only drives a single connection.

import {
  isResponse,
  MCP_PROTOCOL_VERSION,
  parseCallResult,
  parseTools,
  type JsonRpcResponse,
  type JsonRpcIncoming,
  type McpServerInfo,
  type McpToolResult,
  type McpToolSpec,
} from './mcp-protocol.ts'
import { createHttpTransport, createStdioTransport, type McpTransport } from './mcp-transport.ts'

/** The default timeout for the handshake */
export const MCP_HANDSHAKE_TIMEOUT_MS = 10_000

/** The default timeout for a single tool call */
export const MCP_CALL_TIMEOUT_MS = 30_000

export interface McpConnectionOptions {
  transport: 'stdio' | 'http'
  /** `stdio`: the launch command */
  command?: string
  /** `stdio`: the arguments (with placeholders already substituted) */
  args?: string[]
  /** `http`: the server address */
  url?: string
  /** `stdio`: extra env variables */
  env?: Record<string, string>
  /** `http`: extra headers */
  headers?: Record<string, string>
  handshakeTimeoutMs?: number
  callTimeoutMs?: number
}

interface Pending {
  resolve: (response: JsonRpcResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class McpClient {
  private transport: McpTransport | undefined
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listenerCancel: (() => void) | undefined
  private toolsCache: McpToolSpec[] | undefined
  private connected = false
  private closed = false
  private serverDetails: McpServerInfo | undefined

  constructor(private options: McpConnectionOptions) {}

  /** Whether the handshake has completed */
  get isReady(): boolean {
    return this.connected && !this.closed
  }

  /** What the server said about itself — for diagnostics */
  get info(): McpServerInfo | undefined {
    return this.serverDetails
  }

  /**
   * Connects and performs the handshake: `initialize` →
   * `notifications/initialized`.
   *
   * THROWS — the caller (`McpManager`) catches it and marks the server as not
   * working. The last slice of stderr is appended to the error message:
   * reasons such as "npx: command not found" show up exactly there, and
   * without it the user would have no idea what happened.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.connected) return
    if (this.closed) throw new Error('The MCP client is closed')

    this.transport = this.createTransport()
    this.listenerCancel = this.transport.listen((message) => this.onMessage(message))

    const timeout = this.options.handshakeTimeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS
    try {
      const result = await this.request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          // For now we only have the ability to use tools: we do not declare
          // `roots`/`sampling`, because we do not implement them. Declaring
          // them falsely would have the server send us requests and wait for
          // answers.
          capabilities: {},
          clientInfo: { name: 'platforma', version: '0.1.0' },
        },
        timeout,
        signal,
      )
      this.serverDetails = (result ?? undefined) as McpServerInfo | undefined

      // Required by the spec: a notification is sent after the initialize
      // response. No answer is expected.
      //
      // ITS ERROR IS SWALLOWED. A notification is a one-way message and
      // whether it arrives does not change the connection state: `initialize`
      // already succeeded, so the server is ready.
      //
      // OVER HTTP THIS HAPPENS IN PRACTICE: some servers answer a notification
      // with 4xx (they treat it as an unexpected request). If we did not skip
      // the error, connecting to a working server would fail at this step for
      // nothing.
      try {
        await this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      } catch {
        // see the note above
      }
      this.connected = true
    } catch (error) {
      // The handshake failed — we DO NOT LEAVE the process behind
      const note = this.errorNote()
      await this.disconnect()
      const base = error instanceof Error ? error.message : String(error)
      throw new Error(note ? `${base} (server output: ${note})` : base)
    }
  }

  /**
   * The tools declared by the server.
   *
   * THE RESULT IS CACHED. Per the spec a server may announce that its tool
   * list changed via `notifications/tools/list_changed`, but for now we do not
   * react to it: the tool list is declared to the agent once, at the start of
   * the session, and a mid-session change would not reach the model anyway.
   */
  async listTools(signal?: AbortSignal): Promise<McpToolSpec[]> {
    if (this.toolsCache) return this.toolsCache
    this.checkConnected()
    const result = await this.request(
      'tools/list',
      {},
      this.options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
      signal,
    )
    this.toolsCache = parseTools(result)
    return this.toolsCache
  }

  /**
   * Calls a tool.
   *
   * An `isError: true` result DOES NOT THROW — it reaches the agent as an
   * ordinary result (`mcp-tools.ts` marks it as a tool error). Reason: an
   * answer such as "file not found" is information the model needs in order to
   * work, not a condition that breaks the connection.
   */
  async call(
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    this.checkConnected()
    const result = await this.request(
      'tools/call',
      { name: toolName, arguments: args ?? {} },
      this.options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
      signal,
    )
    return parseCallResult(result)
  }

  /**
   * Drops the connection and kills the process.
   *
   * NEVER THROWS and is safe to call TWICE — that matters during session
   * cleanup (`cleanup()` in `agent.ts` can be reached along several paths).
   */
  async disconnect(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.connected = false

    // Do not leave pending requests hanging forever
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('The MCP connection was closed'))
    }
    this.pending.clear()

    this.listenerCancel?.()
    this.listenerCancel = undefined

    try {
      await this.transport?.close()
    } catch {
      // an error while closing must not break the cleanup
    }
    this.transport = undefined
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private createTransport(): McpTransport {
    if (this.options.transport === 'stdio') {
      if (!this.options.command) throw new Error('no command specified for stdio')
      return createStdioTransport(
        this.options.command,
        this.options.args ?? [],
        this.options.env ?? {},
      )
    }

    if (this.options.transport === 'http') {
      if (!this.options.url) throw new Error('no url specified for http')
      return createHttpTransport(
        this.options.url,
        this.options.headers ?? {},
        this.options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
      )
    }

    throw new Error(`Unknown transport: ${String(this.options.transport)}`)
  }

  private errorNote(): string {
    const t = this.transport as (McpTransport & { errorText?: () => string }) | undefined
    return t?.errorText?.() ?? ''
  }

  private checkConnected(): void {
    if (!this.connected || this.closed) throw new Error('The MCP server is not connected')
  }

  /**
   * Sends a request and waits for the response.
   *
   * It can end in three ways: the response arrived, the timeout elapsed, it
   * was cancelled. In all three the entry is removed from `pending` —
   * otherwise the map would keep growing over a long session.
   */
  private async request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const transport = this.transport
    if (!transport) throw new Error('No MCP transport')
    if (signal?.aborted) throw new Error('Request cancelled')

    const id = this.nextId++

    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const settle = (error?: Error) => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        signal?.removeEventListener('abort', cancel)
        if (error) reject(error)
      }

      const cancel = () => settle(new Error('Request cancelled'))
      const timer = setTimeout(
        () => settle(new Error(`The MCP server did not respond (${method}, ${timeoutMs}ms)`)),
        timeoutMs,
      )
      timer.unref?.()
      signal?.addEventListener('abort', cancel, { once: true })

      this.pending.set(id, {
        resolve: (r) => {
          signal?.removeEventListener('abort', cancel)
          resolve(r)
        },
        reject: (e) => {
          signal?.removeEventListener('abort', cancel)
          reject(e)
        },
        timer,
      })

      transport.send({ jsonrpc: '2.0', id, method, params }).catch((x: unknown) => {
        settle(x instanceof Error ? x : new Error(String(x)))
      })
    })

    if (response.error) {
      throw new Error(`MCP error (${method}): ${response.error.message}`)
    }
    return response.result
  }

  private onMessage(message: JsonRpcIncoming): void {
    // Notifications (`notifications/message`, for instance) are ignored for
    // now: nothing consumes them. In the future `tools/list_changed` will be
    // caught here.
    if (!isResponse(message)) return

    const pending = this.pending.get(message.id)
    if (!pending) return // timed out, or an unknown id
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    pending.resolve(message)
  }
}
