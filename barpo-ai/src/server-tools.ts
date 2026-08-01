// The `serverList` tool — it shows the agent the servers connected to the platform.
//
// WHY IT IS NEEDED. The agent can run `ssh <name> ...` through `bash` (which
// works without a password thanks to the managed ssh config — see
// `barpo-server/src/ssh.ts`), BUT it does not know which names exist. If the
// user says "check the disk space on the web server", the agent would be forced
// to guess a name. This tool closes that gap: the list of names → then the work
// with `bash`.
//
// SCOPE — READ ONLY. The tool does NOT CONNECT to a server, makes no SSH call
// and knows nothing about live status. It merely returns the connection records
// from the database. Performing an action on a server goes through `bash`, which
// means `command-analysis.ts` and the permission mechanism apply in full — this
// tool DOES NOT OPEN a side door around them.
//
// WHY IT DOES NOT ASK FOR PERMISSION. The same logic as the search tools (the
// comment at the top of `search-tools.ts`): this is a read operation by nature,
// it changes nothing, and it returns the list of servers the user THEMSELVES
// added to the platform. Asking permission for every listing would lead to
// "permission fatigue".
//
// PRIVACY. The output contains host/port/user — these are needed in order to
// connect and the user sees them in the UI anyway. There is no PASSWORD, because
// one is never stored at all (`ssh.ts`). The SSH key is not emitted either.
//
// LAYER BOUNDARY. The servers live in SQLite, that is, in `barpo-server`.
// `@barpo/ai` however DOES NOT DEPEND on the server (the dependency runs
// only the other way) — so the list arrives here by INVERSION: the caller
// supplies a `ServerProvider` function. That is why this file knows neither the
// database nor `repo.ts`.

import { Type, type Static } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { SearchTool } from './search-tools.ts'

/**
 * The server record the tool sees.
 *
 * The NEEDED part of the `Server` type in `@barpo/shared`. Deliberately
 * narrow: only the fields shown to the agent live here, so that if a more
 * sensitive field is added to `Server` in future (a token, say) it does not
 * end up in this tool's output BY ITSELF.
 */
export interface ServerRecord {
  /** SSH alias — `ssh <name>` works with this name */
  name: string
  host: string
  port: number
  username: string
}

/**
 * The provider that supplies the list of servers (given by the caller).
 *
 * It is read afresh ON EVERY CALL, never cached: the user may add or remove a
 * server during the conversation, and the agent must not look at a stale list
 * and try to connect to a server that no longer exists.
 */
export type ServerProvider = () => ServerRecord[] | Promise<ServerRecord[]>

/** Detail for the UI and the logs */
export interface ServerDetail {
  count: number
}

const serverListSchema = Type.Object({})

export type ServerListInput = Static<typeof serverListSchema>

/**
 * Turns the list into text laid out as a table.
 *
 * The columns are aligned — not necessary for the model, but this text becomes
 * a tool card and is shown to the USER in the UI as well.
 *
 * The default port (22) is shown deliberately: the agent should not have to
 * guess whether `ssh -p` is needed.
 */
export function serversToText(servers: ServerRecord[]): string {
  if (servers.length === 0) {
    return [
      'No servers are connected to this platform yet.',
      "The user adds them from the platform's 'Servers' page.",
    ].join(' ')
  }

  const header = ['NAME', 'HOST', 'PORT', 'USER']
  const rows = servers.map((s) => [s.name, s.host, String(s.port), s.username])
  const widths = header.map((_, i) =>
    Math.max(header[i]!.length, ...rows.map((r) => r[i]!.length)),
  )

  const align = (r: string[]) =>
    r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd()

  return [
    align(header),
    ...rows.map(align),
    '',
    "To run a command on a server, use `bash` with `ssh <NAME> '<command>'` —",
    'passwordless access is already configured.',
  ].join('\n')
}

/**
 * Creates the `serverList` tool.
 *
 * The context (`env.cwd`) IS NOT NEEDED BY THIS TOOL — servers do not depend on
 * the working directory. But the `SearchTool` shape is kept, because
 * `prepareTools()` puts every tool through the same wrapper and passes the
 * context as the last argument.
 */
export function createServerListTool(
  provider: ServerProvider,
): SearchTool<ServerListInput, ServerDetail> {
  return {
    name: 'serverList',
    label: 'serverList',
    description: [
      'List the servers connected to this platform.',
      'Returns each server as name, host, port and username — no live status, no metrics.',
      'The name is an SSH alias: passwordless `ssh <name>` already works from bash,',
      'so use this tool first when the user refers to a server by name or asks what servers exist.',
      'Read-only and needs no permission prompt; running anything on a server still goes through bash.',
    ].join(' '),
    parameters: serverListSchema,
    async execute(): Promise<AgentToolResult<ServerDetail>> {
      const servers = await provider()
      return {
        content: [{ type: 'text', text: serversToText(servers) }],
        details: { count: servers.length },
      }
    },
  }
}

/**
 * The server tools — the raw shape, with no context attached.
 *
 * If no provider was given an EMPTY list comes back: the tool is not declared
 * at all, which means the agent does not know it exists. That is better than
 * "present, but always empty" — the model then does not keep trying a
 * capability that is not there. (The same logic as the disabled-tool handling
 * in `prepareTools()`.)
 */
export function serverToolsRaw(provider?: ServerProvider): SearchTool<never>[] {
  if (!provider) return []
  return [createServerListTool(provider)] as unknown as SearchTool<never>[]
}

/**
 * The server tools — the shape with the context attached (for tests and direct
 * use; `agent.ts` wraps the raw shape itself).
 */
export function serverTools(provider?: ServerProvider): AgentTool<never>[] {
  return serverToolsRaw(provider).map((tool) => ({
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
 * The same reason as `SEARCH_PROMPT_SECTION`: the tool's behaviour and the text
 * describing it should live in ONE FILE, otherwise the two slowly drift apart.
 *
 * The prompt is added CONDITIONALLY (`agent.ts`): with no provider there is no
 * tool, and writing about it then would only distract the model.
 */
export const SERVER_PROMPT_SECTION = {
  /** The line appended to the tool list */
  list: ['- serverList: the servers connected to this platform (name, host, port, user)'],
  /** The instruction on how to use it */
  rules: [
    'When the user refers to a server by name, or asks which servers exist,',
    'call `serverList` first — NEVER guess a server name.',
    'To run something on a server, use `bash` with `ssh <name> \'<command>\'`;',
    'passwordless access is already configured. Remote commands follow the same',
    'permission rules as local ones.',
  ],
} as const
