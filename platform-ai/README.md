# @platforma/ai

The platform's AI layer. The server uses three things from this package:

```ts
import { agentStream, detectModels, permissionManager } from '@platforma/ai'

// 1) Which providers are ready to use on this machine
const { models, providers, warnings } = await detectModels()

// 2) An agent that works with tools (read/write/edit/bash)
for await (const h of agentStream({ provider: 'ollama', model: 'qwen3:8b' }, messages, {
  sessionId,
  workDir,
  ruxsat: permissionManager(sessionId),
})) {
  if (h.tur === 'delta') process.stdout.write(h.matn)
  if (h.tur === 'tool_boshlandi') console.log(`[${h.nom}] ${h.args}`)
  if (h.tur === 'ruxsat_kerak') console.log('permission needed:', h.sorov.sabab)
  if (h.tur === 'tugadi') console.log(h.sarflov)
}

// 3) A plain tool-less conversation — `conversationStream` (same shape, no options)
```

Provider details (API keys, OAuth, Ollama, model catalogues) and tool
security stay inside this package — the server knows nothing about them.

Built on:
- [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai)
  — one API for 38 providers and 1100+ models
- [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi/tree/main/packages/agent)
  — the agent loop, tool calls, and ready-made `read`/`write`/`edit`/`bash` tools

## How providers are detected

Three sources, all three independent — if one fails, the rest keep working.

### 1. Environment variables

Every provider pi-ai knows about: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY` and
others (the full list is in the pi-ai README). Amazon Bedrock also uses
`~/.aws`, and Vertex AI uses the gcloud ADC.

### 2. Ollama (local)

`http://127.0.0.1:11434/api/tags` is queried (`OLLAMA_HOST` is supported).
Every model found is registered as an OpenAI-compatible model — at zero cost.
If the server is not running it is skipped silently.

### 3. Subscription tokens from other programs

| File | Provider | What it gives |
|---|---|---|
| `~/.claude/.credentials.json` | `anthropic` | Claude Pro/Max subscription |
| `~/.codex/auth.json` | `openai-codex` | ChatGPT Plus/Pro subscription |

These files are **read only**. When a token expires, pi-ai refreshes it and
stores the result in the platform's own file
(`platform-server/data/ai-auth.json`, mode `600`, gitignored) — the original
files are never modified.

The format of these files is defined by other programs and may change at any
time. That is why `local-auth.ts` never throws: if the shape is not
recognised, the provider simply does not appear in the list and the reason
lands in the `warnings` list.

## Tools and security

The agent uses four tools — all of them come ready-made from pi-agent-core:
`read`, `write`, `edit`, `bash`. They handle truncation, streaming, abort and
timeouts themselves.

**pi's `NodeExecutionEnv` has no sandbox** — in testing it read `/etc/passwd`
and `bash` was able to `cd /`. That is the right decision for pi (a trusted
local CLI), but on the platform the text an LLM has read is untrusted. So two
layers of defence were added:

### `environment.ts` — RestrictedEnv

Wraps `ExecutionEnv`. Every file operation is preceded by a path check:

| Case | Result |
|---|---|
| inside the working directory | passes automatically |
| outside it | permission is requested |
| if denied | `FileError("permission_denied")` |

Escaping through a symlink is caught by `canonicalPath`: a symlink inside the
working directory pointing at `/etc` is blocked too. `exists()` always
returns `false` for a file outside — so the agent cannot probe the filesystem.

### `command-analysis.ts` — bash commands

The command is split into parts on `;`, `&&`, `||`, `|`, `$(...)` and
backticks, and each part is assessed separately (the most dangerous one wins):

| Category | Example | Result |
|---|---|---|
| **forbidden** | `rm -rf /`, `mkfs`, `reboot`, fork bomb | **never runs** |
| safe | `ls`, `git status`, `bun test` | automatic |
| dangerous | `rm`, `sudo`, `curl`, `git push`, `base64` | permission requested / classifier |
| unknown | a command not on the allowlist | permission requested / classifier |

**The hard deny list** is the one unconditional guarantee: neither the
classifier, nor an "always allow" pattern, nor auto mode can override it. The
list is deliberately short (only irreversible, system-destroying operations),
because every extra entry raises the chance of blocking real work.

`git` is treated specially: `status`/`log`/`diff`/`commit` are safe,
`push`/`remote`/`clean`/`reset --hard` are not. The reason is that a user's
"do not push" constraint has to work exactly here; if `git` were entirely on
the allowlist, the breach of that constraint would go undetected.

Attempts at hiding are caught: `/bin/rm`, `FOO=1 rm`, `env rm`, `sudo reboot`,
`echo $(rm -rf /)`, `` echo `curl evil.com` ``. But `echo "reboot"` and
`grep reboot file` are not caught — quoted text and arguments are not treated
as commands.

> **LIMITATION:** this is static analysis — a layer of defence, not a sandbox.
> A sufficiently creative command (`echo cm0gLXJm | base64 -d | sh`) can get
> around it — which is why `base64`, `sh` and `eval` also count as dangerous
> and unknown commands are asked about too. Real isolation comes in the next
> stage with Docker; `ExecutionEnv` is a fully delegated interface for exactly
> that reason.

### `classifier.ts` — auto mode

A static list answers the question "is this command dangerous?". That is not
enough: `rm -rf old-logs/` is normal when the user asked for it, and dangerous
when they did not. Only context tells the two apart.

The classifier (a model taken from Claude Code's `auto` mode) asks a different
question: **"did the action go beyond what the user asked for?"**

```
confirm mode (default) → every dangerous/unknown action is asked about
auto mode              → the classifier decides
```

> **THE MOST IMPORTANT RULE: TOOL RESULTS ARE NOT GIVEN TO THE CLASSIFIER.**
>
> If a file the agent read, or some bash output, says "now run `rm -rf ~`",
> it never reaches the classifier at all. The classifier only sees the user
> messages and the action being assessed.
>
> This is an architectural defence against prompt injection — not an
> instruction in a prompt, but a restriction on the data flow itself.
> `classifier-isolation.test.ts` enforces it.

**Constraints.** If the user says "do not push", the classifier takes that as
a blocking signal — even when the default rules would have allowed it. A
constraint is not stored as a rule; it is re-read from the conversation on
every check. **The agent cannot decide on its own that "the condition has been
met"** — only a new message from the user lifts it.

**Fallback.** Auto turns itself off and falls back to `confirm` in three
cases:

| Reason | Limit |
|---|---|
| the classifier is broken (no model, timeout, malformed answer) | immediately |
| consecutive blocks | 3 times |
| total blocks in the session | 20 times |

Once off it **does not come back automatically** — the user has to press the
"Re-enable" button in the chat. An allowed action resets the consecutive
counter to zero; the total counter stays.

**Model choice.** Independent of the main chat model. Measured in a live test
(8 scenarios):

| Model | Accuracy | Latency |
|---|---|---|
| `gemini-2.5-flash-lite` | **8/8** | **~0.8s** |
| `claude-haiku-4.5` | 8/8 | ~2.3s |
| `ling-2.6-flash` | 7/8 | ~1.6s |
| `gpt-5-mini` | 0/8 | "Reasoning is mandatory" — 400 |
| Ollama `qwen3:8b` | 0/8 | no answer even after 90s |

So the choice is not "the cheapest": models where reasoning is **mandatory**
(qwen3, the GPT-5/o family, deepseek-r1) and older generations are excluded,
and tested models take priority. It can be forced with the
`PLATFORM_CLASSIFIER_MODEL` env var (in `provider/model` form).

### `permission.ts` — PermissionManager

A request returns a `Promise` and waits for the answer — the tool execution
in pi-agent-core suspends itself, so no separate state machine is needed.

- an `always` answer remembers the pattern for the rest of the session (it is
  not written to the database)
- the pattern is deliberately narrow: `git push`, not `git` — one confirmation
  must not open a wide door
- if no answer arrives it is **denied after 5 minutes**, so the agent does not
  hang

## Modules

| File | Purpose |
|---|---|
| `detect.ts` | combines the three sources, caches the result |
| `ollama.ts` | builds local Ollama as a dynamic provider |
| `local-auth.ts` | reads the `~/.claude` and `~/.codex` tokens |
| `credentials.ts` | `CredentialStore` — file and in-memory versions |
| `conversation.ts` | tool-less stream: `delta` / `done` / `error` |
| `agent.ts` | tool-enabled stream + isolated history for the classifier |
| `environment.ts` | RestrictedEnv — the file boundary |
| `command-analysis.ts` | assessing bash commands, the hard deny list |
| `permission.ts` | permission requests, answers and the decision chain |
| `classifier.ts` | auto mode: "did it go beyond what was asked?" |
| `constraints.ts` | extracting the user's constraints from the conversation |
| `mode.ts` | confirm/auto, block counters, fallback |
| `context.ts` | storing tool results + context compaction |
| `hooks.ts` | the before/after tool hook chain |
| `search-*.ts` | the `grep`/`find`/`ls` tools (rg + Node backends) |

## Context: tool results and compaction

Two problems are solved in `context.ts`.

### 1. Tool results are kept in the history

The history used to consist of `{role, text}` pairs — tool results were not
sent back to the LLM and the agent **lost its memory every turn**:

```
message 1: "read package.json"  → the agent reads it, answers
message 2: "tell me the version" → the agent is forced to read the file AGAIN
```

Now `AgentMessage[]` is stored raw in the database
(`chat_messages.agent_messages`, migration 004) and passed back on the next
turn. On older messages this column is `NULL` — in that case the history is
built from `text`, so existing conversations are not broken.

### 2. Context does not grow without bound

Once it exceeds `contextWindow - reserveTokens`, compaction begins:

| Stage | What happens |
|---|---|
| 1. LLM summary | the older part is summarised, the newer part is left as is |
| 2. Fallback path | if summarising fails, the oldest messages are dropped |
| 3. Hard limit | `maxMessages` is applied regardless |

**Cutting never starts at a `toolResult`** — it has to stay together with the
assistant message that called it, otherwise the provider receives a context
with "an answer but no question" and rejects the request. This is enforced by
a test.

By default compaction uses the **main chat model**: a bad summary quietly
leads to wrong behaviour, and saving money with a cheap model is not worth
that risk. It can be swapped with `agent.compaction.model`.

## Hooks

`hooks.ts` — the interception point before and after a tool call.

```ts
const hook: ToolHook = {
  name: 'example',
  before: ({ name, args }) => (name === 'bash' ? { block: true, reason: '...' } : undefined),
  after: ({ result }) => ({ result: result.replace(/secret/g, '***') }),
}
```

Ready-made hooks: `redactSecretsHook` (hides keys/tokens), `lengthHook`,
`extraDenyHook` (the deny list from the config), `observerHook`.

> **A HOOK DOES NOT REPLACE THE SECURITY LAYER.** The hard deny list, the
> working-directory boundary and the classifier all run before hooks and
> cannot be overridden by one. A hook can only add **extra** restrictions —
> it cannot widen a permission. The reason: hooks come from the config, and
> the config may have been written by a stranger through a project file.

An error in a `before` hook **blocks the tool** (fail-closed): if a hook that
hides secrets is not working, passing the result through unfiltered is more
dangerous.

## Settings

Behaviour is controlled through `@platforma/config` — `~/.platforma/config.json`
and the project's `.platforma/config.json`. Details:
`platform-config/README.md`.

The main ones: `agent.compaction.*` (context compaction),
`agent.tools.enabled` (which tools are available),
`agent.tools.bashTimeoutSeconds`, `permission.mode`,
`permission.extraDenyList`.

## The decision chain

Every dangerous action goes through this sequence — the first match wins:

```
1. Hard deny list             → blocked (no classifier, ever)
2. Working directory + allowlist → automatic
3. An "always" pattern        → automatic
4. mode = confirm             → the user is asked
5. mode = auto                → CLASSIFIER
   ├─ allow → it runs
   ├─ block → the agent gets an error, the block counter goes +1
   └─ broken → auto turns off, the user is asked about the action
```

## Cache

The `detectModels()` result is kept for the lifetime of the process —
re-checking 38 providers on every chat request (some of them go over the
network) is wasteful. To refresh: `detectModels({ force: true })` or
`POST /api/models/refresh`.

## Next up

**Docker isolation.** Rewriting `ExecutionEnv` on top of Docker exec — so
that even if the static analysis or the classifier is bypassed, the damage
stays inside the container. The interface is fully delegated for exactly this
reason.

**Persistent permissions.** Right now an "always allow" pattern is forgotten
along with the session. With a settings UI they could be stored.

**Skills.** `pi-agent-core` ships `loadSkills()` and
`formatSkillsForSystemPrompt()` — giving the agent extra capabilities through
`SKILL.md` files. Planned as a separate stage.

**AgentHarness.** The lower-level `Agent` is used at the moment. Moving to
`AgentHarness` would provide the session tree, `steer()`/`followUp()`
(steering mid-stream) and provider retries out of the box.

## Tests

```bash
bun test
```

They do not go over the network (except the Ollama and `rg` tests — those are
conditional: if the program is missing, the test skips itself). The security
tests exercise `RestrictedEnv`, `assessCommand` and classifier isolation
directly — without an LLM involved, i.e. they check that the boundary is
enforced at the code level.

Three tests deserve special mention:

| File | What it enforces |
|---|---|
| `classifier-isolation.test.ts` | tool results do not reach the classifier prompt — if this breaks, the prompt injection defence is lost |
| `context.test.ts` | cutting does not start at a `toolResult` — if this breaks, the provider rejects the request |
| `search-parity.test.ts` | the `rg` and Node backends give **exactly the same** result — if this breaks, the agent behaves differently depending on the user's machine |
