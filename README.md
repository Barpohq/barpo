# AI Platform — Project documentation

> A self-hosted, open-source AI orchestration platform.
> It began as a Telegram AI news bot; that bot shipped, and the platform grew
> out of it. The bot now lives on as a separate project in `ai-news-bot/`.

---

## Where the code stands

A working backend, AI agent layer and web UI — 1579 tests green.

```bash
bun install
bun test
cd platform-server && bun run src/index.ts   # backend :8787
cd platform-ui && bun run dev                # UI
```

Chat with an agent that reads and writes files, runs commands, connects to MCP
servers and manages real servers over SSH — with a permission layer in front of
every dangerous action. [CONTINUE.md](CONTINUE.md) has the full picture.

## The project in brief

**The problem:** Doing serious work with AI today means juggling several separate tools — Claude, ChatGPT, Gemini, OpenRouter, Claude Code, various deploy services. Each one locks you into its own ecosystem, none of them talk to each other, and the harder jobs (server management, deploys) are still done by hand or through a terminal.

**The solution:** Bring every AI provider, agent, server, and tool together on a single self-hosted platform. You give a high-level instruction through AI chat, and the platform launches whatever tools are needed in the background (Claude Code in a tmux session, for example) and gets the job done.

**Philosophy:**
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
[platform-ai](platform-ai/README.md) (the security model),
[platform-server](platform-server/README.md) (routes, database, WS protocol),
[platform-config](platform-config/README.md),
[platform-ui](platform-ui/README.md), and
[mcp-servers](mcp-servers/README.md).

## Context: where I stand

- 5 servers available, being connected to the platform
- Claude, ChatGPT, and Gemini subscriptions, plus a habit of trying new models through OpenRouter
- The web is my primary working environment
- The first real need — a fully autonomous AI news bot for my Telegram channel — is built and running

## Inspirations and similar projects

- **OpenClaw / Hermes** — the top layer of the agent stack; a model for how open-source projects built by one person for themselves spread
- **MCP (Model Context Protocol)** — the integration standard; rather than inventing our own, we build on what exists
- **Coolify / Dokploy** — the self-hosted server management model, agent-daemon architecture
- **OpenRouter** — a model-agnostic LLM access layer

## Guiding principle

> A platform's right abstractions only emerge from real use.
> The bot is the first "skill". When a second use case appears, the shared patterns will show themselves.
> The platform is not designed top-down — it grows bottom-up.
