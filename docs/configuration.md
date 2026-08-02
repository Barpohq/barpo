# Configuration

Two ways to change how Barpo behaves: **environment variables** (where things
live, which ports and paths) and a **JSON config file** (how the agent behaves,
what it is allowed to do).

Neither is required. With no env vars and no config file at all, the platform
starts with working defaults.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | the port Bun.serve listens on — REST and WebSocket share it |
| `DB_PATH` | `barpo-server/data/platform.db` | the SQLite file. Created on first start, along with its folder |
| `PLATFORM_WORKS` | `~/.barpo/work` | per-session working directories |
| `PLATFORM_PROJECTS` | `~/.barpo/projects` | per-project working directories |
| `PLATFORM_APPS` | `~/.barpo/apps` | published app folders |
| `PLATFORM_SKILLS` | `~/.barpo/skills-store` | the skill store — downloaded skills before they are copied into a project |
| `PLATFORM_CONFIG_DIR` | `~/.barpo` | where the global `config.json` is read from |
| `PLATFORM_MCP_CREDENTIALS` | `~/.barpo/mcp-credentials.json` | MCP secret values. A separate `chmod 600` file, never the database |
| `PLATFORM_SSH` | `~/.barpo/ssh` | the platform's own SSH key, config and `known_hosts` |
| `PLATFORM_USER_SSH_CONFIG` | `~/.ssh/config` | the user's ssh config, which the managed one is included from |
| `PLATFORM_CLASSIFIER_MODEL` | — | forces the classifier's model, as `provider/model`. Wins over the config setting |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | a local Ollama. The scheme may be omitted (`localhost:11434` works) |

Every `PLATFORM_*` path variable exists so the tests can point a root at a
temporary directory, but they work the same way in production.

### Provider API keys

There is no list to configure — `@barpo/ai` asks pi-ai which providers it knows
and looks for each one's own variable:

```sh
export ANTHROPIC_API_KEY=...       # Claude
export OPENAI_API_KEY=...          # OpenAI
export OPENROUTER_API_KEY=...      # OpenRouter (many models behind one key)
export GEMINI_API_KEY=...          # Google
export GROQ_API_KEY=...            # Groq
export XAI_API_KEY=...             # xAI
```

…and so on for the rest of pi-ai's 38 providers. Amazon Bedrock reads `~/.aws`
and Vertex AI uses the gcloud ADC instead of a key.

Detection is one of three independent routes — the others are a local Ollama and
the subscription tokens of programs already installed (`~/.claude`, `~/.codex`).
[getting-started.md](getting-started.md) covers picking one.

### Why the prefix still says `PLATFORM_`

The project's working title was "platforma". The rebrand to Barpo moved the
package scope, the directories and the user data path (`~/.platforma` →
`~/.barpo`), and migration 018 rewrote the identifiers stored in the database.
The env variables were **deliberately left alone**.

Renaming an env var is not like renaming a folder. Nothing errors: the platform
simply stops seeing the value, silently falls back to its default, and starts
looking at an empty directory — which to the user reads as "it lost my data".
Every existing install would hit that on the upgrade, and a compatibility
fallback reading both names would have to stay forever to prevent it.

So this is recorded as known drift rather than fixed by drift. If it is ever
changed, it needs both names honoured for a release and a note in the changelog
— not a quiet rename.

## The config file

Two layers, the upper overriding the lower:

| Layer | Path | Purpose |
|---|---|---|
| global | `~/.barpo/config.json` | the user's usual settings |
| project | `<work dir>/.barpo/config.json` | a restriction for this one job |

`barpo-config/example-config.json` holds every setting at its default value, and
`schema.json` next to it gives editors autocompletion:

```json
{ "$schema": "https://raw.githubusercontent.com/Barpohq/barpo/main/barpo-config/schema.json" }
```

### The settings worth knowing

| Setting | Default | Effect |
|---|---|---|
| `permission.mode` | `confirm` | `confirm` asks about every dangerous action; `auto` lets the classifier decide |
| `permission.waitSeconds` | `300` | how long a permission request waits before it is denied |
| `permission.classifierModel` | `null` | pins the classifier model as `provider/model` |
| `permission.extraDenyList` | `[]` | commands to refuse on top of the built-in hard deny list |
| `permission.consecutiveBlockLimit` | `3` | consecutive blocks before auto mode switches itself off |
| `permission.totalBlockLimit` | `20` | blocks in one session before the same |
| `agent.tools.enabled` | 13 tools | which tools exist. A tool removed from the list is **invisible** — the agent is not told it exists |
| `agent.tools.bashTimeoutSeconds` | `120` | how long one command may run |
| `agent.history.maxMessages` | `200` | the hard cap on history length |
| `agent.compaction.enabled` | `true` | summarise old context instead of dropping it |
| `agent.compaction.model` | `null` | which model summarises. `null` means the main chat model — a bad summary quietly causes wrong behaviour, so saving money here is not worth the risk |
| `mcp.connectTimeoutSeconds` | `10` | starting an MCP server |
| `mcp.callTimeoutSeconds` | `30` | one MCP tool call |
| `chat.attachment.maxFileMb` | `20` | per attached file |
| `session.idleMinutes` | `60` | **not wired up yet** — see below |

Removing a tool from `agent.tools.enabled` is how a capability is taken away
entirely. Note that `appDelete` and the three `schedule*` tools are on by
**default**: neither acts on its own, both ask first, and `appDelete` uniquely
cannot be answered by auto mode or a stored "always".

> **`session.idleMinutes` currently does nothing.** The setting is defined and
> validated, but nothing reads it: the actual cleanup runs on
> `REGISTRY_TTL_MS`, a hard-coded **30 minutes** in `barpo-ai/src/registry.ts`.
> Changing the setting will not move that. What gets collected is only
> session-scoped temporary state — pending permission requests, "always"
> patterns, block counters, the permission mode — so the visible effect of a
> collection is that a long-idle conversation returns to default settings. The
> conversation itself lives in SQLite and is untouched.

### What a project config cannot do

A project file ships with the repo, which means someone else may have written
it. It can never **lower** the security boundary:

| Setting | What the project file may do |
|---|---|
| `permission.mode` | only lower to `confirm`, never raise to `auto` |
| `permission.extraDenyList` | only add entries, never remove them |
| `agent.tools.enabled` | only narrow the list, never widen it |
| everything else | override freely — not security-relevant |

Enforced in `applyProjectRestriction()` and covered by tests.

### Errors never stop the platform

| Case | Result |
|---|---|
| no file | defaults, no warning |
| malformed JSON | defaults + a warning |
| wrong type (`"yes"` instead of `true`) | the default + a warning |
| a number outside its range | **clamped** into range + a warning |
| a bad element in a list | that element dropped, the rest kept |
| an unknown field (a typo) | ignored + a warning |

A number out of range is clamped rather than reset: the intent is clear ("I
wanted it bigger"), so it is brought to the nearest legal value instead of
silently reverting to something much smaller.

Warnings come back in a `warnings` list — the server logs them.

Adding a setting is one line in `FIELDS`; see
[`barpo-config/README.md`](../barpo-config/README.md).
