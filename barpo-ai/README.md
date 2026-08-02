# @barpo/ai

The platform's AI layer. Everything the server needs to run a chat that can
actually do work — provider detection, the tool-using agent loop, and the
security layer that decides what the agent is allowed to do.

```ts
import { agentStream, detectModels, permissionManager, modeManager } from '@barpo/ai'

// 1) Which providers are ready to use on this machine
const { models, providers, warnings } = await detectModels()

// 2) An agent that works with tools (read/write/edit/grep/find/ls/bash)
for await (const event of agentStream(
  { provider: 'ollama', model: 'qwen3:8b' },
  messages,
  {
    sessionId,
    workDir,
    permission: permissionManager(sessionId),
    mode: modeManager(sessionId),
  },
)) {
  switch (event.kind) {
    case 'delta':
      process.stdout.write(event.text)
      break
    case 'tool_start':
      console.log(`[${event.name}] ${event.args}`)
      break
    case 'permission_required':
      console.log('permission needed:', event.request.reason)
      break
    case 'done':
      // `event.messages` is the full context WITH TOOL RESULTS — store it and
      // pass it back on the next turn, or the agent forgets what it read
      console.log(event.usage, event.contextTokens)
      break
  }
}

// 3) A plain tool-less conversation — `conversationStream` (delta/done/error only)
```

`agentStream` never throws: a problem comes back as `{ kind: 'error' }`.

Provider details (API keys, OAuth, Ollama, model catalogues), tool security and
the MCP client all stay inside this package — the server knows nothing about
them.

Built on:
- [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai)
  — one API for 38 providers and 1100+ models
- [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi/tree/main/packages/agent)
  — the agent loop, tool calls, and ready-made `read`/`write`/`edit`/`bash` tools

The security model this package implements is described from the system's point
of view in [`docs/architecture.md`](../docs/architecture.md); what follows is
how it is built.

## File map

```
agent.ts            — the agent stream: prompt assembly, tools, cleanup
conversation.ts     — the tool-free stream (delta/done/error only)
context.ts          — history with tool results, and compaction
detect.ts           — which providers are usable on this machine
ollama.ts           — the local Ollama probe
local-auth.ts       — reading ~/.claude and ~/.codex subscription tokens
source-sync.ts      — writing a rotated OpenAI refresh token back
credentials.ts      — the platform's own token store (600, gitignored)

environment.ts      — RestrictedEnv: the working-directory boundary
command-analysis.ts — assessing a bash command, part by part
permission.ts       — PermissionManager: asking, remembering, timing out
classifier.ts       — auto mode's "did this go beyond what was asked?"
constraints.ts      — user constraints re-read from the conversation
mode.ts             — ModeManager: confirm/auto, block counters, fallback
registry.ts         — TTL + LRU for the per-session managers
hooks.ts            — before/after interception around a tool call

search-tools.ts     — the grep/find/ls tools
search-engine.ts    — backend selection: rg when present, Node otherwise
search-core.ts      — the shared matching logic both backends run
server-tools.ts     · dashboard-tools.ts · schedule-tools.ts — injected tools

mcp-protocol.ts · mcp-transport.ts · mcp-client.ts
mcp-manager.ts  · mcp-tools.ts     — the MCP client (see below)

project-context.ts  — AGENTS.md / CLAUDE.md
skill-load.ts · skill-file.ts — skills and their frontmatter
memory.ts           — the agent's own notes
git-state.ts        — the working directory's git situation, read from files
presence-prompt.ts  — the other conversations sharing a project directory
```

## What the caller supplies

`AgentOptions` is more than a session id and a working directory. Seven of its
fields are **inversions**: the data lives in `barpo-server`'s SQLite, but
this package does not depend on the server — so the server hands in a function
instead.

| Option | What it does |
|---|---|
| `permission` | the `PermissionManager` for the session — files, commands and MCP calls all share it |
| `mode` | the `ModeManager` — `confirm`/`auto`, block counters, fallback. Without it, confirm mode |
| `config` | `@barpo/config` settings. Defaults are used if omitted |
| `classifierHistory` | the TEXT-ONLY history for the classifier — better supplied by the caller (two layers instead of one) |
| `serverProvider` | ↩ the SSH servers connected to the platform → the `serverList` tool |
| `dashboardSink` | ↩ where a published app manifest is stored → the `appPublish` tool |
| `dashboardRemover` | ↩ how an app is erased → the `appDelete` tool |
| `scheduleSink` | ↩ where a new schedule is written → the `scheduleCreate` tool |
| `scheduleLister` | ↩ the schedules that exist → the `scheduleList` tool |
| `scheduleRemover` | ↩ how a schedule is removed → the `scheduleDelete` tool |
| `mcpProvider` | ↩ which MCP servers to connect for this session → the `mcp__*` tools |
| `toolObserver` | called before every tool call, for the audit log. Does not block |
| `hooks` | extra hooks, appended to the ones from the config |
| `gitState` | the work directory's git situation → the situational git rules in the prompt. The ONE option with a fallback: derivable from the directory, so if omitted it is read here |
| `presence` | ↩ the other conversations sharing the project directory → the presence section in the prompt. Empty or omitted = not a word about it |

**A provider that is not given means the tool is not declared at all** — and the
system prompt does not mention it either. The prompt flags are derived from the
tool list that was actually built, so the two cannot drift apart into
"instructions about a tool that is not there".

`barpo-server/src/orchestrator.ts` is the real caller and uses every one of
these.

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

These files are **read only** — with one deliberate exception. When a token
expires, pi-ai refreshes it and stores the result in the platform's own file
(`barpo-server/data/ai-auth.json`, mode `600`, gitignored).

The exception is `source-sync.ts`. OpenAI **rotates** the refresh token: a
refresh returns a new one and revokes the old, so if we only ever read
`~/.codex/auth.json`, the token there would be dead after our first refresh and
`codex` would stop starting in the terminal. So the new token is written back —
carefully: only specific fields inside `tokens.*` are touched, the write is
atomic (temp file + rename, so Codex never sees a half-written file), the mode
stays `600`, and a missing file is **not** created. It never throws.

The format of these files is defined by other programs and may change at any
time. That is why `local-auth.ts` never throws: if the shape is not
recognised, the provider simply does not appear in the list and the reason
lands in the `warnings` list.

## Tools

| Tool | Source | Permission |
|---|---|---|
| `read` `write` `edit` `bash` | pi-agent-core | via `RestrictedEnv` |
| `grep` `find` `ls` | `search-tools.ts` | none — but working directory only |
| `serverList` | `server-tools.ts` | none — read-only |
| `appPublish` | `dashboard-tools.ts` | none — the user asked for it |
| `appDelete` | `dashboard-tools.ts` | always, and **only a human answers** (`requireUser`) |
| `scheduleCreate` `scheduleDelete` | `schedule-tools.ts` | always, but auto mode may answer |
| `scheduleList` | `schedule-tools.ts` | none — read-only |
| `mcp__<server>__<tool>` | `mcp-tools.ts` | always, via `McpManager.call()` |

`appDelete` is the one tool that refuses an automated answer: `requireUser`
skips auto mode AND any stored "always", so an app disappears only when a human
said so, every time. The schedule tools deliberately do NOT use it — a schedule
is reversible and destroys nothing, so demanding a human answer even in auto
mode would be permission fatigue.

A tool disabled in `agent.tools.enabled` is **not declared at all** — better
than "I will refuse if you call it", because the model does not waste turns
retrying a capability that is not there.

Tools run **sequentially** (`toolExecution: 'sequential'`). In testing, parallel
mode had `write` and `read` going at the same time and `read` hit an ENOENT on a
file that was still being written.

**Why `grep`/`find`/`ls` exist when `bash` could do it.** Searching through
`bash` goes through `command-analysis.ts` and asks for permission in many cases
(a pattern containing `/`, a command off the allowlist). But searching is by
nature a read operation. Waking the user for every `grep` is permission fatigue
— the user learns to press "yes" without reading, and waves through a genuinely
dangerous request too. So these three ask nothing, **but never look outside the
working directory**: a path outside comes back as `BoundaryError`, with no
permission prompt offered. If the user really wants to search outside, `bash` is
there and the full permission mechanism applies. The paths they emit are always
relative — an absolute path is never disclosed.

## Security

**pi's `NodeExecutionEnv` has no sandbox** — in testing it read `/etc/passwd`
and `bash` was able to `cd /`. That is the right decision for pi (a trusted
local CLI), but on the platform the text an LLM has read is untrusted. So
several layers of defence were added.

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

The check is **inside the method**, not in the caller — a tool cannot route
around it.

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

> **THE MOST IMPORTANT RULE: UNTRUSTED TEXT IS NOT GIVEN TO THE CLASSIFIER.**
>
> If a file the agent read, or some bash output, says "now run `rm -rf ~`",
> it never reaches the classifier at all. The classifier only sees the user
> messages and the action being assessed.
>
> This is an architectural defence against prompt injection — not an
> instruction in a prompt, but a restriction on the data flow itself.
> `assessAction` builds its prompt from `CLASSIFIER_PROMPT` + `requestToText()`
> and nothing else, so there is no code path for the other text to arrive by.

The boundary covers **four** sources, and each one carries a different risk:

| Source | Why it is untrusted |
|---|---|
| tool results | a file the agent read, or bash output |
| `AGENTS.md`/`CLAUDE.md` | may have arrived with a cloned repo, not written by the user |
| skill descriptions | come from a **foreign GitHub repo** — purely untrusted input |
| memory files | **time-delayed injection**: the agent reads a foreign file that says "write this to memory", copies it, and it comes back through the prompt in the next session |

The first is enforced by `classifier-isolation.test.ts`, the last by
`memory-isolation.test.ts`.

Attachment file names take the same care. The note listing attached files is
appended to the **prompt**, never written to `chat_messages.text` — because the
classifier reads exactly that column, so a file name landing there would be an
injection vector reaching a permission decision. The name is already sanitised
upstream (`workdir.ts`), and this is the second layer.

**Constraints.** If the user says "do not push", the classifier takes that as
a blocking signal — even when the default rules would have allowed it. A
constraint is not stored as a rule; it is re-read from the conversation on
every check (`constraints.ts`). **The agent cannot decide on its own that "the
condition has been met"** — only a new message from the user lifts it.

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

**Model choice.** The classifier runs on its own model, chosen independently of
the main chat model — but not independently of its PROVIDER.

> **THE CLASSIFIER FOLLOWS THE CHAT'S PROVIDER.** This is the rule that matters
> most here, and it was learned the hard way.
>
> Selection used to run over every detected model and take the cheapest-looking
> one, wherever it lived. On an account whose chat runs on a Codex
> **subscription**, that meant picking `openai/gpt-4.1-nano` — a paid API model
> on a different billing channel. The chat worked fine; the classifier answered
> "You have no credits remaining", auto mode shut itself off, and a scheduled
> run died with it. Everything the user could see was configured correctly.
>
> The provider a conversation already uses is known to be reachable and paid
> for. Starting the search there removes a whole class of failure that is
> invisible from the UI.

`pickClassifierModel()` takes the first that applies:

1. the `PLATFORM_CLASSIFIER_MODEL` env var — forced, for working around a
   temporary failure
2. `permission.classifierModel` from the config — the user's permanent choice
3. `CLASSIFIER_BY_PROVIDER`, **for the chat's provider**
4. the heuristic, restricted to the chat's provider
5. the heuristic over every provider — the last resort, so auto mode still
   works when the chat's provider has nothing suitable (a local Ollama holding
   only `qwen3`, for instance)

Env ranks above config because env is the temporary workaround and config is
the permanent setting. Both take `provider/model` form.

**The table is written down rather than guessed**, because a model's name
predicts neither its latency nor its price. Measured: `gpt-5.4` 2.9s against
`gpt-5.4-mini` 4.1s — the "mini" is the slower one. Priced: `gpt-5.6-luna`
$0.20/$1.20 against `gpt-5.4` $2.50/$15.00 — 12× the cost for 1.6s. Price wins,
because the classifier runs before every dangerous tool call.

| Provider | First choice | Why |
|---|---|---|
| `openai-codex` | `gpt-5.6-luna` | cheapest capable in the family by a wide margin. `gpt-5.3-codex-spark` is deliberately absent — the catalogue lists it, the API refuses it |
| `anthropic` | **`claude-sonnet-5`** | see below |
| `google` | `gemini-2.5-flash-lite` | 8/8 at ~1.3s, the fastest thing measured anywhere |
| `openrouter` | `anthropic/claude-sonnet-5` | known-good models named explicitly rather than trusting the proxy's own ordering |
| `openai` | `gpt-4.1-nano` | cheapest capable on the paid API |

Entries are ORDERED and second choices exist on purpose: a provider exposes
different models to different plans, so the first name may simply not be on this
account.

**Anthropic is a deliberate exception to "cheapest capable" — Sonnet, not
Haiku.** The classifier makes a SECURITY decision; it is the only thing standing
between an agent running unattended and a destructive command. Haiku 4.5 scored
8/8 on the original scenarios, but those are the easy ones to get right — the
expensive mistake is the subtle prompt injection nobody wrote a test for. Paying
more per check is the right trade for the one call allowed to say "no".

The original 8-scenario measurements, which set the shape of the heuristic:

| Model | Accuracy | Latency |
|---|---|---|
| `gemini-2.5-flash-lite` | **8/8** | **~0.8s** |
| `claude-haiku-4.5` | 8/8 | ~2.3s |
| `ling-2.6-flash` | 7/8 | ~1.6s |
| `gpt-5-mini` | 0/8 | "Reasoning is mandatory" — 400 |
| Ollama `qwen3:8b` | 0/8 | no answer even after 90s |

So "the cheapest" was never a sufficient criterion: free is worthless if the
model cannot answer. Models where reasoning is **mandatory** (qwen3, the GPT-5/o
family, deepseek-r1) and older generations are excluded from the heuristic. The
`gpt-5` exclusion is matched as `(^|/)gpt-5(-|$)` rather than `\bgpt-5`, which
had swallowed the entire later family and left a Codex-only account with no
candidate at all.

### `permission.ts` — PermissionManager

A request returns a `Promise` and waits for the answer — the tool execution
in pi-agent-core suspends itself, so no separate state machine is needed.

- an `always` answer remembers the pattern for the rest of the session (it is
  not written to the database)
- the pattern is deliberately narrow: `git push`, not `git` — one confirmation
  must not open a wide door
- if no answer arrives it is **denied after 5 minutes**, so the agent does not
  hang

There are three kinds of request — `file`, `command` and `mcp` — and one
manager handles all three. The kind matters to the classifier: an MCP call is
neither a file nor a local command, and its effect is invisible in the local
file system, so looking for command text in it would only confuse the model.

Every resolution reports **where the decision came from** (`PermissionOrigin`):
`always`, `auto`, `auto-block`, `user`, `user-always`, `denied`, `timeout`,
`cancelled`, `forbidden`. This arrives as a separate `permission_decision`
event, because `ask()` only ever returned `allow`/`deny` and the answer to "why
did this command run?" was stored nowhere. `cancelled` and `denied` are kept
apart deliberately: in the first the user stopped the whole reply, in the second
they rejected this specific action — showing both as "you denied this" would be
a lie.

### The decision chain

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

## MCP (Model Context Protocol)

The agent can use tools from third-party MCP servers — over `stdio` (a local
`npx`/`uvx`/`docker` process) or `http`.

The layer is off unless it is used: if `mcpProvider` is absent **or returns an
empty list**, no manager is created, no tool is declared, and the prompt does
not mention MCP at all. So there is deliberately **no "MCP enabled" config
flag** — installing a server is itself the control. Adding a flag on top would
only drop the user into the "I installed it, why isn't it working" state.

| File | Role |
|---|---|
| `mcp-protocol.ts` | the JSON-RPC shapes — only the `tools/*` part we need |
| `mcp-transport.ts` | how bytes move: stdio process, HTTP/SSE |
| `mcp-client.ts` | one connection: handshake, `tools/list`, `tools/call` |
| `mcp-manager.ts` | several servers as one tool list — **and the permission gate** |
| `mcp-tools.ts` | declaring those tools to the agent |

**Permission lives in `McpManager.call()`, not in the tool wrapper.** The rule
is the same one `RestrictedEnv` follows: the check goes *inside* the method the
tool must call, so there is no way to route around it. A hook would not do — a
hook can only add extra restrictions and cannot *ask*, so an MCP tool guarded by
a hook would mean "it runs first, then its result is filtered", which
contradicts the platform's principle that a dangerous action is asked about
beforehand. Arguments shown in the request are passed through the same
`redactSecrets` filter the hooks use, so a token passed as an argument does not
reach the screen or the audit log.

**One broken server does not break the session.** `McpClient` is independent:
its failure comes back as an `Error`, `McpManager` marks that server as not
working, and the rest carry on. The user must not lose a chat because one server
failed to start.

**Tool names are prefixed** — `mcp__<server>__<tool>`. Two servers may well both
offer a `search`, and without the prefix the model could not say which one it
called. Registry names are reverse-DNS (`io.github.owner/repo`), so `.` and `/`
are replaced with `_`.

**No shell is ever used.** `Bun.spawn(argv)` takes an argv *array*, so text like
`;rm -rf ~` inside an argument stays a plain string. This is the MCP spec's own
recommendation. Registry placeholders (`{token}`) are substituted with
`String.replace` inside that array and never go near a shell. Env keys that
alter process behaviour (`LD_PRELOAD`, `BASH_ENV`, `NODE_OPTIONS`, `PERL5OPT`
and friends) are stripped by `sanitiseEnv` — case-insensitively, since some
systems honour `ld_preload` too.

**No zombie processes.** `cleanup()` in `agent.ts` closes the manager on every
exit path, including a cancelled stream. It is synchronous while closing is
async, so the close is kicked off rather than awaited, and its error is
swallowed — cleanup has to run to the end in every case.

> **Why not `@modelcontextprotocol/sdk`:** 4.1 MB, 693 files, 17 dependencies
> (`express`, `cors`, `hono`, `jose`, …), almost all of them for the *server*
> side or OAuth. The decisive reason was testing: the SDK's
> `StdioClientTransport` uses `cross-spawn` and cannot be swapped out with this
> project's injection pattern, and the process spawn has to be fakeable. The
> cost is explicit: as the spec grows we track it by hand, only `tools/*` is
> implemented, and **OAuth servers do not work** — static credentials only (env
> or an HTTP header).

## What the agent knows about the project

Five sources feed the system prompt at the start of every stream. Four are read
from the working directory; presence is the first that is not — it comes from
the server (the session table lives there). **None of them reaches the
classifier** (see above).

### `project-context.ts` — AGENTS.md / CLAUDE.md

So the user does not have to restate their project instructions (code style,
which command runs the tests, what not to touch) in every conversation. The
first file found wins; `AGENTS.md` is preferred as the more widely adopted
agent-oriented standard, `CLAUDE.md` is the fallback for existing projects.
Capped at 16 000 characters (~4000 tokens) because it is appended on **every**
request. It is placed at the very end of the prompt, after the platform's own
rules — there is no law that later text weighs more with a model, but the order
states the intent: the platform rules are the foundation, the project's
instructions sit on top.

### `skill-load.ts` / `skill-file.ts` — Skills

`.barpo/skills/*/SKILL.md`, in the Agent Skills format (frontmatter with
`name`, `description`, `license`, `allowed-tools`). Only **name + description +
path** go into the prompt — progressive disclosure; the model fetches the full
text itself with `read` when it decides it needs it. The full text of 20 skills
would fill the context window on its own. Up to 100 skills.

This is exactly why skill files must live **inside the working directory**:
otherwise `read` would trip the boundary check and ask permission every time.
`barpo-server/src/skill-store.ts` does the copying.

`skill-file.ts` is a hand-written minimal YAML parse of the frontmatter rather
than a dependency: only four fields are needed, all of them a string or a list
of strings. (The `yaml` package is in `node_modules`, but only as a transitive
dependency of pi — it could vanish on a pi upgrade.) Block scalars (`|`, `>`)
*are* supported, and that matters: `anthropics/skills` uses `description: |-`,
and without it the description would parse as the two characters `|-` — the
skill would load, and the model would have no idea when to use it. Validation is
deliberately lenient: only a missing `description` rejects a skill, everything
else is a warning and the skill loads anyway. Third-party repos do not always
match the spec exactly, and losing a whole repo over a capital letter helps
nobody.

### `memory.ts` — project memory

The problem: in every new session the agent learns the project from scratch —
which command runs the tests, why a library was chosen, which style the user
dislikes. Unlike `AGENTS.md`, which the user maintains by hand, **memory is
written by the agent itself** into `.barpo/memory/`, and nobody syncs it.

An index (`MEMORY.md`) plus separate files, not one growing document: a single
file would land in the context in full on every request and, at 50 stored facts,
would fill the window by itself. So the index goes in whole (capped at 8000
characters) and the memory files only as name + description + path — the same
progressive disclosure as skills, with a higher count limit (200), since memory
accumulates naturally while skills are installed selectively. Memories are typed
`decision` / `architecture` / `rule` / `source`.

The memory section is included **even when it is empty**: without the writing
rule in the prompt, the agent would not know the mechanism exists.

### `git-state.ts` — the git situation

There is no git tool and none is planned — `bash` runs git perfectly well. What
bash cannot give the agent is the situation *before its first command*, and the
situation decides the workflow: not a repo → init only if something real is
being built; a repo with no remote → commit locally at meaningful points; a
repo with a remote → branch, commit there, offer a PR, never straight onto the
trunk, and pushing is the user's decision. `readGitState` reads the state once
per stream and `gitToPrompt` turns it into one factual line plus the rules for
exactly that case. The section sits **inside** the prompt after the `bash`
paragraph, not at the tail — it is a behavioural rule, not reference material.

The state is read from `.git`'s own files (`HEAD`, `config`, the worktree
`gitdir:`/`commondir` indirections), **never by spawning git**. Two reasons:
the prompt is assembled synchronously and a subprocess would stall the server
per stream; and spawning git here would be a second, unaudited path to
executing a binary outside `RestrictedEnv` — a cloned repo's `.git/config` can
point git at hooks of its choosing. The price is no dirty-state and no nice
name for a detached HEAD; the agent has `bash` and `git status` is free the
moment it cares. *Any* `[remote "…"]` counts as "has a remote", not just
`origin` — an upstream-only repo must not read as local, that would hand it
the less cautious rules. The remote URL is a stranger's text: control
characters are stripped and the length capped before it enters the prompt.

### `presence-prompt.ts` — the other conversations

Every chat attached to a project shares **one working directory**, and until
now each agent worked as if it were alone in it. Presence tells the agent who
else is there: the server gathers the sibling sessions (`presence.ts` +
`repo.ts: siblingSessions`, capped at 20 in SQL) and marks who has a stream in
flight right now; this module formats the list plus the shared-directory rules
(read again if a file surprises you, do not "tidy up" work you did not do, keep
away from files a live conversation is touching). Computed once at stream
start — the text itself says the list may be stale. It is **presence, not
isolation**: nothing prevents a collision, the agent is only made aware. An
empty list (any session with no project, or the only chat of a project) means
the prompt says nothing at all. Session titles are user- or model-written text:
control characters are stripped and length capped, same as skill descriptions.

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
that risk. It can be swapped with `agent.compaction.model`; if that model is
not found we fall back to the main one rather than throwing — compacting with
the main model beats not compacting at all.

### Which user message is the prompt

`agentStream` looks for the **last `user` message** rather than assuming it is
the last element of the array. This race really happens:

1. the user sends a message, the stream starts;
2. they hit "Stop" and immediately send a new message;
3. the old stream is aborted and the **new** user message is written;
4. the aborted stream then saves its own "cancelled" reply — *after* the new
   user message.

The history now ends `… user, assistant`, and code checking only the last
element silently lost the user's message with "No user message found to send".
The messages after the chosen user message stay in the history.

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

Hooks work on **text**, and only the text block of a result is replaced. This
matters more than it sounds: the whole `content` array used to be replaced with
a single text block, which **destroyed images** — `read` on an image file
returns `[{type:'text'}, {type:'image'}]`, and the hooks run over nearly every
result, so the model silently never saw the image, with no error anywhere. An
attached image comes down exactly this path.

Attached images are not passed as base64 at all: the prompt lists the file paths
and the agent reads them itself with `read`. That is pi's interactive-mode path
and it buys two things — one code path for all attachments, and the image enters
the context only when the agent actually wants it.

## Provider errors

`agent.prompt()` **does not throw** on a provider error. pi-agent-core writes it
into the last assistant message (`stopReason: 'error'`) and returns quietly.
Without `streamError()` checking for that, such a stream counted as successful:
no text, no tools, no error — to the user, "the chat started and ended
immediately". It left no trace in the database either, since the orchestrator
does not write an empty reply. Real cases that went down this path: OpenRouter's
`400 Reasoning is mandatory for this endpoint`, and an invalidated Codex OAuth
token.

An abort is deliberately **not** treated as an error here — the caller knows
about its own cancellation and reports it separately.

## Session lifetime

`registry.ts` — a TTL + LRU registry behind `permissionManager(sessionId)` and
`modeManager(sessionId)`.

Both used to keep one manager per session in a plain `Map`. The `close()`
functions existed but nothing ever called them, so every conversation landed in
the map and stayed there forever — a slow leak on a long-running server.
"Clean up when the session is deleted" does not work: chat sessions live
permanently in SQLite and the UI offers no delete, so that event does not exist
to hook into.

TTL covers the normal case (30 minutes of inactivity and the manager drops out);
LRU covers the anomaly (a script opening sessions faster than the TTL can
collect, capped at 500). This is safe because the managers hold only
session-scoped temporary state — pending requests, "always allow" patterns,
block counters, the permission mode — none of it persistent. A new manager is
created on the next request, which for the user is simply the default state.
An active session is never collected: `get()` refreshes its timestamp on every
request, so a streaming session sits at the head of the list.

## Settings

Behaviour is controlled through `@barpo/config` — `~/.barpo/config.json`
and the project's `.barpo/config.json`. Details:
`barpo-config/README.md`.

The main ones: `agent.compaction.*` (context compaction),
`agent.history.maxMessages`, `agent.history.toolResultLimit`,
`agent.tools.enabled` (which tools are available),
`agent.tools.bashTimeoutSeconds`, `permission.mode`, `permission.waitSeconds`,
`permission.classifierModel`, `permission.extraDenyList`,
`mcp.connectTimeoutSeconds`, `mcp.callTimeoutSeconds`.

A project config can **narrow** `agent.tools.enabled` but never widen it — a
project file may have arrived with a cloned repo.

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

**Dashboard code review.** `states`, `settings` and `actions` code from
`appPublish` runs with the platform's own privileges. The next stage runs the
same classifier over it as a prompt-injection check; the hook points already
exist — `validateCode()` in `state-run.ts`, `validateActionCode()` in
`action-run.ts`, `findForbidden()` in `view-build.ts`.

**MCP OAuth.** Only static credentials work today (env or an HTTP header),
because the hand-written client does not implement the OAuth flow.

**AgentHarness.** Partly adopted: the tools are declared in pi's
`AgentHarnessTool` shape, but the loop itself is still the lower-level `Agent`.
Completing the move would provide the session tree, `steer()`/`followUp()`
(steering mid-stream) and provider retries out of the box.

## Tests

```bash
bun test
```

801 tests across 37 files — 757 pass, 44 skip. They do not go over the network
(the Ollama and `rg` tests are the exception and are conditional: if the program
is missing, the test skips itself, which is where most of those 44 come from).
The security tests exercise `RestrictedEnv`, `assessCommand`, classifier
isolation and `sanitiseEnv` directly — without an LLM involved, i.e. they check
that the boundary is enforced at the code level.

Some deserve special mention:

| File | What it enforces |
|---|---|
| `classifier-isolation.test.ts` | tool results do not reach the classifier prompt — if this breaks, the prompt injection defence is lost |
| `memory-isolation.test.ts` | memory text does not reach the classifier either — the time-delayed injection path |
| `context.test.ts` | cutting does not start at a `toolResult` — if this breaks, the provider rejects the request |
| `search-parity.test.ts` | the `rg` and Node backends give **exactly the same** result — if this breaks, the agent behaves differently depending on the user's machine |
| `search-security.test.ts` | `grep`/`find`/`ls` never escape the working directory, symlinks included |
| `mcp-env-security.test.ts` | `LD_PRELOAD` and friends are stripped before an MCP process is spawned |
| `stream-error.test.ts` | a provider error is not silently reported as an empty successful reply |
