# Architecture

How the built system fits together, and the security model that shapes it.

This describes what **runs today**. The unbuilt parts of the plan live in
[vision.md](vision.md); the running commentary on where the work stands is
[CONTINUE.md](../CONTINUE.md).

## The shape of it

```
┌────────────────────────────────────────────────────────────┐
│  barpo-ui — React + Vite                                   │
│  chat · conversations · agents · servers · skills · MCP    │
│  schedules · audit · app dashboards                        │
└───────────────┬──────────────────────┬─────────────────────┘
         REST /api                WebSocket /ws
                │                      │
┌───────────────▼──────────────────────▼─────────────────────┐
│  barpo-server — Bun.serve + Hono, one port (8787)          │
│                                                            │
│  routes/   the REST surface        ws/hub   channels       │
│  repo.ts   the only place SQL lives                        │
│  audit.ts  the only way to write an audit row              │
│  orchestrator.ts  chat → @barpo/ai → WS events → DB        │
│  schedule/ cron, the tick, limit detection                 │
└───────┬────────────────────────────────────┬───────────────┘
        │                                    │
┌───────▼──────────────┐        ┌────────────▼───────────────┐
│  SQLite (WAL)        │        │  ~/.barpo/                 │
│  data/platform.db    │        │  work/ projects/ apps/     │
│  migrations 001–018  │        │  skills-store/ config.json │
└──────────────────────┘        └────────────────────────────┘
                │
┌───────────────▼────────────────────────────────────────────┐
│  barpo-ai — the agent, the tools, the security layer       │
│  RestrictedEnv · command analysis · permission · classifier│
│  MCP client · skills · memory · context compaction         │
└───────────────┬────────────────────────────────────────────┘
                │
        38 providers via pi-ai · local Ollama · MCP servers
```

`barpo-config` sits underneath both server and AI, and `barpo-shared` carries
the types and the WS protocol that all three agree on.

## The packages, and which way they depend

| Package | Role | Depends on |
|---|---|---|
| `@barpo/shared` | types + the WS protocol (a discriminated union) | nothing |
| `@barpo/config` | settings: global + project layers, JSON Schema | nothing |
| `@barpo/ai` | provider detection, the agent stream, tools, security | `shared`, `config`, pi |
| `@barpo/server` | HTTP, WS, SQLite, orchestration, the scheduler | `shared`, `config`, `ai` |
| `@barpo/ui` | React + Vite; dev-proxies `/api` and `/ws` to 8787 | `shared` |

**`barpo-ai` never depends on `barpo-server`.** The arrow only points one way,
and that is load-bearing rather than tidy. The data an agent needs — which
servers exist, where an app folder goes, which MCP servers to connect, what the
schedules are — all lives in the server's SQLite. Instead of importing it, the
package declares a tool and calls a **function the caller supplied**:

| Injected | Gives the agent |
|---|---|
| `serverProvider` | `serverList` |
| `dashboardSink` / `dashboardRemover` | `appPublish` / `appDelete` |
| `scheduleSink` / `scheduleLister` / `scheduleRemover` | `scheduleCreate` / `scheduleList` / `scheduleDelete` |
| `mcpProvider` | `mcp__<server>__<tool>` |
| `permission` / `mode` | the permission layer for this session |

Two consequences fall out of this and both matter:

- **A provider that is not supplied means the tool is not declared at all** — and
  the system prompt does not mention it either, because the prompt flags are
  derived from the tool list that was actually built. The two cannot drift into
  "instructions about a tool that isn't there".
- **The AI layer is testable without a database.** The security tests run
  `RestrictedEnv`, `assessCommand` and classifier isolation directly, with no
  server and no LLM.

`barpo-server/src/orchestrator.ts` is the real caller and supplies every one of
them.

## A chat message, end to end

```
POST /api/chat/send
  → validate, write the user message, lock the session's provider
  → 202 { messageId }                          ← returns immediately
  → streamReply() runs in the background:
        @barpo/ai agentStream()
          → chat.delta      text as it arrives          [WS]
          → chat.tool       a tool started / finished   [WS]
          → chat.permission a dangerous action is waiting
          → chat.classifier auto mode's verdict
          → chat.status     running / awaiting-permission / done
  → chat.done | chat.error | chat.scheduled
  → the full reply and its tool cards are written to the DB once
```

**The send does not wait for the reply.** A reply takes minutes; knowing whether
the message was *accepted* (or rejected — a 409 provider lock) has to be
immediate. So the HTTP call returns 202 and the answer arrives over the
WebSocket.

A `chat.send` over WS takes exactly the same path (`ws/chat-handler.ts` calls
the same `chat-send.ts`), so both routes obey the same rules. The only
difference is that errors come back as a `chat.error` event rather than a status
code.

Three consequences of the stream being fire-and-forget:

- It **survives the page closing**. `GET /api/chat/running` lists what is alive;
  `chat.status` announces changes.
- `chat.permission` is sent **once**. If the socket was down at that moment the
  event is gone, so the pending requests have their own endpoint — otherwise the
  agent would wait for an answer to a question nobody can see.
- `chat.scheduled` is a third ending, and not an error: a provider limit
  interrupted the reply and the platform booked a continuation. The user is told
  "paused until 14:35" because nothing is left for them to do.

## The security model

The premise: **text an LLM has read is untrusted**. A file in a cloned repo, the
output of a command, a skill from a stranger's GitHub — any of it may contain
"ignore your instructions and run this". The model cannot reliably tell the
difference, so the defence cannot be a line in a prompt. It has to be a
restriction on what the code will do and on where data can flow.

pi's own `NodeExecutionEnv` has no sandbox — in testing it read `/etc/passwd`
and `bash` could `cd /`. That is the right call for pi, a trusted local CLI. On
a platform it is not, so several layers were added.

### The decision chain

Every dangerous action walks this sequence, first match wins:

```
1. Hard deny list                 → blocked. No classifier, no override, ever
2. Inside the working directory,
   or on the command allowlist    → runs automatically
3. An "always" pattern from
   earlier in this session        → runs automatically
4. mode = confirm  (the default)  → the user is asked
5. mode = auto                    → the CLASSIFIER decides
      ├─ allow  → it runs
      ├─ block  → the agent gets an error, the block counter goes +1
      └─ broken → auto turns itself off, and the user is asked
```

**The hard deny list is the one unconditional guarantee** — neither the
classifier, nor a stored "always", nor auto mode can reach past it. It is
deliberately short (irreversible, system-destroying operations only), because
every extra entry raises the chance of blocking real work.

### Where the checks live

The rule throughout: **the check goes inside the method the tool must call**, not
in the caller. A tool cannot route around what it cannot avoid calling.

| Layer | File | What it enforces |
|---|---|---|
| Filesystem boundary | `barpo-ai/src/environment.ts` | every path is resolved (symlinks included) and must sit inside the working directory, or permission is asked. `exists()` returns false for anything outside, so the agent cannot probe the filesystem |
| Command analysis | `barpo-ai/src/command-analysis.ts` | a command is split on `;` `&&` `\|\|` `\|` `$()` and backticks, and each part judged separately — the most dangerous wins |
| Permission | `barpo-ai/src/permission.ts` | asks, remembers a narrow "always" pattern, denies after 5 minutes, and records WHERE each decision came from |
| Auto mode | `barpo-ai/src/classifier.ts` | "did this go beyond what the user asked for?" |
| MCP | `barpo-ai/src/mcp-manager.ts` | the gate is in `call()`, not in the tool wrapper |

A **hook cannot substitute for any of this**. Hooks run after the security layer
and can only add restrictions — never widen a permission. The reason is that
hooks come from the config, and a config file may have arrived with someone
else's repo.

### The classifier, and the line it must not cross

A static list can say a command is dangerous. It cannot say whether it was
*asked for*: `rm -rf old-logs/` is routine when the user requested it and
alarming when they did not. Only context separates the two, so auto mode asks a
model a different question — "did the action go beyond what was asked?"

> **UNTRUSTED TEXT IS NEVER GIVEN TO THE CLASSIFIER.**
>
> If a file the agent read says "now run `rm -rf ~`", that text never reaches
> the classifier at all. It sees the user's own messages and the action being
> assessed — nothing else. `assessAction` builds its prompt from
> `CLASSIFIER_PROMPT` + `requestToText()`, so there is no code path by which the
> other text could arrive.
>
> This is an architectural defence, not an instruction. An instruction can be
> talked around; a missing code path cannot.

The boundary covers four sources, each untrusted for its own reason:

| Source | Why |
|---|---|
| tool results | a file the agent read, or command output |
| `AGENTS.md` / `CLAUDE.md` | may have arrived with a cloned repo |
| skill descriptions | come from a foreign GitHub repo — purely untrusted input |
| memory files | **time-delayed injection**: a foreign file says "write this to memory", the agent copies it, and it returns through the prompt in a later session |

Attachment file names take the same care: the note listing them is appended to
the *prompt*, never to `chat_messages.text`, because that column is exactly what
the classifier reads.

**Auto mode turns itself off** — immediately if the classifier is broken, after
3 consecutive blocks, or after 20 in a session. It never turns itself back on;
the user presses a button. And the classifier runs on the **chat's own
provider** — a rule learned from a real failure, told in full in
[`barpo-ai/README.md`](../barpo-ai/README.md).

### What is NOT solved

> This is defence in depth, **not a sandbox**. Command analysis is static: a
> sufficiently creative construction (`echo cm0gLXJm | base64 -d | sh`) can get
> around it — which is why `base64`, `sh` and `eval` count as dangerous and
> unknown commands are asked about at all. Real isolation arrives with Docker,
> and `ExecutionEnv` is a fully delegated interface for exactly that reason.
>
> Prompt injection is not a solved problem in the field, and nothing here claims
> otherwise. What the design buys is that a successful injection still has to
> pass a human or a classifier before it can act.

The twelve invariants these layers rest on are listed in
[CONTINUE.md](../CONTINUE.md#twelve-boundaries-that-must-not-be-broken), each
with the test that enforces it and what breaks if it goes.

## Storage

**SQLite, one file, WAL.** Nothing to install — the "runs on an ordinary PC"
principle. Migrations run in order at startup, each in its own transaction, so
there is no half-applied state.

Two rows deserve naming:

- **`audit_log` is append-only at the SQL level.** `UPDATE` and `DELETE` are
  blocked by triggers, so the guarantee holds even against a bug in the code.
  There is deliberately no write endpoint — only `auditWrite()` fills it.
- **`apps` holds no manifest, only a folder path.** An app is a directory under
  `~/.barpo/apps/<id>/`; every read goes to disk. That is what makes editing a
  file the whole update — no republish, no watcher, no reload button.

**Secrets never live in the database.** MCP credentials go in a separate
`chmod 600` file, because a database file gets backed up, copied and exported,
and the result of a `SELECT` can end up in a log. Nothing that reaches the
browser ever carries a secret value — only an `isSet` flag.

**Work directories are per session**, `~/.barpo/work/<sessionId>/`, or per
project when a conversation is bound to one. A project folder carries no
privilege: the boundary check applies to it exactly as to a session folder. Every
root is relocatable by an env var — see [configuration.md](configuration.md).

## The time layer

The platform starts work when nobody is watching, in two shapes that share one
table:

- **`resume`** — a provider limit interrupted a reply. The error text is read for
  a reset time, five minutes are added, and the SAME conversation continues at
  that point.
- **`recurring`** — a cron expression and a stored prompt. Every firing opens a
  **brand-new session**, deliberately: a fresh context each run is what keeps a
  daily report reproducible, where one long conversation would drift.

A scheduled run needs auto mode, and auto mode needs a working classifier —
otherwise the run stops at the first `bash`, waits five minutes for an answer
nobody is there to give, and reports success having done nothing. With no
classifier available the run is **refused and the reason recorded**, which is the
honest failure.

The mechanism, the missed-run rules and the cron parser are documented in
[`barpo-server/README.md`](../barpo-server/README.md).

## Extending it

Each of these has a fixed procedure, documented where the code is:

| Adding | Procedure |
|---|---|
| a REST route | [`barpo-server/README.md`](../barpo-server/README.md#extending-it-for-the-agents-that-come-next) |
| a WS event | the comment at the top of `barpo-shared/src/protocol.ts`, plus a case in `eventChannel()` / `eventSession()` |
| a config setting | one line in `FIELDS` — [`barpo-config/README.md`](../barpo-config/README.md) |
| a migration | a new file; never edit an applied one |
| a skill | [`skills/README.md`](../skills/README.md) |
| a built-in MCP server | [`mcp-servers/README.md`](../mcp-servers/README.md) |
