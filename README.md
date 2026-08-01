<img src=".github/logo.svg" alt="Barpo" height="32">

> **The program that builds programs.**
> Describe the app you want in a chat — a Telegram bot, a website, a full-stack
> service. Barpo plans it, builds it, ships it, and the new app plugs its own
> dashboard back into Barpo. Deploy to a domain or a port is one choice away,
> built in.

Self-hosted and open source ([Apache-2.0](LICENSE)). Your keys, your servers,
your data.

*The name comes from the Uzbek "barpo qilmoq" — to build, to bring into being.*

---

## Where the code stands

A working backend, AI agent layer and web UI — 1775 tests green.

```bash
bun install
bun test
cd barpo-server && bun run dev            # backend :8787
cd barpo-ui && bun run dev                # UI
```

Chat with an agent that reads and writes files, runs commands, connects to MCP
servers and manages real servers over SSH — with a permission layer in front of
every dangerous action. You will need a model:
[getting started](docs/getting-started.md) covers the three ways to supply one.
[CONTINUE.md](CONTINUE.md) has the full picture of where the work stands.

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

## Documentation

| | |
|---|---|
| [docs/](docs/README.md) | The full index |
| [Getting started](docs/getting-started.md) | Install, connect a model, first conversation |
| [Architecture](docs/architecture.md) | How the pieces fit — and the security model |
| [CONTINUE.md](CONTINUE.md) | **Picking the work back up** — current state, decisions, the twelve invariants |

Each package carries its own README with the implementation detail, and
[CONTRIBUTING.md](CONTRIBUTING.md) has the working rules.

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
