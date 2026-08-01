# @barpo/ui

The interface of **the program that builds programs**: a new service is ordered
through chat, the platform builds it in the background, and the finished app
**adds its own dashboard** to the platform (the "Apps" section in the sidebar).

Every page reads from the real backend — chat, conversations, agents, servers,
skills, MCP servers, schedules, the audit log and the app dashboards all talk to
live endpoints (`lib/api.ts`, `lib/ws.ts`). One known exception, labelled in the
UI itself: `Terminal.tsx` is still a scripted replay, not a live session.

## Getting started

```sh
bun install
bun run dev
```

The dev server proxies `/api` and `/ws` to the backend on port 8787
(`vite.config.ts`), so no absolute address appears in the frontend code. The
backend has to be running: `cd barpo-server && bun run dev`.

## Structure

```
src/
  lib/
    api.ts         — REST calls (models, chat, projects, skills, MCP, servers, apps, schedules, audit)
    ws.ts          — a single WebSocket client (reconnects automatically)
    apps.ts        — the installed apps in the sidebar (REST + WS)
    app-states.ts  — polling the live state of a dashboard
    running.ts     — the agent streams running in the background (REST + WS)
    conversations.ts — the conversation list shared by the sidebar and its page
    fleet.ts       — the header ticker: servers connected, disk warnings (real SSH metrics)
    hash-path.ts   — URL hash ↔ app state (pure functions, tested)
    date.ts        — date grouping and formatting for the conversation list
    toast.ts       — the toast context and hook
    audit-label.ts — display labels for audit level/result values
    model-storage.ts   — the last selected model, in localStorage
    sidebar-storage.ts — whether the sidebar's Chat accordion is open
  components/
    ModelPicker.tsx    — searchable model picker (grouped by provider)
    ProjectPicker.tsx  — the project (working directory) a conversation binds to
    AttachmentChip.tsx — a file or image attached to the chat
    ToolCard.tsx       — a tool the agent ran (status, diff, classifier label)
    PermissionCard.tsx — a permission request for a dangerous action (3 buttons)
    ModeToggle.tsx     — ⏸ confirm / ⏵⏵ auto
    ModeCard.tsx       — the reason auto turned off + "Re-enable"
    ConversationList.tsx — the sidebar's expandable Chat section
    StreamIndicator.tsx  — a live indicator next to a running session
    Markdown.tsx       — assistant replies rendered as markdown (GFM, no raw HTML)
    Toast.tsx          — the toast provider and its appearance
    AiView.tsx         — runs an AI-written view inside the host React tree
    SettingsForm.tsx   — an app's settings form, rendered from a schema
    ActionButtons.tsx  — an app's action buttons (restart, stop, …)
  ui.tsx           — shared components (Card, StatTile, LevelBadge, Meter…)
  App.tsx          — the shell: header, Pro mode button, sidebar, status strip
  pages/
    Chat.tsx          — the real LLM chat: model picker, streaming reply, error states
    Conversations.tsx — every conversation, with search and a project filter
    Agents.tsx        — the agent streams running in the background, with a stop button
    AppView.tsx       — renders an app manifest dynamically (widget schemas)
    Servers.tsx       — real SSH server management, live metrics
    Skills.tsx        — skill sources, catalog and installation (with scopes)
    Mcp.tsx           — MCP servers: registry / GitHub / manual sources, settings
    Schedules.tsx     — recurring tasks and the platform's own limit resumes
    Audit.tsx         — append-only audit log, server-side filtering, paged
    Terminal.tsx      — a scripted preview of the tmux session view (see below)
```

The `AppManifest` and `Widget` types live in `@barpo/shared`
(`barpo-shared/src/types.ts`), validated by `manifest-validate.ts` — the same
definitions the server writes against, so the two cannot drift.

The menu is deliberately short: **Agents · Servers · Skill store · MCP servers ·
Schedules · Audit log · Terminal**, plus the installed apps. Chat is not in that
list — it is the sidebar's own expandable section (`ConversationList.tsx`),
because it carries the conversation list with it. The platform is meant to be
simple enough to install on an ordinary PC, so there are no surplus technical
pages for people who do not run servers.

## Design decisions

- **Progressive disclosure** — the default state is chat only; the "PRO MODE"
  button reveals the sidebar, the status strip and every technical page (the
  philosophy from [`docs/vision.md`](../docs/vision.md) §3.5).
- Colour palette: ink-blue background + azure accent + gold (cost). The chart
  series (`--color-s1..s4`) passed the dataviz validator (CVD-safe).
- Fonts: Bricolage Grotesque (headings) · Manrope (body) · JetBrains Mono
  (logs, numbers) — all local (@fontsource), no CDN required.
- **Every number shown is a measured one.** The header ticker used to display
  invented figures that stayed the same whether you had five servers or none;
  `lib/fleet.ts` now reads them from the real endpoints, and a value that cannot
  be measured is not shown at all.

## Navigation (deep links)

The URL hash addresses any page directly:

```
(empty)              — plain mode, new conversation
#chat/<uuid>         — plain mode, an open conversation
#pro/chat            — pro mode, the chat page
#pro/chat/<uuid>     — pro mode, an open conversation
#pro/servers         — pro mode, another page (#pro/audit, #pro/schedules, …)
#pro/app:<id>        — pro mode, an installed app
```

Only a proper UUID is accepted as a session id — otherwise arbitrary text like
`chat/xyz` would be read as a session and the UI would try to load a
conversation that does not exist. Parsing lives in `lib/hash-path.ts` as pure
functions, covered by tests.

## Dynamic app modules — architecture

The UI uses a "server-driven UI" model:

1. **Manifest** — every app is a folder on disk; the server reads it and hands
   the UI a manifest: name, icon, and **its dashboard widgets as a schema**.
2. **Host renderer** — `pages/AppView.tsx` turns the schema into UI
   (stats / bars / table / logs / note / deploy / git widgets). The frontend is
   **not rebuilt** for a new app — only data arrives. Widget text may contain
   `{{state.path}}` templates, which are filled in from the live state polled by
   `lib/app-states.ts`. Beyond the widgets, an app can also ship a settings form
   (`SettingsForm.tsx`, schema-driven), action buttons (`ActionButtons.tsx`) and
   an AI-written view (`AiView.tsx`).
3. **Registration** — the server broadcasts a new manifest over the WebSocket
   and `lib/apps.ts` (`useApps`) adds it to the sidebar; `app.removed` takes it
   away again, carrying the id alone because by then the folder is gone. The
   initial list is fetched AFTER the subscription is in place, or an app
   published in between would be missed.

Why not iframes or module federation? The schema-widget model is safer
(AI-written code does not run in the host UI context — a defence against prompt
injection), simpler and guarantees a single design system. When the widget
types run out there are two ways forward: add a new widget type to the host
(under review) or add a sandboxed iframe layer for complex apps.

## How chat works

```
send a message  →  POST /api/chat/send  →  202 { messageId }
the reply       →  WS: chat.delta × N                    (text)
                    WS: chat.tool                        (tool cards)
                    WS: chat.permission                  (permission request)
                    WS: chat.classifier                  (auto mode decision)
                    WS: chat.mode                        (the mode changed)
                    WS: chat.status                      (a stream started/finished)
                 →  chat.done | chat.error | chat.scheduled
```

The reason for the split: whether the request was accepted (or rejected — a 409
provider lock, say) has to be known immediately, whereas the reply takes a long
time and there is no need to hold an HTTP response open for it.

`chat.scheduled` is the third way a stream can end, and it is not an error: a
provider limit interrupted the reply and the platform booked a continuation, so
the chat says "paused until 14:35" and the conversation resumes by itself.

The model picker gets its list from `/api/models` — the providers detected on
the user's machine (a local Ollama, environment keys, `~/.claude` and `~/.codex`
subscriptions). Models are grouped by provider, ordered by **billing channel**
rather than price: local first, then subscription, then API key. Price would be
the wrong key — a subscription model carries the catalogue's per-token cost even
though the user does not pay it, so sorting on `cost` would bury the channel
they have already paid for underneath the one that bills them.

**Provider lock:** once the first message is sent the session binds to its
provider and the picker locks (🔒). Use "+ new conversation" for a different
provider. The reason: each provider stores conversation history in its own
format (thinking blocks, tool ids), and switching mid-way corrupts the context.

**Project lock:** the same rule applies to the project (the working directory).
It can only be chosen before the conversation starts — the agent may already
have created files there, and moving it mid-way would break the context.

The WebSocket (`lib/ws.ts`) is shared by the whole app — it survives page
changes and, if the connection drops, reconnects and restores its subscriptions
automatically.

### Tool cards and permission

`chat.tool` arrives several times for the same `id` (running → done) and the UI
replaces the existing card. `edit` shows a diff; long `bash` output stays
collapsed and opens on click.

When `chat.permission` arrives a permission card appears — the agent waits for
the answer. The answer is shown in the UI immediately (without waiting for the
server to confirm); if it fails to send, a toast reports it. `chat.status`
serves as a fallback path here: unlike `chat.permission` it is not filtered by
session, so if the server says "awaiting permission" and no card is present, the
UI fetches the pending requests over REST.

### Permission mode

The toggle next to the model picker offers two states:

| Label | Meaning |
|---|---|
| `⏸ confirm` | every dangerous action is asked about (the default) |
| `⏵⏵ auto` | the classifier decides — the number of prompts drops sharply |

In auto mode the classifier's decision appears as a one-line label under the
tool card (`chat.classifier`). The decision answers not "is this action
*dangerous*?" but "did it go *beyond what the user asked for*?".

Auto can turn itself off — if the classifier breaks or blocks repeatedly. When
it does, a `ModeCard` appears in the chat with the reason and a "Re-enable"
button, and the toggle turns gold. It never comes back on its own: a mode
changing by itself would be confusing.

## Running agents

A stream started in chat keeps running on the server even after the page is
closed (the orchestrator is fire-and-forget). `lib/running.ts` tracks them from
two sources — the initial list over REST, later changes from `chat.status`
events. They surface in three places: a live indicator next to the conversation
in the sidebar, a counter badge next to "Agents", and the `Agents` page with its
stop button.

## Schedules

Two kinds of row appear on this page and they read differently:

- **recurring** — the user or the agent set up a repeating task on a cron
  timetable. It can be paused, resumed and deleted. Pausing and resuming go
  through `PATCH /api/schedules/:id`; resuming re-arms first, so a schedule
  paused last week does not fire the moment it comes back.
- **resume** — the platform booked a continuation because a provider limit
  interrupted a conversation. Nobody asked for it, so the row explains itself:
  what stopped, and when it picks back up.

The list stays current over the WebSocket (`schedule.changed` /
`schedule.removed`), so a run finishing while the page is open updates it
without a refresh.

## Known gaps

- **`Terminal.tsx` is a scripted replay.** No SSH connection is opened, no tmux
  session exists, and the server names in it are illustrations. The page says so
  in a banner rather than pretending otherwise; `ssh.ts` already has the
  connection layer and `CHANNELS.terminal` already exists, so the replacement is
  wiring rather than design.
- **`builder.create`** — the endpoint that launches a real build in a tmux
  session is not written. The `build.*` events are already defined in the
  protocol and the pages that would consume them are not built either.
- **Approval cards and the Telegram approval flow** wait on the same backend
  work.
- **`playwright` is a dependency but there are no e2e specs yet** — the
  dependency was added ahead of the tests.
