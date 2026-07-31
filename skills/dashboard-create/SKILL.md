---
name: dashboard-create
description: Use when the user asks for a dashboard, a status page, an app overview, or any UI that shows an app's data on this platform. Covers the appPublish tool and the built-in widget shapes (stats, bars, table, logs, note, deploy, git). Read this BEFORE the first appPublish call.
license: internal
---

# Creating an app dashboard

On this platform an app page is built **from data, not from code**. You tell the
`appPublish` tool what should be shown, and the platform renders it.

## The most important rule

**DO NOT WRITE an API, a route, or a frontend file.**

Writing an endpoint for a dashboard is unnecessary and wrong. Gather the data
(bash, read, grep — whatever it takes), then hand the values to `appPublish`.
The page is built from that.

The wrong approach:
- ❌ adding `/api/dashboard` to `server.ts`
- ❌ writing a `Dashboard.tsx` component
- ❌ adding a statistics endpoint to the app

The right approach:
- ✅ read the data → `appPublish({ id, name, widgets: [...] })`

## The call shape

```
appPublish({
  id: "ai-news-bot",          // required: lowercase letters, digits, hyphens
  name: "ai-news-bot",         // required
  icon: "📰",
  tagline: "Collects AI news and publishes it to a Telegram channel",
  version: "v1.4.2",
  service: "helsinki-1 · docker · uptime 31 days",
  status: "running",           // or "idle"
  widgets: [ ... ]
})
```

Calling again with the same `id` **replaces** the old dashboard. That is why
there is no separate tool for updating.

## Widget kinds

Every widget is an object with a `type` field. They are rendered in the order
given, stacked vertically.

### `stats` — the row of numbers at the top

```json
{
  "type": "stats",
  "items": [
    { "label": "CLUSTERS TODAY", "value": "247" },
    { "label": "PUBLISHED", "value": "4", "hint": "1 awaiting approval" },
    { "label": "APPROVAL RATE", "value": "96%", "accent": "#45c8b5" },
    { "label": "COST TODAY", "value": "$0.084", "accent": "#d9a94e" }
  ]
}
```

`value` is a **string**, so write it with its unit: `"$0.084"`, `"96%"`,
`"31 days"`. `hint` is a small note, `accent` is a hex colour.

2–4 items works best: they fit on one row.

### `bars` — lines showing proportions

```json
{
  "type": "bars",
  "title": "Source kinds (412 items today)",
  "items": [
    { "label": "RSS (official blogs)", "value": 214 },
    { "label": "Hacker News", "value": 102 },
    { "label": "Reddit", "value": 71 }
  ],
  "suffix": " items"
}
```

Here `value` is a **number** (not a string!) — the bar length is computed from
it. The largest value takes the full width.

### `table` — a table

```json
{
  "type": "table",
  "title": "Recent posts",
  "columns": ["Time", "Title", "Status"],
  "rows": [
    ["12:06", "Gemini 3 Flash price cut by 40%", "published ✓"],
    ["12:04", "Language trial results", "awaiting approval"]
  ]
}
```

Every row is an array of strings matching the number of columns. If they do not
match, the platform pads or truncates, but it is better to get it right.

The first column is rendered in a monospace font — handy for times and IDs.

### `logs` — terminal-style text

```json
{
  "type": "logs",
  "title": "Recent logs",
  "lines": [
    "12:06:01 [publisher] post #6 published to the channel",
    "12:04:18 [writer] post #5 written (412 tokens)"
  ]
}
```

### `note` — a short remark

```json
{ "type": "note", "text": "Next run: today at 18:00 (Tashkent)" }
```

### `deploy` — the deployment address

```json
{
  "type": "deploy",
  "url": "https://bot.example.uz",
  "kind": "domain",
  "server": "helsinki-1",
  "ssl": "Let's Encrypt, 89 days left"
}
```

`kind`: `"domain"` or `"port"`. `url` **must be http(s)**.

### `git` — recent commits

```json
{
  "type": "git",
  "repo": "firdavs/ai-news-bot",
  "branch": "main",
  "commits": [
    { "hash": "a3f21c8", "msg": "Spam filter for the rank stage", "time": "2 hours ago" }
  ]
}
```

## Where the data comes from

The numbers in a widget must be **real**. Gather them yourself:

- log files — `bash`, `grep`
- the database — `sqlite3` via `bash`, or the project's own script
- server status — `serverList` + `ssh <name> '<command>'`
- git — `git log` via `bash`

If the data cannot be found, **do not invent it**. Drop the widget, or use a
`note` saying "no data yet".

## Live data — `states`

⚠️ **The values inside `widgets` and `data` are FROZEN.** A "CPU 1.6%" written
once stays 1.6% forever.

For anything that changes over time, use `states`. Each state is code that runs
on the server, with **its own refresh interval**.

```
appPublish({
  id: "server-monitoring",
  name: "Server monitoring",
  states: [
    {
      name: "cpu",
      interval: 5,          // ← in seconds. CPU changes fast
      code: `module.exports = async function () {
        const { execSync } = require('child_process')
        const load = execSync("ssh server-107 'cat /proc/loadavg'").toString()
        return { load: load.split(' ')[0] }
      }`
    },
    {
      name: "disk",
      interval: 60,         // ← disk changes slowly, no need to ask often
      code: `module.exports = async function () {
        const { execSync } = require('child_process')
        const out = execSync("ssh server-107 'df -h /'").toString()
        const c = out.split('\\n')[1].split(/\\s+/)
        return { used: c[2], free: c[3], percent: c[4] }
      }`
    }
  ],
  widgets: [
    {
      type: "stats",
      items: [
        { label: "CPU LOAD", value: "{{cpu.load}}" },
        { label: "DISK", value: "{{disk.percent}}", hint: "{{disk.free}} free" }
      ]
    }
  ]
})
```

### Important rules

**Give every value its own interval.** Do not put everything on 5 seconds —
running `df` for disk usage every 5 seconds is pointless work that loads the
server. Sensible intervals: CPU/RAM 5–10s, disk/containers 30–60s, and for
things that barely change (version, uptime) leave `interval` out entirely.

**Do not write an endpoint.** The platform already provides one:
`/api/apps/:id/state/:name`. The page polls it itself.

**The code must RETURN the result**, not draw it:
```js
module.exports = async function () {
  return { cpu: 3.2, ram: 61 }     // ✅ values
}
```

**The `{{state.path}}` template in a widget** is replaced with the live value:
- `{{cpu.load}}` → `"0.42"`
- `{{disk.percent}}` → `"52%"`
- `{{posts[0].title}}` → nested paths work too

If no value arrives, the template is left as-is — deliberately, so that "no
data" is not hidden.

### Limits

| What | Limit |
|---|---|
| Number of states | 20 |
| Size of one code block | 64 KB |
| Shortest interval | 3 seconds |
| Execution time | 20 seconds |
| Result size | 256 KB |

If the code fails, the dashboard **keeps working** — that state keeps its
previous value and everything else looks normal.

## Constraints

| What | Limit |
|---|---|
| Number of widgets | 50 |
| Table/log rows | 1000 |
| `data` size | 256 KB |

Anything over the limit is dropped and you get a warning back.

## When something is rejected

If the tool rejects the call, the response contains a list of reasons. Read
them, fix them, and call again. On rejection **nothing is saved** — the old
dashboard stays as it was.

## When you need a custom look

If the widgets are not enough, you can write your own JSX. Its rules are
separate: **read the `dashboard-jsx` skill**. But try the widgets first — they
are more reliable and faster.

## When you need controls

A dashboard does not have to be read-only. If the user needs to enter a value
(a bot token, an admin id) or press a button (restart, stop), there are
`settings` and `actions` layers.

They matter especially **after a deploy**: the app is running on the server, but
there has to be a way to configure it and restart it.

**Read the `dashboard-controls` skill** — it explains the form fields, the `ssh`
helper, and the rules that keep user input out of the shell.
