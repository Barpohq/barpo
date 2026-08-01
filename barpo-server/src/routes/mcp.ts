// The MCP servers API — catalog, connecting a source, installing.
//
// The model: source → catalog entry → install (a scope).
// In detail: migrations/011-mcp-servers.ts.
//
// The same shape as `routes/skills.ts`. THREE DIFFERENCES:
//
//   1) THE REGISTRY IS TWO-STAGE. On GitHub one repo means several skills and
//      all of them land in the catalog. In the registry one search returns
//      many INDEPENDENT servers and the user picks exactly one. That is why
//      `search` (stores nothing) and `add` (stores) are separate.
//
//   2) SECRET VALUES ARE NEVER RETURNED. The catalog and install responses
//      only carry the "is it set" information, never the token.
//
//   3) THERE IS NO STORE. An MCP server has no files that land on disk — the
//      process fetches its own package with `npx`/`uvx`. So no layer like
//      `skill-store.ts` is needed.
//
// NETWORK REQUESTS live in this layer: the registry API and GitHub. Both have
// a timeout (`mcp-registry.ts`, `github.ts`).

import { Hono } from 'hono'
import type { McpCatalogEntry, McpScope, McpSettingField } from '@barpo/shared'
import { auditWrite } from '../audit.ts'
import { parseGithubRef } from '../github.ts'
import { scanMcpSource } from '../mcp-github.ts'
import { mcpCredentialStore } from '../mcp-credentials.ts'
import {
  registrySearch,
  convertRegistryEntry,
  isValidSettingName,
  type RegistryServerEntry,
} from '../mcp-registry.ts'
import {
  activeMcpServers,
  readProject,
  deleteMcpSource,
  readMcpSources,
  readMcpSource,
  createMcpSource,
  syncMcpServers,
  readMcpServers,
  readMcpServer,
  installMcpServer,
  uninstallMcpServer,
} from '../repo.ts'

export const mcpRoutes = new Hono()

/** The longest text the user may enter — DoS protection */
const MAX_TEXT = 500

/** The most arguments allowed when adding by hand */
const MAX_ARGS = 50

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

mcpRoutes.get('/mcp', (c) => {
  return c.json({ servers: readMcpServers(), sources: readMcpSources() })
})

mcpRoutes.get('/mcp/sources', (c) => {
  return c.json({ sources: readMcpSources() })
})

/**
 * The servers ACTIVE in a session — for diagnostics.
 *
 * Needed so the UI can show "what is running in this project". Credentials are
 * NOT returned (`collectMcpServers` does not even read them).
 */
mcpRoutes.get('/mcp/active', (c) => {
  const projectId = c.req.query('projectId') ?? null
  return c.json({ servers: activeMcpServers(projectId) })
})

// ---------------------------------------------------------------------------
// Source 1: the official registry
// ---------------------------------------------------------------------------

/**
 * Searches the registry. IT STORES NOTHING.
 *
 * The results are shown in the UI, the user picks one and sends it to
 * `/mcp/source/registry`.
 */
mcpRoutes.get('/mcp/registry/search', async (c) => {
  const term = c.req.query('q')?.trim() ?? ''
  if (term.length > MAX_TEXT) {
    return c.json({ error: 'Search term too long' }, 400)
  }

  let raw: RegistryServerEntry[]
  try {
    raw = await registrySearch(term)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Search failed' }, 502)
  }

  // Entries that cannot be used are kept out of the list — pressing "Add" and
  // getting an error would be a poor experience.
  const results = raw
    .map((s) => {
      const entry = convertRegistryEntry(s)
      if (!entry) return null
      return {
        name: entry.name,
        description: entry.description,
        transport: entry.transport,
        version: s.version ?? null,
        settings: entry.settings,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  return c.json({ results })
})

/**
 * Adds the server picked from the registry to the catalog.
 *
 * It is LOOKED UP AGAIN by name (we do not trust the entry sent by the
 * client): otherwise the user could submit an entry with an arbitrary command
 * and have it presented as coming "from the registry".
 */
mcpRoutes.post('/mcp/source/registry', async (c) => {
  let name: unknown
  try {
    const body = (await c.req.json()) as { name?: unknown }
    name = body?.name
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  if (typeof name !== 'string' || !name.trim() || name.length > MAX_TEXT) {
    return c.json({ error: 'Server name is required' }, 400)
  }
  const cleanName = name.trim()

  let found: RegistryServerEntry[]
  try {
    found = await registrySearch(cleanName, 20)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Registry error' }, 502)
  }

  const server = found.find((s) => s.name === cleanName)
  if (!server) {
    return c.json({ error: `Not found in the registry: ${cleanName}` }, 404)
  }

  const entry = convertRegistryEntry(server)
  if (!entry) {
    return c.json({ error: 'No launch method could be determined for this server' }, 422)
  }

  const source = createMcpSource({
    kind: 'registry',
    sourceName: cleanName,
    owner: null,
    repo: null,
    ref: '',
  })
  const result = syncMcpServers(source.id, [entry])

  auditWrite(
    'user',
    'MCP server added to the catalog',
    `${cleanName} (registry)`,
    'write',
  )

  return c.json({ source, ...result }, 201)
})

// ---------------------------------------------------------------------------
// Source 2: a GitHub repo
// ---------------------------------------------------------------------------

mcpRoutes.post('/mcp/source/github', async (c) => {
  let url: unknown
  try {
    const body = (await c.req.json()) as { url?: unknown }
    url = body?.url
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  if (typeof url !== 'string' || !url.trim() || url.length > MAX_TEXT) {
    return c.json({ error: 'Repository URL is required' }, 400)
  }

  const ref = parseGithubRef(url)
  if (!ref) {
    return c.json(
      {
        error: 'Could not parse the URL',
        detail: 'For example: https://github.com/github/github-mcp-server',
      },
      400,
    )
  }

  let scan: Awaited<ReturnType<typeof scanMcpSource>>
  try {
    scan = await scanMcpSource(ref)
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Scan failed' },
      502,
    )
  }

  const source = createMcpSource({
    kind: 'github',
    sourceName: `${ref.owner}/${ref.repo}`,
    owner: ref.owner,
    repo: ref.repo,
    ref: scan.ref,
  })
  const result = syncMcpServers(source.id, scan.servers)

  auditWrite(
    'user',
    'MCP source connected',
    `${ref.owner}/${ref.repo} — ${result.added} server`,
    'write',
  )

  return c.json({ source, ...result, warnings: scan.warnings }, 201)
})

// ---------------------------------------------------------------------------
// Source 3: by hand
// ---------------------------------------------------------------------------

interface ManualBody {
  name?: unknown
  description?: unknown
  transport?: unknown
  command?: unknown
  args?: unknown
  url?: unknown
  settings?: unknown
}

/**
 * Validates and sanitises the setting fields.
 *
 * This is user-supplied data — a malformed shape must not reach the database.
 * On failure a message is returned (the caller turns it into a 400).
 */
function readSettingFields(raw: unknown): { fields: McpSettingField[] } | { error: string } {
  if (raw === undefined || raw === null) return { fields: [] }
  if (!Array.isArray(raw)) return { error: 'settings must be an array' }
  if (raw.length > MAX_ARGS) return { error: 'Too many setting fields' }

  const fields: McpSettingField[] = []
  for (const element of raw) {
    if (!element || typeof element !== 'object') {
      return { error: 'Every setting must be an object' }
    }
    const m = element as { name?: unknown; hint?: unknown; required?: unknown; secret?: unknown }
    if (typeof m.name !== 'string' || !m.name.trim()) {
      return { error: 'Setting name is required' }
    }
    // THE SAME rule as on the registry path (`mcp-registry.ts`): names that
    // change process behaviour (`NODE_OPTIONS`, `LD_PRELOAD`…) and malformed
    // names are refused. When adding by hand we say so openly even if the user
    // is only harming themselves — better than a confusing "why does it not
    // work".
    if (!isValidSettingName(m.name.trim())) {
      return {
        error: `Setting name rejected: ${m.name.trim()} — only letters, digits, _ and -, and it must not be a name that alters process behaviour`,
      }
    }

    const field: McpSettingField = {
      name: m.name.trim(),
      required: m.required === true,
      secret: m.secret === true,
    }
    if (typeof m.hint === 'string' && m.hint.trim()) field.hint = m.hint.slice(0, MAX_TEXT)
    fields.push(field)
  }
  return { fields }
}

mcpRoutes.post('/mcp/source/manual', async (c) => {
  let body: ManualBody
  try {
    body = (await c.req.json()) as ManualBody
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  const { name, transport } = body
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_TEXT) {
    return c.json({ error: 'Server name is required' }, 400)
  }
  if (transport !== 'stdio' && transport !== 'http') {
    return c.json({ error: "transport must be 'stdio' or 'http'" }, 400)
  }

  const settings = readSettingFields(body.settings)
  if ('error' in settings) return c.json({ error: settings.error }, 400)

  const entry: Omit<McpCatalogEntry, 'id' | 'sourceId' | 'createdAt'> = {
    name: name.trim(),
    description: typeof body.description === 'string' ? body.description.slice(0, MAX_TEXT) : '',
    transport,
    settings: settings.fields,
  }

  if (transport === 'stdio') {
    if (typeof body.command !== 'string' || !body.command.trim()) {
      return c.json({ error: 'A command is required for stdio' }, 400)
    }
    if (body.command.length > MAX_TEXT) return c.json({ error: 'Command too long' }, 400)

    let args: string[] = []
    if (body.args !== undefined) {
      if (!Array.isArray(body.args)) {
        return c.json({ error: 'args must be an array' }, 400)
      }
      if (body.args.length > MAX_ARGS) {
        return c.json({ error: 'Too many arguments' }, 400)
      }
      if (!body.args.every((a) => typeof a === 'string' && a.length <= MAX_TEXT)) {
        return c.json({ error: 'Every argument must be a short string' }, 400)
      }
      args = body.args as string[]
    }

    entry.command = body.command.trim()
    entry.args = args
  } else {
    if (typeof body.url !== 'string' || !body.url.trim()) {
      return c.json({ error: 'A url is required for http' }, 400)
    }
    // http(s) only: we do not try to connect over `file://` or any other scheme
    let parsed: URL
    try {
      parsed = new URL(body.url.trim())
    } catch {
      return c.json({ error: 'Invalid url' }, 400)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return c.json({ error: 'url must be http or https' }, 400)
    }
    entry.url = parsed.toString()
  }

  const source = createMcpSource({
    kind: 'manual',
    sourceName: entry.name,
    owner: null,
    repo: null,
    ref: '',
  })
  const result = syncMcpServers(source.id, [entry])

  auditWrite('user', 'MCP server added manually', entry.name, 'write')

  return c.json({ source, ...result }, 201)
})

// ---------------------------------------------------------------------------
// Syncing and removing
// ---------------------------------------------------------------------------

/**
 * Re-scans the source.
 *
 * Meaningless for the `manual` and `builtin` kinds — they do not come from an
 * external source.
 */
mcpRoutes.post('/mcp/source/:id/sync', async (c) => {
  const source = readMcpSource(c.req.param('id'))
  if (!source) return c.json({ error: 'Source not found' }, 404)

  if (source.kind === 'github') {
    if (!source.owner || !source.repo) {
      return c.json({ error: 'Source information is incomplete' }, 422)
    }
    let scan: Awaited<ReturnType<typeof scanMcpSource>>
    try {
      scan = await scanMcpSource({ owner: source.owner, repo: source.repo, ref: source.ref })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Scan failed' },
        502,
      )
    }
    const result = syncMcpServers(source.id, scan.servers)
    auditWrite(
      'user',
      'MCP source synced',
      `${source.sourceName} — +${result.added} / -${result.deleted}`,
      'write',
    )
    return c.json({ ...result, warnings: scan.warnings })
  }

  if (source.kind === 'registry') {
    let found: RegistryServerEntry[]
    try {
      found = await registrySearch(source.sourceName, 20)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Registry error' }, 502)
    }
    const server = found.find((s) => s.name === source.sourceName)
    const entry = server ? convertRegistryEntry(server) : null
    if (!entry) {
      return c.json({ error: `Not found in the registry: ${source.sourceName}` }, 404)
    }
    const result = syncMcpServers(source.id, [entry])
    auditWrite('user', 'MCP source synced', source.sourceName, 'write')
    return c.json({ ...result, warnings: [] })
  }

  return c.json({ error: `This source type cannot be synced: ${source.kind}` }, 422)
})

/**
 * The source, its servers (CASCADE) and its CREDENTIALS are removed.
 *
 * The credentials are not in the database but in a separate file — CASCADE
 * does not reach them, so they are cleaned up by hand. Otherwise the token of
 * a deleted server would sit in that file forever.
 */
mcpRoutes.delete('/mcp/source/:id', async (c) => {
  const id = c.req.param('id')
  const source = readMcpSource(id)
  if (!source) return c.json({ error: 'Source not found' }, 404)

  // The install ids are collected BEFORE the delete — afterwards they are gone
  const installIds = readMcpServers()
    .filter((s) => s.sourceId === id)
    .flatMap((s) => s.installs.map((o) => o.id))

  deleteMcpSource(id)

  const store = mcpCredentialStore()
  for (const installId of installIds) {
    await store.remove(installId).catch(() => undefined)
  }

  auditWrite('user', 'MCP source removed', source.sourceName, 'write')

  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

interface InstallBody {
  scope?: unknown
  projectIds?: unknown
  /** Setting values: the secret ones go to the credential store, the rest to the database */
  settingValues?: unknown
}

/** Splits the submitted values into public and secret parts using the schema */
function splitValues(
  settings: readonly McpSettingField[],
  raw: unknown,
): { open: Record<string, string>; secret: Record<string, string>; error?: string } {
  const open: Record<string, string> = {}
  const secret: Record<string, string> = {}

  if (raw === undefined || raw === null) return { open, secret }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { open, secret, error: 'settingValues must be an object' }
  }

  const incoming = raw as Record<string, unknown>
  for (const field of settings) {
    const value = incoming[field.name]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      return { open, secret, error: `"${field.name}" value must be text` }
    }
    if (value.length > 4000) {
      return { open, secret, error: `"${field.name}" value is too long` }
    }
    // Keys NOT DECLARED IN THE SCHEMA are DROPPED (the loop runs over the
    // schema): the user must not be able to push an arbitrary environment
    // variable into the process.
    if (field.secret) secret[field.name] = value
    else open[field.name] = value
  }

  return { open, secret }
}

/**
 * Installs the server: the scope into the database, the secret values into the
 * credential store.
 *
 * REQUIRED FIELDS ARE CHECKED — without them the server would not start and
 * the user would be left hunting for the reason in the chat.
 */
mcpRoutes.post('/mcp/:id/install', async (c) => {
  const server = readMcpServer(c.req.param('id'))
  if (!server) return c.json({ error: 'MCP server not found' }, 404)

  let body: InstallBody
  try {
    body = (await c.req.json()) as InstallBody
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  const scope = body.scope
  if (scope !== 'global' && scope !== 'project') {
    return c.json({ error: "scope must be 'global' or 'project'" }, 400)
  }

  let projects: string[] = []
  if (scope === 'project') {
    if (!Array.isArray(body.projectIds) || body.projectIds.length === 0) {
      return c.json({ error: 'Project scope needs at least one project selected' }, 400)
    }
    projects = body.projectIds.filter((x): x is string => typeof x === 'string')
    for (const id of projects) {
      if (!readProject(id)) return c.json({ error: `Project not found: ${id}` }, 404)
    }
  }

  const split = splitValues(server.settings, body.settingValues)
  if (split.error) return c.json({ error: split.error }, 400)

  // Required fields: either they arrived now, or they must already be stored
  // (on a re-configure a secret field comes in empty).
  const store = mcpCredentialStore()
  const missing: string[] = []
  for (const field of server.settings) {
    if (!field.required) continue
    const given = field.secret ? split.secret[field.name] : split.open[field.name]
    if (given) continue
    if (field.default) continue
    // A secret field may have been stored by an earlier install
    if (field.secret) {
      const hasInstall = server.installs.length > 0
      if (hasInstall) {
        const stored = await store.get(server.installs[0]!.id)
        if (stored[field.name]) continue
      }
    } else if (server.installs.some((o) => o.settingValues[field.name])) {
      continue
    }
    missing.push(field.name)
  }

  if (missing.length > 0) {
    return c.json(
      {
        error: `Required setting not filled in: ${missing.join(', ')}`,
        missing,
      },
      400,
    )
  }

  const installIds: string[] = []
  if (scope === 'global') {
    installIds.push(installMcpServer(server.id, 'global', null, split.open))
  } else {
    for (const projectId of projects) {
      installIds.push(installMcpServer(server.id, 'project', projectId, split.open))
    }
  }

  // Secret values are stored PER install (one server may work with a different
  // token in two different projects).
  if (Object.keys(split.secret).length > 0) {
    for (const installId of installIds) {
      await store.save(installId, split.secret)
    }
  }

  auditWrite(
    'user',
    'MCP server installed',
    `${server.name} — ${scope === 'global' ? 'global' : `${projects.length} project`}`,
    'write',
  )

  // The response carries NO SECRET VALUE — `readMcpServer` does not even read them
  return c.json({ server: readMcpServer(server.id) })
})

/** Removes an installation and cleans up its credentials */
mcpRoutes.delete('/mcp/:id/install', async (c) => {
  const server = readMcpServer(c.req.param('id'))
  if (!server) return c.json({ error: 'MCP server not found' }, 404)

  let body: InstallBody
  try {
    body = (await c.req.json()) as InstallBody
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  const scope = body.scope
  if (scope !== 'global' && scope !== 'project') {
    return c.json({ error: "scope must be 'global' or 'project'" }, 400)
  }

  const projectIds = Array.isArray(body.projectIds)
    ? body.projectIds.filter((x): x is string => typeof x === 'string')
    : []

  const removed: string[] = []
  if (scope === 'global') {
    const id = uninstallMcpServer(server.id, 'global', null)
    if (id) removed.push(id)
  } else {
    if (projectIds.length === 0) return c.json({ error: 'No project selected' }, 400)
    for (const projectId of projectIds) {
      const id = uninstallMcpServer(server.id, 'project', projectId)
      if (id) removed.push(id)
    }
  }

  // The credentials are not in the database — CASCADE does not reach them
  const store = mcpCredentialStore()
  for (const id of removed) {
    await store.remove(id).catch(() => undefined)
  }

  auditWrite('user', 'MCP installation removed', server.name, 'write')

  return c.json({ server: readMcpServer(server.id) })
})

/** The scope kinds — for the UI (preserving type safety) */
export type { McpScope }
