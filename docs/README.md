# Documentation

## Start here

| If you are… | Read |
|---|---|
| **deciding whether this is for you** | the [root README](../README.md), then [vision.md](vision.md) |
| **installing it** | [getting-started.md](getting-started.md) |
| **picking the work back up** | [CONTINUE.md](../CONTINUE.md) — current state, the decisions behind it, the invariants |
| **changing the code** | [architecture.md](architecture.md) for the system view, then the README of the package you are touching |

## Documents

| Document | Contents |
|---|---|
| [getting-started.md](getting-started.md) | requirements, install, connecting a model, your first conversation, and what to do when something is wrong |
| [architecture.md](architecture.md) | how the packages fit together, a chat message end to end, and **the security model** — the decision chain, the untrusted-text boundary, and what is deliberately not solved |
| [configuration.md](configuration.md) | every environment variable and config setting, with defaults; what a project config may not do |
| [vision.md](vision.md) | the target the platform is growing towards. Written before the work began — parts of it are unbuilt, and it says which |
| [risks.md](risks.md) | the strongest arguments against the project and the answers to them, written down before starting |

Two more live at the repository root because that is where GitHub looks for
them: [CONTRIBUTING.md](../CONTRIBUTING.md) and [LICENSE](../LICENSE)
(Apache-2.0).

## Packages

Each package documents its own implementation, next to the code it describes.

| Package | Answers |
|---|---|
| [`barpo-ai`](../barpo-ai/README.md) | How does the agent work? How are providers detected? What exactly does the permission layer check, and how is the classifier kept away from untrusted text? |
| [`barpo-server`](../barpo-server/README.md) | What are the REST endpoints and the WebSocket events? What is in the database, and what does each migration do? |
| [`barpo-ui`](../barpo-ui/README.md) | How is the interface put together? How does an app render its own dashboard without a frontend rebuild? |
| [`barpo-config`](../barpo-config/README.md) | How are settings read and validated? Why can a project config only narrow the boundary? |
| [`barpo-shared`](../barpo-shared/src/protocol.ts) | The types and the WebSocket protocol. Documented in the source — the comment at the top is the procedure for adding an event |
| [`skills/`](../skills/README.md) | What are the built-in skills, and how do you write one? |
| [`mcp-servers/`](../mcp-servers/README.md) | How do you add an MCP server that ships with the platform? |

## Not part of this

`ai-news-bot/` is a separate, finished project — the Telegram AI news bot Barpo
grew out of. It has its own README and its own test suite, and it stays in Uzbek
because it writes for an Uzbek-language channel.
