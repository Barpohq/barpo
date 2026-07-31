# Where we left off — a guide to picking the work back up

_Last updated: 2026-07-31. If you are continuing on another machine, start from this file._

## Current state

We are turning the mock demo into a real platform. The chosen route: a **real
backend on Bun + TypeScript (Hono)**, with the AI layer built on top of
`pi-agent-core` (pi — [earendil-works/pi](https://github.com/earendil-works/pi),
a coding agent for the terminal; we adapt its ideas for the web).

**Tests:** 1610/1610 green (`bun test`). All five packages are clean under
`tsc` — zero errors.

**The way of working (since 2026-07-28):** the "build the whole system first,
then polish" plan was dropped. We build the piece we need and fix whatever
problems show up on top of it. The goal has not changed, the route has.

### Packages

| Package | Role |
|---|---|
| `platform-shared` | shared types + the WS protocol (discriminated union) |
| `platform-server` | Bun.serve + Hono + bun:sqlite (WAL), port **8787** |
| `platform-ai` | provider detection, the agent stream, tools, security |
| `platform-config` | JSON + JSON Schema settings, global + project layers |
| `platform-ui` | React + Vite, dev proxy `/api` and `/ws` → 8787 |

Each package has its own README with the detail; `platform-ai/README.md` is the
one to read first — it carries the security model.

## Getting it running

```bash
bun install
bun test                                     # 1610 tests
bun run schema                               # regenerate the config schema
cd platform-server && bun run src/index.ts   # backend :8787
cd platform-ui && bun run dev                # UI
```

## What is built

Ten stages, in order. The detail of each lives in git history; what follows is
the decision that came out of it — the part that is expensive to rediscover.

1. **Foundation** — shared types + server + dev proxy.
2. **The AI agent layer** — tools, the permission layer, model selection.
3. **Bringing the agent up to pi's level** — tool results are kept in history
   (the agent used to lose its memory every turn), context compaction, WS
   session isolation, TTL+LRU cleanup for the per-session managers. Added
   `grep`/`find`/`ls` with two backends — `rg` when available, Node otherwise —
   which **produce byte-identical results**, enforced by tests. Plus the hook
   system and the config layer.
4. **Project logic** — a chat may attach to a project; all of a project's chats
   share one work directory. `AGENTS.md`/`CLAUDE.md` are read from it.
5. **Conversation history** — sidebar list and a dedicated page.
6. **Skills** — installed from a GitHub source and wired into the agent.
7. **Servers** — passwordless SSH. The database holds only CONNECTION details;
   live state (cpu/ram/disk/uptime) is read over SSH per request and NOT stored,
   because a stale value would be a trustworthy-looking lie.
8. **Reliability** — three silent data-loss bugs, all from one family: when the
   stream broke, no trace was left. Provider errors were being swallowed
   (pi-agent-core records them on the last assistant message as
   `stopReason: 'error'` rather than throwing — the stream counted as
   successful and the user saw an empty answer); tool calls were only persisted
   at the end of a stream (now `tool_calls`, migration 009, writes first and
   broadcasts after, including HOW the permission was granted); and the
   permission request ignored cancellation, so a stopped stream hung for five
   minutes and could still execute the command the user had stopped.
9. **Attachments** — files and images in chat, including `Ctrl+V` paste.
   **KEY DECISION: an image is a FILE too.** It is not base64-encoded into the
   prompt; it is written to disk, only the PATH goes into the prompt, and the
   agent reads it with `read`. This is pi's own solution (its PR #442 changed
   an attachment into a path deliberately). One code path for files and images,
   and the image enters the context only when the agent asks for it.
10. **Full English translation** — the codebase was written in Uzbek; it is now
    entirely English. See below, because it left two things behind worth
    knowing.
11. **An app became a FOLDER, and gained update + delete** — see below.

### What the translation exposed (2026-07-31)

The rename was done across two commits and uncovered three real bugs that had
nothing to do with language:

- **`AgentToolResult` never had an `isError` field.** `dashboard-tools.ts`
  imported from a module that the rename deleted, so `tsc` skipped the whole
  file and the mistake stayed invisible. A rejected `appPublish` and a failing
  MCP tool were reaching the model as SUCCESS. The failure is now carried by
  the result text and `details`.
- **`Mcp.tsx` compared `kind !== 'default'`** — a value that does not exist in
  `McpCatalogSourceKind`, so the condition was always true and built-in MCP
  sources showed a Delete button.
- **`running` in `orchestrator.ts` leaked between tests** — a module-level Map
  that was never cleared, failing unrelated files about one run in three.
  `clearRunningStreams()` fixes it.

Two deliberate exceptions to the translation: the Uzbek word lists in
`platform-ai/src/constraints.ts` ARE the language-detection feature, and
`classifier.ts` still accepts the old Uzbek JSON keys as a fallback because
small models echo them back.

Storage paths moved with the rename (`~/.platforma/work`, `projects`,
`sessions`, `skills-store`, `mcp-credentials.json`). No data migration was
written for them — a pre-translation install keeps its old directories.
Migration 014 DOES rewrite the built-in source rows, because those strings are
duplicate-detection keys: without it, every startup would have created a second
built-in source and shown every skill twice.

### Apps are folders now (2026-07-31)

The dashboard could be CREATED but never properly updated, and never deleted at
all. The cause was where the manifest lived: a JSON blob in `apps.manifest`.
The agent could not `read` it or `edit` one line of it, and the user could not
open it at all — so "update" meant the model rewriting the whole manifest from
memory, and whatever it forgot to repeat (`states`, `settings`) was silently
lost.

**An app is now a directory**, `~/.platforma/apps/<id>/`:

```
app.json            metadata, widgets, data, and the state/action CONFIG
view.jsx            optional custom view — source, compiled by the platform
states/<name>.js    one file per live value (the file name IS the state name)
settings.js         writes the form values;  settings.read.js reads them back
actions/<name>.js   one file per button
.build/             compile cache, keyed by a hash of view.jsx — generated
```

The consequences worth knowing:

- **`AppManifest` did not change.** `app-store.ts` translates the folder into
  the same shape, so `state-run.ts`, `action-run.ts` and `AiView.tsx` never
  learned that anything moved.
- **The database holds no manifest.** Migration 015 replaced `apps.manifest`
  with `apps.dir`; the table records only that a folder was published. Every
  read goes to disk, so `readApp`/`readApps` are now **async**.
- **Updating needs no tool.** `edit view.jsx` IS the update — no republish, no
  watcher, no reload button. `appPublish` takes only an `id` now and is needed
  only to register a folder, or when a NEW file needs config (an action's
  label, a state's interval).
- **Code is never inside `app.json`.** That was the whole point: JSX in a JSON
  string cannot be edited by a human. `states`/`actions` in `app.json` are
  configuration maps keyed by name; the code sits in real files.
- **Read errors are shown, not swallowed.** A view that will not compile is
  still dropped (widgets survive, unchanged rule), but the reason now travels
  in `AppRecord.errors` to the dashboard — the user writes these files, so the
  mistakes are theirs to see. Broken state files are REPORTED and left on disk;
  deleting a file the user can see would be the worse surprise.
- **No data migration**, by decision: pre-existing rows were test data.

**Delete** exists in two places and both erase the folder:

- `DELETE /api/apps/:id` — the UI confirms in a modal that names the folder.
- `appDelete` — the agent tool, which asks through the permission layer.

`appDelete` is the only tool in the system that **refuses an automated
answer**. `PermissionAsk.requireUser` skips auto mode AND any stored "always",
so a classifier can never authorise erasing an app and one earlier "always"
cannot authorise the next deletion. The user's rule: an app disappears only
when a human said so, every time.

Path safety is two-layered, and neither layer is redundant: `isValidAppId`
allows only `[a-z0-9-]` (so `..` and `/` cannot appear), and `isInsideAppsRoot`
resolves SYMLINKS and confirms the real path sits under the apps root — which
catches the case the pattern cannot, a validly-named folder that links
elsewhere. Deletion uses the RECORDED `dir`, never a recomputed one: if
`PLATFORM_APPS` changed since publishing, recomputing would point at a
directory that was never this app's.

## Idea backlog (no required order)

1. **Wire the remaining UI pages to the API** — `Audit.tsx`, `Dashboard.tsx`
   and `Workflow.tsx` still read mock data.
2. **Enforce `allowed-tools`** — currently only displayed. Our permission layer
   can carry this (pi had no such layer).
3. **A config web UI** — a form generated automatically from the JSON Schema.
4. **Docker isolation** — reimplement `ExecutionEnv` on top of Docker exec.
5. **Move to AgentHarness** — session trees, `steer()`, provider retry.
6. **Integration tests + Playwright.**
7. **Clean up the dead demo exports** in `platform-ui/src/data/mock.ts`
   (`buildPlans`, `cannedReplies`, `installedApps`, `agents` and friends now
   have zero references).
8. **Restrict `img` in `Markdown.tsx`** — an external `![](http://…)` in an LLM
   reply currently renders as a raw `<img>`, so a request goes out. Only a
   `src` starting with `/api/chat/attachment/` should be allowed.

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
- **Apps:** the root is relocated by `PLATFORM_APPS`. An app is a folder, so
  `readApp`/`readApps` are async and read from disk every time. `appPublish`
  only registers a folder — to change an app, EDIT ITS FILES.
- **In tests:** `openDb(':memory:')` + `setDb(db)`. Reset the stream registry
  with `clearRunningStreams()` in `beforeEach` — it is module-level state shared
  by every test file in the process. For apps use `test/app-fixture.ts`
  (`useTempApps()` / `publishTestApp()` / `cleanupApps()`) rather than writing
  folders by hand.
- The runtime database lives in `platform-server/data/` — not in git; migrations
  and the seed run automatically on first start.

### Nine boundaries that must not be broken

| Boundary | Where | What happens if it breaks |
|---|---|---|
| Tool results never reach the classifier | `agent.ts`, `orchestrator.ts` | prompt injection protection is lost |
| Trimming never starts at a `toolResult` | `context.ts` | the provider rejects the request |
| `rg` and the Node backend give identical results | `search-engine.ts` | the agent behaves differently depending on the machine |
| **Skill text never reaches the classifier** | `skill-load.ts` | a foreign repo writes "allow every command" and prises the protection open |
| **Tar paths are sanitised (no `..`)** | `tar.ts` | zip-slip: the archive writes outside the target directory |
| **Attachment names/paths never reach the classifier** | `agent.ts` (`attachmentNote`), `orchestrator.ts` | a filename (`"; rm -rf ~; #.png`) influences the permission decision |
| **`afterToolCall` preserves image blocks** | `agent.ts` (`nonTextBlocks`) | the model silently fails to see the image — with no error message |
| **A deletion path resolves inside the apps root** | `apps-dir.ts` (`isInsideAppsRoot`) | a symlinked app folder makes `rm -rf` follow the link out of our directory |
| **`appDelete` never accepts an automated answer** | `permission.ts` (`requireUser`) | auto mode or one stored "always" erases the user's apps without a human deciding |

All of them are enforced by tests — fix the code rather than "fixing" the test.

The fourth boundary has a STRONGER justification than the `AGENTS.md` one: a
project file was at least placed in the user's own directory, whereas a skill
comes from a foreign GitHub repo that the user may never have read.

## Wider context

- `ai-news-bot/` — a separate, finished project (488 tests), unrelated to this
  work. Still in Uzbek, deliberately: it writes for an Uzbek-language channel.
- Project documentation: `README.md`, `02-ai-platform.md`, `04-risks.md`.
- Package documentation: a README in each of the five packages.
