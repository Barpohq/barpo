# Stage 1 — Telegram AI News Bot

> A fully autonomous bot: every day it collects AI news, analyses it, separates out duplicates, fills in incomplete information, and posts it to the channel in a clean format.

---

## 1. Goals and requirements

### Functional requirements

1. **Collection** — gather AI news from several sources on a schedule (every 2–4 hours)
2. **Deduplication** — merge the different sources' versions of the same story into one cluster
3. **Analysis** — score how important each story is and how well it fits the channel's audience
4. **Enrichment** — gather extra information via web search for stories that are incomplete
5. **Generation** — write a post in the channel's voice and format
6. **Publishing** — post to the Telegram channel automatically (with approval at first, fully automatic later)
7. **Autonomy** — run continuously without my involvement and recover from errors on its own

### Non-functional requirements

- Runs in Docker on a single server
- Minimal LLM cost (a cheap model does 90% of the work, the strong model is reserved for the final post)
- All state is stored in the database — nothing is lost if the server restarts
- Every step is logged — when something breaks, it is obvious where

---

## 2. Architecture — the pipeline

```
┌──────────┐   ┌────────┐   ┌───────┐   ┌──────────┐   ┌──────────┐   ┌─────────┐
│ Collector │──▶│ Dedup  │──▶│ Rank  │──▶│ Enricher │──▶│ Writer   │──▶│ Publisher│
│ (RSS/API) │   │(embed) │   │ (LLM) │   │(search)  │   │ (LLM)    │   │(Telegram)│
└──────────┘   └────────┘   └───────┘   └──────────┘   └──────────┘   └─────────┘
      │             │            │            │              │              │
      └─────────────┴────────────┴────┬───────┴──────────────┴──────────────┘
                                      ▼
                              ┌──────────────┐
                              │ SQLite (state)│
                              └──────────────┘
```

Each stage is an independent module — that makes it easier to extract them into the platform later.

### 2.1 Collector

Sources (initial list):

| Kind | Source | Note |
|---|---|---|
| RSS | Anthropic, OpenAI, Google AI, HuggingFace blogs | Official announcements — the most reliable |
| RSS | arXiv (cs.AI, cs.CL, cs.LG) | Academic papers — need filtering |
| API | Hacker News (Algolia API) | Top posts matching "AI" |
| API | Reddit JSON (r/LocalLLaMA, r/MachineLearning) | Community discussion |
| Scrape | Model release trackers | OpenRouter's list of new models |

- Cron: runs every 2–4 hours
- Every item is written to the database raw: `url, title, content, source, fetched_at, status='raw'`
- Sources live in a configuration file (`sources.yaml`) — they can be added or removed without touching code

### 2.2 Deduplication

Two stages:

1. **Cheap filter:** URL normalisation plus title similarity (fuzzy match). Exact duplicates drop out here.
2. **Semantic clustering:** embeddings (a local model such as `bge-small` — zero API cost) plus cosine similarity. The 15 different posts about "GPT-5 is out" all land in one cluster.

Within a cluster, the most complete/original source is marked as the "primary" one; the rest are kept as additional context.

Important: dedup compares not just against today but against the last 7 days of news — this prevents the LLM error of treating an old story as new.

### 2.3 Rank

A cheap LLM (Haiku / Gemini Flash / a cheap OpenRouter model) assigns each cluster:

- **An importance score** (1–10): a new model release > a minor feature update > a rumour
- **A category:** model release / research / tooling / business news / other
- **Channel fit:** the audience profile is described in the prompt
- **An ad/spam filter:** so promotional posts are not mistaken for news

Only clusters above the threshold (say ≥ 6) move on to the next stage. The number of posts per day is capped (say 5–8 max) so the channel is not flooded.

### 2.4 Enricher

If the information in a cluster is thin (only a headline, for example):
- Web search (Brave Search API / Tavily / self-hosted SearXNG) finds additional sources
- The primary page is fetched and its text extracted
- Everything is added to the cluster's context

### 2.5 Writer (post generation)

- **The strongest model** is used only at this stage (post quality = the channel's reputation)
- Prompt contents: the cluster context + the channel's 5–10 best previous posts (few-shot style samples) + formatting rules
- If posts are written in Uzbek: models need to be tested separately — pick whichever is strongest in Uzbek (Claude and GPT get a trial run)
- Output format: Telegram HTML/Markdown, emoji policy, source link, hashtags

### 2.6 Publisher

- Posts to the channel through the Telegram Bot API
- Images: uses the story's own image (OG image) if there is one, otherwise a text-only post
- Published posts are flagged in the database (`status='published'`, `message_id` stored)

### 2.7 Approval flow (the oversight layer)

**Mandatory for the first 2–4 weeks:**

```
Writer ──▶ sends to a private chat ──▶ [✅ Approve] [✏️ Edit] [❌ Reject]
                                            │                       │
                                            ▼                       ▼
                                       To the channel        Reason requested,
                                                             written to the database
```

- Rejection reasons accumulate → data for improving the Rank prompt
- Confidence statistics are collected (once approval rate is ≥ 95%, auto mode becomes an option)
- Even in fully automatic mode the ❌ button stays — it deletes from the channel and records feedback

---

## 3. Technical stack

| Layer | Choice | Reason |
|---|---|---|
| Language | Python 3.12+ | The richest ecosystem for collection/pipeline work |
| Database | SQLite | One file, easy backups, more than enough for this load |
| Scheduler | APScheduler or cron | Simple, reliable |
| LLM access | OpenRouter (one API for every model) | Easy to swap models and compare — fits the way I work |
| Embeddings | sentence-transformers (local, bge-small) | Zero API cost |
| Web search | Tavily API or SearXNG (self-hosted) | For the enrichment stage |
| Telegram | python-telegram-bot or aiogram | Both are mature |
| Deploy | Docker + docker-compose | Goes on a single server |
| Monitoring | Healthcheck + a Telegram alert on failure | The bot reports on itself |

## 4. Project structure

```
ai-news-bot/
├── docker-compose.yml
├── .env.example              # API key template
├── config/
│   ├── sources.yaml          # List of sources
│   ├── channel.yaml          # Channel profile, voice, language, post limit
│   └── models.yaml           # Which model for which stage (OpenRouter slug)
├── bot/
│   ├── collector/            # Source adapters (rss.py, hn.py, reddit.py)
│   ├── dedup/                # Embeddings + clustering
│   ├── rank/                 # LLM scoring
│   ├── enricher/             # Web search + fetch
│   ├── writer/               # Post generation
│   ├── publisher/            # Telegram publishing + approval flow
│   ├── llm/                  # OpenRouter client (the single entry point!)
│   ├── db/                   # SQLite models and migrations
│   └── main.py               # Scheduler + pipeline orchestration
└── tests/
```

**An important design decision:** `bot/llm/` — every LLM call goes through a single module. That module later becomes the platform's "LLM Router" component. The same goes for `collector/`, `dedup/`, and `publisher/` — they will become platform modules eventually, which is why they are written loosely coupled from day one.

## 5. Rollout stages

1. **Week 1:** Collector + database + dedup. Result: the database is filling with news and duplicates are being clustered (verifiable through a simple CLI)
2. **Week 2:** Rank + Writer + Publisher (in approval mode). Result: finished posts arrive in the private chat
3. **Weeks 3–4:** Prompts are tuned based on approval feedback, error cases are fixed
4. **Week 5+:** Approval rate steady at ≥ 95% → auto mode is switched on. The bot is fully autonomous.

## 6. Resilience to failures

- Every stage is idempotent — on restart it picks up exactly where it left off (state lives in the database)
- If a source goes down → skip + log, the other sources carry on
- If the LLM API errors → 3 retries (exponential backoff) → deferred to the next cycle
- A daily "health report" to the private chat: how many stories were collected, how many posts went out, were there errors
- If nothing at all is collected for 24 hours → alert (something is broken)
