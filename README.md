# AI Platform — Project documentation

> A self-hosted, open-source AI orchestration platform.
> Stage 1: a Telegram AI news bot. Stage 2: evolving that bot into a general-purpose platform.

---

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
| [01-telegram-bot.md](01-telegram-bot.md) | Stage one: the full specification and architecture of the AI news bot |
| [02-ai-platform.md](02-ai-platform.md) | Stage two: bot-to-platform evolution, modules, architecture |
| [03-roadmap.md](03-roadmap.md) | Phase-by-phase plan and success criteria |
| [04-risks.md](04-risks.md) | Critical analysis: risks, weak points, and mitigation strategies |

## Context: where I stand

- 5 servers available, to be connected to the platform
- Claude, ChatGPT, and Gemini subscriptions, plus a habit of trying new models through OpenRouter
- The web is my primary working environment
- First real need: a fully autonomous AI news bot for my Telegram channel

## Inspirations and similar projects

- **OpenClaw / Hermes** — the top layer of the agent stack; a model for how open-source projects built by one person for themselves spread
- **MCP (Model Context Protocol)** — the integration standard; rather than inventing our own, we build on what exists
- **Coolify / Dokploy** — the self-hosted server management model, agent-daemon architecture
- **OpenRouter** — a model-agnostic LLM access layer

## Guiding principle

> A platform's right abstractions only emerge from real use.
> The bot is the first "skill". When a second use case appears, the shared patterns will show themselves.
> The platform is not designed top-down — it grows bottom-up.
