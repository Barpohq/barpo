<img src=".github/logo.svg" alt="Barpo" height="32">

> **The program that builds programs.**
> Describe the app you want in a chat — a Telegram bot, a website, a full-stack
> service. Barpo plans it, builds it, ships it, and the new app plugs its own
> dashboard back into Barpo. Deploy to a domain or a port is one choice away,
> built in.

Self-hosted and open source. Your keys, your servers, your data.

*The name comes from the Uzbek "barpo qilmoq" — to build, to bring into being.*

---

## Where the code stands

A working backend, AI agent layer and web UI — 1775 tests green.

```bash
bun install
bun test
cd barpo-server && bun run src/index.ts   # backend :8787
cd barpo-ui && bun run dev                # UI
```

Chat with an agent that reads and writes files, runs commands, connects to MCP
servers and manages real servers over SSH — with a permission layer in front of
every dangerous action. [CONTINUE.md](CONTINUE.md) has the full picture.

## What makes Barpo different

- **Apps are the output, not chat logs.** You order an app; Barpo builds a real
  project with real code and runs it.
- **Every built app gets its own dashboard.** Apps describe their UI as a
  widget manifest (stats, tables, logs, deploy, git) and Barpo renders it —
  no frontend rebuild, no iframes.
- **Deploy is a built-in extra, not a separate product.** Domain or port,
  chosen in the same conversation.
- **Git-first.** Every change the AI makes is a commit; rollback is always
  available.
- **Security is part of the design.** The AI is never handed a password, every
  dangerous action passes a permission layer, everything lands in an
  append-only audit log.
- **Any AI provider.** 38 providers through one chat; keys come from your
  environment, never leave your machine.
- **A time layer.** Scheduled runs, cron tasks, and automatic resume when a
  provider limit cuts a conversation short.

## Philosophy

- Build it for myself first — abstractions are born out of real needs, not invented up front
- Open source and self-hosted — no vendor lock-in, my data stays on my server
- Bottom-up — first a concrete working solution (the bot), then let the platform grow out of it
- Progressive disclosure — a casual user never sees the complexity, a power user can reach everything
- Security is part of the design — the AI is never handed a password, every action has a permission level, everything lands in the audit log

## Documentation map

| File | Contents |
|---|---|
| [CONTINUE.md](CONTINUE.md) | **Start here to pick the work back up** — current state, what is built, the boundaries that must not be broken |
| [02-ai-platform.md](02-ai-platform.md) | The vision: bot-to-platform evolution, modules, architecture |
| [04-risks.md](04-risks.md) | Critical analysis: risks, weak points, and mitigation strategies |

Each package carries its own README with the implementation detail —
[barpo-ai](barpo-ai/README.md) (the security model),
[barpo-server](barpo-server/README.md) (routes, database, WS protocol),
[barpo-config](barpo-config/README.md),
[barpo-ui](barpo-ui/README.md), and
[mcp-servers](mcp-servers/README.md).

## History and inspirations

Barpo began as a Telegram AI news bot; that bot shipped, and the platform grew
out of it. The bot now lives on as a separate project in `ai-news-bot/`.

- **OpenClaw / Hermes** — the top layer of the agent stack; a model for how open-source projects built by one person for themselves spread
- **MCP (Model Context Protocol)** — the integration standard; rather than inventing our own, we build on what exists
- **Coolify / Dokploy** — the self-hosted server management model, agent-daemon architecture
- **OpenRouter** — a model-agnostic LLM access layer

## Guiding principle

> A platform's right abstractions only emerge from real use.
> The bot is the first "skill". When a second use case appears, the shared patterns will show themselves.
> The platform is not designed top-down — it grows bottom-up.
