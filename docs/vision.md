# Vision — what Barpo is growing into

> A self-hosted, open-source AI orchestration platform grown out of the bot.
> The topmost layer above agents like OpenClaw/Hermes: every AI tool, server, and agent behind a single control point.

> **This document describes the TARGET, not the present.** It was written before
> the platform existed and is kept as the direction, not as a description of
> what runs. Several things below are unbuilt: the Workflow Engine, the Channels
> adapters, the agent-daemon model (servers are managed over SSH today), and the
> tmux Claude Code integration.
>
> For what actually exists right now, read [CONTINUE.md](../CONTINUE.md); for how
> the built system is put together, [architecture.md](architecture.md).

---

## 1. Vision

**In one sentence:** "An operating system for AI tools — every model, agent, server, and deploy one chat and one click away, on your own server, under your own control."

The problems the platform solves (drawn from my own experience):

1. **Fragmentation** — Claude, ChatGPT, Gemini, and OpenRouter are all separate; there is no single interface
2. **No integration** — AI tools do not know about each other; work discussed in a chat has to be started over by hand in Claude Code
3. **Deploy pain** — outside JS there is no simple deploy story; every time means configuring a server by hand
4. **Security culture** — people are handing server passwords straight to AI; there needs to be a right way to do this
5. **Every new automation starts from zero** — there are no ready-made modules for projects like the bot, everything is wired up manually

## 2. The path from bot to platform

The platform is not designed up front — modules are extracted from the bot:

| Bot module | Becomes this platform component |
|---|---|
| `bot/llm/` (OpenRouter client) | **LLM Router** — all providers, model selection, fallback, cost accounting |
| `bot/collector/` | **Data Sources** — RSS/API/scrape adapters, for any agent |
| Scheduler + pipeline | **Workflow Engine** — describing and running staged agent flows |
| Approval flow | **Human-in-the-loop** — an approval layer for any agent |
| Publisher (Telegram) | **Channels** — Telegram/Slack/Email output adapters |
| SQLite state management | **State Store** — agent state, history, audit log |

**The rule:** a module only moves into the platform when a *second* use case needs it. An abstraction with one user is not an abstraction, it is an extra layer.

## 3. Target architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Web UI (chat-first)                     │
│   Simple mode: chat only    │  Pro mode: terminal, logs,     │
│                             │  agent controls, configs       │
├─────────────────────────────────────────────────────────────┤
│                     Orchestrator Core                        │
│  Workflow Engine │ Agent Manager │ Human-in-the-loop │ Audit │
├──────────────┬──────────────┬───────────────┬───────────────┤
│  LLM Router  │  Skill Store │  Tool Runtime │ Server Agents  │
│  (every      │  (installable│  (Claude Code │ (daemons on    │
│  provider +  │  skill       │  in tmux,     │ my 5 servers)  │
│  OpenRouter) │  packages)   │  MCP, bash)   │                │
├──────────────┴──────────────┴───────────────┴───────────────┤
│              State Store (state, history, audit log)         │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 LLM Router

- Every provider (Claude, OpenAI, Gemini, OpenRouter) behind a single interface
- BYOK — my own API keys and subscriptions are used
- Model selection rules per task type (`models.yaml`): cheap work to cheap models, important work to strong ones
- Fallback: automatically switch providers when one is down
- Cost accounting: which agent is burning how many tokens — all of it visible

### 3.2 Tool Runtime

- **Claude Code integration:** when a chat says "add feature X to this repo", the orchestrator launches Claude Code in a tmux session, follows the process, and returns the result to the chat. In pro mode the tmux session can be watched live; in simple mode only the result is shown
- **MCP client** ✅: we do not invent our own standard — we connect MCP servers (using the ecosystem that already exists). Done: the catalog fills from four sources (the official registry, GitHub `server.json`, manual entry, the bundled platform set), both transports (stdio + streamable-http/sse) work, and **every tool call passes through the permission layer** (`kind: 'mcp'`). The client is our own — the SDK would have pulled in 4 MB plus server-side dependencies, and the part of the protocol we actually need (`initialize`/`tools/list`/`tools/call`) is small. Limitations: OAuth-protected servers and `resources`/`prompts` are not supported yet
- **Sandbox:** each tool runs in a separate container with restricted privileges

### 3.3 Server Agents

Giving the platform a server password is NOT an option. Instead:

```
Platform ◀──── outbound WebSocket ──── Agent daemon (on each server)
```

- A small agent is installed on each server (a single `curl ... | sh` command)
- The agent connects to the platform **itself** (outbound) — no port is opened on the server, no password is transmitted
- The agent only has a list of permitted actions

**Permission levels:**

| Level | Actions | Mode |
|---|---|---|
| Read | logs, status, metrics | Automatic |
| Write | deploy, restart, config | Configurable (automatic or with confirmation) |
| Dangerous | rm -rf, DROP DATABASE, DNS, user management | Always requires human confirmation |

- Every action lands in the audit log: who (which agent/LLM), what, when, with what result
- Preview: changes are shown in a temporary environment first, and only go to production after confirmation

### 3.4 Skill Store

- A skill is a declarative package: a manifest (what it does, which permissions it needs) + prompts + code
- Deploy skills come first: "Django deploy", "Rust binary deploy", "Docker compose deploy" — the same experience for every language
- One-click install through the UI (App Store model), but the permission list is shown at install time (Android permission model)
- Because it is open source: the community can write its own skills, but that is a bonus, not the goal
- Security: a skill runs in a sandbox and never gets a permission it did not ask for (the primary defence against prompt injection inside a skill from the store)

### 3.5 UI philosophy — progressive disclosure

- **Default:** chat only. "What did my bot do today?", "deploy this project to my server" — all in plain language
- **Pro mode (one button):** tmux sessions, agent logs, workflow editor, cost dashboard, audit log
- Nobody is restricted and nobody is forced — if you do not want to see it, you do not see it

## 4. Security principles (from day one)

1. Passwords and keys never enter the LLM context — that is what the agent daemon model is for
2. Every action follows the principle of least privilege
3. Dangerous actions always require human confirmation (even in auto mode)
4. A complete audit log — immutable (append-only)
5. Vigilance against prompt injection: text from external content (logs, web pages, skills) is never executed directly as a command
6. Self-hosted — my data never leaves my server

## 5. What we are NOT doing (scope boundary)

- ❌ We are not creating our own standard — we build on MCP and the standards that exist
- ❌ We are not building a SaaS business — self-hosted open source, for myself
- ❌ We are not targeting every audience — my own needs first, everything else is a bonus
- ❌ We are not turning the store into a "marketplace business" — a simple skill catalog is enough
- ❌ We are not competing with model providers — we are the orchestration layer, not the model
