// The audit log — read from the DATABASE, not from a fixture.
//
// The page used to render a hardcoded fixture, which meant it showed the same
// twelve invented rows regardless of what the platform had actually done —
// including on a fresh install that had done nothing at all. Now it reads
// `/api/audit` and filters on the server (the log grows without bound, so
// filtering in the browser would not scale) and stays live: `auditWrite`
// broadcasts every new entry over the WS.
//
// The log is PAGED: the server caps a response, so older entries are fetched
// on demand rather than being unreachable behind the first hundred rows.

import { useCallback, useEffect, useRef, useState } from 'react'
import { CHANNELS, type AuditEntry, type AuditLevel } from '@barpo/shared'
import { fetchAudit } from '../lib/api'
import { LEVEL_LABEL, RESULT_LABEL } from '../lib/audit-label'
import { auditDate } from '../lib/date'
import { ws } from '../lib/ws'
import { Card, LevelBadge, PageHead } from '../ui'

/** Entries per request — also the size of one "load more" step */
const PAGE_SIZE = 100

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

/**
 * Are these the same entry — used to drop duplicates when a live row and a
 * fetched page overlap.
 *
 * `AuditEntry` carries no id (the table's primary key is not exposed), so the
 * comparison is by content. `at` is the ISO instant and makes a collision
 * essentially impossible; the remaining fields cover entries written before
 * that field existed.
 */
function sameEntry(a: AuditEntry, b: AuditEntry): boolean {
  return (
    a.at === b.at &&
    a.time === b.time &&
    a.actor === b.actor &&
    a.action === b.action &&
    a.target === b.target
  )
}

export default function Audit() {
  const [level, setLevel] = useState<(typeof levels)[number]>('all')
  const [actor, setActor] = useState('all')

  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [actors, setActors] = useState<string[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Entries that arrived over the WS while a request was in flight.
   *
   * WITHOUT THIS they are lost: the server takes its snapshot, an action
   * happens, the WS handler prepends the row — and then the response lands and
   * `setEntries` replaces it with the older snapshot. A real action would
   * silently vanish from the log until the next filter change. Same reasoning
   * as the merge in `lib/apps.ts` and `lib/running.ts`.
   *
   * A ref, not state: it must be readable inside the fetch callback without
   * re-running the effect that owns the request.
   */
  const liveDuringFetch = useRef<AuditEntry[]>([])

  /** Does this entry belong on screen under the filter that is active now */
  const matchesFilter = useCallback(
    (entry: AuditEntry) =>
      (level === 'all' || entry.level === level) && (actor === 'all' || entry.actor === actor),
    [level, actor],
  )

  // Refetch whenever a filter changes — the server does the filtering, so a
  // widened filter can bring back rows the previous response never held.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    liveDuringFetch.current = []
    fetchAudit({ level, actor, limit: PAGE_SIZE })
      .then((page) => {
        if (cancelled) return
        // Anything that arrived mid-request goes back on top. It is newer than
        // everything in the snapshot, so prepending keeps the newest-first
        // order; the id check guards against the entry being in both.
        const live = liveDuringFetch.current.filter(
          (l) => !page.entries.some((e) => sameEntry(e, l)),
        )
        liveDuringFetch.current = []
        setEntries([...live, ...page.entries])
        setActors(page.actors)
        setTotal(page.total + live.length)
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
      if (!matchesFilter(entry)) return
      // Remembered as well, in case a request is in flight right now (see the
      // ref above). Harmless when there is none: it is cleared on every fetch.
      liveDuringFetch.current = [entry, ...liveDuringFetch.current]
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
  }, [matchesFilter])

  /**
   * The next page of OLDER entries.
   *
   * The offset is `entries.length` minus whatever arrived live, because those
   * rows sit in front of the server's window and would otherwise shift it —
   * skipping one older entry for each live one.
   */
  function loadMore() {
    setLoadingMore(true)
    fetchAudit({ level, actor, limit: PAGE_SIZE, offset: entries.length })
      .then((page) => {
        setEntries((previous) => [
          ...previous,
          // A live entry can already be on screen; do not repeat it
          ...page.entries.filter((e) => !previous.some((p) => sameEntry(p, e))),
        ])
        setTotal(page.total)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingMore(false))
  }

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
                  <td className="px-5 py-2.5 font-mono text-xs whitespace-nowrap text-faint">
                    {/* The day comes first and only when it is not today —
                        without it two entries a week apart read identically */}
                    {auditDate(e.at) && (
                      <span className="mr-1.5 text-faint/70">{auditDate(e.at)}</span>
                    )}
                    {e.time}
                  </td>
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

      {/* Older entries. The server caps a response, so without this the rows
          past the first page would be unreachable from the UI entirely. */}
      {entries.length < total && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-lg border border-line px-4 py-2 text-[13px] text-muted transition hover:border-lazur-dim hover:text-lazur disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - entries.length)} older`}
          </button>
        </div>
      )}
    </div>
  )
}
