# @barpo/server — the platform backend foundation

The server side of the "a program that builds programs" platform. The database,
migrations, audit system, WebSocket hub and REST endpoints are all in place.
**The chat AI layer is wired up with tools**: the agent reads, writes and edits
files, runs commands and searches the tree (`@barpo/ai`), and through this
server it also reaches the connected servers, the installed MCP servers, the
dashboard-publishing path and the scheduler. The build flow (chat → generated
project) is not connected yet.

For the system-wide picture — how the packages fit together and what the
security model is — read [`docs/architecture.md`](../docs/architecture.md)
first. This file is the implementation reference: routes, database, the WS
protocol.

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
cd barpo-server
bun run dev          # watch mode
bun run start        # plain run
bun test             # tests
```

Port: the `PORT` env variable, default **8787**.
Database path: the `DB_PATH` env variable, default
`barpo-server/data/platform.db` (the folder is created at runtime and is not
committed to git).

The UI dev server proxies `/api` and `/ws` to this port
(`barpo-ui/vite.config.ts`), so no absolute address appears in the frontend
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
  orchestrator.ts   — the chat reply stream: @barpo/ai → WS events → DB
  chat-send.ts      — the shared send logic REST and WS both go through
  work-dir.ts       — the agent work directory: per session or per project
  presence.ts       — who else is in this project's directory (data for the prompt)
  attachment.ts     — an attachment's kind, decided from its CONTENT (magic bytes)
  seed.ts           — initial data (idempotent)
```

**Skills and MCP** — the same three-layer model in both cases: a source, a
catalog entry, an install scope.

```
  skill-store.ts    — the disk layer: ~/.barpo/skills-store/ → the project copy
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

**The time layer** — work that starts when nobody is watching.

```
  schedule/
    cron.ts          — a 5-field cron parser and `nextRun` (no dependency, no minute-by-minute search)
    scheduler.ts     — the 30s tick, the run, and the missed-run rules
    limit-detect.ts  — recognising "the quota ran out" in a provider error, and when it lifts
    schedule-sink.ts — the server side of the agent's schedule tools
```

Two needs, one table (`schedules`). A **recurring** schedule fires a stored
prompt into a **brand-new session** on a cron timetable — a fresh context every
run is what makes a daily report reproducible. A **resume** schedule is created
by the platform itself when a provider limit interrupts a reply: the error text
is read for the reset time, five minutes are added, and the SAME conversation
is continued at that point. The user is told "paused until 14:35"
(`chat.scheduled`) rather than "failed", because nothing is left for them to do.

A missed run (the machine was asleep) is caught up if it is less than six hours
late and skipped with a recorded reason after that — a week away must not
produce seven reports at breakfast.

**A scheduled run works in AUTO permission mode, and has to.** In `confirm` mode
the agent stops at the first `bash` and waits five minutes for an answer nobody
is there to give; the run then produces nothing and reports no error, so the
schedule looks like it worked. The safety condition is the CLASSIFIER: auto mode
means the checks are made by a model rather than a person, so with no classifier
configured the run is REFUSED and the reason recorded. If auto turns itself off
mid-run (three consecutive blocks, a broken classifier) the stream is cut short
and `lastError` says why.

**A schedule inherits the model of the conversation that created it**, so a
report set up while talking to one model is not silently written by another.
`scheduleCreate` accepts an explicit `provider`/`model` to override that; a
pinned model that has since disappeared falls back to the default.

**An app is a FOLDER, not a database row.** `~/.barpo/apps/<id>/` holds
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
    015-apps-as-folders.ts     — an app becomes a folder; `apps.manifest` → `apps.dir`
    016-schedules.ts           — the schedules table (recurring tasks + limit resumes)
    017-schedule-session-trigger.ts — a recurring schedule survives its session's deletion
    018-barpo-rename.ts        — rewrites the stored built-in source identifiers for the new name
  routes/
    health.ts  apps.ts  servers.ts  skills.ts  audit.ts  chat.ts  models.ts
    mcp.ts  projects.ts  schedules.ts
  ws/
    hub.ts          — connection registry, channel subscription, broadcast
    chat-handler.ts — WS chat.send, chat.permission.reply, chat.mode.set
test/               — 43 spec files plus `app-fixture.ts` (see "Extending it")
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

**017 fixes a guarantee that was described but never written.** 016 gave
`schedules.session_id` an `ON DELETE CASCADE` and its comment explained that a
`recurring` row would survive its old session because `scheduler.ts` cleared
`session_id` first. It did no such thing. Deleting the conversation a scheduled
run had produced therefore deleted THE SCHEDULE — tidying up old chats silently
cancelled the user's daily report. 017 adds a `BEFORE DELETE` trigger that
clears `session_id` on `recurring` rows, so by the time the cascade fires only
`resume` rows still point at that session — and those genuinely have no meaning
without their conversation. A trigger rather than a check inside `deleteSession`
for the same reason `audit_log` uses one: it protects the table, not one caller.

**018 is 014 again, for the platform's new name.** The stored built-in source
identifiers carried the old working title inside them (`platforma` → `barpo`,
`platforma://builtin` → `barpo://builtin`, `platforma-builtin` →
`barpo-builtin`). Same duplicate-detection keys, same consequence had the
constants moved without the rows: two built-in sources, every skill and MCP
server listed twice.

## The chat AI flow

Everything to do with the LLM lives in the `@barpo/ai` package (keys, OAuth,
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
(`grep`, `find`, `ls`) come from `@barpo/ai`. The rest are supplied BY THIS
SERVER, through callbacks handed to `agentStream()` (`orchestrator.ts`):

| Tool | Supplied via | What it reaches |
|---|---|---|
| `serverList` | `serverProvider` | the server rows, re-read from the database on every call |
| `appPublish` | `dashboardSink` | read the folder → validate → compile the JSX → record the publish (`dashboard-save.ts`) |
| `appDelete` | `dashboardRemover` | asks the user, then deletes the row and the folder (`app-delete.ts`) |
| `scheduleCreate` | `scheduleSink` | parses the cron, then writes the row (`schedule/schedule-sink.ts`) |
| `scheduleList` | `scheduleLister` | the schedules this platform holds |
| `scheduleDelete` | `scheduleRemover` | removes one, through the permission layer |
| MCP tools | `mcpProvider` | the installed MCP servers, credentials merged in (`mcp-connect.ts`) |

`appDelete` is supplied SEPARATELY from `appPublish` because erasing an app is
a different capability from creating one, and it is declared only alongside the
permission manager. It is also the one tool in the system that refuses an
automated answer: `requireUser` skips auto mode and any stored "always", so an
app disappears only when a human said so — every time.

The schedule tools ask permission too, but deliberately WITHOUT `requireUser`: a
schedule is reversible and destroys nothing, so demanding a human answer even in
auto mode would be permission fatigue.

This is an **inversion**, and it is the point: `barpo-ai` knows nothing about
the database. It declares the tool and calls a function; where the data comes
from is this side's business. An empty MCP list means MCP does not start at all
— no tool is declared and the prompt does not mention it.

Two directories are prepared at the start of every stream:

- `.barpo/skills/` — the installed skills are **synchronised** (global plus
  the ones installed for this session's project). Re-synced on every stream,
  because a skill may have been installed mid-conversation. The database is the
  source of truth, so an extra folder is removed.
- `.barpo/memory/` — only its **existence** is guaranteed. The agent writes
  its own notes here and nobody deletes them.

Neither throws: if the skills cannot be prepared the conversation still starts,
only with an empty skill list. Abandoned attachments — uploaded but never sent —
are cleaned up at the same point.

Each session gets its own work directory, `~/.barpo/work/<sessionId>/`, and
a session bound to a project runs in `~/.barpo/projects/<slug>/` instead, so
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
documented in `barpo-ai/README.md`.

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
| DELETE | `/api/chat/sessions/:id` | `{deleted, streamStopped}` | stops a running stream, then CASCADE + the session's files. A `recurring` schedule that ran here SURVIVES (migration 017) |
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
derives a slug and creates `~/.barpo/projects/<slug>/` itself. The folder is
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

### Schedules

The user's half of the machinery the agent reaches through its `schedule*`
tools. Both halves write the same table and go through the same cron parse.

| Method | Path | Response | Note |
|---|---|---|---|
| GET | `/api/schedules` | `{schedules: Schedule[]}` | |
| GET | `/api/schedules/:id` | `{schedule}` | 404 when not found |
| POST | `/api/schedules` | `{schedule}` · 201 | body `{title, cron, prompt, projectId?, provider?, model?}`; 400 / 409 |
| PATCH | `/api/schedules/:id` | `{schedule}` | body `{status}` — `active` or `paused` only; 400 / 404 |
| DELETE | `/api/schedules/:id` | `{ok}` | 404 / 500 |

**A `resume` cannot be created here.** Those exist only because a provider limit
was hit, and the platform is the only thing that knows that happened; a
hand-made one would point at a conversation that is not waiting. `POST`
therefore always creates a `recurring`.

**There is no route for editing a prompt** — by decision, not omission. Changing
what a schedule does without seeing its history invites "why did today's report
look different?" with no answer anywhere. Delete and recreate, and the list
shows both.

`PATCH` accepts only `active` and `paused`. `done` and `failed` are OUTCOMES the
scheduler writes after a run; letting a client set them would turn the history
into a claim rather than a record. Switching `paused` → `active` **re-arms
first** (`rearm()`): a schedule paused last week has a `runAt` in the past, so
activating it as-is would fire on the very next tick — and "resume this" means
"carry on from the next scheduled time", not "run now and catch up".

The cron expression is parsed BEFORE the row is written (400 when it will not
read, 400 when it has no run inside five years). A stored schedule that can
never fire would sit in the list looking active — failure disguised as success.
`MAX_SCHEDULES` is enforced with a 409.

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

Endpoint: `ws://<host>/ws`. The types live in `@barpo/shared/protocol` (a
discriminated union, keyed on the `type` field).

As soon as the connection opens the server sends `hello`. After that the client
**must subscribe to channels** — without a subscription no event is delivered:

```js
ws.send(JSON.stringify({ type: 'sub', channels: ['chat', 'audit', 'schedules'] }))
```

The channels are `chat`, `build`, `apps`, `audit`, `terminal` and `schedules`.

**Client → server:** `chat.send`, `chat.choice`, `chat.permission.reply`, `chat.mode.set`, `sub`

**Server → client:**

| Event | Channel | When |
|---|---|---|
| `hello` | — (everyone) | on connect |
| `chat.delta` · `chat.tool` · `chat.permission` · `chat.classifier` · `chat.mode` · `chat.done` · `chat.error` | `chat` | during a reply stream |
| `chat.status` | `chat` | the stream's status changed — `running` / `awaiting-permission` / `done` / `error`. This is what drives the live indicator and the running-agents list; `GET /api/chat/running` is its poll-able counterpart for a page that opened mid-stream |
| `chat.scheduled` | `chat` | a provider limit interrupted the reply and a `resume` was booked. Sent INSTEAD of `chat.error`, because nothing is left for the user to do — the UI says "paused until 14:35" |
| `chat.toolcard` | `chat` | a tool card from the old demo build flow — kept for the manifest-driven pages, not emitted by the agent stream |
| `build.step` / `build.choice` / `build.done` / `build.failed` | `build` | during a build |
| `app.installed` / `app.updated` | `apps` | a manifest was registered |
| `app.removed` | `apps` | an app was deleted — the folder went with it |
| `audit.entry` | `audit` | on every `auditWrite` call |
| `schedule.changed` / `schedule.removed` | `schedules` | a schedule was created, paused, resumed or deleted — from either the REST routes or the agent's tools |
| `terminal.line` | `terminal` | tmux session output |

`chat.scheduled` sits on the `chat` channel rather than `schedules` on purpose:
it is part of the reply stream, not a change to the schedule list, and the page
waiting for it is the conversation.

## The database schema

The `schema_version` table tracks which migrations have been applied; each
migration runs in its own transaction — there is no half-applied state.

Tables: `schema_version`, `servers`, `skills`, `skill_sources`, `skill_installs`,
`mcp_sources`, `mcp_servers`, `mcp_installs`, `audit_log`, `apps`, `projects`,
`chat_sessions`, `chat_messages`, `chat_attachments`, `tool_calls`, `schedules`,
`build_sessions`.

`audit_log` is **append-only**: `UPDATE` and `DELETE` are blocked by triggers
(`RAISE(ABORT)`), so the guarantee holds at the SQL level and not even a bug in
the code can break it.

`apps` holds no manifest — only `dir`, the folder a publish registered (see
migration 015 above). Every read goes to disk, which is what makes editing a
file the whole update. The server-driven UI model still holds: the manifest the
UI renders is assembled from that folder, so a new app never requires rebuilding
the frontend.

## Extending it (for the agents that come next)

**A new REST route:**
1. In `src/routes/<name>.ts` write `export const <name>Routes = new Hono()`
2. Add one import and one `api.route('/', <name>Routes)` line to `src/app.ts`

**A new WS event:**
1. Write the interface in `barpo-shared/src/protocol.ts` (`type` — a unique literal)
2. Add it to the `ClientEvent` or `ServerEvent` union
3. If it belongs to the server, add a case to the `eventChannel()` switch — and
   to `eventSession()` if the event belongs to one conversation (otherwise
   TypeScript errors, which is deliberate: neither can be forgotten)
4. Send it with `hub.broadcast(...)`

**A new migration:**
Create `src/migrations/0NN-name.ts` and add it to the list in
`migrations/index.ts`. Never edit a migration that has already been applied —
write a new one.

**The audit rule:** every action that changes state or reads secret data must
call `auditWrite(...)`. Writing to the table directly means no WS event is sent
and the feed in the UI stays silent.

**In tests:** `openDb(':memory:')` + `setDb(db)`, and `clearRunningStreams()` in
`beforeEach` — the stream registry is module-level state shared by every test
file in the process. For apps use `test/app-fixture.ts` (`useTempApps()`,
`publishTestApp()`, `cleanupApps()`) rather than writing folders by hand.
