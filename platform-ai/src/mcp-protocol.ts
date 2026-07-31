// MCP (Model Context Protocol) JSON-RPC shapes — ONLY the part we need.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY WE DID NOT TAKE THE OFFICIAL SDK.                                │
// │                                                                      │
// │ `@modelcontextprotocol/sdk` — 4.1 MB, 693 files, 17 dependencies     │
// │ (`express`, `cors`, `hono`, `jose`, `pkce-challenge`,                │
// │ `express-rate-limit`...). Almost all of them are for the SERVER side │
// │ or for OAuth; we only need the client.                               │
// │                                                                      │
// │ The decisive reason is TESTING. The SDK's `StdioClientTransport`     │
// │ uses `cross-spawn`, meaning it cannot be swapped out with the        │
// │ project's `setCommandRunner()` injection pattern. And we need to     │
// │ fake the process spawn.                                             │
// │                                                                      │
// │ THE COST IS EXPLICIT: as the spec grows (resources, prompts,         │
// │ sampling) we have to track it by hand. For now only `tools/*` is     │
// │ needed. OAuth servers DO NOT WORK EITHER — only static credentials   │
// │ (env or an HTTP header).                                             │
// └──────────────────────────────────────────────────────────────────────┘
//
// The project's philosophy ("we do not invent our own standard — we lean on
// MCP") is not violated: it is about the STANDARD, not about the client
// implementation. We speak the standard protocol, we just write the library
// ourselves.

/**
 * The protocol version we declare.
 *
 * The server may return a DIFFERENT version and that is NOT AN ERROR: per the
 * spec the client adapts to the server's answer. We only declare the version,
 * we do not validate the value in the response — otherwise every spec update
 * would leave working servers unable to connect.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

/** A notification — NO response is expected (no `id`) */
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: JsonRpcError
}

export type JsonRpcIncoming = JsonRpcResponse | JsonRpcNotification

/** Whether an incoming message is a response (has an id) or a notification */
export function isResponse(x: JsonRpcIncoming): x is JsonRpcResponse {
  return typeof (x as JsonRpcResponse).id === 'number'
}

/**
 * A tool declared by the server.
 *
 * `inputSchema` is a JSON Schema. It is passed DIRECTLY to the agent tool
 * (`parameters`): the type of `SearchTool.parameters` is `unknown`, so no
 * conversion is needed (see `mcp-tools.ts`).
 */
export interface McpToolSpec {
  name: string
  description?: string
  inputSchema: unknown
}

/** The result of `tools/call` */
export interface McpToolResult {
  content: { type: string; text?: string }[]
  /**
   * How the server signals that the tool run failed.
   *
   * IMPORTANT: this is NOT a JSON-RPC error. At the protocol level the call
   * succeeded, it is only the tool itself that returned a failing result (say
   * "file not found"). The two are distinguished: a JSON-RPC error is thrown
   * as an `Error`, whereas this reaches the agent as an ordinary result.
   */
  isError?: boolean
}

/** The `initialize` response — we need it only for diagnostics */
export interface McpServerInfo {
  protocolVersion?: string
  serverInfo?: { name?: string; version?: string }
  capabilities?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Extracts the tool list from a `tools/list` result.
 *
 * TOLERANT OF MALFORMED SHAPES: if `tools` is not an array, or an element has
 * no `name`, that element is dropped silently and no error is thrown. Reason:
 * a single broken tool definition must not take the whole server out of
 * service. The server is third-party code and its full conformance to the spec
 * cannot be relied upon.
 */
export function parseTools(result: unknown): McpToolSpec[] {
  if (!result || typeof result !== 'object') return []
  const raw = (result as { tools?: unknown }).tools
  if (!Array.isArray(raw)) return []

  const tools: McpToolSpec[] = []
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const spec = t as { name?: unknown; description?: unknown; inputSchema?: unknown }
    if (typeof spec.name !== 'string' || !spec.name) continue
    tools.push({
      name: spec.name,
      description: typeof spec.description === 'string' ? spec.description : undefined,
      // An empty object when there is no schema: the model calls it without
      // arguments. Leaving `undefined` could break the provider request.
      inputSchema: spec.inputSchema ?? { type: 'object', properties: {} },
    })
  }
  return tools
}

/**
 * Normalises a `tools/call` result.
 *
 * The server may return non-text content (`image`, `resource`) — for now those
 * are NOT SKIPPED, they turn into a placeholder text that names the kind.
 * Reason: telling the agent "the result is empty" would be a lie — it would
 * retry and waste time.
 */
export function parseCallResult(result: unknown): McpToolResult {
  if (!result || typeof result !== 'object') {
    return { content: [{ type: 'text', text: '' }] }
  }
  const raw = result as { content?: unknown; isError?: unknown }
  const isError = raw.isError === true

  if (!Array.isArray(raw.content)) {
    return { content: [{ type: 'text', text: '' }], isError }
  }

  const content = raw.content.map((c) => {
    if (!c || typeof c !== 'object') return { type: 'text', text: String(c ?? '') }
    const part = c as { type?: unknown; text?: unknown }
    const kind = typeof part.type === 'string' ? part.type : 'text'
    if (kind === 'text') {
      return { type: 'text', text: typeof part.text === 'string' ? part.text : '' }
    }
    return { type: kind, text: `[${kind} — non-text content]` }
  })

  return { content, isError }
}
