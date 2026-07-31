---
name: dashboard-jsx
description: Use when a dashboard needs a custom layout that the built-in widgets cannot express, and you are about to pass `view` (JSX source) to appPublish. Explains the required component shape, the platform components and Tailwind classes available to it, and how live `states` data reaches the code. Read this BEFORE writing any view code.
license: internal
---

# A custom dashboard view (JSX)

You can pass your own JSX to `appPublish`'s `view` field. Use it when you need a
layout the widgets cannot express.

**Try the widgets first** (see the `dashboard-create` skill) — they are more
reliable and faster. Write code only when it is genuinely necessary.

## The required shape

```jsx
export default function View({ data, ui }) {
  return <div>...</div>
}
```

`export default` is **mandatory**. The component takes two props:

- `data` — the data you gave to `appPublish` plus the live `states` values
- `ui` — the platform components (below)

## What is available

### Platform components — `ui`

Use these and the dashboard will look **identical** to the rest of the UI:

```jsx
<ui.Card className="p-5">...</ui.Card>
<ui.StatTile label="CPU" value="3.2%" hint="4 cores" accent="#45c8b5" />
<ui.StatusDot status="running" pulse />
```

`StatusDot` statuses: `running`, `idle`, `paused`, `healthy`, `warning`,
`offline`.

### Tailwind classes

The platform's entire style system is open to you:

```jsx
<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
  <div className="rounded-xl border border-line bg-panel p-4">
    <span className="text-xs uppercase tracking-wider text-muted">CPU</span>
    <div className="mt-2 font-mono text-2xl font-semibold text-lazur">3.2%</div>
  </div>
</div>
```

Colour classes: `text-ink`, `text-muted`, `text-faint`, `text-lazur`,
`text-gold`, `text-coral`, `text-mint`, `bg-panel`, `bg-panel2`, `bg-bg`,
`border-line`.

### React hooks

You use them without importing — they are already in scope:

`useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`,
`useReducer`, `useLayoutEffect`, `useId`

```jsx
export default function View({ data }) {
  const [selected, setSelected] = useState(null)
  const total = useMemo(() => data.posts.length, [data.posts])
  return <div>{total} posts</div>
}
```

## What is NOT allowed

| Forbidden | Why | Instead |
|---|---|---|
| `import` / `require` | The code is not bundled | React, the hooks, and `ui` are already provided |
| `fetch`, `WebSocket` | No arbitrary network access | `states` to read, `ui.action` / `ui.save` to write |
| `localStorage`, cookies | The view should be stateless | `useState` |

## Writing — `ui.action` and `ui.save`

If the app has `settings` or `actions`, the view can call them:

```jsx
export default function View({ data, ui }) {
  const [busy, setBusy] = useState(false)

  async function restart() {
    setBusy(true)
    const response = await ui.action('restart')     // actions[].name
    setBusy(false)
  }

  return (
    <ui.Card className="p-5">
      <button onClick={restart} disabled={busy}>
        {busy ? 'Running…' : 'Restart'}
      </button>
    </ui.Card>
  )
}
```

`ui.save({ token: '...' })` writes setting values.
`ui.settings` holds the current non-secret values (secrets are **not** here).

These two functions only ever reach **this app's** routes — you cannot address
another app. That is why they do not violate the `fetch` ban.

**Consider the schema first.** With `settings.fields` the form is rendered by
the platform, and validation, secret masking, and the "empty secret = unchanged"
rule are already handled there. Use `ui.save` only when the schema does not
fit — the details are in the `dashboard-controls` skill.

## Live data — `states`

Do not write a `fetch` for a value that changes over time. Add `states` instead
(see the `dashboard-create` skill) — they run on the server and land in `data`
**automatically**:

```
appPublish({
  states: [
    { name: "cpu", interval: 5, code: "module.exports = async () => ({ percent: 3.2 })" }
  ],
  view: "..."
})
```

Inside your code `data.cpu.percent` will exist and **re-render every 5 seconds
with the new value**. From your side it is just a props change:

```jsx
export default function View({ data }) {
  return <div>CPU: {data.cpu?.percent}%</div>
}
```

`data.cpu` may be `undefined` at first (the first request has not landed yet) —
guard it with `?.`.

Why it works this way: `states` are cached and run exactly once per interval.
Written with `fetch`, every open tab would repeat the request and the platform
would have no control over the refresh interval.

## A complete example

```jsx
export default function View({ data, ui }) {
  const [filter, setFilter] = useState('all')
  const posts = (data.posts ?? []).filter(
    (p) => filter === 'all' || p.status === filter
  )

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ui.StatTile label="CPU" value={`${data.cpu?.percent ?? '—'}%`} />
        <ui.StatTile label="RAM" value={data.ram?.percent ?? '—'} hint={data.ram?.free} />
      </div>

      <ui.Card className="overflow-hidden">
        <div className="flex gap-2 border-b border-line px-5 py-3">
          {['all', 'published', 'pending'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-2.5 py-1 text-xs transition ${
                filter === f ? 'bg-lazur text-bg' : 'text-muted hover:text-ink'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <table className="w-full text-left text-sm">
          <tbody>
            {posts.map((p, i) => (
              <tr key={i} className="border-t border-line/60">
                <td className="px-5 py-2.5 font-mono text-xs text-faint">{p.time}</td>
                <td className="px-5 py-2.5 text-[13px]">{p.title}</td>
                <td className="px-5 py-2.5 text-[13px] text-muted">{p.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ui.Card>
    </div>
  )
}
```

## What happens when it fails

If your code does not compile, or throws during render:

- **The platform keeps working** — nothing breaks
- If you also supplied widgets, they are still displayed
- A short error block appears in the view's place

That is why supplying `widgets` alongside `view` is a good habit.

## Common mistakes

| Mistake | The right way |
|---|---|
| `import React from 'react'` | No imports needed — everything is provided |
| `fetch('/api/...')` — to read | add `states` |
| `fetch('/api/...')` — to write | `ui.action(name)` / `ui.save({...})` |
| `export function View()` | `export default function View()` |
| `data.cpu.percent` (unguarded) | `data.cpu?.percent` — empty on first render |
| `<Card>` | `<ui.Card>` — components live inside `ui` |
