// Turning a database MCP server row into a CONNECTION CONFIG.
//
// This layer is the bridge between `orchestrator.ts` and `barpo-ai`: the
// database (catalog + install + credentials) → `McpConnectableServer`.
//
// VALUES ARE GATHERED FROM THREE SOURCES:
//   1) the catalog entry — command, args, url, and the settings SCHEMA;
//   2) the install row — the NON-SECRET values (`setting_values`);
//   3) the credential store — the SECRET values (a separate file, not the DB).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ PLACEHOLDERS ARE SUBSTITUTED HERE.                                   │
// │                                                                      │
// │ In registry entries the arguments and headers may be templates:      │
// │ `Bearer {api_key}`. They are substituted with a plain text operation │
// │ BEFORE anything is handed to `Bun.spawn`, and the result becomes an  │
// │ element of the argv ARRAY — no shell is involved at any point.       │
// └──────────────────────────────────────────────────────────────────────┘

import type { McpConnectableServer } from '@barpo/ai'
import type { McpInstall, McpServer } from '@barpo/shared'
import { mcpCredentialStore } from './mcp-credentials.ts'
import { substitutePlaceholders } from './mcp-registry.ts'

/**
 * Picks which install's values a session should use.
 *
 * The same server can be installed both globally AND for a project — in that
 * case the PROJECT install wins: a narrower scope means a more specific
 * configuration (a token dedicated to this project, for example).
 *
 * Exported — a test checks precisely this choice.
 */
export function pickInstall(
  server: McpServer,
  projectId: string | null,
): McpInstall | undefined {
  if (projectId) {
    const project = server.installs.find(
      (i) => i.scope === 'project' && i.projectId === projectId,
    )
    if (project) return project
  }
  return server.installs.find((i) => i.scope === 'global')
}

/**
 * Turns a database server row into a connection config.
 *
 * A `null` return means the server is not used in this session (no install
 * was found).
 *
 * NO TIMEOUT IS SET HERE: that is a platform setting and `agent.ts` applies
 * it from the config. This layer only says "where and how to connect".
 */
export async function buildMcpConfig(
  server: McpServer,
  projectId: string | null,
): Promise<McpConnectableServer | null> {
  const install = pickInstall(server, projectId)
  if (!install) return null

  // The open values come from the database, the secrets from a separate file.
  // They are MERGED: one server may ask for both `BASE_URL` (open) and
  // `TOKEN` (secret).
  const secrets = await mcpCredentialStore().get(install.id)
  const values: Record<string, string> = { ...install.settingValues, ...secrets }

  // The default values declared in the schema — for the fields the user left
  // blank. They have the LOWEST precedence.
  const full: Record<string, string> = {}
  for (const field of server.settings) {
    if (field.default !== undefined) full[field.name] = field.default
  }
  Object.assign(full, values)

  if (server.transport === 'stdio') {
    if (!server.command) return null
    return {
      id: server.id,
      name: server.name,
      config: {
        transport: 'stdio',
        command: server.command,
        args: (server.args ?? []).map((a) => substitutePlaceholders(a, full)),
        // The env comes from the setting fields. Only what the SCHEMA
        // declares is passed through: any other key the user supplied must
        // not reach the process (`full` also holds the defaults, but those
        // came from the schema too).
        env: buildEnv(server, full),
      },
    }
  }

  if (!server.url) return null
  return {
    id: server.id,
    name: server.name,
    config: {
      transport: 'http',
      url: substitutePlaceholders(server.url, full),
      headers: buildHeaders(server, full),
    },
  }
}

/**
 * The env object for stdio.
 *
 * Every field in the schema that has a value is added. Empty values are
 * DROPPED: on some servers an empty env variable reads as "given, but empty"
 * and is handled differently from "not given at all".
 */
function buildEnv(server: McpServer, values: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const field of server.settings) {
    const value = values[field.name]
    if (value) env[field.name] = value
  }
  return env
}

/**
 * The headers for HTTP.
 *
 * In the registry a header value is a template (`Bearer {api_key}`) and
 * arrives in the SCHEMA as `value`. Our schema, however, only keeps the field
 * names, so the header value is exactly what the user typed. If they did not
 * write the `Bearer ` prefix themselves, that is their decision — we do not
 * guess.
 */
function buildHeaders(
  server: McpServer,
  values: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const field of server.settings) {
    const value = values[field.name]
    if (value) headers[field.name] = substitutePlaceholders(value, values)
  }
  return headers
}

/**
 * The list of servers a session can connect to.
 *
 * `orchestrator.ts` hands this function to `agentStream()` as the
 * `mcpProvider`. Entries that cannot be connected (no install, no command)
 * are dropped silently — the session has to start regardless.
 */
export async function connectableServers(
  servers: readonly McpServer[],
  projectId: string | null,
): Promise<McpConnectableServer[]> {
  const result: McpConnectableServer[] = []
  for (const server of servers) {
    const config = await buildMcpConfig(server, projectId)
    if (config) result.push(config)
  }
  return result
}
