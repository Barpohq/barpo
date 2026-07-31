# Roadmap — the phase-by-phase plan

> The principle: every phase delivers a useful result on its own. We never end up in the "it works once everything is finished" trap.

---

## Phase 0 — Foundation (week 1) ✅

- [x] Create the repo (open source, pick a licence — MIT or Apache 2.0)
- [x] Docker + docker-compose skeleton
- [x] SQLite schema and migration system
- [x] `bot/llm/` — OpenRouter client (with retry, fallback, cost logging)
- [x] Configuration system (`sources.yaml`, `channel.yaml`, `models.yaml`)

**Result:** `docker compose up` works and a test request reaches the LLM.

## Phase 1 — Bot: collection and dedup (1–2 weeks) ✅

- [x] RSS collector (official blogs)
- [x] Hacker News + Reddit adapters
- [x] Local embeddings + clustering
- [x] Dedup with a 7-day window
- [x] CLI: view the clusters in the database

**Result:** the database fills with clustered news every day. Quality can be eyeballed.

## Phase 2 — Bot: analysis and posts (1–2 weeks)

- [x] Rank: scoring with a cheap model + spam filter
- [x] Enricher: web search + page fetch
- [x] Writer: strong model + few-shot channel voice
- [ ] Language trial: which model writes best in the posts' language — a comparison
- [x] Publisher + approval flow (✅/✏️/❌ in a private chat)

**Rank results (2026-07-26):** 247 clusters scored, 151 accepted / 96 rejected
(24 spam), $0.047, 0 errors. The spam filter correctly caught PR pieces,
subscription ads, and off-topic content.

**Enricher results (2026-07-26):** 14 of 25 clusters were enriched by fetch
alone (average 130 → 5000+ characters). The remaining 11 will be handled once
the Tavily key is added: 7 are aggregator clusters (no concrete URL), 4 are
OpenAI pages (403 — bot blocking, the search fallback works).

Once the Tavily key was added, 26 clusters were enriched (16 fetch, 10 search),
text volume 62 → 4805 characters.

**Writer results (2026-07-26):** 5 posts written, all of them passed
validation on the first attempt. Average 840 characters (limit 1024),
$0.037/post. The channel format and few-shot samples live in `channel.yaml`.

**Publisher results (2026-07-26):** the full chain worked — the Writer wrote a
post, sent it for approval, and once ✅ was pressed it went to the channel
(https://t.me/meninguchunyangikanal/2). The duplicate filter resolved the
cluster 259 vs 264 problem: comparison is by model identifier, and post #3 was
dropped automatically.

**Remaining work — the language trial:** the writer currently runs on Opus 5
($0.037/post). The comparison across `language_test_candidates` in models.yaml
has not been run yet — if a cheaper model gives sufficient quality, the monthly
cost drops several times over.

**Result:** finished posts arrive in the private chat every day and I approve them into the channel.

## Phase 3 — Bot: autonomy (2–4 weeks of parallel observation)

> Note: the first and last items **are waiting on data to accumulate** —
> edit diffs and approval statistics build up as the channel is used. The
> infrastructure (health, statistics) is ready and measures them
> automatically.

- [ ] Prompt tuning based on edit diffs and rejection patterns
- [x] Health report + alerting
- [x] Idempotency and crash-recovery tests
- [ ] Approval rate steady at ≥ 95% → **switch on auto mode**

**Corrected assumption (2026-07-27):** the original plan leaned on a
`reject_reason` column — the assumption was that a human writes a reason for a
rejected post. In practice that does not happen: rejection is usually "I just
didn't like it", which is hard to put into words, so the reason field stays
empty. Reason-driven prompt tuning does not work, and it was abandoned.

Two signals are used instead, both collected without any words:

  1. **The edit diff** (`original_body` ↔ `body`) — the strongest one. When a
     human fixes the text, the action itself shows what they disliked, and
     that is more precise than a comment. The Publisher already stores it.
  2. **Rejection patterns** — which category, source, importance score, and
     post length get rejected. A pattern emerges even without a stated reason.

**Health results (2026-07-26):** a daily report to Telegram (09:00
Tashkent), with an immediate alert on problems (with a 6-hour cooldown).
Approval rate is computed automatically and readiness for autonomous mode is
displayed. CLI: `bot health`, `bot stats`. Telegram: /health, /stats, /sources.

A source's "broken" status is derived from its current state rather than its
error history — so a source that has been fixed does not keep alerting all day.

**Crash-recovery results (2026-07-27):** `tests/test_recovery.py` — 29 tests,
one "the process died mid-way" scenario per stage. The principle: losing work
is cheap (the next cycle redoes it), repeating work is expensive (LLM money, a
second post to the channel) — so the tests check that nothing is repeated.

Confirmed properties: the Collector writes no duplicates on restart; because
the dedup queue is built on `cluster_items`, an item cannot be doubled even in
a half-written state; `item_count` is recomputed from COUNT(*); Rank is
guarded by `UPDATE ... WHERE status = 'new'`; the Enricher runs once per
`enriched_at`; the Writer's `_save_post()` is atomic and the queue filter is
built on the posts table; the Publisher's duplicate filter stops the second
post after an interruption; a migration error rolls back completely.

One deliberate behaviour was documented: in the Writer, a save error halts the
whole flow (unlike an error on a single cluster) — if the database is not
accepting writes, spending LLM money on the remaining clusters is pointless.

**Result:** the bot is fully autonomous. This is the project's first big win and the platform's proven core.

## Phase 4 — The second use case (the platform is born) ✅

The chosen use case: a **server monitor agent**. The reason — it shares the
most modules with the bot (LLM, database, Telegram, configuration, scheduler),
which gives the strongest signal for what belongs in the core. A deploy agent
would be a sharper pain point, but it would have pulled a large chunk of
Phase 5's work (daemon, permission levels, sandbox) forward.

- [x] Core extraction: `core/` — logging, config, db, llm, telegram
- [x] Monitor agent: SSH checks, status, alerts, LLM diagnostics
- [x] Both agents on one database, migrations separated by range

**Decisions:**

- **Connection — SSH** (the system `ssh`, not a library). No daemon is
  installed on the server, the key is never read into the Python process, and
  there is no new dependency. It can be swapped for an agent daemon in Phase 5.
- **Read-only.** The roadmap's original description included "try to fix it
  itself" — that was rejected on the X2 (prompt injection) risk. The LLM
  performs no actions, it only explains.
- **The package is named `core/`, not `platform/`** — `platform` is a stdlib
  module, and a `platform/` at the project root shadowed it, producing
  incomprehensible errors inside `httpx`/`apscheduler`.
- **One SQLite file** — `llm_calls` must not be split ("which agent is
  spending how much"). Migration ranges: bot 1–199, monitor 200–299.

**Deliberately not moved into core:** `bot/health/`, `notify._send()`, the
scheduler, the CLI. They are similar-but-different code across two domains —
15 duplicated lines of SQL are cheaper than the wrong abstraction.

**Result (2026-07-26):** 2 agents on one core. 333 → 488 tests.
Tested against a real server: the measurements were correct, the alert and
recovery flows worked, and the model did not comply with a prompt injection
attack — it flagged the attack instead.
Monitor diagnostics cost ~$0.0007/call.

## Phase 5 — Server agents + the security layer

- [ ] Agent daemon (outbound WebSocket, single-command install)
- [ ] Permission levels (read / write / dangerous)
- [ ] Human-in-the-loop approval (a generalised version of the approval flow)
- [ ] Append-only audit log
- [ ] Connect my 5 servers

**Result:** I manage my servers safely through chat.

## Phase 6 — Web UI + progressive disclosure

- [ ] Chat-first web interface
- [ ] Pro mode: logs, tmux view, cost dashboard, audit log
- [ ] Skill catalog (simple version: a list + one-click install + permission display)

**Result:** the full platform experience — something I use every day myself.

## Phase 7+ — Open development

- A set of deploy skills (Python/Django, Rust, Go, Docker…)
- MCP: fill out the builtin set (`mcp-servers/`), OAuth-protected servers, `resources`/`prompts` (the client layer is ✅ done)
- Documentation + README — so other people can self-host it too
- Community contributions (a bonus if they come; if not, the project still works for me)

---

## Success criteria

| Stage | Criterion |
|---|---|
| Bot | 30 days uninterrupted, without my involvement, with quality posts |
| Platform core | 2+ agents on one core, without duplicated code |
| Server management | I do a simple deploy through chat with one command, without opening a terminal |
| Overall | No lingering need to go back to the old scattered tools in my daily work |

## Anti-goals (traps to avoid)

- Not writing platform code before the bot is finished
- Not adding features on the grounds that "we'll need it later" — only real, present needs
- Not starting the UI before Phase 6 (the CLI + Telegram approval are enough)
- Not chasing perfection — a version that works beats a beautiful plan
