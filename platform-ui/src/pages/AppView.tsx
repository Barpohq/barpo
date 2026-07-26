import type { AppManifest, Widget } from '../data/mock'
import { Card, StatTile, StatusDot } from '../ui'

// Manifest'dagi vidjet sxemasini UI'ga aylantiradi — ilovalar o'z dashboardini
// data sifatida olib keladi, host esa render qiladi (server-driven UI).
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
                  w.kind === 'domen' ? 'bg-lazur-dim/15 text-lazur' : 'bg-gold/15 text-gold'
                }`}
              >
                {w.kind === 'domen' ? '🌐 domen ulangan' : '🔌 port preview'}
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
        </div>
      </header>

      <div className="space-y-4">
        {app.widgets.map((w, i) => (
          <WidgetView key={i} w={w} />
        ))}
      </div>

      <p className="mt-6 font-mono text-[11px] text-faint">
        Bu sahifa ilova manifestidan dinamik render qilindi — host UI qayta build qilinmagan.
      </p>
    </div>
  )
}
