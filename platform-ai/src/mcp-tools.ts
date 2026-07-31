// Declaring MCP tools to the agent.
//
// The same "provider inversion" pattern as `server-tools.ts` /
// `dashboard-tools.ts`: with no manager given an EMPTY list comes back,
// meaning no tool is declared at all and the prompt does not say a single word
// about MCP. The agent DOES NOT KNOW that MCP exists.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THE FUNDAMENTAL DIFFERENCE FROM THOSE: THE TOOLS ARE DYNAMIC.        │
// │                                                                      │
// │ `serverList` and `appPublish` are each a single static tool whose    │
// │ name is known up front and which sits in the `agent.tools.enabled`   │
// │ config list.                                                         │
// │                                                                      │
// │ MCP tools, on the other hand, are UNKNOWN until the session starts:  │
// │ which servers are installed comes from the database, and which tools │
// │ they offer is determined from the server itself (`tools/list`). So   │
// │ they cannot be written into a static config list.                    │
// │                                                                      │
// │ THE SOLUTION: NO config flag at all. The control is at install time: │
// │ if no server is installed, `mcpProvider` returns an empty list → no  │
// │ manager is created → this function returns `[]`. Installing is       │
// │ already a deliberate act; putting a flag on top of it would drop the │
// │ user into the "why isn't it working" state.                          │
// └──────────────────────────────────────────────────────────────────────┘

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { McpManager } from './mcp-manager.ts'
import type { SearchTool } from './search-tools.ts'

/** Detail for the UI and the logs */
export interface McpToolDetail {
  serverName: string
  toolName: string
  /** Whether the MCP tool itself reported a failure — shown on the tool card */
  isError?: boolean
}

/** The prefix of the tool names the agent sees */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * Sanitises a name so it can be used in a tool identifier.
 *
 * The model has to return the tool name EXACTLY, so only safe characters may
 * remain in it. Registry names are reverse-DNS (`io.github.owner/repo`) — we
 * turn the `.` and `/` in them into `_`.
 *
 * The same idea as `safeName` in `skill-store.ts`, but that one lives in
 * `platform-server` and this package does not depend on it.
 */
export function safeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown'
}

/**
 * The full tool name the agent sees.
 *
 * COLLISION RESOLUTION: if two different MCP servers offer the same tool name
 * (both having a `search`, say), without a prefix they would become
 * indistinguishable and the model would not know which one it called. Since
 * the server name is part of the prefix, that cannot happen.
 *
 * The `__` separator: MCP tool names are usually restricted to
 * `[a-zA-Z0-9_-]`, so two underscores rarely occur naturally. This also
 * matches the convention used in Claude Code.
 */
export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${safeToolName(serverName)}__${toolName}`
}

/** Whether a tool name belongs to an MCP tool */
export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX)
}

/**
 * Returns the MCP tools in raw form (with no context bound).
 *
 * With no manager given, or when no tool is found — an empty list.
 *
 * `execute` DOES NOT USE THE CONTEXT (`env.cwd` is meaningless for MCP), but it
 * conforms to the `SearchTool` shape: `agent.ts` puts every tool through the
 * same wrapper (`serverList` does exactly the same).
 */
export function mcpToolsRaw(manager?: McpManager): SearchTool<never>[] {
  if (!manager) return []

  const tools = manager.list().map(({ serverId, serverName, tool }) => {
    const name = mcpToolName(serverName, tool.name)
    return {
      name,
      label: name,
      // The server name goes into the description as well: so the model knows
      // which system it is working with without having to read the prefix.
      description: [`[MCP: ${serverName}]`, tool.description ?? `the ${tool.name} tool`].join(' '),
      // The JSON Schema is passed through DIRECTLY. The type of
      // `SearchTool.parameters` is `unknown` — DELIBERATELY, for exactly this
      // case. Converting it could break the MCP server's schema.
      parameters: tool.inputSchema,
      async execute(
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<McpToolDetail>> {
        // THE PERMISSION CHECK IS INSIDE THIS CALL — the `call()` method
        // (`mcp-manager.ts`) calls `ask()` itself. There is NO extra check
        // here: one gate, not two places.
        const result = await manager.call(serverId, tool.name, params, signal)
        const content = result.content.map((c) => ({
          type: 'text' as const,
          text: c.text ?? '',
        }))
        // If the tool itself returned a failing result the agent has to SEE
        // that — otherwise it treats the failure as a success and moves on.
        // `AgentToolResult` carries no `isError` field, so the failure is
        // marked in the text instead.
        return {
          content: result.isError
            ? [{ type: 'text' as const, text: `The MCP tool reported an error:\n${content.map((c) => c.text).join('\n')}` }]
            : content,
          details: { serverName, toolName: tool.name, isError: result.isError },
        }
      },
    }
  })

  return tools as unknown as SearchTool<never>[]
}

/**
 * The MCP tools — the context-bound form (for tests and direct use; `agent.ts`
 * wraps the raw form itself).
 */
export function mcpTools(manager?: McpManager): AgentTool<never>[] {
  return mcpToolsRaw(manager).map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: never) =>
      tool.execute(toolCallId, params, signal, onUpdate, { env: { cwd: '' } }),
  })) as unknown as AgentTool<never>[]
}

/**
 * The section appended to `AGENT_SYSTEM_PROMPT`.
 *
 * It is added ONLY WHEN MCP TOOLS EXIST (the `hasMcp` flag in `agent.ts`).
 * Otherwise the model would waste time thinking about a capability that is not
 * there — the same rule as `SERVER_PROMPT_SECTION`.
 */
export const MCP_PROMPT_SECTION = {
  list: [
    "- mcp__<server>__<tool>: tools from MCP servers connected to this platform",
  ],
  rules: [
    'MCP TOOLS. The prefix in the name tells you which server a tool comes from',
    '(`mcp__github__create_issue` → the `github` server). Their descriptions come',
    'from the server itself — read them to decide when a tool applies.',
    '',
    'These tools act on EXTERNAL systems, not on the working directory: creating',
    'issues, sending messages, querying remote APIs. That means their effects are',
    'usually NOT reversible by editing a file. Use them when the task calls for',
    'that system, and prefer a read-only tool over a writing one when both would',
    'answer the question.',
    '',
    'Each call may ask the user for permission — that is normal, the same rule as',
    'for bash. If permission is denied you get an error: explain it and suggest',
    'another way.',
  ],
} as const
