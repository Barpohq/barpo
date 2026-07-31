# @platforma/server — the platform backend foundation

The server side of the "a program that builds programs" platform. The database,
migrations, audit system, WebSocket hub and REST endpoints are all in place.
**The chat AI layer is wired up with tools**: the agent reads, writes and edits
files, runs commands and searches the tree (`@platforma/ai`), and through this
server it also reaches the connected servers, the installed MCP servers and the
dashboard-publishing path. The build flow (chat → generated project) is not
connected yet.

## Stack

| Part | Choice | Why |
|---|---|---|
| Runtime | Bun | one toolchain across the monorepo, reads TS directly |
| HTTP | Hono | lightweight, testable without a network via `app.request()` |
| Database | bun:sqlite (WAL) | a single file, nothing to install — the "runs on an ordinary PC" principle |
| Real-time | Bun.serve websocket | shares a port with REST, so no CORS problem |

## Running it

```sh
bun install          # at the repo root (workspace)
cd platform-server
bun run dev          # watch mode
bun run start        # plain run
bun test             # tests
```

Port: the `PORT` env variable, default **8787**.
Database path: the `DB_PATH` env variable, default
`platform-server/data/platform.db` (the folder is created at runtime and is not
committed to git).

The UI dev server proxies `/api` and `/ws` to this port
(`platform-ui/vite.config.ts`), so no absolute address appears in the frontend
code.

## File layout

Every source file opens with a comment explaining **why it is built the way it
is** — the tables below are a map, the reasoning lives in the files.

**The core**

```
src/
  index.ts          — entry point: Bun.serve (Hono + WS on one port)
  app.ts            — the Hono app, assembles the route modules
  db.ts             — SQLite connection, WAL, migration runner
  repo.ts           — the database layer (SQL lives only here)
  audit.ts          — auditWrite / auditRead — the ONLY way to write an audit record
  orchestrator.ts   — the chat reply stream: @platforma/ai → WS events → DB
  chat-send.ts      — the shared send logic REST and WS both go through
  work-dir.ts       — the agent work directory: per session or per project
  attachment.ts     — an attachment's kind, decided from its CONTENT (magic bytes)
  seed.ts           — initial data (idempotent)
```

**Skills and MCP** — the same three-layer model in both cases: a source, a
catalog entry, an install scope.

```
  skill-store.ts    — the disk layer: ~/.platforma/skills-store/ → the project copy
  builtin-skills.ts — the skills shipped with the platform (source kind `builtin`)
  github.ts         — the GitHub client: tree scan + tarball
  tar.ts            — a minimal tar reader written in-house (zip-slip protection)
  mcp-registry.ts   — the official registry client (registry.modelcontextprotocol.io)
  mcp-github.ts     — scanning `server.json` out of a GitHub repo
  mcp-builtin.ts    — the built-in MCP source (deliberately empty for now)
  mcp-connect.ts    — a database row → a connection config, credentials merged in
  mcp-credentials.ts— secret setting values in a separate 600 file, NOT in the DB
```

**Servers and the app layer** — the dashboards the agent publishes and the
machines they read from.

```
  ssh.ts            — the platform key, the managed config, key install, metrics
  app-ssh.ts        — the `ssh` object handed to the AI's code (argv only, no shell)
  state-run.ts      — running the state code the AI wrote
  state-cache.ts    — one cache per state, on its own interval, requests coalesced
  action-run.ts     — running actions and settings: a lock, an audit entry, a longer timeout
  apps-dir.ts       — where an app's folder lives, and the path checks that guard it
  app-store.ts      — reads a folder into an `AppManifest` (the folder ↔ manifest translator)
  view-cache.ts     — `.build/` next to the source, keyed by a hash of `view.jsx`
  dashboard-save.ts — the `appPublish` tool → read the folder → validate → record it
  app-delete.ts     — deletes the publish row AND the folder (confirmed callers only)
  view-build.ts     — compiling the AI's JSX into browser JS (classic transform)
```

**An app is a FOLDER, not a database row.** `~/.platforma/apps/<id>/` holds
`app.json` plus optional `view.jsx`, `states/<name>.js`, `settings.js` and
`actions/<name>.js`; the `apps` table records only that a folder was published
and where. Every request reads the folder, which is what makes editing a file —
by the agent or by the user, in any editor — the whole update. `PLATFORM_APPS`
relocates the root (tests point it at a temporary directory).

**Migrations, routes, WebSocket**

```
  migrations/
    index.ts        — the list of migrations, applied in order by number
    001-initial.ts             — the initial schema
    002-chat-model.ts          — provider/model columns on chat_sessions
    003-tool-cards.ts          — a tool_cards column on chat_messages
    004-agent-messages.ts      — the full LLM context stored alongside the message
    005-projects.ts            — projects; chat_sessions.project_id
    006-skills.ts              — the real skill model (three tables), the mock table dropped
    007-servers-real.ts        — servers hold connection data only, no stored metrics
    009-tool-calls.ts          — tool calls as their own table (see below on 008)
    010-builtin-source.ts      — the `builtin` source kind, table rebuilt for the CHECK
    011-mcp-servers.ts         — MCP: sources, catalog, installs
    012-attachments.ts         — chat attachments
    013-english-rename.ts      — the Uzbek→English rename of the whole schema
    014-builtin-source-rename.ts — renames the stored built-in source identifiers
  routes/
    health.ts  apps.ts  servers.ts  skills.ts  audit.ts  chat.ts  models.ts
    mcp.ts  projects.ts
  ws/
    hub.ts          — connection registry, channel subscription, broadcast
    chat-handler.ts — WS chat.send, chat.permission.reply, chat.mode.set
test/               — bun test
```

**There is no migration 008 — deliberately.** On some local databases an
abandoned experiment (`command_runs`) had been recorded under number 8. The
runner works by number, so a new migration 8 would have been skipped in silence
on exactly those databases and its table never created. Number 9 applies in
both cases, and its SQL drops the orphaned table (`IF EXISTS`, because on a
fresh database it is not there). The reasoning is written out in
`009-tool-calls.ts`.

**014 exists because 013 could not finish the job.** 013 translated the schema —
table names, columns, CHECK values — but two built-in source identifiers are
stored VALUES that the TypeScript layer compares by exact string
(`standart-skilllar` → `builtin-skills`, `platforma-standart` →
`platforma-builtin`). Both are duplicate-detection keys: changing the constant
without rewriting the rows would make the lookup miss on the next start-up and a
SECOND built-in source would be created next to the old one — every built-in
skill and MCP server shown twice.

## The chat AI flow

Everything to do with the LLM lives in the `@platforma/ai` package (keys, OAuth,
Ollama, model catalogues, the classifier). The server calls `detectModels()` and
`agentStream()` — or `conversationStream()` for the tool-free mode.

```
POST /api/chat/send  →  the message is written to the DB, the session provider is locked
                     →  streamReply() starts in the background (202 is returned)
                     →  chat.delta · chat.tool · chat.permission
                        chat.classifier · chat.mode                  [WS]
                     →  chat.done | chat.error
                     →  the full reply + tool cards are written to the DB once
```

A `chat.send` arriving over WS takes exactly the same path
(`ws/chat-handler.ts`); the difference is that errors come back as a
`chat.error` event rather than an HTTP status.

### Tools

The file and shell tools (`read`, `write`, `edit`, `bash`) and the search tools
(`grep`, `find`, `ls`) come from `@platforma/ai`. Three more are supplied BY
THIS SERVER, through callbacks handed to `agentStream()` (`orchestrator.ts`):

| Tool | Supplied via | What it reaches |
|---|---|---|
| `serverList` | `serverProvider` | the server rows, re-read from the database on every call |
| `appPublish` | `dashboardSink` | read the folder → validate → compile the JSX → record the publish (`dashboard-save.ts`) |
| `appDelete` | `dashboardRemover` | asks the user, then deletes the row and the folder (`app-delete.ts`) |
| MCP tools | `mcpProvider` | the installed MCP servers, credentials merged in (`mcp-connect.ts`) |

`appDelete` is supplied SEPARATELY from `appPublish` because erasing an app is
a different capability from creating one, and it is declared only alongside the
permission manager. It is also the one tool in the system that refuses an
automated answer: `requireUser` skips auto mode and any stored "always", so an
app disappears only when a human said so — every time.

This is an **inversion**, and it is the point: `platform-ai` knows nothing about
the database. It declares the tool and calls a function; where the data comes
from is this side's business. An empty MCP list means MCP does not start at all
— no tool is declared and the prompt does not mention it.

Two directories are prepared at the start of every stream:

- `.platforma/skills/` — the installed skills are **synchronised** (global plus
  the ones installed for this session's project). Re-synced on every stream,
  because a skill may have been installed mid-conversation. The database is the
  source of truth, so an extra folder is removed.
- `.platforma/memory/` — only its **existence** is guaranteed. The agent writes
  its own notes here and nobody deletes them.

Neither throws: if the skills cannot be prepared the conversation still starts,
only with an empty skill list. Abandoned attachments — uploaded but never sent —
are cleaned up at the same point.

Each session gets its own work directory, `~/.platforma/work/<sessionId>/`, and
a session bound to a project runs in `~/.platforma/projects/<slug>/` instead, so
every conversation about one codebase sees one set of files. Both roots are
relocatable (`PLATFORM_WORKS`, `PLATFORM_PROJECTS`). A project folder carries no
privilege of any kind: the boundary check applies to it exactly as it does to a
session folder.

Every tool call is recorded in the audit log: `read` → read, `bash` and every
MCP tool → dangerous, everything else → write.

### Permission modes

| Mode | Behaviour |
|---|---|
| `confirm` (default) | a `chat.permission` is raised for a dangerous or unfamiliar action and the agent waits for an answer |
| `auto` | the classifier decides — anything that does not stray beyond what was asked passes |

The mode is switched with `POST /api/chat/sessions/:id/mode` or the WS
`chat.mode.set` event. The classifier's verdict arrives as `chat.classifier` and
a mode change as `chat.mode`.

**Auto can switch itself off** — if the classifier is faulty, or after 3
consecutive or 20 total blocks. When that happens the `chat.mode` event carries
the reason and the UI shows a "Turn back on" button. It never restores itself
automatically.

A permission answer is given via `chat.permission.reply` (WS) or
`POST /api/chat/permission` (REST). If no answer arrives within 5 minutes it is
denied.

The classifier mechanism, the isolation of tool results and the limits are
documented in `platform-ai/README.md`.

The list of models is detected on the user's own machine: environment variables,
a local Ollama, and the `~/.claude` / `~/.codex` subscription tokens.

## REST endpoints

All of them sit under the `/api` prefix and respond with JSON.

### Health

| Method | Path | Response | Note |
|---|---|---|---|
| GET | `/api/health` | `{ok, version, schema, wsClients, uptimeMs, time}` | liveness + schema version |

### Chat — sessions

| Method | Path | Response | Note |
|---|---|---|---|
| GET | `/api/chat/sessions` | `{sessions: ChatSession[]}` | sorted by last activity |
| POST | `/api/chat/sessions` | `{session}` · 201 | body optional: `{title?, projectId?}`; 404 for an unknown project |
| GET | `/api/chat/running` | `{running: [{sessionId, title, …}]}` | the streams alive right now — the "background agents" view |
| GET | `/api/chat/sessions/:id` | `{session}` | restoring from a `#chat/<uuid>` URL; 404 |
| PATCH | `/api/chat/sessions/:id` | `{session}` | renaming; `title` only, max 200 chars |
| DELETE | `/api/chat/sessions/:id` | `{deleted, streamStopped}` | stops a running stream, then CASCADE + the session's files |
| GET | `/api/chat/sessions/:id/messages` | `{messages: ChatMessage[]}` | 404 when not found |

The model and the project are **locked once the conversation starts**, which is
why `PATCH` accepts nothing but the title: swapping either would corrupt the
context.

### Chat — sending, permissions, mode

| Method | Path | Response | Note |
|---|---|---|---|
| POST | `/api/chat/send` | `{messageId, model}` · 202 | the reply streams over WS; errors: 400 / 404 / 409 |
| POST | `/api/chat/stop` | `{stopped}` | cancels the reply stream in flight |
| POST | `/api/chat/permission` | `{accepted}` | permission answer: `allow` / `deny` / `always`; 404 once it has expired |
| GET | `/api/chat/sessions/:id/permissions` | `{requests}` | the requests still waiting — asked for on page load and WS reconnect |
| GET | `/api/chat/sessions/:id/mode` | `{state}` | the session's permission mode |
| POST | `/api/chat/sessions/:id/mode` | `{state}` | switch the mode: `confirm` / `auto` |

`POST /api/chat/send` **does not wait** for the reply: the message is stored, the
stream starts in the background and 202 is returned. The reply arrives over WS as
`chat.delta` → `chat.done` (or `chat.error`) events. The validation and write
logic live in `chat-send.ts` — the WS path calls exactly the same function, so
both paths work by the same rules.

`chat.permission` is sent **once**. If the page was closed or the socket dropped
at that moment the event is gone for good, so the pending list has its own
endpoint — without it the agent would sit waiting for an answer to a question
nobody can see.

### Chat — attachments

| Method | Path | Response | Note |
|---|---|---|---|
| POST | `/api/chat/attachment` | `{attachments}` · 201 | multipart; `sessionId` required; 400 / 404 / 413 |
| GET | `/api/chat/attachment/:id` | the raw bytes | the only binary response in the project |
| DELETE | `/api/chat/attachment/:id` | `{deleted}` | 409 once it is attached to a sent message |

Uploading is separate from sending on purpose: a file takes megabytes and a
message does not. The file is picked → uploaded → the chip appears → the text is
typed → `send` carries only the ids. A side effect is that the WS path works
with ids as well, so no binary ever crosses the WebSocket.

The kind (image / file) is decided from the **content**, never from the file name
or the client's `content-type` — both are forgeable, and the kind becomes the
`content-type` of the `GET` response. Only a content-detected image is served
with its real mime type and `inline`; everything else is
`application/octet-stream` + `attachment` + `nosniff`, which closes the
stored-XSS route.

A **sent** attachment cannot be removed (409): it is part of the conversation
history and the agent has already seen it. Rewriting history backwards would
build a false context.

### Projects

| Method | Path | Response | Note |
|---|---|---|---|
| GET | `/api/projects` | `{projects: Project[]}` | |
| POST | `/api/projects` | `{project}` · 201 | body `{name}`; 409 on a duplicate name |

**The user does not supply a path, only a name.** If a path were accepted, the
boundary of the agent's tools could be pointed at `/` or `~`; the platform
derives a slug and creates `~/.platforma/projects/<slug>/` itself. The folder is
created BEFORE the row, so a failing file system never leaves a "project without
a folder" behind.

### Skills

| Method | Path | Response | Note |
|---|---|---|---|
| GET | `/api/skills` | `{skills, sources}` | the catalog |
| GET | `/api/skills/sources` | `{sources: SkillSource[]}` | |
| POST | `/api/skills/source` | `{source, added, deleted, warnings}` · 201 | body `{url}`; 400 on a bad URL, 502 when GitHub fails |
| POST | `/api/skills/source/:id/sync` | `{added, deleted, warnings}` | re-scan; 404 / 502 |
| DELETE | `/api/skills/source/:id` | `{ok}` | the source, its skills (CASCADE) and its store folder |
| POST | `/api/skills/:id/install` | `{skill}` | body `{scope, projectIds?}`; 400 / 404 / 502 |
| DELETE | `/api/skills/:id/install` | `{skill}` | when the last install goes, the files leave the store too |

Connecting a source **does not install anything** — the skills only enter the
catalog. Which skill goes where is the user's decision, so downloading is its own
step. One install call can cover several projects: the files still exist in a
single copy in the store, only the `skill_installs` rows multiply.

### MCP servers

The same three-layer model as skills, with one shape difference: on GitHub a
single repo yields many skills and all of them land in the catalog, whereas a
registry search returns many INDEPENDENT servers and the user picks exactly one.
Hence `search` (stores nothing) and the `source/*` routes (store) are separate.

| Method | Path | Response | Note |
|---|---|---|---|
| GET | `/api/mcp` | `{servers, sources}` | the catalog |
| GET | `/api/mcp/sources` | `{sources: McpSource[]}` | |
| GET | `/api/mcp/active` | `{servers}` | query `projectId`; what is actually running — for diagnostics |
| GET | `/api/mcp/registry/search` | `{results}` | query `q`; stores nothing; 400 / 502 |
| POST | `/api/mcp/source/registry` | `{source, added, deleted}` · 201 | body `{name}`; 404 / 422 / 502 |
| POST | `/api/mcp/source/github` | `{source, …, warnings}` · 201 | body `{url}`; 400 / 502 |
| POST | `/api/mcp/source/manual` | `{source, …}` · 201 | body `{name, transport, command/args \| url}`; 400 |
| POST | `/api/mcp/source/:id/sync` | `{added, deleted, warnings}` | 422 for `manual` / `builtin` — they have no external source |
| DELETE | `/api/mcp/source/:id` | `{ok}` | also removes the credentials of every install |
| POST | `/api/mcp/:id/install` | `{server}` | body `{scope, projectIds?, settingValues?}`; required fields are checked |
| DELETE | `/api/mcp/:id/install` | `{server}` | the credentials go with it |

A registry entry is **looked up again by name** on add — the entry the client
posts is not trusted. Otherwise a user could submit an arbitrary command and have
it presented as coming "from the registry".

**Secret values are never returned.** The catalog and install responses carry
only "is it set", never the token itself. Secrets live in a separate `chmod 600`
file rather than the database, because a database file gets backed up, copied and
exported, and the result of a `SELECT` can end up in a log. CASCADE does not
reach that file, so credentials are cleaned up by hand on every delete path.

### Servers

| Method | Path | Response | Note |
|---|---|---|---|
| GET | `/api/servers` | `{servers: Server[]}` | connection data only |
| POST | `/api/servers` | `{server, connectionError}` · 201 | installs the platform key, rewrites the managed ssh config |
| DELETE | `/api/servers/:id` | `{ok, note}` | the key STAYS in the server's authorized_keys |
| GET | `/api/servers/:id/metrics` | `{metrics}` | read over SSH per request, never stored |

The password is **not stored**: it is handed to `sshpass` through the
environment for the duration of that one request. Only host / port / user reach
the database. Metrics are not stored either — a stale value would be a
trustworthy-looking lie. Deleting a server does not remove the key from it: that
would require connecting, and the server being deleted may be precisely the
unreachable one.

### Apps — manifests, live state, controls

| Method | Path | Response | Note |
|---|---|---|---|
| GET | `/api/apps` | `{apps: AppManifest[]}` | read from the folders on every call |
| GET | `/api/apps/:id` | `{manifest, status, createdAt, updatedAt, dir?, errors?}` | 404 when not found |
| DELETE | `/api/apps/:id` | `{ok, folderRemoved?, error?}` | erases the folder too — the UI confirms first |
| GET | `/api/apps/:id/state` | `{states: {name: result}}` | every state at once — for the initial page load |
| GET | `/api/apps/:id/state/:name` | the state result | one state; `?force=1` bypasses the cache |
| GET | `/api/apps/:id/settings` | `{fields, values, isSet, warning?}` | 404 when the app has no settings |
| PUT | `/api/apps/:id/settings` | `{ok, …}` | 400 on validation errors, 500 when the write fails |
| POST | `/api/apps/:id/action/:name` | `{ok, wasBusy?, states?}` | runs the action, then force-refreshes `action.refresh` |

**The AI never writes a new API.** These routes are fixed and ready in advance;
the agent only supplies CODE — `manifest.states[].code`, `settings.read/write`,
`actions[].code`. A failing state is still HTTP 200: it is a data error, not a
server error, so the frontend keeps the previous value instead of taking the
dashboard down.

Reads are cached per state on that state's own interval, and there is no timer:
the cache is checked WHEN A REQUEST ARRIVES, so with the page closed nothing
runs. Parallel requests for a stale value are coalesced into one execution.

**Secret settings are never returned — only an `isSet` flag.** A token does not
travel the server → platform → browser path; the user does not see the current
value, they only write a new one. An empty secret on `PUT` therefore means "I did
not change it" and is skipped, rather than wiping the stored token. Only the
setting KEYS reach the audit log, never the values.

### Audit and models

| Method | Path | Response | Note |
|---|---|---|---|
| GET | `/api/audit` | `{entries: AuditEntry[], total}` | query: `level`, `actor`, `limit` (max 1000), `offset` |
| GET | `/api/models` | `{models, providers, warnings, time}` | the AI models detected on this machine (cached) |
| POST | `/api/models/refresh` | as above | re-runs detection |

The **first** message of a session must carry `model: { provider, model }` — that
is when the provider is locked. Sending a different provider afterwards returns
**409** (switching models within one provider is allowed).

There is **deliberately no write endpoint** for the audit log — it is only filled
from inside the backend via `auditWrite(...)` and cannot be written to from
outside.

## The WebSocket protocol

Endpoint: `ws://<host>/ws`. The types live in `@platforma/shared/protocol` (a
discriminated union, keyed on the `type` field).

As soon as the connection opens the server sends `hello`. After that the client
**must subscribe to channels** — without a subscription no event is delivered:

```js
ws.send(JSON.stringify({ type: 'sub', channels: ['chat', 'build', 'audit'] }))
```

**Client → server:** `chat.send`, `chat.choice`, `chat.permission.reply`, `chat.mode.set`, `sub`

**Server → client:**

| Event | Channel | When |
|---|---|---|
| `hello` | — (everyone) | on connect |
| `chat.delta` · `chat.tool` · `chat.permission` · `chat.classifier` · `chat.mode` · `chat.done` · `chat.error` | `chat` | during a reply stream |
| `chat.status` | `chat` | the stream's status changed — `running` / `awaiting-permission` / `done` / `error`. This is what drives the live indicator and the running-agents list; `GET /api/chat/running` is its poll-able counterpart for a page that opened mid-stream |
| `chat.toolcard` | `chat` | a tool card from the old demo build flow — kept for the manifest-driven pages, not emitted by the agent stream |
| `build.step` / `build.choice` / `build.done` / `build.failed` | `build` | during a build |
| `app.installed` / `app.updated` | `apps` | a manifest was registered |
| `audit.entry` | `audit` | on every `auditWrite` call |
| `terminal.line` | `terminal` | tmux session output |

## The database schema

The `schema_version` table tracks which migrations have been applied; each
migration runs in its own transaction — there is no half-applied state.

Tables: `servers`, `skills`, `skill_sources`, `skill_installs`, `mcp_sources`,
`mcp_servers`, `mcp_installs`, `audit_log`, `apps`, `projects`, `chat_sessions`,
`chat_messages`, `chat_attachments`, `tool_calls`, `build_sessions`.

`audit_log` is **append-only**: `UPDATE` and `DELETE` are blocked by triggers
(`RAISE(ABORT)`), so the guarantee holds at the SQL level and not even a bug in
the code can break it.

Manifests are stored as complete JSON in the `apps.manifest` column — the
server-driven UI model: adding a new app does not require rebuilding the
frontend.

## Extending it (for the agents that come next)

**A new REST route:**
1. In `src/routes/<name>.ts` write `export const <name>Routes = new Hono()`
2. Add one import and one `api.route('/', <name>Routes)` line to `src/app.ts`

**A new WS event:**
1. Write the interface in `platform-shared/src/protocol.ts` (`type` — a unique literal)
2. Add it to the `ClientEvent` or `ServerEvent` union
3. If it belongs to the server, add a case to the `eventChannel()` switch
   (otherwise TypeScript errors — that is deliberate, so it cannot be forgotten)
4. Send it with `hub.broadcast(...)`

**A new migration:**
Create `src/migrations/00N-name.ts` and add it to the list in
`migrations/index.ts`. Never edit a migration that has already been applied —
write a new one.

**The audit rule:** every action that changes state or reads secret data must
call `auditWrite(...)`. Writing to the table directly means no WS event is sent
and the feed in the UI stays silent.
