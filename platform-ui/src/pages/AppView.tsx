import { useEffect, useState } from 'react'
import type { AppManifest, Widget } from '@platforma/shared'
import AiView from '../components/AiView'
import ActionButtons from '../components/ActionButtons'
import SettingsForm from '../components/SettingsForm'
import { useAppStates } from '../lib/app-states'
import { deleteApp, fetchApp, type AppDetail } from '../lib/api'
import { useToast } from '../lib/toast'
import { Card, StatTile, StatusDot } from '../ui'

/**
 * Replaces `{{state.path}}` templates in widget text with the live value.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ WHY IT IS NEEDED. Widgets are stored in the manifest as TEXT, i.e. │
 * │ they are frozen. The live states arrive separately. Without        │
 * │ templates the AI could only show live data through `view` (JSX) —  │
 * │ needless complexity for a simple stat card.                        │
 * │                                                                    │
 * │ Now: `value: "{{cpu.percent}}%"` → `"3.2%"`.                       │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * When the value is not found the template is LEFT AS IS — deliberately:
 * showing an empty string would hide the "no data" case and the user would
 * not see what was expected.
 */
function applyTemplate(text: string, data: Record<string, unknown>): string {
  if (!text.includes('{{')) return text
  return text.replace(/\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g, (full, path: string) => {
    const value = readByPath(data, path)
    if (value === undefined || value === null) return full
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
}

/** Reads a value by an `a.b[0].c` style path */
function readByPath(source: unknown, path: string): unknown {
  let current: unknown = source
  for (const part of path.split(/[.[\]]/).filter(Boolean)) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** Applies the template to every piece of text in a widget */
function applyWidgetTemplate(w: Widget, data: Record<string, unknown>): Widget {
  const s = (m: string) => applyTemplate(m, data)

  switch (w.type) {
    case 'stats':
      return {
        ...w,
        items: w.items.map((i) => ({
          ...i,
          value: s(i.value),
          ...(i.hint ? { hint: s(i.hint) } : {}),
        })),
      }
    case 'bars':
      return {
        ...w,
        items: w.items.map((i) => {
          // `value` must be a number (the bar width is computed from it), so
          // the template result is converted back to a number. If it does not
          // convert, the old value is kept.
          const raw = typeof i.value === 'number' ? i.value : Number(s(String(i.value)))
          return { ...i, value: Number.isFinite(raw) ? raw : 0, label: s(i.label) }
        }),
      }
    case 'table':
      return { ...w, rows: w.rows.map((r) => r.map(s)) }
    case 'logs':
      return { ...w, lines: w.lines.map(s) }
    case 'note':
      return { ...w, text: s(w.text) }
    case 'deploy':
      return { ...w, ...(w.extra ? { extra: s(w.extra) } : {}) }
    default:
      return w
  }
}

// Turns the widget schema from the manifest into UI — apps bring their own
// dashboard as data and the host renders it (server-driven UI).
function WidgetView({ w }: { w: Widget }) {
  switch (w.type) {
    case 'stats':
      return (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {w.items.map((s) => (
            <StatTile key={s.label} label={s.label} value={s.value} hint={s.hint} accent={s.accent} />
          ))}
        </div>
      )
    case 'bars': {
      const max = Math.max(...w.items.map((i) => i.value))
      return (
        <Card className="p-5">
          <h2 className="mb-4 font-display text-sm font-semibold">{w.title}</h2>
          <div className="space-y-3">
            {w.items.map((i) => (
              <div key={i.label}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="text-xs">{i.label}</span>
                  <span className="font-mono text-xs text-muted">
                    {i.value}
                    {w.suffix ?? ''}
                  </span>
                </div>
                <div className="h-3 overflow-hidden rounded-r-[4px] bg-panel2">
                  <div className="h-full rounded-r-[4px] bg-s1" style={{ width: `${(i.value / max) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )
    }
    case 'table':
      return (
        <Card className="overflow-hidden">
          <h2 className="border-b border-line px-5 py-3 font-display text-sm font-semibold">{w.title}</h2>
          <div className="thin-scroll overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-faint">
                  {w.columns.map((c) => (
                    <th key={c} className="px-5 py-2 font-medium">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {w.rows.map((r, i) => (
                  <tr key={i} className="border-t border-line/60">
                    {r.map((cell, j) => (
                      <td key={j} className={`px-5 py-2.5 ${j === 0 ? 'font-mono text-xs text-faint' : 'text-[13px] text-muted'}`}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )
    case 'logs':
      return (
        <Card className="overflow-hidden">
          <h2 className="border-b border-line px-5 py-3 font-display text-sm font-semibold">{w.title}</h2>
          <div className="thin-scroll max-h-48 overflow-y-auto bg-bg px-4 py-3 font-mono text-xs leading-relaxed text-muted">
            {w.lines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
            <span className="cursor-blink text-lazur">▍</span>
          </div>
        </Card>
      )
    case 'deploy':
      return (
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wider text-faint">Deploy</div>
              <a
                href={w.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 block truncate font-mono text-lg text-lazur hover:underline"
              >
                {w.url}
              </a>
              {w.extra && <div className="mt-1.5 text-xs leading-relaxed text-muted">{w.extra}</div>}
            </div>
            <div className="space-y-1.5 text-right">
              <span
                className={`inline-block rounded-md px-2 py-1 font-mono text-[11px] ${
                  w.kind === 'domain' ? 'bg-lazur-dim/15 text-lazur' : 'bg-gold/15 text-gold'
                }`}
              >
                {w.kind === 'domain' ? '🌐 domain connected' : '🔌 port preview'}
              </span>
              <div className="font-mono text-[11px] text-faint">server: {w.server}</div>
              {w.ssl && <div className="font-mono text-[11px] text-faint">SSL: {w.ssl}</div>}
            </div>
          </div>
        </Card>
      )
    case 'git':
      return (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
            <h2 className="font-display text-sm font-semibold">Git</h2>
            <span className="font-mono text-[11px] text-faint">
              {w.repo} · <span className="text-lazur">{w.branch}</span>
            </span>
          </div>
          <ul>
            {w.commits.map((c) => (
              <li key={c.hash} className="flex items-baseline gap-3 border-t border-line/60 px-5 py-2.5 first:border-t-0">
                <span className="font-mono text-xs text-lazur">{c.hash}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{c.msg}</span>
                <span className="shrink-0 font-mono text-[11px] text-faint">{c.time}</span>
              </li>
            ))}
          </ul>
        </Card>
      )
    case 'note':
      return (
        <p className="rounded-xl border border-dashed border-line px-4 py-3 text-xs leading-relaxed text-muted">
          {w.text}
        </p>
      )
  }
}

export default function AppView({ app }: { app: AppManifest }) {
  // The AI view now runs in the HOST tree — no separate React runtime has to
  // be loaded (the iframe used to pull in ~190 KB).

  // The folder path and any read errors. They are NOT in the manifest — the
  // list endpoint returns manifests only — so they are fetched per app.
  const [detail, setDetail] = useState<AppDetail | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const notify = useToast()

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    fetchApp(app.id)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch(() => {
        // The page renders from the manifest it was already given — losing the
        // folder path costs a hint, not the dashboard.
      })
    return () => {
      cancelled = true
    }
  }, [app.id])

  // Live states — each polled on its own interval.
  const { values, entries, refresh, applyResults } = useAppStates(app.id, app.states)

  // `data` from the manifest is the INITIAL value; the live states are written
  // on top of it. That order matters: the page is not empty on the first
  // render, and the values are then replaced with live data.
  const data = { ...(app.data ?? {}), ...values }

  // States that never succeeded — we show a warning for those. One that worked
  // once and then failed is not shown: a real (if stale) value is on screen.
  const failed = Object.entries(entries).filter(
    ([, e]) => e.error && e.value === undefined,
  )

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-panel2 text-xl" aria-hidden>
            {app.icon}
          </span>
          <div>
            <h1 className="flex items-center gap-2.5 font-display text-2xl font-semibold tracking-tight">
              {app.name}
              <span className="font-mono text-xs font-normal text-faint">{app.version}</span>
            </h1>
            <p className="mt-1 text-sm text-muted">{app.tagline}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusDot status={app.status} pulse={app.status === 'running'} />
          <span className="font-mono text-[11px] text-faint">{app.service}</span>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="mt-1 rounded-md px-2 py-1 text-[11px] text-faint transition-colors hover:bg-panel2 hover:text-red-400"
          >
            Delete app
          </button>
        </div>
      </header>

      {/*
        ┌──────────────────────────────────────────────────────────────┐
        │ THE CONFIRMATION NAMES THE FOLDER, NOT JUST THE APP.         │
        │                                                              │
        │ Deleting erases files the user may have edited by hand, and  │
        │ there is no undo. "Are you sure?" does not carry that — the  │
        │ path does, because it is the thing about to disappear.       │
        └──────────────────────────────────────────────────────────────┘
      */}
      {confirming && (
        <Card className="mb-4 border-red-500/30 p-4">
          <div className="text-sm font-medium">Delete “{app.name}”?</div>
          <p className="mt-1.5 text-sm text-muted">
            This removes the app from the platform and permanently deletes its folder,
            including any files you edited yourself. It cannot be undone.
          </p>
          {detail?.dir && (
            <p className="mt-2 font-mono text-[11px] text-faint">{detail.dir}</p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={deleting}
              onClick={async () => {
                setDeleting(true)
                try {
                  const result = await deleteApp(app.id)
                  if (result.ok) {
                    // The sidebar updates itself from the `app.removed` event —
                    // no navigation is forced here, because the parent decides
                    // what to show once the app is gone from its list.
                    notify(
                      result.folderRemoved
                        ? `“${app.name}” and its folder were deleted`
                        : `“${app.name}” was removed`,
                      'success',
                    )
                  } else {
                    notify(result.error ?? 'Could not delete the app', 'error')
                  }
                } catch (error) {
                  notify(`Could not delete the app: ${String(error)}`, 'error')
                } finally {
                  setDeleting(false)
                  setConfirming(false)
                }
              }}
              className="rounded-md bg-red-500/15 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/25 disabled:opacity-50"
            >
              {deleting ? 'Deleting…' : 'Delete permanently'}
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => setConfirming(false)}
              className="rounded-md px-3 py-1.5 text-xs text-muted transition-colors hover:bg-panel2 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </Card>
      )}

      {/*
        Problems found while READING the folder — a view that did not compile,
        a state file with a bad name. Shown above everything else because the
        user is now the one who edits these files: a silently dropped view
        would look like the platform ignoring what they just wrote.
      */}
      {detail?.errors && detail.errors.length > 0 && (
        <Card className="mb-4 border-gold/30 p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-gold">
            Problems in this app’s files
          </div>
          <ul className="mt-2 space-y-1">
            {detail.errors.map((e, i) => (
              <li key={i} className="font-mono text-[11px] text-faint">
                {e}
              </li>
            ))}
          </ul>
          {detail.dir && (
            <p className="mt-2 font-mono text-[11px] text-faint">{detail.dir}</p>
          )}
        </Card>
      )}

      <div className="space-y-4">
        {/*
          The AI-written custom view — BEFORE THE WIDGETS.
          It runs in isolation: if it throws, only it goes dark, while the
          widgets below and the whole platform stay intact.
        */}
        {app.view && (
          <AiView
            code={app.view.code}
            data={data}
            // Passing `appId` unlocks `ui.save`/`ui.action`. In an app without
            // controls they are NOT PROVIDED — the view only draws.
            {...(app.settings || app.actions?.length ? { appId: app.id } : {})}
            onAction={(response) => {
              if (response.states) applyResults(response.states)
            }}
            onSaved={refresh}
          />
        )}

        {/*
          CONTROLS BEFORE THE WIDGETS. The reason: the user usually comes to
          this page TO DO SOMETHING (refresh a token, restart a bot) — for
          reading, the status in the sidebar is enough already. Pushing the
          actions below the tables and logs would force people to hunt for
          them.
        */}
        {app.actions && app.actions.length > 0 && (
          <ActionButtons
            appId={app.id}
            actions={app.actions}
            onCompleted={(response) => {
              // The server already recomputed the states listed in `refresh`
              // and returned them — no second request is needed.
              if (response.states) applyResults(response.states)
            }}
          />
        )}

        {app.settings && (
          <SettingsForm
            appId={app.id}
            // The app may have restarted after saving — every state is
            // force-refreshed.
            onSaved={refresh}
          />
        )}

        {/*
          States that are not working. Only the ones that NEVER produced a
          value are listed — for the others a real (if stale) value is on
          screen and a warning would only mislead.
        */}
        {failed.length > 0 && (
          <Card className="p-4">
            <div className="text-xs font-medium uppercase tracking-wider text-gold">
              Data unavailable
            </div>
            <ul className="mt-2 space-y-1">
              {failed.map(([name, e]) => (
                <li key={name} className="font-mono text-[11px] text-faint">
                  {name}: {e.error}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {app.widgets.map((w, i) => (
          <WidgetView key={i} w={applyWidgetTemplate(w, data)} />
        ))}
      </div>

      <p className="mt-6 font-mono text-[11px] text-faint">
        {detail?.dir
          ? `Rendered from ${detail.dir} — edit those files and refresh.`
          : 'This page was rendered dynamically from the app manifest — the host UI was not rebuilt.'}
      </p>
    </div>
  )
}
