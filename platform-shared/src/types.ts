// Shared platform types — both the UI and the server take them from here.
// This file is the single source of truth: when a type changes, both sides
// learn about it at once.
// (It used to live inside platform-ui/src/data/mock.ts; now mock.ts imports
// from here and re-exports — nothing changes for the pages.)

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentStatus = 'running' | 'idle' | 'paused'

export interface Agent {
  id: string
  name: string
  desc: string
  status: AgentStatus
  schedule: string
  nextRun: string
  todayCost: number
  todayCalls: number
  model: string
  metrics: { label: string; value: string }[]
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

// Only CONNECTION data is stored in the database. Live state (metrics,
// online/offline) is fetched over SSH as `ServerMetrics` on every request —
// it is not stored, because a stale value would be a "trustworthy-looking lie".
export interface Server {
  id: string
  /** SSH alias — `ssh <name>` works with this name. Only [a-z0-9-]. */
  name: string
  host: string
  port: number
  /** Usually 'root' — so the platform can fully manage the server */
  username: string
  createdAt: string
}

/** Live state read over SSH — never written to the database */
export interface ServerMetrics {
  status: 'connected' | 'error'
  /** When status='error', the reason goes here */
  error?: string
  /** In the form "3 days 4 hours" */
  uptime?: string
  /** Percentages: 0-100. CPU — 1-minute load / core count. */
  cpu?: number
  ram?: number
  disk?: number
}

// ---------------------------------------------------------------------------
// Workflow (pipeline steps)
// ---------------------------------------------------------------------------

export interface WorkflowStep {
  id: string
  name: string
  desc: string
  status: 'done' | 'running' | 'waiting'
  stat: string
  detail: string
}

// ---------------------------------------------------------------------------
// LLM calls and cost
// ---------------------------------------------------------------------------

export interface LlmCall {
  time: string
  agent: string
  model: string
  task: string
  tokens: string
  cost: string
}

// ---------------------------------------------------------------------------
// Audit log — append-only, every action on the platform lands here
// ---------------------------------------------------------------------------

export type AuditLevel = 'read' | 'write' | 'dangerous'

export interface AuditEntry {
  /** "HH:MM" — the time of day, ready to display */
  time: string
  /**
   * The full moment, ISO 8601. WITHOUT THIS the log cannot be read once it
   * spans more than a day: `time` is only "HH:MM", so an entry from
   * 09:00 today and one from 09:00 last week look identical. The column has
   * always been in the database (`created_at`); it simply was not carried out
   * to the client.
   *
   * Optional because entries created before this field existed do not have it
   * — read it defensively.
   */
  at?: string
  actor: string
  action: string
  target: string
  level: AuditLevel
  result: 'OK' | 'approved' | 'denied' | 'pending'
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
//
// The model has three layers — they must NOT be mixed up:
//
//   SOURCE  — a connected GitHub repo (`anthropics/skills`). One source holds
//             many skills.
//   SKILL   — a single `SKILL.md` found inside the repo. It shows up in the
//             catalog, but is not on disk yet — this only means "available".
//   INSTALL — where the skill runs: globally (everywhere) or in specific
//             projects. One skill can be installed into several projects at
//             once, which is why this is a separate list.
//
// A skill appears on disk ONLY after it is installed (in the store), and it is
// copied into the project folder at the start of a session. Details:
// platform-server/src/skill-store.ts.

/**
 * Where a skill source comes from.
 *
 * `github`  — a repo the user connected (`owner/repo`).
 * `builtin` — the default skills that ship WITH the platform.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ WHY `builtin` IS A SEPARATE KIND. Builtin skills (such as writing  │
 * │ dashboards) are part of the platform and are versioned with it.    │
 * │                                                                    │
 * │ For now they are read from the `skills/` folder inside the repo,   │
 * │ because the repo is private. Once the repo is opened the source    │
 * │ moves to GitHub — at that point ONLY the scanning source changes;  │
 * │ the catalog, install and UI flows stay as they are. That is why    │
 * │ they go through the catalog like an ordinary source from day one.  │
 * └────────────────────────────────────────────────────────────────────┘
 */
export type SkillSourceKind = 'github' | 'builtin'

export interface SkillSource {
  id: string
  kind: SkillSourceKind
  /** The original URL the user entered — this is what the UI shows */
  url: string
  owner: string
  repo: string
  /** Branch or tag. When empty, the repo's default branch was used. */
  ref: string
  /** Commit SHA of the last sync — this is how we know something changed */
  commitSha: string | null
  lastSync: string | null
  createdAt: string
}

/** Where a skill is active */
export type SkillScope = 'global' | 'project'

export interface SkillInstall {
  scope: SkillScope
  /** Required when `scope: 'project'`, otherwise undefined */
  projectId?: string
}

export interface Skill {
  id: string
  sourceId: string
  /** Path inside the repo — `document-skills/pdf/SKILL.md` */
  path: string
  /** The `name` from the frontmatter, or the folder name if missing */
  name: string
  /** The `description` from the frontmatter — REQUIRED, it goes into the prompt */
  description: string
  license?: string
  /**
   * The `allowed-tools` from the frontmatter.
   *
   * NOT ENFORCED FOR NOW — it is merely shown to the user in the install
   * modal. Enforcement is a separate step (it is not implemented in pi
   * either).
   */
  allowedTools?: string[]
  /** Places that do not match the spec — the skill still loads, the UI shows these */
  warnings: string[]
  /** Empty array = not installed, only sitting in the catalog */
  installs: SkillInstall[]
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) servers
// ---------------------------------------------------------------------------
//
// The model has EXACTLY THE SAME three layers as skills (see the comment
// above):
//
//   SOURCE  — where the catalog came from (registry, GitHub repo, manual,
//             builtin).
//   SERVER  — a single MCP server entry in the catalog. It means "available",
//             NOT "connected".
//   INSTALL — where the server is active: globally or in specific projects.
//
// THE FUNDAMENTAL DIFFERENCE FROM SKILLS — here it is a PROCESS, not a DISK.
//
// When a skill is installed a file is copied and that is the end of it; the
// agent reads it with `read`. When an MCP server is installed nothing is
// copied: it starts as a PROCESS at the beginning of each session (stdio) or
// connects to a remote address (http), and it gives the agent NEW TOOLS.
//
// Three things follow from that (platform-ai/src/mcp-*.ts):
//   1) lifecycle — starting the process, killing it, leaving no zombies;
//   2) credentials — nearly every server requires a token (see below);
//   3) permission — every tool call goes through `PermissionManager.ask()`.

/**
 * How we talk to an MCP server.
 *
 * `stdio` — a local process (`npx`/`uvx`/`docker`) over JSON-RPC on
 *           stdin/stdout. Most of the ecosystem works this way.
 * `http`  — a remote server (`streamable-http` or `sse`). No local code
 *           starts, which means it is cleaner from a security standpoint.
 */
export type McpTransportKind = 'stdio' | 'http'

/**
 * Where a catalog entry came from.
 *
 * `registry` — the official MCP registry (registry.modelcontextprotocol.io).
 * `github`   — found by searching for `server.json` in a repo.
 * `manual`   — entered by the user (a command or a URL).
 * `builtin`  — the set that ships with the platform.
 *
 * Same idea as `SkillSourceKind`: the source kind matters ONLY for HOW the
 * entry is obtained; every step after that (catalog, install, UI) does not
 * know the kind.
 */
export type McpCatalogSourceKind = 'registry' | 'github' | 'manual' | 'builtin'

export interface McpSource {
  id: string
  kind: McpCatalogSourceKind
  /**
   * The name identifying the source — its meaning depends on the kind:
   * the server name for `registry`, `owner/repo` for `github`, the name the
   * user gave for `manual`, and the folder name for `builtin`.
   */
  sourceName: string
  /** Only filled in for the `github` kind */
  owner: string | null
  repo: string | null
  /** Branch or tag. Empty string = default branch. */
  ref: string
  lastSync: string | null
  createdAt: string
}

/**
 * A single configurable field — an env variable (stdio) or an HTTP header.
 *
 * IMPORTANT: this is ONLY THE SCHEMA, not the value. That is, the information
 * "this server asks for `GITHUB_TOKEN`". The value itself is entered during
 * install and, when it is `secret`, it NEVER reaches the database
 * (`mcp-credentials.ts`).
 *
 * Taken from `KeyValueInput` in the official registry schema:
 * `isRequired` → `required`, `isSecret` → `secret`.
 */
export interface McpSettingField {
  name: string
  hint?: string
  required: boolean
  /** true — hidden in the UI, goes into the credential store, never returned by the API */
  secret: boolean
  default?: string
}

/**
 * An MCP server in the catalog — it means "such a server exists".
 *
 * It is filled in two different ways depending on `transport`: `command`
 * + `args` for `stdio`, `url` for `http`. This is enforced with a CHECK in
 * the database (migration 011).
 */
export interface McpCatalogEntry {
  id: string
  sourceId: string
  /** The reverse-DNS name from the registry (`com.example/github`) or a free-form name */
  name: string
  description: string
  transport: McpTransportKind
  /** `stdio`: the launch command — `npx`, `uvx`, `docker` */
  command?: string
  /**
   * `stdio`: arguments. Placeholders (`{token}`) are NOT substituted yet —
   * they are substituted before the process starts, inside the `Bun.spawn`
   * argv array (NOT through a shell).
   */
  args?: string[]
  /** `http`: the server address */
  url?: string
  /** A DESCRIPTION of the required env vars/headers — no values */
  settings: McpSettingField[]
  createdAt: string
}

/** Where an MCP server is active — the same as `SkillScope` */
export type McpScope = 'global' | 'project'

export interface McpInstall {
  /** The id of the install row — the credential key is built from it */
  id: string
  scope: McpScope
  /** Required when `scope: 'project'` */
  projectId?: string
  /**
   * NON-SECRET setting values (for example `BASE_URL`).
   *
   * Secrets are NOT here — they live in `mcp-credentials.ts`, in a separate
   * file. Each install has its own values: one server can run in two projects
   * with different tokens.
   */
  settingValues: Record<string, string>
}

/** Catalog + install state — the full view for the UI list */
export interface McpServer extends McpCatalogEntry {
  /** Empty array = not installed, only sitting in the catalog */
  installs: McpInstall[]
}

// ---------------------------------------------------------------------------
// Chat: tool cards
// ---------------------------------------------------------------------------

/** The old single-card shape — the mock demo and the build flow still use it */
export interface ToolCard {
  tool: string
  args: string
  result: string
}

// ---------------------------------------------------------------------------
// Agent tool calls — the actions the LLM performed by hand
// ---------------------------------------------------------------------------

export type ToolStatus = 'running' | 'done' | 'error' | 'denied'

/** A single tool call — the UI card is rendered from this shape */
export interface ToolCall {
  id: string
  /** 'read' | 'write' | 'edit' | 'bash' */
  name: string
  /** A shortened view of the arguments: a file path or the command text */
  args: string
  status: ToolStatus
  /** The result text (shortened when long) */
  result?: string
  /** A diff for `edit`, a truncation marker for `bash` */
  detail?: {
    diff?: string
    truncated?: boolean
  }
  /** The verdict the classifier produced for this action in auto mode */
  classifier?: ClassifierVerdict
  /**
   * How the action was approved. It is written to the database together with
   * the tool call, so it is still visible when the conversation is reopened.
   */
  permission?: PermissionDecision
}

// ---------------------------------------------------------------------------
// Permission requests — asked of the user before a dangerous action
// ---------------------------------------------------------------------------

/**
 * The kind of action that needs permission.
 *
 * `file`    — a file outside the work directory (`environment.ts`).
 * `command` — a dangerous or unfamiliar bash command (`command-analysis.ts`).
 * `mcp`     — a tool of a connected MCP server (`mcp-manager.ts`).
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ WHY MCP IS A THIRD KIND AND NOT `command`. An MCP call is neither  │
 * │ a file nor a local command: it causes a side effect in an external │
 * │ system (an issue on GitHub, a message in Slack) and that effect is │
 * │ INVISIBLE in the local file system. The classifier has to know     │
 * │ that difference too, otherwise it would judge it as a "bash        │
 * │ command" and look for command text — and an MCP call has no such   │
 * │ text.                                                              │
 * └────────────────────────────────────────────────────────────────────┘
 */
export type PermissionKind = 'file' | 'command' | 'mcp'

/** `always` — permission is granted and the pattern is remembered for the session */
export type PermissionAnswer = 'allow' | 'deny' | 'always'

/**
 * Permission mode.
 *
 * `confirm` — every dangerous or unfamiliar action is asked of the user.
 * `auto`    — the classifier decides: an action is run automatically as long
 *             as it does not stray from what the user asked for.
 *
 * Commands on the hard deny list are blocked in both modes.
 */
export type PermissionMode = 'confirm' | 'auto'

export interface ModeState {
  mode: PermissionMode
  /** When auto turned itself off — the reason */
  reason?: string
  /** Which model the classifier is running with */
  classifierModel?: string
}

/** The verdict the classifier produced for one action — shown under the tool card in the UI */
export interface ClassifierVerdict {
  /** Which tool call it belongs to */
  toolId?: string
  verdict: 'allow' | 'block'
  note: string
}

/**
 * HOW the action was approved — stored together with the tool call.
 *
 * This is not the answer ITSELF, but WHERE the answer came from. When the user
 * later asks "why was this command run?", this is the only reliable source:
 *
 *   `always`      — "Always" was chosen earlier in this session, so it was not asked again
 *   `auto`        — the classifier granted permission in auto mode
 *   `auto-block`  — the classifier blocked it in auto mode
 *   `user`        — the user pressed "Allow"
 *   `user-always` — the user pressed "Always"
 *   `denied`      — the user denied it
 *   `timeout`     — no answer arrived, it was DENIED when the deadline passed
 *   `cancelled`   — the reply stream was stopped, the request closed itself
 *   `forbidden`   — the hard deny list, nobody is asked
 *
 * `cancelled` and `denied` are DELIBERATELY separate: in the first the user
 * stopped the whole reply, in the second they rejected this specific action.
 * Showing both as "you denied this" would be a lie.
 */
export type PermissionOrigin =
  | 'always'
  | 'auto'
  | 'auto-block'
  | 'user'
  | 'user-always'
  | 'denied'
  | 'timeout'
  | 'cancelled'
  | 'forbidden'

/** The permission decision — how it was resolved, attached to the tool call */
export interface PermissionDecision {
  /** The id of the request shown to the user; absent when nothing was asked */
  requestId?: string
  origin: PermissionOrigin
  /** Was permission granted (`false` for `denied`/`auto-block`/`timeout`/`forbidden`) */
  granted: boolean
  /** The pattern remembered on "Always" */
  pattern?: string
  time: string
}

export interface PermissionRequest {
  id: string
  sessionId: string
  kind: PermissionKind
  /** Which tool: 'read', 'write', 'edit', 'bash' */
  action: string
  /** A file path or the command text */
  target: string
  /** Why it is being asked — shown to the user */
  reason: string
  /** What gets remembered when "Always allow" is chosen */
  pattern: string
  time: string
}

// ---------------------------------------------------------------------------
// App manifests — widgets as a schema, the host UI renders them dynamically
// ---------------------------------------------------------------------------

export interface StatItem {
  label: string
  value: string
  hint?: string
  accent?: string
}

export type Widget =
  | { type: 'stats'; items: StatItem[] }
  | { type: 'bars'; title: string; items: { label: string; value: number; note?: string }[]; suffix?: string }
  | { type: 'table'; title: string; columns: string[]; rows: string[][] }
  | { type: 'logs'; title: string; lines: string[] }
  | { type: 'note'; text: string }
  | { type: 'deploy'; url: string; kind: 'domain' | 'port'; server: string; ssl?: string; extra?: string }
  | { type: 'git'; repo: string; branch: string; commits: { hash: string; msg: string; time: string }[] }

/**
 * View code written by the AI — an OPTIONAL layer.
 *
 * WHY CODE IS NEEDED. The `Widget` vocabulary is deliberately narrow: it is
 * predictable and safe, but not every dashboard fits into it. The code layer
 * lifts that ceiling — the AI writes whatever layout it wants in JSX.
 *
 * ⚠️ TRUST LEVEL. The code runs in the HOST React tree, that is, with the
 * platform's own privileges (it used to run in a sandboxed iframe — the
 * comment at the top of `AiView.tsx` explains why that changed). This is the
 * same level and the same conscious decision as the `states` layer.
 *
 * The boundary is in `view-build.ts`: `import` and `fetch` are forbidden, so
 * the code cannot make arbitrary network calls. Writing happens only through
 * the platform-provided `ui.save` / `ui.action` and only to ITS OWN app
 * (the app id is locked into a closure in `AiView.tsx`).
 *
 * Error isolation is preserved: `ViewErrorBoundary` catches render errors and
 * only that block disappears.
 */
export interface AppView {
  /**
   * COMPILED JS (not JSX).
   *
   * The AI writes JSX and the server converts it with `Bun.build` — so the
   * browser is not burdened with the transform and errors are caught on the
   * server rather than in the UI.
   */
  code: string
  /** Hash of the source code — for cache invalidation and auditing */
  hash: string
}

/**
 * A piece of data that is REFRESHED over time.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ THE RULE DOES NOT CHANGE: THE AI DOES NOT WRITE NEW APIS.          │
 * │                                                                    │
 * │ There is one endpoint and it is ready IN ADVANCE:                  │
 * │     GET /api/apps/:id/state/:name                                  │
 * │ The AI only decides WHAT that endpoint RETURNS — that is, it       │
 * │ writes the state code, not the route.                              │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * WHY EVERY STATE IS SEPARATE. The data on a dashboard does not go stale at
 * the same rate: CPU changes every 5 seconds, while disk usage barely changes
 * even over 30 seconds. If we put everything into one object, the fastest
 * refreshing item would force the whole set to be recomputed each time — that
 * is, `df` would run every 5 seconds for no reason.
 *
 * That is why every state is an independent unit: its own code, its own
 * interval, its own cache.
 */
export interface AppState {
  /**
   * The state name — it sits under this key inside `data` and it lands in the
   * URL.
   *
   * Only `[a-z0-9_]` (enforced by `manifest-validate.ts`): it becomes a path
   * segment.
   */
  name: string
  /**
   * JS code executed on the server.
   *
   * In the form `module.exports = async function () { ... }` — the result
   * lands in `data[name]`. The code runs IN THE SERVER PROCESS, which means
   * `child_process`, `fs` and the network are open to it.
   *
   * ┌──────────────────────────────────────────────────────────────────┐
   * │ ⚠️ TRUST LEVEL. This code runs with the platform's full          │
   * │ privileges and is repeated AUTOMATICALLY on an interval.         │
   * │                                                                  │
   * │ For now it does NOT go through the permission layer — this is a  │
   * │ CONSCIOUS temporary decision. The next step adds a classifier    │
   * │ that inspects the code (prompt-injection protection); the hook   │
   * │ point is `platform-server/src/state-run.ts` → `validateCode()`.  │
   * └──────────────────────────────────────────────────────────────────┘
   */
  code: string
  /**
   * The recomputation interval (seconds).
   *
   * `0` or omitted — no automatic refresh, it is computed once when the page
   * is opened.
   */
  interval?: number
}

// ---------------------------------------------------------------------------
// The controls layer — settings (a form) and actions (buttons)
// ---------------------------------------------------------------------------
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THE SOURCE OF TRUTH IS THE SERVER, NOT THE PLATFORM.                 │
// │                                                                      │
// │ The app (a telegram bot, say) runs INDEPENDENTLY on the server and   │
// │ reads its token from its own configuration (`/opt/bot/.env`). When   │
// │ the user enters the token in the platform it is written THERE, not   │
// │ into the platform's own database.                                    │
// │                                                                      │
// │     browser → platform → SSH → server:/opt/bot/.env → restart        │
// │                                                                      │
// │ Secrets do not flow in the REVERSE direction: for a secret field the │
// │ platform only knows "set / not set", it never reads the value.       │
// │                                                                      │
// │ WHY THIS DIFFERS FROM `mcp-credentials.ts`. The platform ITSELF      │
// │ starts an MCP server — it NEEDS the token, so it is stored. An app   │
// │ runs on the server by itself — the platform does not need its token, │
// │ so storing it would only be an extra risk.                           │
// └──────────────────────────────────────────────────────────────────────┘

/**
 * The kind of a setting field — it decides which input element the UI draws.
 *
 * `secret` is its own category: it is hidden in the UI, its current value is
 * NEVER returned, and leaving it empty means "I did not change it" (the same
 * decision as `McpSettingField.secret`).
 */
export type SettingKind = 'text' | 'secret' | 'number' | 'select' | 'toggle' | 'textarea'

export interface SettingField {
  /**
   * The setting key — it is written under this name in the server's
   * configuration.
   *
   * Only `[a-z][a-z0-9_]*`: it ends up as an `.env` key (uppercased) and may
   * become a JSON key. The strict pattern closes off injection paths —
   * `manifest-validate.ts` enforces it.
   */
  key: string
  kind: SettingKind
  label: string
  hint?: string
  required?: boolean
  /** The initial value — NOT USED for `secret` */
  default?: string
  /** The list of options for `kind: 'select'` */
  options?: string[]
  /**
   * The validation regex (as a string, passed to the `RegExp` constructor).
   *
   * ┌────────────────────────────────────────────────────────────────────┐
   * │ THIS IS THE THIRD LAYER OF INJECTION PROTECTION.                   │
   * │                                                                    │
   * │ The `states` layer had NO user input; here there IS some. The      │
   * │ first two layers keep the input entirely away from the shell       │
   * │ (argv array + stdin), while the pattern constrains the VALUE       │
   * │ ITSELF — so that a bot token cannot deviate from the shape         │
   * │ `^\d+:[A-Za-z0-9_-]+$`, for example.                               │
   * └────────────────────────────────────────────────────────────────────┘
   */
  pattern?: string
  /** The text shown to the user when the pattern is violated */
  patternHint?: string
}

/**
 * App settings — the form schema and the code that writes it to the server.
 *
 * The schema (`fields`) and the code (`write`) are DELIBERATELY separate: the
 * schema is predictable and the UI renders it itself (the `widgets`
 * philosophy), while the code takes on the part that differs for every app —
 * which file, in which format, with which restart.
 */
export interface AppSettings {
  fields: SettingField[]
  /**
   * The code that writes the values TO THE SERVER.
   *
   * `module.exports = async function ({ values, ssh, appId }) { ... }`
   *
   * `ssh.writeEnv()` and `ssh.command()` are provided by the platform — the AI
   * does not write shell lines (see the comment in `action-run.ts`).
   */
  write: string
  /**
   * The code that reads the current values FROM THE SERVER (optional).
   *
   * ⚠️ IT MUST NOT RETURN SECRETS. If a secret key is returned it is dropped
   * and a warning is recorded — a token must not travel the
   * server → platform → browser path.
   *
   * When it is not given the form opens empty (with `default` values only).
   */
  read?: string
}

/**
 * An action the user presses — restart, stop, clear the cache.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ ⚠️ TRUST LEVEL — THE SAME AS `states`.                              │
 * │                                                                      │
 * │ The action code runs in the server process with the platform's full  │
 * │ privileges. The difference: `states` repeats AUTOMATICALLY, while an │
 * │ action runs once WHEN the user presses it and lands in the audit     │
 * │ log.                                                                 │
 * │                                                                      │
 * │ It does NOT go through the permission layer (unlike the `bash` tool) │
 * │ — a conscious temporary decision. The classifier hook point is       │
 * │ `platform-server/src/action-run.ts` → `validateCode()`.              │
 * └──────────────────────────────────────────────────────────────────────┘
 */
export interface AppAction {
  /**
   * The action name — it lands in the URL path
   * (`POST /api/apps/:id/action/:name`).
   *
   * The same pattern and the same reason as `AppState.name`: it fully closes
   * off path traversal (`../`) and encoding problems.
   */
  name: string
  label: string
  hint?: string
  /** The audit level — `'write'` when not given */
  risk?: AuditLevel
  /**
   * `true` — the UI asks for confirmation before pressing.
   *
   * ⚠️ This guards against ACCIDENTAL clicks, not against an ATTACK: the check
   * is on the UI side and code calling the API directly skips it.
   */
  confirm?: boolean
  /** `module.exports = async function ({ ssh, setting, appId }) { ... }` */
  code: string
  /**
   * The names of the states that MUST be refreshed after the action finishes.
   *
   * When restart is pressed the status has to update immediately — the stale
   * cached value should not wait for the interval to elapse.
   */
  refresh?: string[]
}

export interface AppManifest {
  id: string
  icon: string
  name: string
  tagline: string
  version: string
  service: string
  status: 'running' | 'idle'
  widgets: Widget[]
  /**
   * The INITIAL data handed to the view.
   *
   * When there are `states`, their computed results are written on top of this
   * object (`data[state.name]`). So this is the value for the first render,
   * which is then replaced with live data.
   *
   * `unknown` is deliberate: the shape differs per app and the AI decides it.
   * The limit is on SIZE, not on content (`manifest-validate.ts`).
   */
  data?: Record<string, unknown>
  /**
   * Live data sources — each with its own interval.
   *
   * Without them the dashboard stays static (the values in `data` do not
   * change).
   */
  states?: AppState[]
  /** Without it `widgets` is rendered. Both may be present. */
  view?: AppView
  /**
   * The settings form — without it no form is shown.
   *
   * The values are written to the app ON THE SERVER, not to the platform (see
   * the layer comment above).
   */
  settings?: AppSettings
  /** The actions the user presses — without them no buttons are shown */
  actions?: AppAction[]
}

// ---------------------------------------------------------------------------
// Build plans — the orchestrator streams in this shape
// ---------------------------------------------------------------------------

export interface BuildStep {
  text: string
  kind: 'info' | 'tool' | 'out' | 'done'
}

export interface DeployOption {
  label: string
  steps: BuildStep[]
  widget: Widget
}

export interface BuildPlan {
  id: string
  keywords: string[]
  intro: string
  toolCard: ToolCard
  steps: BuildStep[]
  choice?: { question: string; options: DeployOption[] }
  manifest: AppManifest
}

// ---------------------------------------------------------------------------
// AI models — the server reports what it detected on the user's PC in this shape
// ---------------------------------------------------------------------------

/**
 * The billing model the provider is connected under.
 *
 * For the user this matters even more than the price: with `subscription` the
 * tokens are covered by the monthly payment, while with `apiKey` every token
 * is billed separately. If the two looked the same the user would
 * unknowingly burn through a paid channel.
 *
 * It is a separate field so the UI does not have to parse text — the `source`
 * string is free-form (for example `~/.codex (ChatGPT subscription)`) and may
 * change.
 */
export type BillingKind = 'subscription' | 'apiKey' | 'local'

/** A single ready-to-use model (its provider is configured) */
export interface ModelInfo {
  /** Provider id: 'openrouter', 'ollama', 'anthropic' ... */
  provider: string
  /** The provider's display name: 'OpenRouter', 'Ollama' */
  providerName: string
  /** Model id: 'anthropic/claude-sonnet-4.5', 'qwen3:8b' */
  id: string
  /** The model's display name */
  name: string
  contextWindow: number
  /** Whether the model supports thinking (reasoning) mode */
  reasoning: boolean
  /** Whether it supports image input */
  vision: boolean
  /** Price per 1 million tokens (in US dollars). 0 for local models. */
  cost: { input: number; output: number }
  /** Where the key was found: 'OPENROUTER_API_KEY', 'Ollama (local)' ... */
  source: string
  /** The billing model — subscription / API key / local */
  billing: BillingKind
}

/** A detected provider — for the group header in the model picker */
export interface ProviderInfo {
  id: string
  name: string
  source: string
  /** The billing model — subscription / API key / local */
  billing: BillingKind
  /** How many models are available */
  modelCount: number
}

/** A problem that occurred during detection (not fatal, informational only) */
export interface DetectWarning {
  source: string
  reason: string
}

// ---------------------------------------------------------------------------
// Chat sessions — the new types the backend stores
// ---------------------------------------------------------------------------

export interface ChatSession {
  id: string
  title: string
  /**
   * The provider and model selected when the session started. Both are
   * `undefined` until the first message is sent. Once set, the provider does
   * not change — swapping providers mid-conversation breaks the context format
   * (thinking blocks and tool ids no longer match).
   */
  provider?: string
  model?: string
  /**
   * The project the session is attached to. When `undefined`, the agent tools
   * work in the session's own folder; when attached, in the project folder —
   * that is, every conversation of one project sees a single set of files.
   */
  projectId?: string
  createdAt: string
  updatedAt: string
  /**
   * The number of messages in the conversation. Only filled in on the LIST
   * request (`GET /api/chat/sessions`) — when a single session is requested
   * the extra computation is unnecessary.
   *
   * The UI uses it to spot an "empty conversation": creating a session and
   * abandoning it before the first message is an ordinary situation.
   */
  messageCount?: number
}

// ---------------------------------------------------------------------------
// Projects (project / workspace)
// ---------------------------------------------------------------------------

/**
 * A project — a work directory bound to a name.
 *
 * The platform creates the folder itself (`~/.platforma/projects/<slug>/`);
 * the user does not supply a path: if an arbitrary path were accepted, the
 * boundary for the agent tools could end up being `/`.
 */
export interface Project {
  id: string
  name: string
  /** The full path — the UI only displays it, it cannot change it */
  folder: string
  createdAt: string
  /** The number of chat sessions attached to this project */
  chatCount?: number
}

/**
 * A file or image attached to a chat.
 *
 * Both images and ordinary files live ON DISK (in the session's upload folder)
 * and the agent reads them itself with the existing `read`/`grep`/`bash`
 * tools. They are not passed to the LLM as base64 — only the path and a short
 * note go into the prompt. That is why there is a single flow for files and
 * images.
 */
export interface ChatAttachment {
  id: string
  sessionId: string
  /**
   * `image` — when the agent reads it with `read` the LLM sees it (the model
   * must support vision); `file` — an ordinary file whose contents are read as
   * text.
   *
   * The kind is determined by MAGIC BYTES: neither the extension nor the
   * `content-type` the client sent is trusted (a ZIP called `.png` is a file).
   */
  kind: 'image' | 'file'
  /** The name the user gave — this is what the UI shows */
  originalName: string
  /**
   * The path RELATIVE to the work directory — the agent reads by it.
   *
   * An absolute path is DELIBERATELY not given: the record survives the
   * project folder being moved, and the client does not get to see the
   * server's file layout.
   */
  path: string
  mime: string
  size: number
  createdAt: string
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  text: string
  /** @deprecated For the old demo flow. New code uses `toolCards`. */
  toolCard?: ToolCard
  /** The tool calls the agent made during this reply, in order */
  toolCards?: ToolCall[]
  /**
   * The full context the LLM sees — pi-agent-core's `AgentMessage[]` array in
   * its raw form (tool calls, tool RESULTS, thinking blocks).
   *
   * How it differs from `text`: `text` is the clean reply text the UI shows,
   * while this is the history handed back to the LLM on the next turn. Tool
   * results exist only here, so without it the agent loses its memory every
   * turn.
   *
   * The type is `unknown[]`: `@platforma/shared` must not depend on the AI
   * package (the UI imports these types too). The precise type is restored on
   * the server.
   *
   * `undefined` in old messages (before migration 004) — in that case the
   * history is built from `text`.
   */
  agentMessages?: unknown[]
  /**
   * The context size (in tokens) reported by the provider. The compaction
   * decision relies on it — an exact number instead of recomputing the whole
   * history.
   */
  contextTokens?: number
  /**
   * The files attached to this message (only present for `role: 'user'`).
   *
   * The same pattern as `toolCards`: they are stored in a separate table and
   * `readMessages()` joins them onto the message.
   */
  attachments?: ChatAttachment[]
  createdAt: string
}

// ---------------------------------------------------------------------------
// Build sessions — the state of the "build it for me" flow started from a chat
// ---------------------------------------------------------------------------

export type BuildSessionStatus = 'running' | 'waiting_choice' | 'done' | 'failed'

export interface BuildSession {
  id: string
  appId: string
  status: BuildSessionStatus
  createdAt: string
}

// ---------------------------------------------------------------------------
// The app's record — the publish row joined with what its folder contains
// ---------------------------------------------------------------------------

export interface AppRecord {
  id: string
  manifest: AppManifest
  status: 'running' | 'idle'
  createdAt: string
  /** When it was last published — the FOLDER may be newer (it is edited freely) */
  updatedAt: string
  /**
   * The folder the app was read from.
   *
   * Shown in the UI so the user knows which directory to open in an editor —
   * the whole point of an app being files rather than a database blob.
   */
  dir?: string
  /**
   * Problems found while reading the folder — a state file with an invalid
   * name, a view that did not compile, a settings block with no code.
   *
   * ┌────────────────────────────────────────────────────────────────────┐
   * │ THESE ARE SHOWN, NOT SWALLOWED.                                    │
   * │                                                                    │
   * │ The folder is now editable by hand, so its errors belong to the    │
   * │ USER as much as to the AI. A silently dropped view would look like │
   * │ the platform ignoring the file they just wrote. The dashboard      │
   * │ renders these at the top and carries on with whatever DID load.    │
   * └────────────────────────────────────────────────────────────────────┘
   */
  errors?: string[]
}

// ---------------------------------------------------------------------------
// Schedules — work that starts without a human being present
// ---------------------------------------------------------------------------

/**
 * WHY a schedule exists at all, in two sentences.
 *
 * A subscription plan runs out of hourly or weekly quota mid-task, and the
 * agent stops. Somebody then has to work out when the limit resets and come
 * back to say "carry on" — which is the kind of clerical work the platform
 * should be doing itself.
 *
 * The same machinery answers a second need: "prepare this report every day".
 * One is reactive and fires once, the other is a standing rule.
 */
export type ScheduleKind = 'resume' | 'recurring'

/**
 * 'active'  — the tick will fire it
 * 'paused'  — switched off by the user; stays in the list
 * 'done'    — a 'resume' that has run (kept, so "why did my chat continue at
 *             3am?" has an answer)
 * 'failed'  — the last run threw; `lastError` says why. A 'recurring' schedule
 *             still re-arms — one failed report is not a reason to stop
 *             reporting.
 */
export type ScheduleStatus = 'active' | 'paused' | 'done' | 'failed'

/**
 * Who created it. Shown in the list, because "I never asked for this" deserves
 * an answer:
 *   'user'   — the UI
 *   'agent'  — the model, through the permission layer
 *   'system' — the rate-limit detector
 */
export type ScheduleCreator = 'user' | 'agent' | 'system'

export interface Schedule {
  id: string
  kind: ScheduleKind
  /** A human-readable label for the list */
  title: string
  /**
   * For 'resume' — the session to continue.
   * For 'recurring' — the session the LAST run created (absent before the
   * first run). The next run opens a new one.
   */
  sessionId?: string
  /** A recurring run opens its session inside this project */
  projectId?: string
  /** What is sent when it fires */
  prompt: string
  /** A 5-field cron expression — absent for 'resume', which fires once */
  cron?: string
  /** Plain-language rendering of `cron`, for display only */
  cronText?: string
  /** The model the run uses; absent means "the session's own", or the default */
  provider?: string
  model?: string
  /** When it next fires — epoch ms, UTC */
  runAt: number
  status: ScheduleStatus
  createdBy: ScheduleCreator
  createdAt: string
  lastRunAt?: string
  lastError?: string
  /** How many times it has fired */
  runs: number
}
