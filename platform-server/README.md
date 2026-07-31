# @platforma/server — the platform backend foundation

The server side of the "a program that builds programs" platform. The database,
migrations, audit system, WebSocket hub and REST endpoints are all in place.
**The chat AI layer is wired up with tools**: the agent can read, write and edit
files and run commands (`@platforma/ai`). The build flow (chat → generated
project) is not connected yet.

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

```
src/
  index.ts          — entry point: Bun.serve (Hono + WS on one port)
  app.ts            — the Hono app, assembles the route modules
  db.ts             — SQLite connection, WAL, migration runner
  repo.ts           — the database layer (SQL lives only here)
  audit.ts          — auditWrite / auditRead — the ONLY way to write an audit record
  orchestrator.ts   — the chat reply stream: @platforma/ai → WS events → DB
  work-dir.ts       — the agent work directory, per session
  seed.ts           — initial data (idempotent)
  migrations/
    index.ts        — the list of migrations
    001-initial.ts
    002-chat-model.ts — provider/model columns on chat_sessions
    003-tool-cards.ts — a tool_cards column on chat_messages
    013-english-rename.ts — the Uzbek→English rename of the whole schema
  routes/
    health.ts  apps.ts  servers.ts  skills.ts  audit.ts  chat.ts  models.ts
    mcp.ts  projects.ts
  ws/
    hub.ts          — connection registry, channel subscription, broadcast
    chat-handler.ts — WS chat.send, chat.permission.reply, chat.mode.set
test/               — bun test
```

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

The agent uses `read`, `write`, `edit` and `bash`. Each session gets its own
work directory: `~/.platforma/work/<sessionId>/` (relocatable with the
`PLATFORM_WORKS` env variable).

Every tool call is recorded in the audit log: `read` → read, `write`/`edit` →
write, `bash` → dangerous.

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

| Method | Path | Response | Note |
|---|---|---|---|
| GET | `/api/health` | `{ok, version, schema, wsClients, uptimeMs, time}` | liveness + schema version |
| GET | `/api/apps` | `{apps: AppManifest[]}` | the manifests of the installed apps |
| GET | `/api/apps/:id` | `{manifest, status, createdAt, updatedAt}` | 404 when not found |
| GET | `/api/servers` | `{servers: Server[]}` | |
| GET | `/api/skills` | `{skills: Skill[]}` | with permissions |
| GET | `/api/audit` | `{entries: AuditEntry[], total}` | query: `level`, `actor`, `limit` (max 1000), `offset` |
| GET | `/api/chat/sessions` | `{sessions: ChatSession[]}` | sorted by last activity |
| POST | `/api/chat/sessions` | `{session}` · 201 | body optional: `{title?}` |
| GET | `/api/chat/sessions/:id/messages` | `{messages: ChatMessage[]}` | 404 when not found |
| POST | `/api/chat/send` | `{messageId, model}` · 202 | the reply streams over WS; errors: 400 / 404 / 409 |
| POST | `/api/chat/stop` | `{stopped}` | cancels the reply stream in flight |
| POST | `/api/chat/permission` | `{accepted}` | permission answer: `allow` / `deny` / `always` |
| GET | `/api/chat/sessions/:id/mode` | `{state}` | the session's permission mode |
| POST | `/api/chat/sessions/:id/mode` | `{state}` | switch the mode: `confirm` / `auto` |
| GET | `/api/models` | `{models, providers, warnings, time}` | the AI models detected on this machine (cached) |
| POST | `/api/models/refresh` | as above | re-runs detection |

`POST /api/chat/send` **does not wait** for the reply: the message is stored, the
stream starts in the background and 202 is returned. The reply arrives over WS as
`chat.delta` → `chat.done` (or `chat.error`) events.

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
