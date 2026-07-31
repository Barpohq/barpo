# @platforma/config

The platform's settings layer. The user controls agent behaviour, tools and
the permission system through a file.

```ts
import { config } from '@platforma/config'

const { config: settings, warnings } = config({ workDir })
settings.agent.compaction.reserveTokens   // → 16384
```

## Where the files live

Two layers; the upper one overrides the lower.

| Layer | Path | Purpose |
|---|---|---|
| global | `~/.platforma/config.json` | the user's usual settings |
| project | `<work dir>/.platforma/config.json` | a restriction for this job |

The global directory can be moved with `PLATFORM_CONFIG_DIR` (that is what
the tests do).

Neither file is required — with no file at all the defaults are used.

## What the project config CANNOT do

The project file ships with the repo, meaning someone else may have written
it. So it **cannot lower the security boundary**:

| Setting | What the project can do |
|---|---|
| `permission.mode` | only lower it to `confirm`, never raise it to `auto` |
| `permission.extraDenyList` | only add entries, never remove them |
| `agent.tools.enabled` | only narrow it, never widen it |
| everything else | overrides freely (not security-relevant) |

This is implemented in `applyProjectRestriction()` and enforced by tests.
Same reasoning as pi's "project trust" problem: a repo must not be able to
change your settings.

## What happens on an error

**Reading the config never throws and never stops the platform.**

| Case | Result |
|---|---|
| no file | defaults, no warning |
| malformed JSON | defaults + a warning |
| wrong kind (`"yes"` instead of `true`) | default value + a warning |
| a number outside its range | **clamped** to the range + a warning |
| a bad element in a list | only that element is dropped |
| unknown field (a typo) | ignored + a warning |

A number outside its range is clamped to the range rather than reset to the
default: the user's intent is clear ("I wanted it bigger"), so it is simply
brought into the allowed range.

Warnings come back in the `warnings` list — the server logs them and the UI
will show them later.

## Adding a setting

It is written in one place — `FIELDS` in `src/schema.ts`:

```ts
{
  path: 'agent.compaction.reserveTokens',
  kind: 'number',
  default: 16384,
  hint: "The part of the context window reserved for the summary.",
  range: { min: 1000, max: 200_000 },
}
```

Then add a matching field to the `Config` type and update the schema:

```bash
bun run schema
```

Validation, the default value, the JSON Schema and (later) the web form all
follow automatically from that one spec. `validate.test.ts` enforces that
`FIELDS` and the `Config` type match, and `schema.test.ts` checks that
`schema.json` is not stale.

## Why JSON

The web UI will later write this file. The form is built automatically from
the JSON Schema and validation stays in one place. JSONC/TOML are nicer for
a human to read, but comments are lost on a web ↔ file round trip — a
comment the user wrote would be wiped on the first save.

For editor autocompletion, put this at the top of the file:

```json
{ "$schema": "https://.../schema.json" }
```

`example-config.json` holds all settings with their default values.

## Tests

```bash
bun test
```

49 tests. The main enforced behaviours: even garbage input yields a working
config, the project config cannot lower the security boundary, and default
values never leak out as shared objects.
