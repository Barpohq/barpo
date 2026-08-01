// Schedules — the REST surface behind the Schedules page.
//
// The user's half of the same machinery the agent reaches through its tools.
// What is deliberately NOT here:
//
//   - creating a `resume`. Those exist only because a provider limit was hit,
//     and the platform is the only thing that knows that happened. A
//     hand-made one would point at a conversation that is not waiting.
//   - editing a schedule's prompt. There is no field for it in the UI and no
//     route here: changing what a schedule does without seeing its history
//     invites "why did today's report look different?" with no answer. Delete
//     and recreate, and the list shows both.

import { Hono } from 'hono'
import type { ScheduleStatus } from '@barpo/shared'
import { auditWrite } from '../audit.ts'
import {
  createSchedule,
  deleteSchedule,
  readSchedule,
  readSchedules,
  setScheduleStatus,
} from '../repo.ts'
import { describeCron, nextRunOf } from '../schedule/cron.ts'
import { MAX_SCHEDULES } from '../schedule/schedule-sink.ts'
import { rearm } from '../schedule/scheduler.ts'
import { hub } from '../ws/hub.ts'

export const schedulesRoutes = new Hono()

const TITLE_MAX = 120

schedulesRoutes.get('/schedules', (c) => {
  return c.json({ schedules: readSchedules() })
})

schedulesRoutes.get('/schedules/:id', (c) => {
  const schedule = readSchedule(c.req.param('id'))
  if (!schedule) return c.json({ error: 'Schedule not found' }, 404)
  return c.json({ schedule })
})

interface CreateBody {
  title?: unknown
  cron?: unknown
  prompt?: unknown
  projectId?: unknown
  provider?: unknown
  model?: unknown
}

schedulesRoutes.post('/schedules', async (c) => {
  let body: CreateBody
  try {
    body = (await c.req.json()) as CreateBody
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const cron = typeof body.cron === 'string' ? body.cron.trim() : ''
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''

  if (!title) return c.json({ error: 'A title is required' }, 400)
  if (title.length > TITLE_MAX) {
    return c.json({ error: `The title must not exceed ${TITLE_MAX} characters` }, 400)
  }
  if (!cron) return c.json({ error: 'A cron expression is required' }, 400)
  if (!prompt) return c.json({ error: 'A prompt is required' }, 400)

  if (readSchedules().length >= MAX_SCHEDULES) {
    return c.json(
      { error: `This platform already has ${MAX_SCHEDULES} schedules`, detail: 'Delete one first' },
      409,
    )
  }

  // The expression is validated BEFORE the row is written — the same rule as
  // in `schedule-sink.ts`. A stored schedule that cannot fire would look
  // active in the list and never run.
  let runAt: number | null
  try {
    runAt = nextRunOf(cron)
  } catch (error) {
    return c.json(
      {
        error: 'The cron expression could not be read',
        detail: error instanceof Error ? error.message : String(error),
      },
      400,
    )
  }

  if (runAt === null) {
    return c.json(
      {
        error: 'That expression has no run within the next five years',
        detail: 'Check the day and month fields',
      },
      400,
    )
  }

  const schedule = createSchedule({
    kind: 'recurring',
    title,
    prompt,
    cron,
    runAt,
    createdBy: 'user',
    projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
    provider: typeof body.provider === 'string' ? body.provider : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
  })

  auditWrite('user', 'schedule created', `${title}: ${describeCron(cron)}`.slice(0, 120), 'write', 'OK')
  hub.broadcast({ type: 'schedule.changed', schedule })

  return c.json({ schedule }, 201)
})

/**
 * Pause or resume.
 *
 * Only these two transitions are accepted. 'done' and 'failed' are OUTCOMES —
 * the scheduler writes them after a run, and letting a client set them would
 * make the history a claim rather than a record.
 */
schedulesRoutes.patch('/schedules/:id', async (c) => {
  const id = c.req.param('id')
  const existing = readSchedule(id)
  if (!existing) return c.json({ error: 'Schedule not found' }, 404)

  let body: { status?: unknown }
  try {
    body = (await c.req.json()) as { status?: unknown }
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  const status = body.status
  if (status !== 'active' && status !== 'paused') {
    return c.json(
      {
        error: 'status must be "active" or "paused"',
        detail: '"done" and "failed" are set by the scheduler after a run',
      },
      400,
    )
  }

  // RE-ARMING BEFORE ACTIVATING. A schedule paused last week has a `runAt` in
  // the past, so switching it straight back to active would fire it on the very
  // next tick — and "resume this" means "carry on from the next scheduled
  // time", not "run now and catch up".
  if (status === 'active' && existing.status === 'paused') {
    rearm(existing)
  }

  const updated = setScheduleStatus(id, status as ScheduleStatus)
  if (!updated) return c.json({ error: 'Schedule not found' }, 404)

  auditWrite('user', `schedule ${status === 'paused' ? 'paused' : 'resumed'}`, updated.title.slice(0, 120), 'write', 'OK')
  hub.broadcast({ type: 'schedule.changed', schedule: updated })

  return c.json({ schedule: updated })
})

schedulesRoutes.delete('/schedules/:id', (c) => {
  const id = c.req.param('id')
  const existing = readSchedule(id)
  if (!existing) return c.json({ error: 'Schedule not found' }, 404)

  if (!deleteSchedule(id)) return c.json({ error: 'The schedule could not be deleted' }, 500)

  auditWrite('user', 'schedule deleted', existing.title.slice(0, 120), 'write', 'OK')
  hub.broadcast({ type: 'schedule.removed', id })

  return c.json({ ok: true })
})
