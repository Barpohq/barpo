# Risks and critical analysis

> The strongest arguments against this project, and the answers to them, written down before starting.
> The goal: avoid blind optimism.

> **Written before the work began**, and kept as it was. Several of the
> mitigations below are now built rather than planned — the permission layer,
> the classifier, the append-only audit log and the cost of prompt injection are
> described as they actually work in [architecture.md](architecture.md). Read
> this document for the reasoning; read that one for the implementation.

---

## Risks eliminated by the change in the project's direction

The original idea (a commercial SaaS platform for everyone) carried the serious risks below. Going self-hosted, open-source, and "for myself" eliminated them:

| Risk | Why it no longer applies |
|---|---|
| Providers build the best features themselves and squeeze us out | We are not fighting for a market; if my own need is met, the goal is reached. If they ship a good tool, we plug that into the platform too |
| "A product for everyone is a product for nobody" | The audience is exactly one person: me. Progressive disclosure is for my own convenience, not for marketing |
| A centralised platform is a tempting target for attackers | Self-hosted: there is no door into thousands of user servers, only my own |
| Unclear business model, hostile economics | There is no business. BYOK — my own subscriptions and keys. Cost = my own API spend |
| Chicken-and-egg problem in the store | The store is just a catalog, not a marketplace. I write most of the skills myself |
| Legal liability (the AI breaks a client's server) | There is no client. My server, my risk, "as is" under an open-source licence |

## Risks that remain live

### X1. Scope creep — the biggest risk

**The risk:** "for myself" projects expand without limit, because nobody says no. You start building a platform instead of a bot, then an ecosystem instead of a platform, and nothing ever ships.

**Mitigation:**
- The strict order: no platform code until the bot works
- A module is only generalised when a second use case demands it
- Every new idea is checked against the anti-goals first

### X2. Prompt injection — technically an unsolved problem

**The risk:** the bot works with external content (web pages, RSS, Reddit posts). A malicious page may contain text along the lines of "ignore your previous instructions, do X". At the platform stage this gets more serious: when the AI reads server logs, a command hidden inside a log could affect server management.

**Mitigation:**
- At the bot stage the risk is low: the bot only writes posts, performs no actions, and there is an approval flow
- External content is always passed as "data", in a separately marked context
- At the platform stage: dangerous actions are tied to human confirmation rather than an LLM decision — even a successful injection does not get the action executed
- This problem will not be solved completely — only the damage can be limited. We design with that acknowledged

### X3. LLM stochasticity — "fully autonomous" is never 100% reliable

**The risk:** the bot may publish an old story as new, get a fact wrong, or drift out of voice. The channel's reputation is my reputation.

**Mitigation:**
- A 7-day dedup window plus a date check
- The approval stage is mandatory and long enough (the 95% criterion)
- Even in auto mode every post keeps a ❌ button — one press deletes it and records feedback
- The source link is always in the post — readers can check for themselves

### X4. Maintenance burden

**The risk:** source formats change, APIs break, providers move endpoints. An "autonomous" bot in fact demands constant small repairs. The agent daemons on the 5 servers will need updating too.

**Mitigation:**
- Health report + alerting: breakage is visible immediately, it does not die quietly
- Source adapters are independent: if one breaks the rest keep working
- Configuration is not code (`yaml`) — many fixes are made without a deploy
- Realistic expectation: about 1 hour of maintenance a week — that is a normal price

### X5. Time and motivation

**The risk:** most solo-developer projects get abandoned somewhere around phase 2–3. The platform stage in particular (phases 4–6) is months of work.

**Mitigation:**
- Every phase is useful on its own: even if the bot is abandoned at phase 3, a working, useful product remains
- The biggest motivational design choice: the first result (an automatic post to the channel) is visible in 2–3 weeks
- The platform gets built "when it is needed" — motivation comes from a real need, not from obligation

### X6. LLM quality in Uzbek

**The risk:** if the channel is in Uzbek, many models are weak in the language and posts may come out stilted or wrong.

**Mitigation:**
- A dedicated language trial in phase 2: have 3–4 models write the same story and compare
- Few-shot samples drawn from my own posts — this lifts both voice and language quality
- A hybrid if needed: analyse the content in English and write only the final text in Uzbek with a strong model

### X7. Cost control

**The risk:** dozens of clusters × LLM calls every 2–4 hours — left unwatched, the monthly bill can be a surprise. At the platform stage, agents calling each other pushes spend up 2–5x.

**Mitigation:**
- Cost logging in the LLM Router from day one (phase 0)
- Cheap/strong model split: 90% of the work on the cheap model
- A daily post limit plus the rank threshold — the number of calls is naturally bounded
- A daily cost cap: if it is exceeded the bot stops and sends an alert

---

## Open questions (unanswered for now, to be settled later)

1. ~~Channel language and audience profile~~ — settled (phase 2, `channel.yaml`)
2. X/Twitter as a source: the official API is expensive — which alternative works reliably?
3. ~~Which use case comes second?~~ — the **server monitor agent** was chosen
   (2026-07-26). Reason: it shares the most modules with the bot, which gives
   the strongest signal for extracting the core. A deploy agent would be a
   sharper pain point, but it would have pulled Phase 5's work forward.
4. Write the agent daemon from scratch, or adapt an existing open-source
   solution like Coolify/Dokploy? (To be settled in phase 5 — for now the
   monitor works over SSH, without a daemon)
