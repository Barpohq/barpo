// Schedules — work the platform does on its own, at a set time.
//
// Two kinds of row appear here and they read differently:
//
//   recurring — the user (or the agent) set up a repeating task. It can be
//               paused, resumed and deleted.
//   resume    — the platform booked a continuation because a provider limit
//               interrupted a conversation. Nobody asked for it, so the row
//               explains itself: what stopped, and when it picks back up.
//
// The list is kept current over WS (`schedule.changed` / `schedule.removed`),
// so a run finishing while the page is open updates it without a refresh.

import { useCallback, useEffect, useState } from 'react'
import type { Schedule } from '@barpo/shared'
import {
  ApiError,
  createSchedule,
  deleteSchedule,
  fetchSchedules,
  setScheduleStatus,
} from '../lib/api'
import { useToast } from '../lib/toast'
import { ws } from '../lib/ws'
import { Card, PageHead, StatusDot } from '../ui'

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

/**
 * "in 3 hours", "tomorrow at 09:00", "2 days ago".
 *
 * The relative form is the one that answers the question the user actually
 * has ("is this about to run?"), and the absolute time is shown next to it for
 * anything further out than a day — "in 5 days" alone is not enough to plan
 * around.
 */
function whenText(runAt: number, now: number = Date.now()): string {
  const diff = runAt - now
  const absolute = new Date(runAt).toLocaleString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  if (diff < 0) {
    const late = Math.round(-diff / 60000)
    if (late < 60) return `due ${late} min ago`
    return `due ${absolute}`
  }

  const minutes = Math.round(diff / 60000)
  if (minutes < 1) return 'about to run'
  if (minutes < 60) return `in ${minutes} min`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `in ${hours} h · ${absolute}`
  return absolute
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

/**
 * The presets exist because a cron expression is the one part of this form a
 * user can get wrong without noticing. They cover what people actually ask
 * for; the field stays editable for anything else.
 */
const PRESETS: { label: string; cron: string }[] = [
  { label: 'Every day 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays 08:30', cron: '30 8 * * mon-fri' },
  { label: 'Every Monday 09:00', cron: '0 9 * * mon' },
  { label: 'Every Friday 18:00', cron: '0 18 * * fri' },
  { label: '1st of the month', cron: '0 9 1 * *' },
  { label: 'Every hour', cron: '0 * * * *' },
]

function CreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (schedule: Schedule) => void
}) {
  const [title, setTitle] = useState('')
  const [cron, setCron] = useState('0 9 * * *')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { schedule } = await createSchedule({
        title: title.trim(),
        cron: cron.trim(),
        prompt: prompt.trim(),
      })
      onCreated(schedule)
      onClose()
    } catch (e) {
      // The server is the only cron parser — its message names the field and
      // the problem, so it is shown verbatim rather than reworded.
      setError(
        e instanceof ApiError
          ? `${e.message}${e.detail ? ` — ${e.detail}` : ''}`
          : 'Could not create the schedule',
      )
      setBusy(false)
    }
  }

  const inputClass =
    'mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm ' +
    'outline-none focus:border-lazur-dim'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="New schedule"
    >
      <Card className="rise-in max-h-[90vh] w-full max-w-lg overflow-y-auto p-6">
        <form onClick={(e) => e.stopPropagation()} onSubmit={submit}>
          <h2 className="font-display text-lg font-semibold">New schedule</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            The platform opens a new conversation at the chosen time and sends your
            instruction to it — on its own, for as long as the schedule exists.
          </p>

          <label className="mt-4 block text-xs font-medium uppercase tracking-wider text-faint">
            Name
            <input
              className={inputClass}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Daily sales report"
              autoFocus
              required
            />
          </label>

          <div className="mt-4">
            <span className="text-xs font-medium uppercase tracking-wider text-faint">When</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.cron}
                  type="button"
                  onClick={() => setCron(p.cron)}
                  className={`rounded-md px-2 py-1 text-[11px] ${
                    cron === p.cron
                      ? 'bg-lazur-dim text-bg'
                      : 'bg-panel2 text-muted hover:text-fg'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              className={inputClass}
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 9 * * *"
              required
            />
            <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-faint">
              minute hour day month weekday · your local time
            </p>
          </div>

          <label className="mt-4 block text-xs font-medium uppercase tracking-wider text-faint">
            Instruction
            <textarea
              className={`${inputClass} h-32 resize-y font-sans`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Read the sales figures from the /api/sales endpoint, group them by region, apply the discount rules in rules.md and write the result to report-YYYY-MM-DD.md"
              required
            />
          </label>
          {/* The single most common way a schedule fails — and it fails
              silently, every day, until somebody checks. */}
          <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
            Each run starts in a <strong className="text-muted">brand-new, empty chat</strong>. It
            cannot see this page or any earlier conversation, so write out the sources, the rules
            and where the result should go.
          </p>

          {error && (
            <p className="mt-3 rounded-lg bg-coral/10 px-3 py-2 text-xs leading-relaxed text-coral">
              {error}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-panel2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-lazur-dim px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-60"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Delete confirmation
// ---------------------------------------------------------------------------

function DeleteModal({
  schedule,
  onClose,
  onDeleted,
}: {
  schedule: Schedule
  onClose: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await deleteSchedule(schedule.id)
      onDeleted()
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete')
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Delete schedule"
    >
      <Card className="rise-in w-full max-w-sm p-6">
        <div onClick={(e) => e.stopPropagation()}>
          <h2 className="font-display text-lg font-semibold">Delete “{schedule.title}”?</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            It will stop running. The conversations its past runs produced stay where
            they are — only future runs are cancelled.
          </p>

          {error && <p className="mt-3 rounded-lg bg-coral/10 px-3 py-2 text-xs text-coral">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-panel2">
              Cancel
            </button>
            <button
              onClick={remove}
              disabled={busy}
              className="rounded-lg bg-coral/80 px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-60"
            >
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

/** Which dot to show. 'failed' is amber, not red: the schedule still runs. */
function dotStatus(schedule: Schedule): 'healthy' | 'warning' | 'offline' {
  if (schedule.status === 'paused' || schedule.status === 'done') return 'offline'
  if (schedule.status === 'failed' || schedule.lastError) return 'warning'
  return 'healthy'
}

function ScheduleRow({
  schedule,
  onDelete,
  onToggle,
  onOpenSession,
}: {
  schedule: Schedule
  onDelete: (s: Schedule) => void
  onToggle: (s: Schedule) => void
  onOpenSession: (sessionId: string) => void
}) {
  const isResume = schedule.kind === 'resume'
  const finished = schedule.status === 'done'

  return (
    <Card className={`p-5 ${schedule.status === 'failed' ? 'border-coral/40' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-display text-[15px] font-semibold">{schedule.title}</h2>
            {isResume && (
              <span className="shrink-0 rounded-md bg-panel2 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-faint">
                auto
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {isResume
              ? finished
                ? 'the conversation was continued'
                : 'continues a conversation the provider limit interrupted'
              : (schedule.cronText ?? schedule.cron)}
          </div>
        </div>
        <StatusDot status={dotStatus(schedule)} />
      </div>

      {!finished && (
        <div className="mt-3 font-mono text-[11px] text-lazur">{whenText(schedule.runAt)}</div>
      )}

      {schedule.lastError && (
        <p className="mt-3 rounded-lg bg-coral/10 px-3 py-2 font-mono text-[11px] leading-relaxed text-coral">
          {schedule.lastError}
        </p>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-[11px] text-faint">
        <span className="font-mono">
          {schedule.runs === 0 ? 'not run yet' : `${schedule.runs} run${schedule.runs === 1 ? '' : 's'}`}
          {schedule.createdBy !== 'user' && ` · by ${schedule.createdBy}`}
        </span>

        <div className="flex items-center gap-1">
          {schedule.sessionId && (
            <button
              onClick={() => onOpenSession(schedule.sessionId!)}
              className="rounded-md px-2 py-1 text-muted hover:bg-panel2 hover:text-fg"
            >
              open chat
            </button>
          )}
          {/* A finished one-off has nothing left to pause */}
          {!finished && !isResume && (
            <button
              onClick={() => onToggle(schedule)}
              className="rounded-md px-2 py-1 text-muted hover:bg-panel2 hover:text-fg"
            >
              {schedule.status === 'paused' ? 'resume' : 'pause'}
            </button>
          )}
          <button
            onClick={() => onDelete(schedule)}
            className="rounded-md px-2 py-1 text-coral/80 hover:bg-coral/10"
          >
            delete
          </button>
        </div>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Schedules({
  onOpenConversation,
}: {
  onOpenConversation: (sessionId: string) => void
}) {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleting, setDeleting] = useState<Schedule | null>(null)
  const toast = useToast()

  const refresh = useCallback(() => {
    fetchSchedules()
      .then((r) => setSchedules(r.schedules))
      .catch(() => toast('Could not load the schedules', 'error'))
      .finally(() => setLoading(false))
  }, [toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Live updates: a run finishing (or a limit booking a continuation) while
  // this page is open should show up without a manual refresh.
  useEffect(() => {
    const unsubscribe = ws.subscribe(['schedules'])
    const stop = ws.watch((event) => {
      if (event.type === 'schedule.changed') {
        setSchedules((current) => {
          const index = current.findIndex((s) => s.id === event.schedule.id)
          if (index === -1) return [event.schedule, ...current]
          const next = [...current]
          next[index] = event.schedule
          return next
        })
      } else if (event.type === 'schedule.removed') {
        setSchedules((current) => current.filter((s) => s.id !== event.id))
      }
    })
    return () => {
      stop()
      unsubscribe()
    }
  }, [])

  const toggle = async (schedule: Schedule) => {
    const next = schedule.status === 'paused' ? 'active' : 'paused'
    try {
      const { schedule: updated } = await setScheduleStatus(schedule.id, next)
      // The WS event updates the list too; setting it here as well means the
      // button responds even if the socket is down.
      setSchedules((current) => current.map((s) => (s.id === updated.id ? updated : s)))
      toast(next === 'paused' ? `“${schedule.title}” paused` : `“${schedule.title}” resumed`, 'info')
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not change the schedule', 'error')
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="Schedules"
        sub="Work the platform starts on its own — a repeating task, or a conversation waiting for a provider limit to reset"
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {schedules.map((s) => (
          <ScheduleRow
            key={s.id}
            schedule={s}
            onDelete={setDeleting}
            onToggle={toggle}
            onOpenSession={onOpenConversation}
          />
        ))}

        <Card className="flex flex-col items-center justify-center border-dashed p-5 text-center">
          <div className="font-display text-sm font-semibold text-muted">
            {loading ? 'Loading…' : schedules.length === 0 ? 'Nothing scheduled' : 'New schedule'}
          </div>
          <p className="mt-2 max-w-52 text-xs leading-relaxed text-faint">
            Something you do every day or every week — set it up once and the platform
            does it on time, in a fresh conversation.
          </p>
          <button
            onClick={() => setCreateOpen(true)}
            className="mt-3 rounded-lg bg-lazur-dim px-4 py-1.5 text-sm font-medium text-bg"
          >
            Create
          </button>
        </Card>
      </div>

      {createOpen && (
        <CreateModal
          onClose={() => setCreateOpen(false)}
          onCreated={(schedule) => {
            setSchedules((current) => [schedule, ...current])
            toast(`“${schedule.title}” scheduled — ${schedule.cronText ?? schedule.cron}`, 'success')
          }}
        />
      )}

      {deleting && (
        <DeleteModal
          schedule={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setSchedules((current) => current.filter((s) => s.id !== deleting.id))
            toast(`“${deleting.title}” deleted`, 'info')
          }}
        />
      )}
    </div>
  )
}
