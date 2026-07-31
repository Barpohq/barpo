// Backend REST API access — a thin `fetch` layer.
//
// URLs are relative (`/api/...`): vite proxy in dev, a single process in prod
// — the same path works in both.
//
// Server errors arrive as `{ error, detail? }`; `ApiError` keeps that data
// together with the status so the caller can distinguish cases such as 409
// (provider lock).

import type {
  AppManifest,
  ChatAttachment,
  ChatMessage,
  ChatSession,
  DetectWarning,
  McpScope,
  McpServer,
  McpSettingField,
  McpSource,
  McpTransportKind,
  ModelInfo,
  ModeState,
  PermissionAnswer,
  PermissionMode,
  PermissionRequest,
  Project,
  ProviderInfo,
  Server,
  ServerMetrics,
  SettingField,
  Skill,
  SkillScope,
  SkillSource,
} from '@platforma/shared'

export class ApiError extends Error {
  status: number
  detail?: string

  constructor(status: number, message: string, detail?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, options)
  } catch (error) {
    throw new ApiError(0, 'Could not reach the server', error instanceof Error ? error.message : undefined)
  }

  const text = await response.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new ApiError(response.status, 'Could not read the server response', text.slice(0, 200))
  }

  if (!response.ok) {
    const e = body as { error?: string; detail?: string }
    throw new ApiError(response.status, e.error ?? `Error ${response.status}`, e.detail)
  }
  return body as T
}

const jsonHeaders = { 'content-type': 'application/json' }

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelsResponse {
  models: ModelInfo[]
  providers: ProviderInfo[]
  warnings: DetectWarning[]
  time: string
}

export function fetchModels(): Promise<ModelsResponse> {
  return request<ModelsResponse>('/api/models')
}

export function refreshModels(): Promise<ModelsResponse> {
  return request<ModelsResponse>('/api/models/refresh', { method: 'POST' })
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * New session. If `projectId` is given the conversation is attached to the
 * project and the agent's tools run inside the project folder.
 */
export async function createSession(title?: string, projectId?: string): Promise<ChatSession> {
  const response = await request<{ session: ChatSession }>('/api/chat/sessions', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ title, projectId }),
  })
  return response.session
}

/**
 * All conversations — by last activity (newest first).
 *
 * Every record carries `messageCount`: the UI uses it to single out empty
 * conversations.
 */
export async function fetchSessions(): Promise<ChatSession[]> {
  const response = await request<{ sessions: ChatSession[] }>('/api/chat/sessions')
  return response.sessions
}

/** Renames a conversation. Title only — model and project are locked. */
export async function renameSession(
  sessionId: string,
  title: string,
): Promise<ChatSession> {
  const response = await request<{ session: ChatSession }>(`/api/chat/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ title }),
  })
  return response.session
}

/**
 * Deletes a conversation — together with its messages, irreversibly.
 *
 * If a stream is running the server stops it first.
 */
export function deleteSession(
  sessionId: string,
): Promise<{ deleted: boolean; streamStopped: boolean }> {
  return request<{ deleted: boolean; streamStopped: boolean }>(
    `/api/chat/sessions/${sessionId}`,
    { method: 'DELETE' },
  )
}

/**
 * A single session — for restoring from the URL.
 *
 * Returns `null` (rather than throwing) when the session is not found: a stale
 * or wrong URL is a normal case, and the caller simply lands on an empty chat.
 */
export async function fetchSession(sessionId: string): Promise<ChatSession | null> {
  try {
    const response = await request<{ session: ChatSession }>(`/api/chat/sessions/${sessionId}`)
    return response.session
  } catch {
    return null
  }
}

export async function fetchMessages(sessionId: string): Promise<ChatMessage[]> {
  const response = await request<{ messages: ChatMessage[] }>(`/api/chat/sessions/${sessionId}/messages`)
  return response.messages
}

export interface SendResponse {
  messageId: string
  model: { provider: string; model: string }
}

/**
 * Sends a message. `attachments` are the IDs returned by `uploadAttachment()`.
 *
 * Only IDs are sent: the server looks up path and kind in the database (if the
 * client supplied them it could point outside the work directory or slip past
 * the vision guard).
 */
export function sendMessage(
  sessionId: string,
  text: string,
  model: { provider: string; model: string },
  attachments?: string[],
): Promise<SendResponse> {
  return request<SendResponse>('/api/chat/send', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ sessionId, text, model, attachments }),
  })
}

/**
 * Attaches a file or image to the chat.
 *
 * `content-type` is DELIBERATELY NOT SET: for FormData the browser sets it
 * itself as `multipart/form-data; boundary=...`. Setting it by hand loses the
 * boundary and the server cannot read the body.
 *
 * `sessionId` is required — the file goes straight into the session folder.
 * That is why the chat page creates the session the moment a file is picked.
 */
export async function uploadAttachment(
  sessionId: string,
  files: File[],
): Promise<ChatAttachment[]> {
  const body = new FormData()
  body.set('sessionId', sessionId)
  for (const f of files) body.append('file', f)

  const response = await request<{ attachments: ChatAttachment[] }>('/api/chat/attachment', {
    method: 'POST',
    body,
  })
  return response.attachments
}

/**
 * Removes an attachment (the `×` on the chip).
 *
 * For an attachment already linked to a message the server answers 409: it is
 * part of the conversation history and the agent has seen it.
 */
export function removeAttachment(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/chat/attachment/${id}`, { method: 'DELETE' })
}

/** URL of the attachment content — for `<img src>` and downloads */
export function attachmentUrl(id: string): string {
  return `/api/chat/attachment/${id}`
}

export function sendPermissionAnswer(
  sessionId: string,
  requestId: string,
  answer: PermissionAnswer,
): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>('/api/chat/permission', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ sessionId, requestId, answer }),
  })
}

/**
 * Permission requests awaiting an answer in the session.
 *
 * An ADDITIONAL path next to the `chat.permission` WS event: the event is sent
 * once and may not arrive (the page was opened mid-stream, the WS is
 * reconnecting, the session filter is not set yet). Without this the agent
 * waits for an answer while the user cannot see what is being asked.
 */
export async function fetchPendingPermissions(sessionId: string): Promise<PermissionRequest[]> {
  const response = await request<{ requests: PermissionRequest[] }>(
    `/api/chat/sessions/${sessionId}/permissions`,
  )
  return response.requests
}

export async function fetchMode(sessionId: string): Promise<ModeState> {
  const response = await request<{ state: ModeState }>(`/api/chat/sessions/${sessionId}/mode`)
  return response.state
}

export async function setMode(
  sessionId: string,
  mode: PermissionMode,
): Promise<ModeState> {
  const response = await request<{ state: ModeState }>(`/api/chat/sessions/${sessionId}/mode`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ mode }),
  })
  return response.state
}

/** A single session whose agent stream is currently running */
export interface RunningSession {
  sessionId: string
  status: 'running' | 'awaiting-permission'
  /** Session title — absent if the session was deleted */
  title?: string
}

/**
 * The initial list of running sessions.
 *
 * Only needed when the page opens: after that the list is kept up to date by
 * `chat.status` WS events. Both are needed, because status changes that happen
 * before the WS connects never reach the client.
 */
export async function fetchRunning(): Promise<RunningSession[]> {
  const response = await request<{ running: RunningSession[] }>('/api/chat/running')
  return response.running
}

export function stopStream(sessionId: string): Promise<{ stopped: boolean }> {
  return request<{ stopped: boolean }>('/api/chat/stop', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ sessionId }),
  })
}

// ---------------------------------------------------------------------------
// Apps (dynamic dashboards)
// ---------------------------------------------------------------------------

/**
 * Dashboards published by the agent via `appPublish`.
 *
 * The sidebar is built from this list — not from mock data. The manifest has
 * already been validated on the server (`validateManifest`), so no re-check is
 * needed here.
 */
export async function fetchApps(): Promise<AppManifest[]> {
  const response = await request<{ apps: AppManifest[] }>('/api/apps')
  return response.apps
}

// ---------------------------------------------------------------------------
// App controls — settings and actions
// ---------------------------------------------------------------------------
//
// THE SERVER IS THE SOURCE OF TRUTH. Values are written into the app's own
// configuration on the server (see the controls-layer note in `types.ts`), so
// secret values NEVER reach this side — only the `isSet` flag.

export interface SettingsState {
  fields: SettingField[]
  /** Current values without secrets (read from the server) */
  values: Record<string, string>
  /** For secret fields: key → whether it is set on the server */
  isSet: Record<string, boolean>
  /** If reading failed — the reason. The form is shown regardless. */
  warning?: string
}

export function fetchAppSettings(appId: string): Promise<SettingsState> {
  return request<SettingsState>(`/api/apps/${encodeURIComponent(appId)}/settings`)
}

export interface SettingsSaveResponse {
  ok: boolean
  message?: string
  error?: string
  /** Validation errors (400) */
  errors?: string[]
}

/**
 * Writes the values to the server.
 *
 * DO NOT SEND EMPTY SECRETS: an empty string means "I did not change it" and
 * the server drops it, but not sending it at all is clearer.
 */
export function saveAppSettings(
  appId: string,
  values: Record<string, string>,
): Promise<SettingsSaveResponse> {
  return request<SettingsSaveResponse>(`/api/apps/${encodeURIComponent(appId)}/settings`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ values }),
  })
}

export interface ActionResponse {
  ok: boolean
  message?: string
  error?: string
  /** The action was already running — the result comes from that run */
  wasBusy?: boolean
  /** New values of the states listed in `refresh` */
  states?: Record<string, { ok: boolean; value?: unknown; error?: string; time: string }>
}

export function runAppAction(appId: string, name: string): Promise<ActionResponse> {
  return request<ActionResponse>(
    `/api/apps/${encodeURIComponent(appId)}/action/${encodeURIComponent(name)}`,
    { method: 'POST' },
  )
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function fetchProjects(): Promise<Project[]> {
  const response = await request<{ projects: Project[] }>('/api/projects')
  return response.projects
}

/**
 * New project. Only the name is sent — the server creates the folder itself
 * (`~/.platforma/projects/<slug>/`); the client cannot supply a path.
 */
export async function createProject(name: string): Promise<Project> {
  const response = await request<{ project: Project }>('/api/projects', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  })
  return response.project
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillCatalog {
  skills: Skill[]
  sources: SkillSource[]
}

export function fetchSkills(): Promise<SkillCatalog> {
  return request<SkillCatalog>('/api/skills')
}

export interface SourceResult {
  source: SkillSource
  added: number
  updated: number
  deleted: number
  warnings: string[]
}

/** Connects a GitHub repo — skills land in the catalog, NOTHING IS DOWNLOADED */
export function addSkillSource(url: string): Promise<SourceResult> {
  return request<SourceResult>('/api/skills/source', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ url }),
  })
}

export function syncSkillSource(
  id: string,
): Promise<Omit<SourceResult, 'source'>> {
  return request<Omit<SourceResult, 'source'>>(`/api/skills/source/${id}/sync`, {
    method: 'POST',
  })
}

export function deleteSkillSource(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/skills/source/${id}`, { method: 'DELETE' })
}

/**
 * Installs a skill. With `scope: 'project'` the `projectIds` are required —
 * a single call can install into several projects.
 */
export async function installSkill(
  id: string,
  scope: SkillScope,
  projectIds?: string[],
): Promise<Skill> {
  const response = await request<{ skill: Skill }>(`/api/skills/${id}/install`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ scope, projectIds }),
  })
  return response.skill
}

export async function uninstallSkill(
  id: string,
  scope: SkillScope,
  projectIds?: string[],
): Promise<Skill | null> {
  const response = await request<{ skill: Skill | null }>(`/api/skills/${id}/install`, {
    method: 'DELETE',
    headers: jsonHeaders,
    body: JSON.stringify({ scope, projectIds }),
  })
  return response.skill
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------
//
// Same shape as the skills section. TWO DIFFERENCES:
//   - the registry search is a SEPARATE step (its results are not stored);
//   - `settingValues` are sent, but SECRET values are NEVER returned in the
//     response (the server does not even read them back).

export interface McpCatalog {
  servers: McpServer[]
  sources: McpSource[]
}

export function fetchMcpServers(): Promise<McpCatalog> {
  return request<McpCatalog>('/api/mcp')
}

/** A registry search hit — an entry not yet added to the catalog */
export interface McpRegistryResult {
  name: string
  description: string
  transport: McpTransportKind
  version: string | null
  settings: McpSettingField[]
}

/** Searches the official registry. STORES NOTHING. */
export async function mcpRegistrySearch(term: string): Promise<McpRegistryResult[]> {
  const response = await request<{ results: McpRegistryResult[] }>(
    `/api/mcp/registry/search?q=${encodeURIComponent(term)}`,
  )
  return response.results
}

export interface McpSourceResult {
  source: McpSource
  added: number
  updated: number
  deleted: number
  warnings?: string[]
}

/** Adds the server picked from the registry to the catalog */
export function addMcpFromRegistry(name: string): Promise<McpSourceResult> {
  return request<McpSourceResult>('/api/mcp/source/registry', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  })
}

/** Scans a GitHub repo for `server.json` files */
export function addMcpFromGithub(url: string): Promise<McpSourceResult> {
  return request<McpSourceResult>('/api/mcp/source/github', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ url }),
  })
}

export interface McpManualInput {
  name: string
  description?: string
  transport: McpTransportKind
  /** for stdio */
  command?: string
  args?: string[]
  /** for http */
  url?: string
  settings?: McpSettingField[]
}

/** Adding a server by hand — command or URL comes from the user */
export function addMcpManually(input: McpManualInput): Promise<McpSourceResult> {
  return request<McpSourceResult>('/api/mcp/source/manual', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
}

export function syncMcpSource(id: string): Promise<Omit<McpSourceResult, 'source'>> {
  return request<Omit<McpSourceResult, 'source'>>(`/api/mcp/source/${id}/sync`, {
    method: 'POST',
  })
}

export function deleteMcpSource(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/mcp/source/${id}`, { method: 'DELETE' })
}

/**
 * Installs the server.
 *
 * `settingValues` — field name → value. Secret fields go into a separate file
 * (not into the database). An EMPTY value means "I did not change it": the
 * stored token stays in place.
 */
export async function installMcpServer(
  id: string,
  scope: McpScope,
  settingValues: Record<string, string>,
  projectIds?: string[],
): Promise<McpServer> {
  const response = await request<{ server: McpServer }>(`/api/mcp/${id}/install`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ scope, projectIds, settingValues }),
  })
  return response.server
}

export async function uninstallMcpServer(
  id: string,
  scope: McpScope,
  projectIds?: string[],
): Promise<McpServer | null> {
  const response = await request<{ server: McpServer | null }>(`/api/mcp/${id}/install`, {
    method: 'DELETE',
    headers: jsonHeaders,
    body: JSON.stringify({ scope, projectIds }),
  })
  return response.server
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

export function fetchServers(): Promise<{ servers: Server[] }> {
  return request<{ servers: Server[] }>('/api/servers')
}

/**
 * Adds a server: the backend installs the platform key on it and gets
 * `ssh <name>` working. `password` is optional — it is not needed if your
 * existing keys can already log in; if given it is NOT STORED.
 */
export async function addServer(info: {
  name: string
  host: string
  port?: number | string
  username?: string
  password?: string
}): Promise<{ server: Server; connectionError?: string }> {
  return request<{ server: Server; connectionError?: string }>('/api/servers', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(info),
  })
}

export function deleteServer(id: string): Promise<{ ok: boolean; note?: string }> {
  return request<{ ok: boolean; note?: string }>(`/api/servers/${id}`, { method: 'DELETE' })
}

export function fetchServerMetrics(id: string): Promise<{ metrics: ServerMetrics }> {
  return request<{ metrics: ServerMetrics }>(`/api/servers/${id}/metrics`)
}
