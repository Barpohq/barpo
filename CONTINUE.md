# Where we left off — a guide to picking the work back up

_Last updated: 2026-08-02. If you are continuing on another machine, start from this file._

## Current state

We are turning the mock demo into a real platform. The chosen route: a **real
backend on Bun + TypeScript (Hono)**, with the AI layer built on top of
`pi-agent-core` (pi — [earendil-works/pi](https://github.com/earendil-works/pi),
a coding agent for the terminal; we adapt its ideas for the web).

**Tests:** 1858 pass, 44 skip, 0 fail across 87 files (`bun test`, ~23s). The
skips are conditional — the Ollama and `rg` tests skip themselves when the
program is not installed. All five packages are clean under `tsc` — zero errors.

**The way of working (since 2026-07-28):** the "build the whole system first,
then polish" plan was dropped. We build the piece we need and fix whatever
problems show up on top of it. The goal has not changed, the route has.

### Packages

| Package | Role |
|---|---|
| `barpo-shared` | shared types + the WS protocol (discriminated union) |
| `barpo-server` | Bun.serve + Hono + bun:sqlite (WAL), port **8787** |
| `barpo-ai` | provider detection, the agent stream, tools, security |
| `barpo-config` | JSON + JSON Schema settings, global + project layers |
| `barpo-ui` | React + Vite, dev proxy `/api` and `/ws` → 8787 |

Each package has its own README with the detail; `barpo-ai/README.md` is the
one to read first — it carries the security model.

## Getting it running

```bash
bun install
bun test                                     # 1858 pass, 44 skip
bun run schema                               # regenerate the config schema
cd barpo-server && bun run src/index.ts   # backend :8787
cd barpo-ui && bun run dev                # UI
```

## What is built

Fourteen stages, in order. The detail of each lives in git history; what follows
is the decision that came out of it — the part that is expensive to rediscover.

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
12. **The time layer** — the platform now starts work on its own: it resumes a
    conversation after a provider limit resets, and runs recurring tasks on a
    cron timetable. See below.
13. **The platform got its name — Barpo** (2026-08-02). See below.

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
`barpo-ai/src/constraints.ts` ARE the language-detection feature, and
`classifier.ts` still accepts the old Uzbek JSON keys as a fallback because
small models echo them back.

Storage paths moved with the rename (`~/.barpo/work`, `projects`,
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

**An app is now a directory**, `~/.barpo/apps/<id>/`:

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

### The time layer — work that starts on its own (2026-07-31)

Two problems that look different and share one mechanism.

**A subscription plan runs out mid-task.** The agent stops, and somebody has to
work out when the limit resets and come back to say "carry on". The platform now
does that itself: the provider error is read for a reset time (`limit-detect.ts`),
five minutes are added, and a `resume` schedule continues THE SAME conversation
at that point. The user sees "paused until 14:35" — a `chat.scheduled` event
sent INSTEAD of `chat.error`, because nothing is left for them to do.

**Something has to be done every day.** A `recurring` schedule stores a cron
expression and a prompt. Every firing opens a **brand-new session**, which is
the point: a fresh context each run is what keeps a daily report reproducible,
where one long conversation would drift and eventually hit compaction.

The pieces, all under `barpo-server/src/schedule/`:

- **`cron.ts`** — a 5-field parser written in-house. The npm packages all carry a
  timezone database and a scheduler we do not need. `nextRun` walks the calendar
  FIELD BY FIELD, so `0 0 1 1 *` costs the same as `* * * * *`; a naive "add a
  minute and test" loop would spin 525,600 times and look like a hang. Times are
  LOCAL. Cron's day-of-month/day-of-week OR rule is implemented as standard —
  `0 9 13 * fri` means "the 13th, or any Friday", not "Friday the 13th".
- **`limit-detect.ts`** — text matching, and it has to be, because pi-agent-core
  never gives us the HTTP layer: a provider error arrives as a STRING on the last
  assistant message. Built to fail safe — an unrecognised error costs one manual
  "carry on", whereas a false positive parks a conversation for a limit that was
  never hit. `context length exceeded` contains the word "limit" and is
  explicitly excluded: rescheduling it would retry the same doomed request once
  an hour forever.
- **`scheduler.ts`** — a `setTimeout` CHAIN (not `setInterval`, which queues the
  next call regardless of how long the last took and lets a backlog land at
  once). One pass runs at startup, which is what catches up runs missed while
  the machine was off. A missed run is caught up if it is under six hours late
  and SKIPPED with a recorded reason beyond that — a week away must not produce
  seven reports at breakfast.
- **`schedule-sink.ts`** — the server half of the agent's tools. Its one job that
  matters: a cron expression the model invented is parsed BEFORE a row is
  written, so a schedule that can never fire is never stored.

The agent gets `scheduleCreate` / `scheduleList` / `scheduleDelete`. Create and
delete go through the permission layer but do NOT use `requireUser` (unlike
`appDelete`): a schedule is reversible and destroys nothing, so demanding a
human answer even in auto mode would be permission fatigue.

**A scheduled run works in AUTO permission mode, and that is not optional.** In
`confirm` mode the agent stops at the first `bash`, waits five minutes for an
answer nobody is there to give, and reads the silence as a refusal — the run
burns its tokens, produces nothing, and reports no error, so the schedule looks
like it worked. `enableAutoMode()` therefore switches the session over before
the stream starts.

The safety condition is the CLASSIFIER, checked first: auto mode is not "no
checks", it is "the checks are made by a model rather than a person". With no
classifier available there is no check at all, so the run is REFUSED and the
reason is recorded (the session is still created, so the refusal is visible
rather than looking like the schedule never fired). Auto can also turn itself
off mid-run — a broken classifier, three consecutive blocks, twenty in total
(`mode.ts`); `runWithAutoMode()` then cuts the stream short with `stopStream`
rather than letting each remaining tool call time out separately, and writes
the reason to `lastError`.

**The classifier follows the CHAT's provider** (`classifier.ts`,
`CLASSIFIER_BY_PROVIDER`). This was found by a scheduled run dying: selection
used to scan every detected model and take the cheapest-looking one, so on an
account whose chat runs on a Codex SUBSCRIPTION it picked `openai/gpt-4.1-nano`
— a paid API model on a different billing channel. The chat worked; the
classifier answered "no credits remaining", auto mode shut off, and the run died
mid-command with nothing visibly misconfigured.

The provider a conversation already uses is known to be reachable and paid for,
so the search starts there: env → config → the table for the chat's provider →
the heuristic within that provider → the heuristic everywhere (so a local Ollama
holding only `qwen3` does not cost you auto mode entirely).

The table is written down rather than guessed, because names predict neither
latency nor price. Measured: `gpt-5.4` 2.9s, `gpt-5.4-mini` 4.1s — the "mini" is
slower. Priced: `gpt-5.6-luna` $0.20/$1.20 vs `gpt-5.4` $2.50/$15.00 — 12× for
1.6s. Price wins, because the classifier runs before every dangerous tool call.
Anthropic is a deliberate exception: **Sonnet, not Haiku**, since this is the one
call allowed to say "no" and the expensive mistake is the subtle injection
nobody wrote a test for.

The `gpt-5` exclusion was also too broad — `\bgpt-5` matched the entire later
family, so a Codex-only account had no candidate at all. It is now
`(^|/)gpt-5(-|$)`, which stops at the dot; `codex-spark` is excluded separately
(the catalogue lists it, the API refuses it).

**A schedule inherits the model of the conversation that created it.** Without
that, every run picked whatever was first in the detected list, so a report set
up while talking to one model would be written by another with nothing to
indicate the change. `scheduleCreate` takes optional `provider`/`model` for the
"run it on something cheaper" case; half an argument is treated as none. A
pinned model that no longer exists falls back to the default rather than
failing — a report from a different model beats no report.

**The thing that will bite whoever extends this:** a scheduled run starts in an
empty conversation. A prompt that says "prepare the report we discussed"
produces nothing — silently, every day, until someone checks. The tool
description, the config hint and the UI form all say so, and
`schedule-sink.ts` rejects a prompt under ten characters, but nothing can
validate this properly.

A sharper version of the same problem was found on a live run and IS fixed:
`SCHEDULED_RUN_NOTE`. A stored prompt naturally reads "Every day, check the
issues and label them" — which, to a model waking in an empty conversation with
`scheduleCreate` in its toolbox, reads as a request to SET UP a schedule. Twice
in a row the agent called `scheduleList`, found the schedule that had just
started it, replied "one already exists so I did not create a duplicate", and
stopped. No error, no work done, `lastError` empty: the schedule reported
success. The note now precedes every recurring prompt and says plainly that the
scheduling has already happened and this is the run. A `resume` does not get it
— that conversation already has its history.

**Known limit, not a bug:** if the machine is off, nothing fires. The startup
pass covers a closed laptop; it does not cover a machine that stays off past
`MAX_LATENESS_MS`. A launchd/systemd unit is the real fix and is not written.

### The name — Barpo (2026-08-02)

The working title was "platforma". The project is now **Barpo** (barpo.dev),
from the Uzbek *barpo qilmoq* — to build, to bring into being. The positioning
went with it: "the program that builds programs".

What actually moved, and what deliberately did not:

- **Package scope** `@platforma/*` → `@barpo/*`, and the directories with them
  (`platform-ai/` → `barpo-ai/` and so on). Two commits: the scope first, the
  directory names last, because the second is the one that breaks every path.
- **User data** `~/.platforma` → `~/.barpo`. **No data migration was written** —
  a pre-rename install keeps its old directory and simply starts fresh in the
  new one. The same decision as the English rename: these were single-user
  installs and the cost of a migration exceeded the cost of the loss.
- **Migration 018** rewrites the stored built-in source identifiers. This one
  was NOT optional, for exactly the reason 014 exists: those strings are
  duplicate-detection keys compared by exact match, so moving the constants
  without the rows would have created a second built-in source and shown every
  built-in skill and MCP server twice.
- **Historical migrations and their seeds were left untouched** — rewriting an
  applied migration to say a newer name would make a fresh database diverge from
  an upgraded one.
- **`PLATFORM_*` env variables did NOT change.** This is the last place the old
  name lives, and it survives on purpose: renaming an env var breaks every
  existing install silently — the platform falls back to defaults and looks like
  it lost the user's data. Documented in `docs/configuration.md`.

### Git and presence (2026-08-02, issue #17)

The agent had no git guidance at all, and the chats of one project — which all
share a single work directory — did not know about each other. Two decisions,
both of which will otherwise be relitigated:

- **No git tool. Bash is enough.** What was missing was not a tool but the
  *situation*: `git-state.ts` reads the work directory's git state (from
  `.git`'s own files — never by spawning git; the reasons are boxed in that
  file) and the prompt gets the rules for exactly that case. Not a repo →
  init only if something real is being built. Repo without a remote → local
  commits at meaningful points. Repo with a remote → branch + PR, never
  straight onto the trunk, and pushing is the user's decision. Git is offered,
  never forced — every obligation in the text is conditional. `git init`
  joined `SAFE_GIT` (the prompt tells the agent to init; gating it would make
  the agent's own instructions fire a permission prompt); `merge`, `pull`,
  `checkout`, `clone`, `push` stay gated, and the reasons sit in the comment
  above `SAFE_GIT`.
- **Presence, not isolation.** One directory, and the agents are told about
  each other: the server gathers the sibling sessions and who is streaming
  (`presence.ts`, `repo.ts: siblingSessions`), `presence-prompt.ts` formats
  the list plus the shared-directory rules. A session with no project hears
  nothing.

**Known limit, not a bug:** presence is advisory. Two agents can still write
the same file; the `edit` tool's exact-string match makes the second one fail
loudly rather than corrupt, but the error will read as confusing. Worktree
isolation per session is the real fix and is deliberately a later iteration.

## Idea backlog (no required order)

1. **Enforce `allowed-tools`** — currently parsed (`skill-file.ts`) and
   displayed, but nothing reads it at permission time. Our permission layer can
   carry this (pi had no such layer).
2. **A config web UI** — a form generated automatically from the JSON Schema.
3. **Docker isolation** — reimplement `ExecutionEnv` on top of Docker exec.
4. **Finish the move to AgentHarness** — the tools already use the
   `AgentHarnessTool` shape; the loop is still the lower-level `Agent`. Session
   trees, `steer()`, provider retry.
5. **E2E tests** — `playwright` is a dependency of `barpo-ui` but no spec has
   been written. Integration tests do exist (`config-integration.test.ts`,
   `mcp-client-integration.test.ts`, `dashboard-integration.test.ts`).
6. **Restrict `img` in `Markdown.tsx`** — an external `![](http://…)` in an LLM
   reply currently renders as a raw `<img>`, so a request goes out. Only a
   `src` starting with `/api/chat/attachment/` should be allowed. Still open,
   and it is the one live security gap on this list.
7. **A real terminal** — `Terminal.tsx` is a scripted replay. `ssh.ts` has the
   connection layer and `CHANNELS.terminal` exists, so this is wiring.
8. **CI** — no workflow runs `bun test` on a PR yet.
9. **`session.idleMinutes` is defined but never read.** The setting is validated
   and documented; the actual cleanup runs on `REGISTRY_TTL_MS`, a hard-coded 30
   minutes in `barpo-ai/src/registry.ts`. Either wire the setting through or
   drop it — a setting that silently does nothing is worse than no setting.

## Notes for agents (important technical details)

- **Adding a route:** `barpo-server/src/routes/<name>.ts` plus one import and
  one `api.route()` line in `createApp()` in `app.ts`.
- **Adding a WS event:** follow the procedure in
  `barpo-shared/src/protocol.ts` — there is a 4-step comment there. Both
  `eventChannel()` and `eventSession()` need updating.
- **Adding a config setting:** just one line in `FIELDS` in
  `barpo-config/src/schema.ts` plus a field on the `Config` type, then
  `bun run schema`. Validation, the default value, and the JSON Schema follow
  automatically.
- **Adding a migration:** `barpo-server/src/migrations/0NN-name.ts` plus a line
  in `migrations/index.ts`. Never edit one that has already been applied — the
  runner works by number, so an edited migration simply never re-runs on the
  databases that already have it. The list currently ends at **018**; there is
  no 008, deliberately (the reason is written out in `009-tool-calls.ts`).
- **Audit:** only through `auditWrite(...)` — the table blocks UPDATE/DELETE with
  a SQL trigger.
- **Schedules:** a cron expression is parsed BEFORE its row is written, on both
  paths (`schedule-sink.ts` for the agent, `routes/schedules.ts` for the user).
  A scheduled run needs auto mode, and auto mode needs a working classifier —
  with none available the run is refused and the reason recorded.
- **Skills:** the store root is relocated by `PLATFORM_SKILLS` (a temporary
  directory in tests). The agent reads skills from `.barpo/skills/`, where
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
- The runtime database lives in `barpo-server/data/` — not in git; migrations
  and the seed run automatically on first start.

### Thirteen boundaries that must not be broken

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
| **A cron expression is parsed before its row is written** | `schedule-sink.ts`, `routes/schedules.ts` | a schedule that can never fire sits in the list looking active — failure disguised as success |
| **Deleting a conversation never deletes a recurring schedule** | migration 017 (`schedules_keep_recurring`) | tidying up old chats silently cancels the user's daily report |
| **A context-length error is never read as a quota error** | `limit-detect.ts` (`NOT_A_QUOTA`) | the same doomed request is retried once an hour forever |
| **The git remote URL and session titles never reach the classifier** | `git-state.ts`, `presence-prompt.ts`, `orchestrator.ts` | a cloned repo's `.git/config` or a crafted chat title influences a permission decision |

All of them are enforced by tests — `classifier-isolation`, `memory-isolation`,
`context`, `search-parity`, `search-security`, `skill-load`, `tar`,
`agent-prompt`, `schedule-tools`, `cron`, `schedules-api`, `limit-detect`,
`git-state`, `presence-prompt`. When
one goes red, **fix the code rather than "fixing" the test**.

**The skill-text boundary has a STRONGER justification** than the `AGENTS.md`
one: a project file was at least placed in the user's own directory, whereas a
skill comes from a foreign GitHub repo that the user may never have read.

## Wider context

- `ai-news-bot/` — a separate, finished project (488 tests), unrelated to this
  work. Still in Uzbek, deliberately: it writes for an Uzbek-language channel.
- Project documentation: [`docs/`](docs/README.md) — the index, and from there
  [architecture](docs/architecture.md) (the system view and the security model),
  [configuration](docs/configuration.md), [getting started](docs/getting-started.md),
  [vision](docs/vision.md) and [risks](docs/risks.md).
- Package documentation: a README in each of the five packages, plus
  [`skills/`](skills/README.md) and [`mcp-servers/`](mcp-servers/README.md).
