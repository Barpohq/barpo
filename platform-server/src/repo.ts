// The database layer — SQL is written only here (and in audit.ts). Route files
// do not write SQL, they call these functions. The reason: when the table
// schema changes, only one place needs editing.

import type { Database } from 'bun:sqlite'
import type {
  AppRecord,
  BuildSession,
  BuildSessionStatus,
  ChatAttachment,
  ChatMessage,
  ChatSession,
  McpCatalogEntry,
  McpCatalogSourceKind,
  McpInstall,
  McpScope,
  McpServer,
  McpSettingField,
  McpSource,
  McpTransportKind,
  Project,
  Server,
  Skill,
  SkillInstall,
  SkillScope,
  SkillSource,
  SkillSourceKind,
  ToolCall,
  ToolCard,
} from '@platforma/shared'
import { db as globalDb } from './db.ts'
import { readAppFolder } from './app-store.ts'

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

interface ServerRow {
  id: string
  name: string
  host: string
  port: number
  username: string
  created_at: string
}

function serverFromRow(r: ServerRow): Server {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    username: r.username,
    createdAt: r.created_at,
  }
}

export function readServers(database?: Database): Server[] {
  const d = database ?? globalDb()
  return d
    .query<ServerRow, []>('SELECT * FROM servers ORDER BY rowid')
    .all()
    .map(serverFromRow)
}

export function serverById(id: string, database?: Database): Server | null {
  const d = database ?? globalDb()
  const r = d.query<ServerRow, [string]>('SELECT * FROM servers WHERE id = ?').get(id)
  return r ? serverFromRow(r) : null
}

export function serverByName(name: string, database?: Database): Server | null {
  const d = database ?? globalDb()
  const r = d.query<ServerRow, [string]>('SELECT * FROM servers WHERE name = ?').get(name)
  return r ? serverFromRow(r) : null
}

export function createServer(
  data: { name: string; host: string; port: number; username: string },
  database?: Database,
): Server {
  const d = database ?? globalDb()
  const server: Server = {
    id: crypto.randomUUID(),
    name: data.name,
    host: data.host,
    port: data.port,
    username: data.username,
    createdAt: new Date().toISOString(),
  }
  d.query(
    'INSERT INTO servers (id, name, host, port, username, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(server.id, server.name, server.host, server.port, server.username, server.createdAt)
  return server
}

export function deleteServer(id: string, database?: Database): boolean {
  const d = database ?? globalDb()
  const r = d.query('DELETE FROM servers WHERE id = ?').run(id)
  return r.changes > 0
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
//
// Three tables: source (repo) → skill (catalog entry) → install (scope).
// The full model rationale is in migrations/006-skills.ts.

interface SkillSourceRow {
  id: string
  kind: SkillSourceKind
  url: string
  owner: string
  repo: string
  ref: string
  commit_sha: string | null
  last_sync: string | null
  created_at: string
}

function skillSourceFromRow(r: SkillSourceRow): SkillSource {
  return {
    id: r.id,
    kind: r.kind,
    url: r.url,
    owner: r.owner,
    repo: r.repo,
    ref: r.ref,
    commitSha: r.commit_sha,
    lastSync: r.last_sync,
    createdAt: r.created_at,
  }
}

export function readSkillSources(database?: Database): SkillSource[] {
  const d = database ?? globalDb()
  return d
    .query<SkillSourceRow, []>('SELECT * FROM skill_sources ORDER BY created_at')
    .all()
    .map(skillSourceFromRow)
}

export function readSkillSource(id: string, database?: Database): SkillSource | null {
  const d = database ?? globalDb()
  const r = d.query<SkillSourceRow, [string]>('SELECT * FROM skill_sources WHERE id = ?').get(id)
  return r ? skillSourceFromRow(r) : null
}

/**
 * Creates the source, or returns the existing one.
 *
 * Connecting the same repo twice is NOT AN ERROR: if the user adds a repo a
 * second time, returning the existing record is better than failing with
 * "already exists" — the outcome is the state they wanted anyway (repo
 * connected).
 */
export function createSkillSource(
  source: Omit<SkillSource, 'id' | 'commitSha' | 'lastSync' | 'createdAt'>,
  database?: Database,
): SkillSource {
  const d = database ?? globalDb()
  const existing = d
    .query<SkillSourceRow, [string, string, string]>(
      'SELECT * FROM skill_sources WHERE owner = ? AND repo = ? AND ref = ?',
    )
    .get(source.owner, source.repo, source.ref)
  if (existing) return skillSourceFromRow(existing)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  d.prepare(
    `INSERT INTO skill_sources (id, kind, url, owner, repo, ref, commit_sha, last_sync, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(id, source.kind, source.url, source.owner, source.repo, source.ref, now)

  return { ...source, id, commitSha: null, lastSync: null, createdAt: now }
}

/** The source and ALL of its skills are removed (and their installs via CASCADE) */
export function deleteSkillSource(id: string, database?: Database): boolean {
  const d = database ?? globalDb()
  return d.prepare('DELETE FROM skill_sources WHERE id = ?').run(id).changes > 0
}

interface SkillRow {
  id: string
  source_id: string
  path: string
  name: string
  description: string
  license: string | null
  allowed_tools: string | null
  warnings: string
}

/**
 * Joins `skills` with `skill_installs` and returns the combined records.
 *
 * The installs are fetched with a separate query and stitched together in
 * memory (rather than a JOIN): a JOIN would repeat each skill once per install
 * and the rows would have to be regrouped afterwards. There are only hundreds
 * of skills, so this is not a performance concern.
 */
function collectSkills(rows: SkillRow[], d: Database): Skill[] {
  const installs = new Map<string, SkillInstall[]>()
  for (const i of d
    .query<{ skill_id: string; scope: SkillScope; project_id: string | null }, []>(
      'SELECT skill_id, scope, project_id FROM skill_installs',
    )
    .all()) {
    const list = installs.get(i.skill_id) ?? []
    list.push({ scope: i.scope, projectId: i.project_id ?? undefined })
    installs.set(i.skill_id, list)
  }

  return rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    path: r.path,
    name: r.name,
    description: r.description,
    license: r.license ?? undefined,
    allowedTools: r.allowed_tools ? (JSON.parse(r.allowed_tools) as string[]) : undefined,
    warnings: JSON.parse(r.warnings) as string[],
    installs: installs.get(r.id) ?? [],
  }))
}

/** The whole catalog — both installed and not installed */
export function readSkills(database?: Database): Skill[] {
  const d = database ?? globalDb()
  const rows = d.query<SkillRow, []>('SELECT * FROM skills ORDER BY name').all()
  return collectSkills(rows, d)
}

export function readSkill(id: string, database?: Database): Skill | null {
  const d = database ?? globalDb()
  const r = d.query<SkillRow, [string]>('SELECT * FROM skills WHERE id = ?').get(id)
  return r ? (collectSkills([r], d)[0] ?? null) : null
}

/**
 * The skills ACTIVE in a project: the globally installed ones plus those
 * installed for this project. When `projectId` is null (a session with no
 * project) only the global ones apply.
 *
 * At the start of a session `.platforma/skills/` is built from this list.
 */
export function activeSkills(projectId: string | null, database?: Database): Skill[] {
  const d = database ?? globalDb()
  const rows = d
    .query<SkillRow, [string | null]>(
      `SELECT DISTINCT s.* FROM skills s
         JOIN skill_installs i ON i.skill_id = s.id
        WHERE i.scope = 'global' OR i.project_id = ?
        ORDER BY s.name`,
    )
    .all(projectId)
  return collectSkills(rows, d)
}

/**
 * Writes the result of a sync to the database: what was found is UPSERTed,
 * what disappeared is deleted.
 *
 * UPSERT (rather than INSERT) IS DELIBERATE: if a skill's `id` does not change
 * across re-syncs, the installs attached to it survive. Otherwise the user
 * would have to reinstall everything after every sync.
 */
export function syncSkills(
  sourceId: string,
  found: Omit<Skill, 'id' | 'sourceId' | 'installs'>[],
  commitSha: string | null,
  database?: Database,
): { added: number; updated: number; deleted: number } {
  const d = database ?? globalDb()
  const result = { added: 0, updated: 0, deleted: 0 }

  d.transaction(() => {
    const oldPaths = new Set(
      d
        .query<{ path: string }, [string]>('SELECT path FROM skills WHERE source_id = ?')
        .all(sourceId)
        .map((r) => r.path),
    )

    const st = d.prepare(
      `INSERT INTO skills (id, source_id, path, name, description, license, allowed_tools, warnings)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, path) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            license = excluded.license,
            allowed_tools = excluded.allowed_tools,
            warnings = excluded.warnings`,
    )

    for (const s of found) {
      st.run(
        crypto.randomUUID(),
        sourceId,
        s.path,
        s.name,
        s.description,
        s.license ?? null,
        s.allowedTools ? JSON.stringify(s.allowedTools) : null,
        JSON.stringify(s.warnings),
      )
      if (oldPaths.delete(s.path)) result.updated++
      else result.added++
    }

    // Skills removed from the repo — CASCADE clears their installs too
    const remove = d.prepare('DELETE FROM skills WHERE source_id = ? AND path = ?')
    for (const path of oldPaths) {
      remove.run(sourceId, path)
      result.deleted++
    }

    d.prepare('UPDATE skill_sources SET commit_sha = ?, last_sync = ? WHERE id = ?').run(
      commitSha,
      new Date().toISOString(),
      sourceId,
    )
  })()

  return result
}

/** Idempotent — passes silently when it is already installed */
export function installSkill(
  skillId: string,
  scope: SkillScope,
  projectId: string | null,
  database?: Database,
): void {
  const d = database ?? globalDb()
  d.prepare(
    `INSERT INTO skill_installs (id, skill_id, scope, project_id, created_at)
          VALUES (?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(crypto.randomUUID(), skillId, scope, projectId, new Date().toISOString())
}

export function uninstallSkill(
  skillId: string,
  scope: SkillScope,
  projectId: string | null,
  database?: Database,
): boolean {
  const d = database ?? globalDb()
  return (
    d
      .prepare(
        `DELETE FROM skill_installs
          WHERE skill_id = ? AND scope = ? AND COALESCE(project_id, '') = COALESCE(?, '')`,
      )
      .run(skillId, scope, projectId).changes > 0
  )
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------
//
// EXACTLY THE SAME three-layer pattern as the skills section above
// (source → catalog → install), with the same rules:
//   - `createMcpSource` is idempotent (connecting twice is not an error);
//   - `syncMcpServers` does UPSERT + diff, ids do not change;
//   - installs live in their own table, compared with `COALESCE` for
//     global/project.
//
// THE DIFFERENCE: `McpInstall` carries an `id` and `settingValues`. The `id` is
// needed because secret credentials are stored against it in a separate file
// (`mcp-credentials.ts`) — skills had nothing to store.
//
// The full model rationale is in migrations/011-mcp-servers.ts.

interface McpSourceRow {
  id: string
  kind: McpCatalogSourceKind
  source_name: string
  owner: string | null
  repo: string | null
  ref: string
  last_sync: string | null
  created_at: string
}

function mcpSourceFromRow(r: McpSourceRow): McpSource {
  return {
    id: r.id,
    kind: r.kind,
    sourceName: r.source_name,
    owner: r.owner,
    repo: r.repo,
    ref: r.ref,
    lastSync: r.last_sync,
    createdAt: r.created_at,
  }
}

export function readMcpSources(database?: Database): McpSource[] {
  const d = database ?? globalDb()
  return d
    .query<McpSourceRow, []>('SELECT * FROM mcp_sources ORDER BY created_at')
    .all()
    .map(mcpSourceFromRow)
}

export function readMcpSource(id: string, database?: Database): McpSource | null {
  const d = database ?? globalDb()
  const r = d.query<McpSourceRow, [string]>('SELECT * FROM mcp_sources WHERE id = ?').get(id)
  return r ? mcpSourceFromRow(r) : null
}

/**
 * Creates the source, or returns the existing one.
 *
 * Same rule as `createSkillSource`: connecting twice is NOT AN ERROR, because
 * the outcome is the state the user wanted anyway. Only the uniqueness key
 * differs — here it is `(kind, source_name, ref)`, because a source can be a
 * GitHub repo, a registry entry, or a manually entered name.
 */
export function createMcpSource(
  source: Omit<McpSource, 'id' | 'lastSync' | 'createdAt'>,
  database?: Database,
): McpSource {
  const d = database ?? globalDb()
  const existing = d
    .query<McpSourceRow, [string, string, string]>(
      'SELECT * FROM mcp_sources WHERE kind = ? AND source_name = ? AND ref = ?',
    )
    .get(source.kind, source.sourceName, source.ref)
  if (existing) return mcpSourceFromRow(existing)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  d.prepare(
    `INSERT INTO mcp_sources (id, kind, source_name, owner, repo, ref, last_sync, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(id, source.kind, source.sourceName, source.owner, source.repo, source.ref, now)

  return { ...source, id, lastSync: null, createdAt: now }
}

/** The source, its servers and their installs (CASCADE) are all removed */
export function deleteMcpSource(id: string, database?: Database): boolean {
  const d = database ?? globalDb()
  return d.prepare('DELETE FROM mcp_sources WHERE id = ?').run(id).changes > 0
}

interface McpServerRow {
  id: string
  source_id: string
  name: string
  description: string
  transport: McpTransportKind
  command: string | null
  args: string | null
  url: string | null
  settings: string
}

/**
 * Joins `mcp_servers` with `mcp_installs`.
 *
 * Not a JOIN, for the same reason as `collectSkills`: a JOIN would repeat each
 * server once per install.
 */
function collectMcpServers(rows: McpServerRow[], d: Database): McpServer[] {
  const installs = new Map<string, McpInstall[]>()
  for (const i of d
    .query<
      {
        id: string
        server_id: string
        scope: McpScope
        project_id: string | null
        setting_values: string
      },
      []
    >('SELECT id, server_id, scope, project_id, setting_values FROM mcp_installs')
    .all()) {
    const list = installs.get(i.server_id) ?? []
    list.push({
      id: i.id,
      scope: i.scope,
      projectId: i.project_id ?? undefined,
      settingValues: JSON.parse(i.setting_values) as Record<string, string>,
    })
    installs.set(i.server_id, list)
  }

  return rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    name: r.name,
    description: r.description,
    transport: r.transport,
    command: r.command ?? undefined,
    args: r.args ? (JSON.parse(r.args) as string[]) : undefined,
    url: r.url ?? undefined,
    settings: JSON.parse(r.settings) as McpSettingField[],
    // A catalog entry comes from its source and has no `created_at` column of
    // its own — a sync may rewrite it, so "when it appeared" is only meaningful
    // at the source level. The UI shows the source's date as well.
    createdAt: '',
    installs: installs.get(r.id) ?? [],
  }))
}

/** The whole catalog — both installed and not installed */
export function readMcpServers(database?: Database): McpServer[] {
  const d = database ?? globalDb()
  const rows = d.query<McpServerRow, []>('SELECT * FROM mcp_servers ORDER BY name').all()
  return collectMcpServers(rows, d)
}

export function readMcpServer(id: string, database?: Database): McpServer | null {
  const d = database ?? globalDb()
  const r = d.query<McpServerRow, [string]>('SELECT * FROM mcp_servers WHERE id = ?').get(id)
  return r ? (collectMcpServers([r], d)[0] ?? null) : null
}

/**
 * The MCP servers ACTIVE in a project: the globally installed ones plus those
 * installed for this project. The same query as `activeSkills`.
 *
 * At the start of a session the connections are made from this list
 * (`orchestrator.ts` → `agentStream` → `McpManager`).
 */
export function activeMcpServers(projectId: string | null, database?: Database): McpServer[] {
  const d = database ?? globalDb()
  const rows = d
    .query<McpServerRow, [string | null]>(
      `SELECT DISTINCT s.* FROM mcp_servers s
         JOIN mcp_installs i ON i.server_id = s.id
        WHERE i.scope = 'global' OR i.project_id = ?
        ORDER BY s.name`,
    )
    .all(projectId)
  return collectMcpServers(rows, d)
}

/**
 * Writes the result of a scan to the database: what was found is UPSERTed,
 * what disappeared is deleted.
 *
 * UPSERT for the same reason as `syncSkills`: keeping the server `id` keeps its
 * installs AND the credentials bound to them (which are keyed by install id) in
 * place. With INSERT the user would have to re-enter the token after every sync.
 */
export function syncMcpServers(
  sourceId: string,
  found: Omit<McpCatalogEntry, 'id' | 'sourceId' | 'createdAt'>[],
  database?: Database,
): { added: number; updated: number; deleted: number } {
  const d = database ?? globalDb()
  const result = { added: 0, updated: 0, deleted: 0 }

  d.transaction(() => {
    const oldNames = new Set(
      d
        .query<{ name: string }, [string]>('SELECT name FROM mcp_servers WHERE source_id = ?')
        .all(sourceId)
        .map((r) => r.name),
    )

    const st = d.prepare(
      `INSERT INTO mcp_servers (id, source_id, name, description, transport, command, args, url, settings)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, name) DO UPDATE SET
            description = excluded.description,
            transport = excluded.transport,
            command = excluded.command,
            args = excluded.args,
            url = excluded.url,
            settings = excluded.settings`,
    )

    for (const s of found) {
      st.run(
        crypto.randomUUID(),
        sourceId,
        s.name,
        s.description,
        s.transport,
        s.command ?? null,
        s.args ? JSON.stringify(s.args) : null,
        s.url ?? null,
        JSON.stringify(s.settings),
      )
      if (oldNames.delete(s.name)) result.updated++
      else result.added++
    }

    // Servers that vanished from the source — CASCADE clears their installs too
    const remove = d.prepare('DELETE FROM mcp_servers WHERE source_id = ? AND name = ?')
    for (const name of oldNames) {
      remove.run(sourceId, name)
      result.deleted++
    }

    d.prepare('UPDATE mcp_sources SET last_sync = ? WHERE id = ?').run(
      new Date().toISOString(),
      sourceId,
    )
  })()

  return result
}

/**
 * Installs the server and returns the install id.
 *
 * THE ID IS RETURNED (unlike for skills): secret credentials are stored against
 * it, so the caller needs it.
 *
 * Idempotent: if it is already installed the setting values are UPDATED and the
 * existing id is returned. The reason — for the user, pressing "install" a
 * second time means editing the settings; creating a new row would orphan the
 * old credentials.
 */
export function installMcpServer(
  serverId: string,
  scope: McpScope,
  projectId: string | null,
  settingValues: Record<string, string>,
  database?: Database,
): string {
  const d = database ?? globalDb()
  const values = JSON.stringify(settingValues)

  const existing = d
    .query<{ id: string }, [string, McpScope, string | null]>(
      `SELECT id FROM mcp_installs
        WHERE server_id = ? AND scope = ? AND COALESCE(project_id, '') = COALESCE(?, '')`,
    )
    .get(serverId, scope, projectId)

  if (existing) {
    d.prepare('UPDATE mcp_installs SET setting_values = ? WHERE id = ?').run(values, existing.id)
    return existing.id
  }

  const id = crypto.randomUUID()
  d.prepare(
    `INSERT INTO mcp_installs (id, server_id, scope, project_id, setting_values, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, serverId, scope, projectId, values, new Date().toISOString())
  return id
}

/**
 * Removes an install. Returns the id of the deleted row (or null) — the caller
 * uses that id to clear the matching credentials as well.
 */
export function uninstallMcpServer(
  serverId: string,
  scope: McpScope,
  projectId: string | null,
  database?: Database,
): string | null {
  const d = database ?? globalDb()
  const existing = d
    .query<{ id: string }, [string, McpScope, string | null]>(
      `SELECT id FROM mcp_installs
        WHERE server_id = ? AND scope = ? AND COALESCE(project_id, '') = COALESCE(?, '')`,
    )
    .get(serverId, scope, projectId)
  if (!existing) return null

  d.prepare('DELETE FROM mcp_installs WHERE id = ?').run(existing.id)
  return existing.id
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

// ┌──────────────────────────────────────────────────────────────────────┐
// │ THE DATABASE NO LONGER HOLDS THE MANIFEST.                           │
// │                                                                      │
// │ An app is a FOLDER (`apps-dir.ts`, `app-store.ts`); this table only  │
// │ records that the folder was published, and where it lives. Every     │
// │ read goes to disk, which is what makes a hand-edited `view.jsx`      │
// │ take effect with no publish, no watcher and no reload button.        │
// │                                                                      │
// │ The cost is that reads are now ASYNC (files, and a possible JSX      │
// │ compile). That is why `readApp`/`readApps` return promises — the     │
// │ routes were already async, so it reaches no further.                 │
// └──────────────────────────────────────────────────────────────────────┘

interface AppRow {
  id: string
  dir: string
  status: AppRecord['status']
  created_at: string
  published_at: string
}

/** The publish record — what the database knows, without touching the disk */
export interface AppPublication {
  id: string
  dir: string
  status: AppRecord['status']
  createdAt: string
  publishedAt: string
}

function publicationFromRow(r: AppRow): AppPublication {
  return {
    id: r.id,
    dir: r.dir,
    status: r.status,
    createdAt: r.created_at,
    publishedAt: r.published_at,
  }
}

/**
 * The published apps as the DATABASE sees them — no disk access.
 *
 * Used by anything that needs the id/folder list without paying for a full
 * folder read (deletion, existence checks).
 */
export function readPublications(database?: Database): AppPublication[] {
  const d = database ?? globalDb()
  return d
    .query<AppRow, []>('SELECT * FROM apps ORDER BY created_at')
    .all()
    .map(publicationFromRow)
}

export function readPublication(id: string, database?: Database): AppPublication | null {
  const d = database ?? globalDb()
  const r = d.query<AppRow, [string]>('SELECT * FROM apps WHERE id = ?').get(id)
  return r ? publicationFromRow(r) : null
}

/**
 * Reads one app from its folder.
 *
 * Returns `null` when the app is not published or its folder is gone —
 * a folder deleted by hand makes the app disappear from the list rather than
 * breaking the page (the same isolation rule as before, one level down).
 *
 * A folder that EXISTS but is broken still comes back as a record: the errors
 * ride along in `AppRecord.errors` so the user can read them on the dashboard.
 * That distinction matters — "gone" and "wrong" need different answers.
 */
export async function readApp(id: string, database?: Database): Promise<AppRecord | null> {
  const publication = readPublication(id, database)
  if (!publication) return null
  return recordFromPublication(publication)
}

export async function readApps(database?: Database): Promise<AppRecord[]> {
  const publications = readPublications(database)
  // In parallel: one app with a slow compile must not hold up the list.
  const records = await Promise.all(publications.map(recordFromPublication))
  return records.filter((r): r is AppRecord => r !== null)
}

async function recordFromPublication(p: AppPublication): Promise<AppRecord | null> {
  const folder = await readAppFolder(p.dir)

  if (!folder.manifest) {
    // The folder is unreadable — `app.json` missing or not parseable. There is
    // no id, no name, nothing to render, so the app drops off the list. The
    // publish row stays: restoring the file brings the app straight back.
    return null
  }

  return {
    id: p.id,
    manifest: folder.manifest,
    status: folder.manifest.status,
    createdAt: p.createdAt,
    updatedAt: p.publishedAt,
    dir: p.dir,
    ...(folder.errors.length > 0 ? { errors: folder.errors } : {}),
  }
}

/**
 * Records a folder as a published app (upsert).
 *
 * It stores no content — only the pointer. `isNew` distinguishes the first
 * publish from a re-publish, which is what picks the WS event.
 */
export function publishApp(
  id: string,
  dir: string,
  status: AppRecord['status'],
  database?: Database,
): { isNew: boolean } {
  const d = database ?? globalDb()
  const now = new Date().toISOString()
  const existing = readPublication(id, d)

  if (existing) {
    d.prepare('UPDATE apps SET dir = ?, status = ?, published_at = ? WHERE id = ?').run(
      dir,
      status,
      now,
      id,
    )
    return { isNew: false }
  }

  d.prepare(
    'INSERT INTO apps (id, dir, status, created_at, published_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, dir, status, now, now)
  return { isNew: true }
}

/**
 * Removes the publish record.
 *
 * IT DOES NOT TOUCH THE FOLDER — deleting files is a separate, louder decision
 * and lives in `app-delete.ts`, behind confirmation. Keeping the two apart
 * means "take it off the list" can never be mistaken for "erase the user's
 * work".
 */
export function unpublishApp(id: string, database?: Database): boolean {
  const d = database ?? globalDb()
  const existing = readPublication(id, d)
  if (!existing) return false
  d.prepare('DELETE FROM apps WHERE id = ?').run(id)
  return true
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string
  name: string
  folder: string
  created_at: string
}

function projectFromRow(r: ProjectRow, chatCount?: number): Project {
  return {
    id: r.id,
    name: r.name,
    folder: r.folder,
    createdAt: r.created_at,
    chatCount,
  }
}

/**
 * All projects, each with the number of chats attached to it.
 *
 * `LEFT JOIN`: a project with no chats still appears in the list (with 0).
 */
export function readProjects(database?: Database): Project[] {
  const d = database ?? globalDb()
  return d
    .query<ProjectRow & { chats: number }, []>(
      `SELECT p.*, COUNT(s.id) AS chats
         FROM projects p
         LEFT JOIN chat_sessions s ON s.project_id = p.id
        GROUP BY p.id
        ORDER BY p.created_at DESC`,
    )
    .all()
    .map((r) => projectFromRow(r, r.chats))
}

export function readProject(id: string, database?: Database): Project | null {
  const d = database ?? globalDb()
  const r = d.query<ProjectRow, [string]>('SELECT * FROM projects WHERE id = ?').get(id)
  return r ? projectFromRow(r) : null
}

/** Lookup by name — to catch a duplicate name up front */
export function projectByName(name: string, database?: Database): Project | null {
  const d = database ?? globalDb()
  const r = d.query<ProjectRow, [string]>('SELECT * FROM projects WHERE name = ?').get(name)
  return r ? projectFromRow(r) : null
}

/**
 * Creates the project record. The folder is created by the caller (the route),
 * which passes its full path — this layer does not touch the file system.
 *
 * If the name is a duplicate the UNIQUE index raises an error; the route turns
 * that into a 409.
 */
export function createProject(name: string, folder: string, database?: Database): Project {
  const d = database ?? globalDb()
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    folder,
    createdAt: new Date().toISOString(),
    chatCount: 0,
  }
  d.prepare('INSERT INTO projects (id, name, folder, created_at) VALUES (?, ?, ?, ?)').run(
    project.id,
    project.name,
    project.folder,
    project.createdAt,
  )
  return project
}

/**
 * The folder of the project a session is attached to. `null` when the session
 * has no project (or does not exist) — the caller then falls back to the
 * session folder.
 *
 * A single SQL statement: the orchestrator calls this on every reply stream, so
 * a second query would be wasteful.
 */
export function sessionProjectDir(sessionId: string, database?: Database): string | null {
  const d = database ?? globalDb()
  const r = d
    .query<{ folder: string }, [string]>(
      `SELECT p.folder AS folder
         FROM chat_sessions s
         JOIN projects p ON p.id = s.project_id
        WHERE s.id = ?`,
    )
    .get(sessionId)
  return r?.folder ?? null
}

// ---------------------------------------------------------------------------
// Chat sessions
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string
  title: string
  provider: string | null
  model: string | null
  project_id: string | null
  created_at: string
  updated_at: string
}

function sessionFromRow(r: SessionRow): ChatSession {
  return {
    id: r.id,
    title: r.title,
    provider: r.provider ?? undefined,
    model: r.model ?? undefined,
    projectId: r.project_id ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/**
 * All sessions, ordered by last activity (newest first).
 *
 * `messageCount` is included so the UI can tell an "empty conversation" apart:
 * creating a session and abandoning it before the first message is a normal
 * thing to do. `LEFT JOIN`: a session with no messages stays in the list
 * (with 0).
 */
export function readSessions(database?: Database): ChatSession[] {
  const d = database ?? globalDb()
  return d
    .query<SessionRow & { messages: number }, []>(
      `SELECT s.*, COUNT(m.id) AS messages
         FROM chat_sessions s
         LEFT JOIN chat_messages m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.updated_at DESC`,
    )
    .all()
    .map((r) => ({ ...sessionFromRow(r), messageCount: r.messages }))
}

export function readSession(id: string, database?: Database): ChatSession | null {
  const d = database ?? globalDb()
  const r = d.query<SessionRow, [string]>('SELECT * FROM chat_sessions WHERE id = ?').get(id)
  return r ? sessionFromRow(r) : null
}

/**
 * A new session. When `projectId` is given the session is attached to that
 * project — the agent's tools then run in the project's folder.
 *
 * The project's EXISTENCE is not checked here: the route layer checks it and
 * gives the user a clear error. There is a foreign key in the database anyway,
 * so a record pointing at a missing project cannot be created.
 */
export function createSession(
  title?: string,
  database?: Database,
  projectId?: string,
): ChatSession {
  const d = database ?? globalDb()
  const now = new Date().toISOString()
  const session: ChatSession = {
    id: crypto.randomUUID(),
    title: title?.trim() || 'New conversation',
    projectId,
    createdAt: now,
    updatedAt: now,
  }
  d.prepare(
    'INSERT INTO chat_sessions (id, title, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(session.id, session.title, projectId ?? null, session.createdAt, session.updatedAt)
  return session
}

/**
 * Locks the session's model — it only ever writes the FIRST time.
 *
 * The `WHERE provider IS NULL` condition prevents a race: if two messages
 * arrive at once, the second one cannot replace the provider already chosen.
 * The return value says whether it was written (true) or was already locked
 * (false).
 */
export function lockSessionModel(
  id: string,
  provider: string,
  model: string,
  database?: Database,
): boolean {
  const d = database ?? globalDb()
  const result = d
    .prepare('UPDATE chat_sessions SET provider = ?, model = ? WHERE id = ? AND provider IS NULL')
    .run(provider, model, id)
  return result.changes > 0
}

/**
 * Changes the model within a session (the provider DOES NOT change).
 * Switching models inside one provider is safe — the context format is the same.
 */
export function changeSessionModel(id: string, model: string, database?: Database): void {
  const d = database ?? globalDb()
  d.prepare('UPDATE chat_sessions SET model = ? WHERE id = ?').run(model, id)
}

/**
 * Renames a session manually.
 *
 * `updated_at` is DELIBERATELY left alone: the list is sorted by last ACTIVITY,
 * and editing the title should not push the conversation to the top.
 *
 * `false` — no such session.
 */
export function renameSession(id: string, title: string, database?: Database): boolean {
  const d = database ?? globalDb()
  const result = d.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(title, id)
  return result.changes > 0
}

/**
 * Deletes a session entirely. The messages go with it via `ON DELETE CASCADE`
 * (migration 001), while `build_sessions.session_id` becomes NULL — the build
 * history should not disappear just because a conversation was deleted.
 *
 * `false` — there was no such session.
 */
export function deleteSession(id: string, database?: Database): boolean {
  const d = database ?? globalDb()
  const result = d.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id)
  return result.changes > 0
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

interface MessageRow {
  id: string
  session_id: string
  role: ChatMessage['role']
  text: string
  tool_card: string | null
  tool_cards: string | null
  agent_messages: string | null
  context_tokens: number | null
  created_at: string
}

function messageFromRow(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    text: r.text,
    toolCard: r.tool_card ? (JSON.parse(r.tool_card) as ToolCard) : undefined,
    toolCards: r.tool_cards ? (JSON.parse(r.tool_cards) as ToolCall[]) : undefined,
    // Malformed JSON must not make the whole session unreadable: this column is
    // only for the LLM context, and without it the conversation carries on
    // using `text`.
    agentMessages: readJsonArray(r.agent_messages),
    contextTokens: r.context_tokens ?? undefined,
    createdAt: r.created_at,
  }
}

/** Reads a raw JSON column. Returns `undefined` when malformed — never throws. */
function readJsonArray(raw: string | null): unknown[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function readMessages(sessionId: string, database?: Database): ChatMessage[] {
  const d = database ?? globalDb()
  const messages = d
    .query<MessageRow, [string]>(
      'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at, rowid',
    )
    .all(sessionId)
    .map(messageFromRow)

  // Tool cards are taken from the `tool_calls` table IN PREFERENCE to the
  // column.
  //
  // The reason: every call is written there DURING the stream, whereas the
  // `tool_cards` column is written at the END of it. If the stream was
  // interrupted (provider error, server restart) the column stays empty while
  // the table holds the records — previously those executed commands did not
  // show up in the history at all.
  //
  // The permission decision also exists only in that table, so "why was this
  // command run" is not answerable from the old column.
  const calls = new Map<string, ToolCall[]>()
  for (const r of d
    .query<ToolCallRow, [string]>(
      'SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at, rowid',
    )
    .all(sessionId)) {
    const list = calls.get(r.message_id)
    if (list) list.push(toolCallFromRow(r))
    else calls.set(r.message_id, [toolCallFromRow(r)])
  }

  // Attachments — the same pattern, but with two DIFFERENCES.
  //
  //   1) The `message_id IS NOT NULL` condition. NULL means uploaded but not
  //      yet sent; it must not appear in the history (the chip lives in the UI,
  //      in local state).
  //   2) No synthetic message is BUILT for an orphan. For a tool call an orphan
  //      was a sign of LOST DATA; here NULL is a normal intermediate state and
  //      showing it as a message would be a lie.
  const attachments = new Map<string, ChatAttachment[]>()
  for (const r of d
    .query<AttachmentRow, [string]>(
      `SELECT * FROM chat_attachments
       WHERE session_id = ? AND message_id IS NOT NULL
       ORDER BY created_at, rowid`,
    )
    .all(sessionId)) {
    // SQL has already checked that `message_id` is not null; the type does not
    // know that
    const key = r.message_id!
    const list = attachments.get(key)
    if (list) list.push(attachmentFromRow(r))
    else attachments.set(key, [attachmentFromRow(r)])
  }

  if (calls.size === 0 && attachments.size === 0) return messages

  const result = messages.map((m) => {
    const cards = calls.get(m.id)
    const files = attachments.get(m.id)
    if (!cards && !files) return m
    calls.delete(m.id)
    return {
      ...m,
      ...(cards ? { toolCards: cards } : {}),
      ...(files ? { attachments: files } : {}),
    }
  })

  // ORPHANED CALLS — a reply whose message was never written.
  //
  // This can happen: if the process stops mid-stream (server restart, power
  // loss) the assistant message IS NOT WRITTEN while the calls are already in
  // the database. Dropping them would mean the user never sees the commands
  // that ran — exactly the data loss this table exists to prevent.
  //
  // So a synthetic reply is built for the orphans. `agentMessages` is left
  // unset: a half-finished context would break the next turn.
  for (const [messageId, cards] of calls) {
    result.push({
      id: messageId,
      sessionId,
      role: 'assistant',
      text: '⚠︎ The response did not finish — the stream was interrupted. The actions that ran are below.',
      toolCards: cards,
      createdAt: orphanTime(d, messageId),
    })
  }

  // The synthetic messages were appended at the end — put them back in their
  // rightful place by time
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** The time of the first record in a set of orphaned calls — used for ordering */
function orphanTime(d: Database, messageId: string): string {
  const r = d
    .query<{ time: string | null }, [string]>(
      'SELECT MIN(created_at) AS time FROM tool_calls WHERE message_id = ?',
    )
    .get(messageId)
  return r?.time ?? new Date().toISOString()
}

export function writeMessage(
  message: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
  database?: Database,
): ChatMessage {
  const d = database ?? globalDb()
  const full: ChatMessage = {
    id: message.id ?? crypto.randomUUID(),
    sessionId: message.sessionId,
    role: message.role,
    text: message.text,
    toolCard: message.toolCard,
    toolCards: message.toolCards,
    agentMessages: message.agentMessages,
    contextTokens: message.contextTokens,
    createdAt: message.createdAt ?? new Date().toISOString(),
  }

  d.prepare(
    `INSERT INTO chat_messages
       (id, session_id, role, text, tool_card, tool_cards, agent_messages, context_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    full.id,
    full.sessionId,
    full.role,
    full.text,
    full.toolCard ? JSON.stringify(full.toolCard) : null,
    full.toolCards?.length ? JSON.stringify(full.toolCards) : null,
    full.agentMessages?.length ? JSON.stringify(full.agentMessages) : null,
    full.contextTokens ?? null,
    full.createdAt,
  )

  // The session's "last activity" time is refreshed — the list is sorted by it
  d.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(full.createdAt, full.sessionId)

  return full
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------
//
// Every call is written HERE FIRST and broadcast to the UI AFTERWARDS
// (`sendTool` in `orchestrator.ts`). The order is deliberate: a WS event can be
// lost and a stream can be cut short mid-way — the database record survives.
// It used to be the other way round, and commands executed during an
// interrupted stream vanished without a trace.
//
// `readMessages` takes the cards FROM THIS TABLE (not from the old
// `chat_messages.tool_cards` column): that column is only written at the end of
// a stream, so it stays empty for an interrupted reply. The column remains as a
// fallback for old messages.

interface ToolCallRow {
  id: string
  session_id: string
  message_id: string
  name: string
  args: string
  status: ToolCall['status']
  result: string | null
  detail: string | null
  permission: string | null
  classifier: string | null
  created_at: string
  updated_at: string
}

function toolCallFromRow(r: ToolCallRow): ToolCall {
  return {
    id: r.id,
    name: r.name,
    args: r.args,
    status: r.status,
    result: r.result ?? undefined,
    detail: parseJsonObject<ToolCall['detail']>(r.detail),
    permission: parseJsonObject<ToolCall['permission']>(r.permission),
    classifier: parseJsonObject<ToolCall['classifier']>(r.classifier),
  }
}

/** Malformed JSON must not make the whole reply unreadable — returns `undefined` */
function parseJsonObject<T>(raw: string | null): T | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/**
 * Writes or updates a tool call (UPSERT by id).
 *
 * One call arrives several times: `running` → result chunks → `done`. This
 * function is called each time and the record is overwritten.
 *
 * `COALESCE` is deliberate: if `permission` or `classifier` is not supplied on
 * a later update, what was already written IS NOT ERASED. The permission
 * decision arrives in the middle of a call, and the completion event knows
 * nothing about it.
 */
export function writeToolCall(
  call: ToolCall & { sessionId: string; messageId: string },
  database?: Database,
): void {
  const d = database ?? globalDb()
  const now = new Date().toISOString()
  d.prepare(
    `INSERT INTO tool_calls
       (id, session_id, message_id, name, args, status, result, detail, permission,
        classifier, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name       = excluded.name,
       args       = excluded.args,
       status     = excluded.status,
       result     = excluded.result,
       detail     = COALESCE(excluded.detail, tool_calls.detail),
       permission = COALESCE(excluded.permission, tool_calls.permission),
       classifier = COALESCE(excluded.classifier, tool_calls.classifier),
       updated_at = excluded.updated_at`,
  ).run(
    call.id,
    call.sessionId,
    call.messageId,
    call.name,
    call.args,
    call.status,
    call.result ?? null,
    call.detail ? JSON.stringify(call.detail) : null,
    call.permission ? JSON.stringify(call.permission) : null,
    call.classifier ? JSON.stringify(call.classifier) : null,
    now,
    now,
  )
}

/** The tool calls of a single reply, in execution order */
export function readToolCalls(messageId: string, database?: Database): ToolCall[] {
  const d = database ?? globalDb()
  return d
    .query<ToolCallRow, [string]>(
      'SELECT * FROM tool_calls WHERE message_id = ? ORDER BY created_at, rowid',
    )
    .all(messageId)
    .map(toolCallFromRow)
}

/** Every tool call in a session — for diagnostics and restoring the history */
export function readSessionToolCalls(sessionId: string, database?: Database): ToolCall[] {
  const d = database ?? globalDb()
  return d
    .query<ToolCallRow, [string]>(
      'SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at, rowid',
    )
    .all(sessionId)
    .map(toolCallFromRow)
}

// ---------------------------------------------------------------------------
// Attachments — files and images uploaded to the chat
// ---------------------------------------------------------------------------
//
// The same pattern as `tool_calls`: a separate table, with `readMessages()`
// stitching the records onto their message. The difference is that
// `message_id` may be NULL (uploaded but not yet sent) and that this is a
// NORMAL intermediate state, so no synthetic message is BUILT for an orphan.
//
// This layer DOES NOT TOUCH THE FILE SYSTEM (the same rule as
// `createProject`): writing and deleting on disk is the caller's job. That is
// why `deleteOrphanAttachments` returns the list of deleted records — the
// caller cleans up the files itself.

interface AttachmentRow {
  id: string
  session_id: string
  message_id: string | null
  kind: ChatAttachment['kind']
  name: string
  original_name: string
  path: string
  mime: string
  size: number
  created_at: string
}

function attachmentFromRow(r: AttachmentRow): ChatAttachment {
  return {
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind,
    originalName: r.original_name,
    path: r.path,
    mime: r.mime,
    size: r.size,
    createdAt: r.created_at,
  }
}

/**
 * A new attachment record. When `messageId` is not given it is NULL — the file
 * was uploaded but the message has not been sent yet.
 *
 * `name` (the sanitised name on disk) is NOT part of the external type: it is
 * only needed on the server, to build the path. The client sees `originalName`
 * and `path`.
 */
export function writeAttachment(
  attachment: Omit<ChatAttachment, 'id' | 'createdAt'> & {
    id?: string
    createdAt?: string
    name: string
    messageId?: string | null
  },
  database?: Database,
): ChatAttachment {
  const d = database ?? globalDb()
  const full: ChatAttachment = {
    id: attachment.id ?? crypto.randomUUID(),
    sessionId: attachment.sessionId,
    kind: attachment.kind,
    originalName: attachment.originalName,
    path: attachment.path,
    mime: attachment.mime,
    size: attachment.size,
    createdAt: attachment.createdAt ?? new Date().toISOString(),
  }

  d.prepare(
    `INSERT INTO chat_attachments
       (id, session_id, message_id, kind, name, original_name, path, mime, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    full.id,
    full.sessionId,
    attachment.messageId ?? null,
    full.kind,
    attachment.name,
    full.originalName,
    full.path,
    full.mime,
    full.size,
    full.createdAt,
  )

  return full
}

export function readAttachment(id: string, database?: Database): ChatAttachment | null {
  const d = database ?? globalDb()
  const r = d
    .query<AttachmentRow, [string]>('SELECT * FROM chat_attachments WHERE id = ?')
    .get(id)
  return r ? attachmentFromRow(r) : null
}

/**
 * Fetches attachments by id — ONLY those belonging to this session.
 *
 * The session filter is a SECURITY BOUNDARY, not a convenience: the client can
 * send arbitrary ids in `chat.send`, and without it another conversation's file
 * could be attached to this message.
 *
 * The returned list is IN THE ORDER REQUESTED — the files appear in the prompt
 * the way the user picked them. A missing id is not silently dropped: the
 * caller checks the count and raises an error.
 */
export function readAttachmentsByIds(
  sessionId: string,
  ids: string[],
  database?: Database,
): ChatAttachment[] {
  if (ids.length === 0) return []
  const d = database ?? globalDb()
  const placeholders = ids.map(() => '?').join(', ')
  const found = d
    .query<AttachmentRow, string[]>(
      `SELECT * FROM chat_attachments WHERE session_id = ? AND id IN (${placeholders})`,
    )
    .all(sessionId, ...ids)
    .map(attachmentFromRow)

  const byId = new Map(found.map((a) => [a.id, a]))
  return ids.map((id) => byId.get(id)).filter((a): a is ChatAttachment => a !== undefined)
}

/** Every attachment in a session — for cleaning the folder and for diagnostics */
export function sessionAttachments(sessionId: string, database?: Database): ChatAttachment[] {
  const d = database ?? globalDb()
  return d
    .query<AttachmentRow, [string]>(
      'SELECT * FROM chat_attachments WHERE session_id = ? ORDER BY created_at, rowid',
    )
    .all(sessionId)
    .map(attachmentFromRow)
}

/**
 * Links attachments to a message — called once the message has been written.
 *
 * Only records belonging to THIS SESSION and not yet linked
 * (`message_id IS NULL`) are changed. The second condition guards against a
 * repeated send: a file that already belongs to one message must not migrate to
 * another.
 *
 * Returns the number of changed records.
 */
export function linkAttachmentsToMessage(
  sessionId: string,
  messageId: string,
  ids: string[],
  database?: Database,
): number {
  if (ids.length === 0) return 0
  const d = database ?? globalDb()
  const placeholders = ids.map(() => '?').join(', ')
  const result = d
    .prepare(
      `UPDATE chat_attachments SET message_id = ?
       WHERE session_id = ? AND message_id IS NULL AND id IN (${placeholders})`,
    )
    .run(messageId, sessionId, ...ids)
  return result.changes
}

/**
 * Whether an attachment is linked to a message.
 *
 * `ChatAttachment` DELIBERATELY has no `messageId`: the client does not need it
 * and the external type is not padded with internal state. But the server needs
 * to know it in one place — to refuse deleting an attachment that has been sent.
 */
export function isAttachmentLinked(id: string, database?: Database): boolean {
  const d = database ?? globalDb()
  const r = d
    .query<{ message_id: string | null }, [string]>(
      'SELECT message_id FROM chat_attachments WHERE id = ?',
    )
    .get(id)
  return r?.message_id !== null && r?.message_id !== undefined
}

/** Deletes a single attachment. The file is removed by the caller. */
export function deleteAttachment(id: string, database?: Database): boolean {
  const d = database ?? globalDb()
  return d.prepare('DELETE FROM chat_attachments WHERE id = ?').run(id).changes > 0
}

/**
 * Deletes attachments that are not linked to a message and have gone stale.
 *
 * WHY IT IS NEEDED: a user uploading a file and then changing their mind is a
 * normal thing to do. The record stays at `message_id IS NULL` and the file
 * sits on disk. No cron job is required — this is called at the start of
 * `streamReply` for that session (`orchestrator.ts`), so the cleanup happens
 * naturally as the platform is used.
 *
 * The age threshold is LARGE (24 hours by default) on purpose: if a user is
 * looking at a chip whose file has been deleted underneath them, sending would
 * fail.
 *
 * RETURNS the deleted records — the caller cleans up the files.
 */
export function deleteOrphanAttachments(
  sessionId: string,
  hoursAgo = 24,
  database?: Database,
): ChatAttachment[] {
  const d = database ?? globalDb()
  const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString()
  const orphans = d
    .query<AttachmentRow, [string, string]>(
      `SELECT * FROM chat_attachments
       WHERE session_id = ? AND message_id IS NULL AND created_at < ?`,
    )
    .all(sessionId, cutoff)
    .map(attachmentFromRow)

  if (orphans.length === 0) return []

  const placeholders = orphans.map(() => '?').join(', ')
  d.prepare(`DELETE FROM chat_attachments WHERE id IN (${placeholders})`).run(
    ...orphans.map((a) => a.id),
  )
  return orphans
}

// ---------------------------------------------------------------------------
// Build sessions — a skeleton, filled in by the orchestrator at a later stage
// ---------------------------------------------------------------------------

interface BuildRow {
  id: string
  app_id: string
  session_id: string | null
  status: BuildSessionStatus
  error: string | null
  created_at: string
  updated_at: string
}

function buildFromRow(r: BuildRow): BuildSession {
  return { id: r.id, appId: r.app_id, status: r.status, createdAt: r.created_at }
}

export function createBuild(
  appId: string,
  sessionId: string | null = null,
  database?: Database,
): BuildSession {
  const d = database ?? globalDb()
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  d.prepare(
    `INSERT INTO build_sessions (id, app_id, session_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?)`,
  ).run(id, appId, sessionId, now, now)
  return { id, appId, status: 'running', createdAt: now }
}

export function setBuildStatus(
  id: string,
  status: BuildSessionStatus,
  error?: string,
  database?: Database,
): void {
  const d = database ?? globalDb()
  d.prepare('UPDATE build_sessions SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(
    status,
    error ?? null,
    new Date().toISOString(),
    id,
  )
}

export function readBuild(id: string, database?: Database): BuildSession | null {
  const d = database ?? globalDb()
  const r = d.query<BuildRow, [string]>('SELECT * FROM build_sessions WHERE id = ?').get(id)
  return r ? buildFromRow(r) : null
}
