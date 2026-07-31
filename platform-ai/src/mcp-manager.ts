// The manager of the MCP servers connected for a session.
//
// TWO JOBS:
//   1) connect to several servers and collect their tools into one list
//      (names get prefixed — `mcp-tools.ts`);
//   2) ASK FOR PERMISSION BEFORE EVERY TOOL CALL.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY PERMISSION LIVES EXACTLY HERE.                                   │
// │                                                                      │
// │ `environment.ts` (`RestrictedEnv`) is the single gate for files and  │
// │ commands: a tool cannot get around it, because the check is INSIDE   │
// │ the method. An MCP call, however, does not fit the `ExecutionEnv`    │
// │ interface — it is neither a file nor a command. So MCP needs a       │
// │ SEPARATE gate, but THE RULE IS THE SAME: the check goes inside the   │
// │ `call()` method, not in the caller. The tool wrappers in           │
// │ `mcp-tools.ts` call only this method, so there is no way to route    │
// │ around the permission.                                               │
// │                                                                      │
// │ The hook layer (`hooks.ts`) IS NOT ENOUGH: it can only add EXTRA     │
// │ restrictions and it DOES NOT ASK for permission. Restricted through  │
// │ a hook, an MCP tool would become "runs without asking, then its      │
// │ result is filtered" — which contradicts the platform's principle     │
// │ that "a dangerous action is asked about beforehand".                 │
// └──────────────────────────────────────────────────────────────────────┘
//
// THE PERMISSION MANAGER IS TAKEN FROM OUTSIDE (not created here). That way
// the "always allow" patterns, the block counters and the classifier context
// share THE SAME state as file/command requests: for the user the permission
// system is one thing, not split by tool kind.

import { redactSecrets } from './hooks.ts'
import { McpClient, type McpConnectionOptions } from './mcp-client.ts'
import type { McpToolResult, McpToolSpec } from './mcp-protocol.ts'
import type { PermissionManager } from './permission.ts'

/** One server that the session should connect to */
export interface McpConnectableServer {
  /** `mcp_servers.id` — for diagnostics and for binding tools */
  id: string
  /** The name the agent sees — the tool prefix is built from it */
  name: string
  config: McpConnectionOptions
}

/** One MCP tool declared to the agent */
export interface McpToolListEntry {
  serverId: string
  serverName: string
  tool: McpToolSpec
}

/** The length limit of `nishon` in a permission request */
const TARGET_LIMIT = 1000

/**
 * Turns the arguments into text for the permission request.
 *
 * SECRET VALUES ARE REDACTED. The arguments are visible to the user in the UI
 * and are written to the audit log; if the agent passed a token as an argument
 * (say `{"token": "ghp_..."}`) it must not reach the screen. THE SAME function
 * as in `hooks.ts` is used — the filter lives in one place.
 *
 * Exported: the test checks this exact output.
 */
export function argsToTarget(args: unknown): string {
  let raw: string
  try {
    raw = JSON.stringify(args ?? {}) ?? '{}'
  } catch {
    // A circular reference or a non-serialisable value — the arguments come
    // from the model, so this is unexpected, but the permission request still
    // has to be shown.
    raw = '(the arguments could not be read)'
  }
  const redacted = redactSecrets(raw)
  return redacted.length > TARGET_LIMIT
    ? `${redacted.slice(0, TARGET_LIMIT)}…`
    : redacted
}

/**
 * The "always allow" pattern.
 *
 * THE GRANULARITY IS AT THE TOOL LEVEL, not at the server level. At the server
 * level, one press of "Always" would permanently open EVERY tool of that
 * server (`read_file` as well as `delete_repo`).
 *
 * AN EXPLICIT TRADEOFF: the argument VALUE is not part of the pattern. Grant
 * "always" to `github.create_issue` and later calls with different arguments
 * pass too. This is the same level as the command pattern (`git push`) in
 * `environment.ts` — deliberately so, for consistency.
 */
export function mcpPattern(serverName: string, toolName: string): string {
  return `mcp:${serverName}.${toolName}`
}

export class McpManager {
  private clients = new Map<string, McpClient>()
  private tools = new Map<string, McpToolSpec[]>()
  private names = new Map<string, string>()
  /** serverId → the connection error. For diagnostics and the UI. */
  private errors = new Map<string, string>()
  private closed = false

  constructor(
    readonly sessionId: string,
    private ruxsat: PermissionManager,
  ) {}

  /** How many servers are connected */
  get connectedCount(): number {
    return this.clients.size
  }

  /** The servers that failed to connect: serverId → error text */
  get connectionErrors(): ReadonlyMap<string, string> {
    return this.errors
  }

  /**
   * Connects to the given servers and collects their tool lists.
   *
   * NEVER THROWS and EVERY SERVER IS INDEPENDENT. If one fails to start (`npx`
   * not found, no token, a timeout) the error is recorded in `errors` and the
   * rest carry on. Reason: the user must not lose the whole chat because of
   * one broken server — the same rule as in `builtin-skills.ts` and
   * `project-context.ts` ("the convenience layer does not bring the session
   * down").
   *
   * It connects IN PARALLEL: if 5 servers connected one after another with a
   * 10-second timeout, starting a session could stretch to 50 seconds.
   */
  async connect(servers: readonly McpConnectableServer[], signal?: AbortSignal): Promise<void> {
    if (this.closed) return

    await Promise.all(
      servers.map(async (s) => {
        this.names.set(s.id, s.name)
        const client = new McpClient(s.config)
        try {
          await client.connect(signal)
          const tools = await client.listTools(signal)
          // The stream may have been cancelled in the meantime
          if (this.closed) {
            await client.disconnect()
            return
          }
          this.clients.set(s.id, client)
          this.tools.set(s.id, tools)
        } catch (error) {
          this.errors.set(s.id, error instanceof Error ? error.message : String(error))
          // Do not leave a half-connected client behind
          await client.disconnect().catch(() => undefined)
        }
      }),
    )
  }

  /** The tools declared to the agent — together with the server name */
  list(): McpToolListEntry[] {
    const result: McpToolListEntry[] = []
    for (const [serverId, tools] of this.tools) {
      const serverName = this.names.get(serverId) ?? serverId
      for (const tool of tools) result.push({ serverId, serverName, tool })
    }
    return result
  }

  /**
   * Calls a tool — AFTER PERMISSION.
   *
   * If permission is not granted an ERROR IS THROWN: the agent sees it as a
   * tool error and looks for another way. The same behaviour as a denied
   * action in `environment.ts`.
   */
  async call(
    serverId: string,
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    const client = this.clients.get(serverId)
    const serverName = this.names.get(serverId) ?? serverId
    if (!client) {
      const reason = this.errors.get(serverId)
      throw new Error(
        reason
          ? `MCP server not connected: ${serverName} (${reason})`
          : `MCP server not found: ${serverName}`,
      )
    }

    const answer = await this.ruxsat.sora({
      tur: 'mcp',
      amal: `${serverName}.${toolName}`,
      nishon: argsToTarget(args),
      sabab: `the "${toolName}" tool of the "${serverName}" MCP server reaches an external system`,
      naqsh: mcpPattern(serverName, toolName),
    })

    if (answer === 'deny') {
      throw new Error(`Permission denied: ${serverName}.${toolName}`)
    }

    return client.call(toolName, args, signal)
  }

  /**
   * Closes every connection — LEAVING NO ZOMBIE PROCESS happens here.
   *
   * Called from `cleanup()` in `agent.ts`. Safe to call twice and never throws:
   * cleanup must run to completion in every case.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    const clients = [...this.clients.values()]
    this.clients.clear()
    this.tools.clear()

    await Promise.all(clients.map((c) => c.disconnect().catch(() => undefined)))
  }
}
