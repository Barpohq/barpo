# Getting started

From nothing to a working conversation with an agent that can read your files,
run commands and build things.

## What you need

| | Required? | Why |
|---|---|---|
| [Bun](https://bun.sh) 1.3+ | yes | the only toolchain — runtime, package manager, test runner, and it reads TypeScript directly |
| git | yes | the platform commits the agent's changes, and skills are installed from GitHub |
| **a model** | yes | see [Connecting a model](#connecting-a-model) — without one, chat cannot start |
| [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) | no | makes the agent's search faster. Without it a Node backend runs instead, and the two are tested to return identical results |
| [Ollama](https://ollama.com) | no | one way of supplying a model, entirely local and free |
| `sshpass` | no | only needed the first time you connect a server with a password |

No database to install, no Docker, no external service. SQLite is a file.

## Install and run

```bash
git clone https://github.com/Barpohq/barpo.git
cd barpo
bun install
bun test          # 1775 pass, 44 skip — a quick check that everything is sound
```

Then two processes, in two terminals:

```bash
cd barpo-server && bun run dev    # backend on :8787, watch mode
cd barpo-ui     && bun run dev    # the UI, and it proxies /api and /ws to 8787
```

Open the address Vite prints. The database, its folder and the migrations all
take care of themselves on that first start.

`bun run schema` regenerates `barpo-config/schema.json` from the field
definitions — you only need it after adding a config setting.

## Connecting a model

This is the one step that actually blocks a first run: with no model detected,
the picker is empty and a message cannot be sent. There are three independent
routes, and **any one of them is enough**.

### 1. An API key

Export the variable for whichever provider you have and restart the server:

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # Claude
export OPENAI_API_KEY=sk-...             # OpenAI
export OPENROUTER_API_KEY=sk-or-...      # many models behind one key
export GEMINI_API_KEY=...                # Google
```

OpenRouter is the least fuss if you have none of the others — one key, most
models, including some that cost nothing. (They will not float to the top of the
picker: it sorts by billing channel, and an OpenRouter key is an API key
whatever the model's price.)

### 2. A local Ollama

If Ollama is running, every model it has is detected automatically at zero cost:

```bash
ollama serve
ollama pull qwen3:8b
```

Worth knowing: a local model is fine for chat, but a model that *must* reason
before answering (`qwen3` and friends) is unusable as the permission classifier
— it never finishes. Auto mode will fall back to asking you instead.

### 3. A subscription you already pay for

If you use Claude Code or Codex in your terminal, their tokens are already on
this machine and are read as-is:

| File | Gives you |
|---|---|
| `~/.claude/.credentials.json` | your Claude Pro/Max subscription |
| `~/.codex/auth.json` | your ChatGPT Plus/Pro subscription |

These are read, not modified — with one deliberate exception documented in
[`barpo-ai/README.md`](../barpo-ai/README.md): OpenAI rotates its refresh token,
so the new one is written back, or `codex` in your terminal would stop working
after Barpo's first refresh.

### Checking it worked

```bash
curl -s localhost:8787/api/models | head -c 400
```

`models` lists what was found; `warnings` explains anything that was skipped and
why. `POST /api/models/refresh` re-runs detection without restarting (the result
is cached for the process lifetime — re-checking 38 providers on every message
would be wasteful).

## Your first conversation

1. Pick a model in the picker at the top. The list is ordered by **how it is
   paid for**, not by price: local models first, then subscriptions, then
   API-key models. That ordering matters when one model reaches you both ways —
   `gpt-5.6-luna` over a Codex subscription and over `OPENAI_API_KEY` are the
   same model on two billing channels, and the subscription one has to be the
   one you land on.
2. Type something that needs a tool — "what files are in this folder?" is a good
   first test, because you will see the agent call `ls` rather than guess.
3. **A permission card may appear.** The agent wanted to do something dangerous
   or unfamiliar and has stopped to ask. Three answers: allow once, allow
   always (for this session, and the pattern it remembers is narrow — `git
   push`, not `git`), or deny.
4. The reply streams in as it is generated. Closing the page does not stop it —
   the run continues on the server and the "Agents" page can stop it.

Two things lock once the first message is sent: the **provider** and the
**project**. Each provider stores history in its own format, and the agent may
already have created files in the project folder, so switching either mid-way
would corrupt the conversation. Start a new conversation instead.

### Permission modes

The default is `⏸ confirm` — you are asked about every dangerous action. The
toggle next to the model picker switches to `⏵⏵ auto`, where a small model
judges each action against what you actually asked for. It can turn itself off
(a broken classifier, or repeated blocks) and never turns itself back on.

Details of what "dangerous" means and where the line sits:
[architecture.md](architecture.md#the-security-model).

## Pro mode

The default interface is chat and nothing else. The **PRO MODE** button reveals
the sidebar and the technical pages: agents, servers, the skill store, MCP
servers, schedules, the audit log. Nothing is hidden from you and nothing is
forced on you — if you never run a server, you never see server management.

## Where your data lives

| Path | Contents |
|---|---|
| `barpo-server/data/platform.db` | the database — conversations, audit log, catalogs. Not in git |
| `~/.barpo/work/<sessionId>/` | one working directory per conversation |
| `~/.barpo/projects/<slug>/` | one per project, shared by all its conversations |
| `~/.barpo/apps/<id>/` | published app folders — edit these files directly, that IS the update |
| `~/.barpo/skills-store/` | downloaded skills before they are copied into a project |
| `~/.barpo/config.json` | your settings |
| `~/.barpo/mcp-credentials.json` | MCP secrets, `chmod 600`, never in the database |
| `~/.barpo/ssh/` | the platform's own SSH key and managed config |

Every one of these is relocatable — see [configuration.md](configuration.md).

## When something is wrong

**The model list is empty.** Nothing was detected. Check
`curl -s localhost:8787/api/models` and read `warnings` — it names what was
tried. The most common cause is an env var exported in a different shell from
the one running the server.

**Port 8787 is already in use.** `PORT=9000 bun run dev` in `barpo-server`, and
change the proxy target in `barpo-ui/vite.config.ts` to match.

**Ollama is not detected.** Confirm it answers:
`curl -s localhost:11434/api/tags`. A non-default address goes in `OLLAMA_HOST`.
Detection failing is silent by design — a missing Ollama is not an error.

**The chat starts and ends immediately with no text.** A provider error. It is
reported as `chat.error` with the message; the usual causes are an expired
subscription token or a model your account cannot actually use.

**A conversation says "paused until …".** Not an error: a provider limit was
hit, and the platform has booked a resume for after the reset. It continues on
its own — the Schedules page lists it.

## Where to go next

| | |
|---|---|
| [architecture.md](architecture.md) | how the pieces fit, and the security model |
| [configuration.md](configuration.md) | every env variable and setting |
| [`skills/README.md`](../skills/README.md) | teaching the agent a repeatable procedure |
| [`barpo-server/README.md`](../barpo-server/README.md) | the REST and WebSocket reference |
| [CONTINUE.md](../CONTINUE.md) | the state of the work, and why things are the way they are |
