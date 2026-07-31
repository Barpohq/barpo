---
name: dashboard-controls
description: Use when an app's dashboard needs a settings form or control buttons — a bot token, an admin id, a mode switch, a restart/stop button. Covers the settings.js and actions/ files of an app folder, the `ssh` helper, and the rules that keep user input out of the shell. Read this BEFORE writing any form or button.
license: internal
---

# App controls: forms and buttons

A dashboard does not only **display** — it can also control. Two layers:

| Layer | What it is | Where it lives | When |
|---|---|---|---|
| settings | a form — the user enters values | `settings.js` + `app.json` | token, admin id, mode |
| actions | a button — the user presses it | `actions/<name>.js` + `app.json` | restart, stop, clear the cache |

Both are ordinary files in the app folder. **No endpoint is needed** — the
platform already serves `PUT /api/apps/:id/settings` and
`POST /api/apps/:id/action/:name`.

Editing these files later needs **no republish**; adding a NEW action does,
because its button label lives in `app.json`.

## The most important rule: WHERE the value is written

**A setting's value is written to the app ITSELF on the server, not to the
platform.**

The bot runs on the server and reads its token from its own configuration
(`/opt/bot/.env`). When the user enters the token in the platform it has to
reach **that file** — otherwise the bot carries on with the old token.

```
browser → platform → SSH → server:/opt/bot/.env → restart
```

The platform **does not store** the token. Which means:
- when the form opens, a secret field appears **empty** (with a `✓ set` marker)
- the `read` code **must not return** a secret value — if it does, it is dropped

## Settings

Three pieces: the **schema** in `app.json`, the **write** code, and optionally
the **read** code.

`app.json`:
```json
{
  "id": "telegram-bot",
  "name": "Telegram bot",
  "widgets": [],
  "settings": {
    "fields": [
      {
        "key": "token",
        "kind": "secret",
        "label": "Bot token",
        "hint": "The token from @BotFather",
        "required": true,
        "pattern": "^\\d+:[A-Za-z0-9_-]+$",
        "patternHint": "The token must look like `123456:ABC-DEF`"
      },
      { "key": "admin_id", "kind": "number", "label": "Admin ID" },
      { "key": "mode", "kind": "select", "label": "Mode", "options": ["polling", "webhook"] },
      { "key": "active", "kind": "toggle", "label": "Enabled" }
    ]
  }
}
```

`key` is `a-z0-9_` and becomes the configuration key. `kind: "secret"` is
hidden in the UI and never returned.

`settings.js` — writes the values to the app on its server:
```js
module.exports = async function ({ values, ssh }) {
  const s = ssh('helsinki-1')
  const env = {}
  if (values.token) env.TELEGRAM_TOKEN = values.token
  if (values.admin_id) env.ADMIN_ID = values.admin_id
  if (values.mode) env.MODE = values.mode

  await s.writeEnv('/opt/bot/.env', env)
  await s.command(['docker', 'restart', 'telegram-bot'])
  return { message: 'Saved, the bot was restarted' }
}
```

`settings.read.js` — optional, so the form opens filled in:
```js
module.exports = async function ({ ssh }) {
  const text = await ssh('helsinki-1').readFile('/opt/bot/.env')
  if (!text) return {}
  const v = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) v[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return {
    admin_id: v.ADMIN_ID,
    mode: v.MODE,
    // For a secret, not the VALUE but its PRESENCE — true/false
    token: Boolean(v.TELEGRAM_TOKEN)
  }
}
```

⚠️ Declaring `settings` in `app.json` **requires** `settings.js` — without it
the form has no way to save and the platform reports the problem.

### Field kinds

| `kind` | UI | Note |
|---|---|---|
| `text` | text input | the default kind |
| `secret` | password input | token, password, API key |
| `number` | number input | validated |
| `select` | select | `options` is required |
| `toggle` | switch | value is `"true"` / `"false"` |
| `textarea` | textarea | long text, a configuration block |

### `read` and secret fields

For a secret, return **`true` / `false`, not the value**:

```js
return {
  mode: v.MODE,                       // not secret — the value
  token: Boolean(v.TELEGRAM_TOKEN)    // secret — presence only
}
```

The platform builds the `✓ set` marker from that. The user does not see the
current token but does know **whether one has been entered** — which answers the
"why isn't my bot working?" question.

If you do return a secret value, the platform **throws it away** (it never
reaches the browser) and treats non-empty as "set". That works, but
`Boolean(...)` is clearer and keeps the token out of the platform's memory
entirely.

### About the `write` code

`values` contains only the fields that **changed**. If the user does not touch
the token, there is no `values.token` — so check each value before using it (as
`if (values.token)` does above).

**For a secret, an empty value means "I didn't change it"** and it does not
arrive at all — so the existing token is not wiped.

## Actions

One file per button, plus its label in `app.json`. **The file name is the
action name** — `a-z0-9_`, because it becomes part of the URL path.

`actions/restart.js`:
```js
module.exports = async function ({ ssh }) {
  await ssh('helsinki-1').command(['docker', 'restart', 'telegram-bot'])
  return { message: 'The bot was restarted' }
}
```

`actions/clear_logs.js`:
```js
module.exports = async function ({ ssh }) {
  await ssh('helsinki-1').command(['truncate', '-s', '0', '/opt/bot/bot.log'])
  return { message: 'Logs cleared' }
}
```

`app.json`:
```json
{
  "actions": {
    "restart": {
      "label": "Restart the bot",
      "hint": "Restarts the container",
      "confirm": true,
      "risk": "write",
      "refresh": ["status"]
    },
    "clear_logs": {
      "label": "Clear the logs",
      "risk": "dangerous",
      "confirm": true
    }
  }
}
```

⚠️ An action file with **no entry in `app.json`** is skipped — its button would
have no label. Adding a new action is therefore one of the few times you do
need to call `appPublish` again.

The `{ message }` you return is shown to the user.

**`refresh`** — the names of the states to recompute after the action. When
restart is pressed the status has to update immediately, rather than waiting out
the cached value's interval.

**`confirm: true`** — put it on actions that change things and cannot be undone.
It protects against a stray click.

## `ssh` — running commands

`ssh(serverName)` gives you three functions. The server name must be one of the
servers connected to the platform (check with the `serverList` tool).

### `command(argv)` — AN ARGV ARRAY, NOT a shell string

```js
await s.command(['docker', 'restart', 'bot'])              // ✅
await s.command(['systemctl', 'restart', 'mybot.service'])  // ✅

await s.command('docker restart bot')                       // ❌ THROWS
await s.command([`docker restart ${setting.name}`])         // ❌ template string
```

**Why this is strict.** A value the user typed ends up in the command. Put into
a shell string, entering `bot; rm -rf /` would mean **executing a command**. In
an array, `;` stays ordinary text.

**If the command fails, `command` throws** (exit code ≠ 0). So you do not have to
check the exit code yourself:

```js
await s.command(['docker', 'restart', 'bot'])
return { message: 'The bot was restarted' }   // ✅ only reached on success
```

The error becomes `{ ok: false, error: "..." }` and is shown to the user.

If you want to handle the exit code **yourself**, use `rawCommand`:

```js
const r = await s.rawCommand(['docker', 'inspect', 'bot'])
const exists = r.code === 0        // 1 for a missing container — an answer, not an error
```

### `writeEnv(path, values)` — writing configuration

```js
await s.writeEnv('/opt/bot/.env', { TELEGRAM_TOKEN: values.token })
```

It handles all of this for you:
- values go over **stdin** — the token never shows up in `ps` output
- an existing key is **replaced in place** (the old value does not linger in the file)
- comments and ordering are preserved
- the write is atomic (`mv`) — a half-written file could stop the bot from starting

**Do not write `echo >> .env`.** That leaves the old value in the file and puts
the token into shell history.

### `readFile(path)`

Returns the file's text, or `null` if it does not exist (it does not throw).

## Security rules — the short list

1. **Only arrays for `command`** — never a string, never a template
2. **Use `writeEnv` for `.env`** — do not hand-write `echo`/`sed`
3. **`read` must not return secrets** — the token must not reach the browser
4. **Set a `pattern`** — whenever the value's format is known (token, port, URL)
5. **`confirm: true`** — on actions that change things

## Limits

| What | Limit |
|---|---|
| Settings fields | 30 |
| Number of actions | 20 |
| Size of one code block | 64 KB |
| Action execution time | 90 seconds |
| `select` options | 50 |

## What happens when something fails

- **If an action fails** — the user sees the error message and the dashboard
  keeps working
- **If a setting cannot be written** — the form stays open and the values are not lost
- **If the same action is pressed twice** — it runs once (there is a lock)
- **If a secret appears in an error message** — the platform replaces it with `•••`

## When you need a custom form

If the schema is not enough, you can write your own form inside `view` (JSX) —
it receives the `ui.save({...})` and `ui.action('name')` functions. Those only
ever reach **this app's** routes.

But try the schema first: validation, secret masking, and the "empty secret =
unchanged" rule all come for free there.
