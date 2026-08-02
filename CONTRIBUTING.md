# Contributing

Barpo is built by one person for their own use, in the open. Contributions are
welcome; so is a fork if you want it to go a different way.

This file is short because most of it is one idea: **the code explains why it is
shaped the way it is, and that explanation is part of the code.** If you keep
that, the rest follows.

## Getting set up

[docs/getting-started.md](docs/getting-started.md) covers installing and running.
For changing the code you mainly need:

```bash
bun install
bun test          # all of it, ~16s — 1775 pass, 44 skip
```

The 44 skips are conditional: the Ollama and `rg` tests skip themselves when
those programs are not installed. Nothing in the suite goes over the network.

## The rules that are not obvious

**Fix the code, not the test.** Twelve invariants are enforced by tests and
listed in [CONTINUE.md](CONTINUE.md#twelve-boundaries-that-must-not-be-broken),
each with what breaks if it goes. Most are security properties whose failure is
silent — a classifier that starts seeing tool results still answers, it just
answers about attacker-supplied text. If one of those tests goes red, something
real broke.

**Every source file opens with a comment explaining why it exists.** Not what
it does — the code says that — but the decision behind it: what was tried, what
went wrong, why the obvious approach was rejected. This is the project's main
defence against re-litigating settled questions six months later, and new files
are expected to carry it too.

**Never edit a migration that has been applied.** The runner works by number, so
an edited migration simply never re-runs on databases that already have it, and
those databases quietly diverge. Write a new one. (`008` is missing on purpose;
`009-tool-calls.ts` explains why.)

**The audit log is written only through `auditWrite(...)`.** Writing to the
table directly means no WebSocket event is broadcast and the feed in the UI stays
silent — and `UPDATE`/`DELETE` are blocked by SQL triggers anyway.

**Documentation is updated in the same commit as the code.** This is not
politeness; it is the failure mode this project has actually hit. A README
describing a directory that was deleted weeks earlier is worse than no README,
because it is believed.

## Fixed procedures

Each of these is written down where the code is, and each is short:

| Adding | Where the steps are |
|---|---|
| a REST route | [`barpo-server/README.md`](barpo-server/README.md#extending-it-for-the-agents-that-come-next) |
| a WebSocket event | the steps are at the top of `barpo-shared/src/protocol.ts`. A server event also needs a case in `eventChannel()` — and in `eventSession()` when it belongs to one conversation. TypeScript will insist, which is deliberate |
| a config setting | one line in `FIELDS`, one field on the `Config` type, then `bun run schema` — [`barpo-config/README.md`](barpo-config/README.md) |
| a migration | a new numbered file plus a line in `migrations/index.ts` |
| a built-in skill | [`skills/README.md`](skills/README.md) |
| a built-in MCP server | [`mcp-servers/README.md`](mcp-servers/README.md) |

## Tests

`bun test` at the root runs everything. Per package:

```bash
cd barpo-ai     && bun test     # 801 across 37 files
cd barpo-server && bun test     # 43 spec files
cd barpo-config && bun test     # 49
```

Useful things to know when writing them:

- `openDb(':memory:')` + `setDb(db)` for anything touching the database.
- `clearRunningStreams()` in `beforeEach` — the stream registry is module-level
  state shared by every test file in the process, and leaving it dirty fails
  unrelated files about one run in three.
- For apps, use `test/app-fixture.ts` (`useTempApps()`, `publishTestApp()`,
  `cleanupApps()`) rather than writing folders by hand.
- The security tests deliberately involve no LLM: they check that the boundary
  holds at the code level, which is the only kind of check that cannot be talked
  out of its answer.

## Style

- TypeScript throughout, `oxlint` on the UI package.
- Commit messages say what changed and why, in a sentence a human would say out
  loud. The existing log is the reference.
- Uzbek and English both appear in commit messages; the code and documentation
  are English. The exception is `ai-news-bot/`, which is a separate finished
  project and stays in Uzbek because it writes for an Uzbek-language channel —
  please leave it alone.

## Reporting something

Open an issue. If it is a security problem in the permission layer, the
classifier isolation or the filesystem boundary, say so plainly in the title —
those are the parts where a quiet failure does the most damage.
