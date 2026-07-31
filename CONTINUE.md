# Where we left off — a guide to picking the work back up

_Last updated: 2026-07-30. If you are continuing on another machine, start from this file._

## Current state

We are in the middle of turning the mock demo into a real platform. The chosen
route: a **real backend on Bun + TypeScript (Hono)**, with the AI layer built on
top of `pi-agent-core` (pi — [earendil-works/pi](https://github.com/earendil-works/pi),
a coding agent for the terminal; we adapt its ideas for the web).

**Tests:** 1559/1559 green (`bun test`). `platform-ui` is clean under
`tsc --noEmit`; `platform-server` still has 5 old errors (the `isError` field and
the test's `rawCommand` — unrelated to attachments; stage 9 brought this down
from 36 to 5).

The 6 previously noted failures in `environment.test.ts` are FIXED — the cause was
`RestrictedEnv` not canonicalising the work directory (on macOS `/var` is a
symlink to `/private/var`, so a file INSIDE the work directory looked like it was
outside it). This matters for skills too: without the fix, the agent asked for
permission on every `SKILL.md` read.

**The way of working changed (2026-07-28):** the "build the whole system first,
then polish" plan was dropped. Now we build the piece we need and fix whatever
problems show up on top of it. The goal has not changed, the route has — the old
"Remaining plan" further down is no longer a required order, it is a backlog of
ideas.

### Packages

| Package | Role |
|---|---|
| `platform-shared` | shared types + the WS protocol (discriminated union) |
| `platform-server` | Bun.serve + Hono + bun:sqlite (WAL), port **8787** |
| `platform-ai` | provider detection, the agent stream, tools, security |
| `platform-config` | JSON + JSON Schema settings, global + project layers |
| `platform-ui` | React + Vite, dev proxy `/api` and `/ws` → 8787 |

## Getting it running

```bash
bun install
bun test                                     # 1559 tests
bun run schema                               # regenerate the config schema
cd platform-server && bun run src/index.ts   # backend :8787
cd platform-ui && bun run dev                # UI
```

## Completed stages

1. ~~Foundation: shared + server + proxy~~ ✅
2. ~~The AI agent layer: tools, permissions, model selection~~ ✅
3. ~~**Bringing the agent layer up to pi's level**~~ ✅ (below)
4. ~~**Project logic + a view of background agents**~~ ✅ (below)
5. ~~**Conversation history: sidebar list + a dedicated page**~~ ✅ (below)
6. ~~**Skills: installing from a GitHub source and wiring them into the agent**~~ ✅ (below)
7. ~~**Servers: passwordless SSH connections + live metrics**~~ ✅ (below)
8. ~~**Reliability: silently lost errors + persisting tool calls**~~ ✅ (below)
9. ~~**Attaching files and images to chat (including paste)**~~ ✅ (below)

### What was done in stage 9 (2026-07-30)

Attaching files and images to chat. Pasting an image from the clipboard with
`Ctrl+V` works too — that is the path people need most (take a screenshot and
drop it straight in).

**KEY DECISION: an image is a FILE too.** Images are not base64-encoded and
passed to `prompt()`. Like any other file they are written to disk, only the
PATH goes into the prompt, and the agent reads it with `read` — that is when it
sees the image.

This is pi-coding-agent's own solution, verified by reading its code:
`interactive-mode.js:2071-2093` writes a Ctrl+V image to
`/tmp/pi-clipboard-<uuid>.png` and puts only the path text into the editor.
`CHANGELOG.md:3847` shows it was originally an attachment, and `:3832` (PR #442)
changed it to a path **deliberately**. pi's attachment path (CLI `@image.png`)
writes the full base64 into the JSONL and resends it on every turn — pi did not
solve that problem, it merely sidestepped it in interactive mode.

What this buys us:
- **one code path** for files and images, not two separate flows;
- no need to touch `agent.prompt(prompt, images)`;
- the image only enters the context when the agent wants it, and as a
  `toolResult` it gets trimmed naturally by compaction;
- the `read` tool **already** returns images (`createReadTool()` detects them by
  magic bytes) — no new code needed.

The price: one extra turn (the agent does a `read` first).

**Directory:** `<workDir>/.platforma/sessions/<sessionId>/files/`. It is split
per session because in a project conversation the work directory is shared. For
the same reason `.platforma` was **excluded from search** (`SKIPPED_DIRS`) —
otherwise an agent running `grep` would turn up files from unrelated
conversations. A conscious side effect: skills and memory dropped out of `grep`
too (they reach the prompt anyway). Given an explicit path the list is bypassed,
so the attachment flow still works.

**TWO EXISTING BUGS found and fixed along the way:**

1. `agent.ts:660` — when `afterToolCall` modified a result it replaced `content`
   wholesale with `[{type:'text'}]` and **silently dropped the image block**.
   `lengthHook`/`redactSecretsHook` run on almost every result, meaning that
   without this fix the entire feature would not have worked — with no error
   message. `nonTextBlocks()` now preserves image blocks.

2. `context.ts:215` — `estimatedTokens` did `JSON.stringify(...).length / 4` and
   counted the whole base64 payload: a 5 MB image became ~1.7 million "tokens".
   `cutPoint` would then send the entire recent history off to be summarised.
   It now uses pi's `estimateTokens` (an image counts as a fixed 4800
   characters).

**Security decisions:**
- The kind is determined by **magic bytes** (`attachment.ts`); the extension and
  the client-supplied `content-type` are not trusted: a ZIP file named `.png`
  gets caught. SVG is deliberately not treated as an image (XML → script vector).
- `GET /api/chat/attachment/:id`: an image → its real mime + `inline`; a file →
  **always** `application/octet-stream` + `attachment`. Otherwise a file uploaded
  as `text/html` would be stored XSS.
- Name sanitisation is allowlist-based (`uploadName`): `../`, NUL, and shell
  metacharacters simply cannot appear in the output set. The extension is
  preserved (`projectSlug` stripped it, which is why it was not reused).
- The prompt note is **not written to `chat_messages.text`**, only into the
  `prompt()` text. The classifier reads exactly that `text` field — a filename
  landing there would be an injection vector.
- The vision guard lives in `/chat/send` (the model is locked in at exactly that
  point): image + a model without vision → 400, and the message is **not
  stored**. If it were silently let through, the agent would draw the wrong
  conclusion that "there is nothing in the image".

**New files:** `platform-server/src/attachment.ts` (magic bytes),
`platform-server/src/chat-send.ts` (shared logic for REST and WS),
`platform-server/src/migrations/012-attachments.ts`,
`platform-ui/src/components/AttachmentChip.tsx`, and 4 test files.

**A side benefit — refactoring:** extracting `acceptMessage()` means `/chat/send`
and the WS `chat.send` now go through **the same** logic. Previously the model
lock check existed in two copies. `tsc` errors dropped from 36 to 5.

**Known debt:** `![](http://external/x.png)` in an LLM reply renders as a raw
`<img>` (`Markdown.tsx` has no `img` component) — so an external request goes
out. This risk exists independently of attachments but belongs to the image
topic: an `img` component should be added that only allows a `src` starting with
`/api/chat/attachment/`.

### What was done in stage 8 (2026-07-29)

Three silent data-loss bugs were fixed. All of them from the same family: when
the reply stream broke, no trace was left behind.

**1. Provider errors were being swallowed.** pi-agent-core does not THROW a
provider error out of `prompt()` — it records it on the last assistant message
as `stopReason: 'error'`. `agentStream` did not check for it, so the stream
counted as SUCCESSFUL: no text, no tools, no error. To the user this looked like
"the chat started, ended immediately, and nothing happened". Nothing reached the
database either (`orchestrator.ts` did not store an empty reply) — so the
question sat alone in the history.

Real examples (from the user's database): OpenRouter `400 Reasoning is
mandatory for this endpoint`, Codex `invalidated oauth token`.

`streamError()` (`agent.ts`) now catches this and surfaces it as `chat.error`;
the persistence condition was widened too (text/tool/context — any one of the
three triggers a write).

**2. Tool calls were only persisted at the END of a stream.** A new `tool_calls`
table (migration 009): every call is written to the database FIRST and broadcast
to the UI AFTERWARDS. How the permission was granted is stored as well — auto
classifier / user / "always" / denied / timeout / cancelled / hard deny
(`PermissionOrigin`). That line shows up on the tool card. `readMessages` takes
the cards from this table, and for calls whose message never got written it
builds a synthetic reply — so an orphaned record does not disappear.

**3. The permission request ignored cancellation.** `ask()` did not listen to the
abort signal, so a stream where "Stop" had been pressed hung there for 5
MINUTES. That had two consequences: (a) the old card stayed alive in the UI, and
pressing it would EXECUTE a command the user had stopped; (b) once the timeout
expired the decision was written onto the NEXT stream's card, making the "who
granted permission" trail a lie. The signal is now observed and the decision is
bound to the exact call that asked for it, by `requestId` (`requestTool`).

Side fixes: the permission card now sits at the end of the conversation rather
than INSIDE the streaming message (previously, if the message had not been added
yet, the card was not drawn at all); `GET /api/chat/sessions/:id/permissions`
exists to recover a lost `chat.permission`; the mode is sent to the server under
both values.

⚠︎ **Migration number 8 is DELIBERATELY skipped** — some local databases have an
abandoned experiment (`command_runs`) recorded under number 8. Migration 009
cleans it up with `DROP TABLE IF EXISTS`.

### What was done in stage 7 (2026-07-29)

The mock `Servers.tsx` was replaced with real SSH management. Adding a server
means SETTING UP a passwordless connection: the platform's key is installed for
the server's root user, after which `ssh <name>` works without a password both
in the platform and in a terminal.

**The model (migration 007):** the database holds only CONNECTION details
(name/host/port/username) — live state (cpu/ram/disk/uptime) is read over SSH on
every request and NOT STORED: a stale value would be a "trustworthy-looking
lie". The old mock table was dropped and the server seed removed.

**The three-part SSH scheme (`platform-server/src/ssh.ts`):**

1. **The platform key** — `~/.platforma/ssh/id_ed25519`, DELIBERATELY separate
   from the user's personal key (revoking access = deleting this one key from
   the server). Created once with `ssh-keygen`, without a passphrase.
2. **The managed config** — `~/.platforma/ssh/config`, rewritten IN FULL from the
   database list on every save (the database is the source of truth — the same
   rule as the skills directory). `~/.ssh/config` gets only a single `Include`
   line, placed EXACTLY AT THE TOP: in OpenSSH, an `Include` that comes after
   any `Host` block belongs to that block and stops working globally.
3. **Key installation** — two paths, and the order matters: first a BatchMode
   attempt with the user's existing keys (if that gets in, no password is needed
   at all), otherwise the one-time password from the form via `sshpass -e` (the
   SSHPASS env var — invisible in argv, NEVER WRITTEN to the database, gone as
   soon as the response returns).

**Important small decisions:**

- `UserKnownHostsFile` points into the platform directory, with
  `StrictHostKeyChecking accept-new` — on a first connection the interactive
  prompt would hang inside the server process; the user's own known_hosts is
  left untouched.
- Platform connections use `-F <managed config>` — the user's personal settings
  (ProxyJump and so on) do not bleed into the platform.
- POST ordering: install the key first, database SECOND — if the connection
  fails, no "broken server" record is left behind (502 + a clear reason).
- `fetchMetrics` never throws — the UI card shows the error state and HTTP
  returns 200. Metrics arrive as KEY=value lines from a single ssh call; the
  parser does not depend on ordering and leaves a field empty when its line is
  missing.
- On deletion the key STAYS on the server (the server being deleted may be
  exactly the one that is unreachable) — the UI states this plainly in the
  confirmation modal.
- Name/host/username go through a strict allowlist regex — they end up in the
  ssh_config file and on the command line, so unvetted text must not get in.
- All external commands go through the `CommandRunner` interface — tests install
  a fake runner with `setCommandRunner()` (the `setDb` style). Paths are
  relocatable via the `PLATFORM_SSH` / `PLATFORM_USER_SSH_CONFIG` env vars. On
  the JS side there is a 20s timeout, on top of ConnectTimeout.

**Tested:** 34 new tests (ssh.test.ts, servers.test.ts) plus a live smoke test:
the backend was brought up with a separate port/database/directory, it created a
real key with ssh-keygen, a POST to an unreachable host returned a clean 502 in
10s, and the database was left clean. Connecting to a real server has not been
tested yet (no server was at hand).

**Left for later:** removing the key from the server on deletion (best-effort),
streaming metrics over WS (currently they are requested once per page open),
running agent tools on a server (`ssh <name> <command>` already works, but it is
not wired into the agent layer).

### What was done in stage 6 (2026-07-28)

The mock skill store was replaced with a real `SKILL.md` system. There is no
registry — any GitHub repo can be connected (`anthropics/skills` yielded 18
skills in testing).

**A three-layer model** (migration `006-skills`):

| Table | What it holds |
|---|---|
| `skill_sources` | the connected repo (owner/repo/ref, commit SHA) |
| `skills` | the `SKILL.md` files found in the repo — the CATALOG, not yet on disk |
| `skill_installs` | scope: `global` or `project` + `project_id` |

One skill can be installed globally AND in several projects at the same time —
which is why installs are their own table rather than a column on `skills`.
Syncing uses UPSERT: rescanning a repo does not change a skill's `id`, so
installs are not lost.

**The disk flow:**

```
GitHub tarball → STORE ~/.platforma/skills-store/<sourceId>/<skillId>/
                        ↓ COPIED at the start of a session
                 <workDir>/.platforma/skills/<name>/
                        ↓ read from there
                 system prompt: the <available_skills> list
```

- **A copy, NOT a symlink.** `environment.ts` checks with `canonicalPath`; a
  symlink resolves outside the work directory, so the model hit a permission
  modal on every `SKILL.md` read. With a copy the boundary code is untouched.
  Confirmed in testing: **0 permission requests**.
- `.platforma/skills/` is a **managed directory**. The database is the source of
  truth; it is synced at the start of every stream (extras are deleted, missing
  entries are copied). Anything placed there by hand disappears in the next
  session.

**Wiring into the agent — progressive disclosure, as in pi:** only the name,
description, and path go into the prompt (`<available_skills>`); the model
fetches the full text itself with `read`. pi has no separate `Skill` tool — and
neither do we.

**New files:** `platform-ai/src/skill-file.ts` (frontmatter parsing, with our own
minimal YAML parser — the `yaml` package is a transitive dependency of pi and we
did not want to rely on it), `skill-load.ts` (reading + wiring into the prompt),
`platform-server/src/github.ts`, `tar.ts` (zip-slip protection),
`skill-store.ts`, `routes/skills.ts`.

**The parser MUST support block scalars.** `claude-api` in `anthropics/skills`
uses the `description: |-` form (a multi-line YAML block). Without support, the
description came out as the two characters `|-` — the skill loaded, but the
model had no idea when to use it. `|`, `>`, and `-`/`+` chomping are supported.

**UI: cards are all the same height.** Description lengths vary enormously (204
to 1025 characters) — they are truncated with `line-clamp-4`, and the full text
lives in a "Details" modal (with the file path, licence, tools, scope, and
warnings).

**Search covers NAME and DESCRIPTION.** Users remember what a skill does, not
what it is called — typing "word" has to find `docx` (whose name contains no
"word"). Words are checked separately with `AND`, and order does not matter.
Alongside it there is a status filter (installed/not installed) and a source
filter (visible once 2+ repos are connected).

**GitHub rate limit:** 60 requests/hour without a token. Scanning the catalog
costs one blob request per `SKILL.md`, so 2–3 scans exhaust the limit. The error
is reported clearly (including when it resets) — it does not just quietly stop
working.

**Left for later:** `allowed-tools` is NOT ENFORCED — it is only displayed (pi
does not implement it either). Private repos (no token), GitLab, and installing
from a local directory.

### What was done in stage 5 (2026-07-28)

The **conversation list UI**, flagged as "left for later" in stage 4, is now
closed — old chats can be reopened.

**Server:**

- `GET /chat/sessions` now also returns `messageCount` (LEFT JOIN) — the UI can
  distinguish an "empty conversation".
- `PATCH /chat/sessions/:id` — title only (model and project are locked).
  It DOES NOT TOUCH `updated_at`: the list is sorted by last activity, and
  renaming should not push a conversation to the top.
- `DELETE /chat/sessions/:id` — messages go with it via CASCADE. If a stream is
  running it is `abort()`ed first.
- `orchestrator.ts`: before storing a reply it checks that the session still
  exists. This is MANDATORY — `abort()` is not synchronous, so the `writeMessage()`
  after the stream's `finally` still runs and would throw a foreign key error
  (which is not caught there).

**UI:**

- "Chat" in the sidebar is now an accordion holding the 5 most recent
  conversations, **regardless of their state**, with running ones marked by
  `StreamIndicator`. Open/closed state lives in `localStorage` (default: closed).
- The old "Live streams" section was REMOVED — it would now be a duplicate. A
  live dot sits next to the collapsed accordion, and the total count is on the
  Agents badge.
- `pages/Conversations.tsx` — search, project filter, date grouping, inline
  renaming, and deletion behind a confirmation modal.
- `useConversations()` is called ONCE in App and passed down through props: the
  sidebar and the page must show the same source (otherwise a deletion only
  showed up in one of them).
- `Chat.tsx`: `initialSession` → `openSession`. Previously a conversation was
  only restored when the page opened; now it reloads when the prop changes, so
  you can switch to another conversation with a chat already open.

**Tested:** the full chain in the browser (accordion → open a conversation →
switch to another → refresh → new conversation), with renaming and deletion
confirmed against the server.

### What was done in stage 4 (2026-07-28)

**A view of background agents** — the server already ran them in the background
(the orchestrator is fire-and-forget); the view layer was added:

- The `chat.status` WS event (`running` / `awaiting-permission` / `done` /
  `error`) — deliberately NOT FILTERED by session (`eventSession()` → null), so
  the sidebar sees every session.
- `GET /chat/running` — the initial state when the page opens.
- UI: a "Live streams" section in the App sidebar, `Agents.tsx` wired to real
  data (with a "Stop" button), and a "In background" line in Chat.
- The most important state is `awaiting-permission`: when a background agent asks
  for permission the user sees it through the badge (otherwise it would expire on
  the 30-minute TTL).

**Project logic** — the workspace concept:

- Migration 005: a `projects` table + `chat_sessions.project_id` (NULL = a plain
  chat). `routes/projects.ts`: GET/POST.
- Only the platform creates the directory: `~/.platforma/projects/<slug>/`
  (relocatable via the `PLATFORM_PROJECTS` env var). The slug uses the allowlist
  `[a-zA-Z0-9_-]`.
- A project session's agent tools run in the project directory — all of a
  project's chats share ONE directory (parallel collisions are an accepted risk;
  there is no lock). The boundary is the same as for a plain session in
  `environment.ts`.
- `AGENTS.md` (which takes precedence) or `CLAUDE.md` in the project directory is
  appended to the agent system prompt (16k character limit). It does NOT go to
  the classifier — enforced by tests (`project-context`, using attack text).
- UI: a `ProjectPicker` in Chat (with inline project creation), locked once the
  session starts.

**Left for later:** deleting a project (what happens to the directory needs a
decision), a separate Projects page, connecting an existing external directory.
(~~the conversation list UI~~ — closed in stage 5.)

### What was done in stage 3

**Critical fixes:**

- **Tool results are kept in history.** Previously the agent lost its memory
  every turn — after "read the file", asking "what's the version" forced it to
  read the file again. `AgentMessage[]` now lives in the database
  (`chat_messages.agent_messages`, migration 004).
- **Context compaction.** A long conversation would overflow the context window
  and the session stopped working entirely. Now there is an LLM summary plus a
  fallback trim.
- **WS session isolation.** Two browser windows were receiving each other's
  `chat.delta`/`chat.permission` events.
- **A memory leak.** Permission and mode managers lived forever — they are now
  cleaned up by TTL (30 min) + LRU (500).
- **A lost user message.** Pressing "Stop" and immediately sending a new message
  caused the message to vanish silently due to a race.

**New capabilities:**

- `grep` / `find` / `ls` tools — using `rg` when available, otherwise a Node
  backend. **The two produce byte-identical results** (enforced by tests).
- A hook system: `before` (blocking) and `after` (modifying the result).
- The config layer: `~/.platforma/config.json` plus the project's
  `.platforma/config.json`, with JSON Schema.

## Idea backlog (the old plan — no longer a required order)

1. **Wire the UI pages to the API** — `Audit.tsx` still uses mock data
   (`Skills.tsx` was wired up in stage 6, `Servers.tsx` in stage 7).
2. **Enforce `allowed-tools`** — currently it is only displayed. Our permission
   layer can carry this (pi had no such layer).
3. **A config web UI** — a form generated automatically from the JSON Schema.
4. **Docker isolation** — reimplement `ExecutionEnv` on top of Docker exec.
5. **Move to AgentHarness** — session trees, `steer()`, provider retry.
6. **Integration tests + Playwright.**

## Notes for agents (important technical details)

- **Adding a route:** `platform-server/src/routes/<name>.ts` plus one import and
  one `api.route()` line in `createApp()` in `app.ts`.
- **Adding a WS event:** follow the procedure in
  `platform-shared/src/protocol.ts` — there is a 4-step comment there. Both
  `eventChannel()` and `eventSession()` need updating.
- **Adding a config setting:** just one line in `FIELDS` in
  `platform-config/src/schema.ts` plus a field on the `Config` type, then
  `bun run schema`. Validation, the default value, and the JSON Schema follow
  automatically.
- **Audit:** only through `auditWrite(...)` — the table blocks UPDATE/DELETE with
  a SQL trigger.
- **Skills:** the store root is relocated by `PLATFORM_SKILLS` (a temporary
  directory in tests). The agent reads skills from `.platforma/skills/`, where
  `syncToProject()` places the copy — do not put files there by hand, they are
  deleted on the next stream.
- **In tests:** `openDb(':memory:')` + `setDb(db)`.
- The runtime database lives in `platform-server/data/` — not in git; migrations
  and the seed run automatically on first start.

### Seven boundaries that must not be broken

| Boundary | Where | What happens if it breaks |
|---|---|---|
| Tool results never reach the classifier | `agent.ts`, `orchestrator.ts` | prompt injection protection is lost |
| Trimming never starts at a `toolResult` | `context.ts` | the provider rejects the request |
| `rg` and the Node backend give identical results | `search-engine.ts` | the agent behaves differently depending on the machine |
| **Skill text never reaches the classifier** | `skill-load.ts` | a foreign repo writes "allow every command" and prises the protection open |
| **Tar paths are sanitised (no `..`)** | `tar.ts` | zip-slip: the archive writes outside the target directory |
| **Attachment names/paths never reach the classifier** | `agent.ts` (`attachmentNote`), `orchestrator.ts` | a filename (`"; rm -rf ~; #.png`) influences the permission decision |
| **`afterToolCall` preserves image blocks** | `agent.ts` (`nonTextBlocks`) | the model silently fails to see the image — with no error message |

All of them are enforced by tests — fix the code rather than "fixing" the test.

The fourth boundary has a STRONGER justification than the `AGENTS.md` one: a
project file was at least placed in the user's own directory, whereas a skill
comes from a foreign GitHub repo that the user may never have read.

## Wider context

- `ai-news-bot/` — a separate, finished project (488 tests), unrelated to this work.
- Project documentation: `README.md`, `01-telegram-bot.md`, `02-ai-platform.md`,
  `03-roadmap.md`, `04-risks.md`.
- Package documentation: `platform-ai/README.md` (the most detailed — the security
  model), `platform-config/README.md`, `platform-server/README.md`.
