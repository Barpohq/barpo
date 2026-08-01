// The audit log — read from the DATABASE, not from a fixture.
//
// The page used to render a hardcoded fixture, which meant it showed the same
// twelve invented rows regardless of what the platform had actually done —
// including on a fresh install that had done nothing at all. Now it reads
// `/api/audit` and filters on the server (the log
// grows without bound, so filtering in the browser would not scale) and stays
// live: `auditWrite` broadcasts every new entry over the WS.

import { useEffect, useState } from 'react'
import { CHANNELS, type AuditEntry, type AuditLevel } from '@platforma/shared'
import { fetchAudit } from '../lib/api'
import { LEVEL_LABEL, RESULT_LABEL } from '../lib/audit-label'
import { ws } from '../lib/ws'
import { Card, LevelBadge, PageHead } from '../ui'

// The keys come from the database — their labels live in `lib/audit-label.ts`
const resultStyle: Record<string, string> = {
  OK: 'text-mint',
  approved: 'text-mint',
  denied: 'text-coral',
  pending: 'text-gold',
}

/** `all` is a filter value — it never occurs in the database */
const levels: (AuditLevel | 'all')[] = ['all', 'read', 'write', 'dangerous']

const levelLabel = (l: (typeof levels)[number]): string =>
  l === 'all' ? 'all' : LEVEL_LABEL[l]

export default function Audit() {
  const [level, setLevel] = useState<(typeof levels)[number]>('all')
  const [actor, setActor] = useState('all')

  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [actors, setActors] = useState<string[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Refetch whenever a filter changes — the server does the filtering, so a
  // widened filter can bring back rows the previous response never held.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchAudit({ level, actor })
      .then((page) => {
        if (cancelled) return
        setEntries(page.entries)
        setActors(page.actors)
        setTotal(page.total)
        setError(null)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [level, actor])

  // Live entries. A new row is prepended locally rather than refetched: the
  // list is sorted newest-first, so this keeps the page in step without a
  // request per event.
  useEffect(() => {
    ws.connect()
    const unsubscribe = ws.subscribe([CHANNELS.audit])
    const unwatch = ws.watch((event) => {
      if (event.type !== 'audit.entry') return
      const entry = event.entry
      // The active filter applies to live entries too — otherwise a row that
      // the filter excludes would appear anyway and look like a bug.
      if (level !== 'all' && entry.level !== level) return
      if (actor !== 'all' && entry.actor !== actor) return
      setEntries((previous) => [entry, ...previous])
      setTotal((n) => n + 1)
      // A brand-new actor has to reach the dropdown, or it could never be
      // selected until the next reload.
      setActors((previous) =>
        previous.includes(entry.actor) ? previous : [...previous, entry.actor].sort(),
      )
    })
    return () => {
      unwatch()
      unsubscribe()
    }
  }, [level, actor])

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="Audit log"
        sub="Every action is recorded: who, what, when and at which level. Append-only — it cannot be edited"
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-xs text-faint">Level:</span>
          {levels.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={`rounded-full px-3 py-1 text-xs transition ${
                level === l ? 'bg-lazur-dim font-semibold text-bg' : 'border border-line text-muted hover:text-ink'
              }`}
            >
              {levelLabel(l)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-faint">
          Actor:
          <select
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            className="rounded-lg border border-line bg-panel px-2 py-1 font-mono text-xs text-ink"
          >
            {['all', ...actors].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto font-mono text-[11px] text-faint">
          {/* `total` counts every matching row; `entries` is capped by the
              server's limit, so the two can differ on a busy platform */}
          {entries.length < total ? `${entries.length} of ${total} entries` : `${total} entries`}
        </span>
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-coral/10 px-4 py-3 text-sm text-coral">
          Could not load the audit log: {error}
        </p>
      )}

      <Card className="overflow-hidden">
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-faint">
                <th className="px-5 py-2.5 font-medium">Time</th>
                <th className="px-3 py-2.5 font-medium">Actor</th>
                <th className="px-3 py-2.5 font-medium">Action</th>
                <th className="px-3 py-2.5 font-medium">Target</th>
                <th className="px-3 py-2.5 font-medium">Level</th>
                <th className="px-5 py-2.5 text-right font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i} className="border-t border-line/60">
                  <td className="px-5 py-2.5 font-mono text-xs text-faint">{e.time}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-lazur">{e.actor}</td>
                  <td className="px-3 py-2.5 text-[13px]">{e.action}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-muted">{e.target}</td>
                  <td className="px-3 py-2.5"><LevelBadge level={e.level} /></td>
                  <td className={`px-5 py-2.5 text-right font-mono text-xs ${resultStyle[e.result]}`}>
                    {RESULT_LABEL[e.result] ?? e.result}
                  </td>
                </tr>
              ))}
              {entries.length === 0 && !error && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-sm text-faint">
                    {loading
                      ? 'Loading…'
                      : level === 'all' && actor === 'all'
                        ? 'The log is empty — it fills up as soon as the platform does something'
                        : 'No entries match this filter — try widening it'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
