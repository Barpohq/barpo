// The /api/schedules routes — the user's half of the schedule machinery.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { Schedule } from '@barpo/shared'
import { app } from '../src/app.ts'
import { openDb, setDb } from '../src/db.ts'
import {
  createSchedule,
  createSession,
  deleteSession,
  readSchedule,
  readSchedules,
  setScheduleSession,
} from '../src/repo.ts'
import { MAX_SCHEDULES } from '../src/schedule/schedule-sink.ts'
import { hub } from '../src/ws/hub.ts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)
})

afterEach(() => {
  setDb(null)
  hub.clear()
  db.close()
})

const HOUR = 60 * 60 * 1000

async function post(path: string, body: unknown) {
  const response = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function patch(path: string, body: unknown) {
  const response = await app.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function get(path: string) {
  const response = await app.request(path)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** A stored schedule, for the tests that do not go through POST */
function seed(overrides: Partial<Parameters<typeof createSchedule>[0]> = {}) {
  return createSchedule(
    {
      kind: 'recurring',
      title: 'Daily report',
      prompt: 'Prepare the daily report',
      cron: '0 9 * * *',
      runAt: Date.now() + HOUR,
      createdBy: 'user',
      ...overrides,
    },
    db,
  )
}

describe('GET /api/schedules', () => {
  test('an empty list', async () => {
    const { status, body } = await get('/api/schedules')
    expect(status).toBe(200)
    expect(body.schedules).toEqual([])
  })

  test('returns what exists, with the plain-language rendering', async () => {
    seed()
    const { body } = await get('/api/schedules')
    const schedules = body.schedules as Schedule[]
    expect(schedules).toHaveLength(1)
    expect(schedules[0]!.title).toBe('Daily report')
    expect(schedules[0]!.cronText).toBe('every day at 09:00')
  })

  test('a single schedule by id, and 404 for an unknown one', async () => {
    const created = seed()
    expect((await get(`/api/schedules/${created.id}`)).status).toBe(200)
    expect((await get('/api/schedules/nope')).status).toBe(404)
  })
})

describe('POST /api/schedules', () => {
  test('creates one and returns 201', async () => {
    const { status, body } = await post('/api/schedules', {
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(status).toBe(201)
    const schedule = body.schedule as Schedule
    expect(schedule.title).toBe('Daily report')
    expect(schedule.createdBy).toBe('user')
    expect(schedule.status).toBe('active')
    expect(schedule.runAt).toBeGreaterThan(Date.now())
  })

  test('a bad cron expression is rejected BEFORE anything is stored', async () => {
    // A stored schedule that cannot fire looks active in the list and never
    // runs — failure disguised as success.
    const { status, body } = await post('/api/schedules', {
      title: 'Broken',
      cron: 'every morning',
      prompt: 'Prepare the report',
    })

    expect(status).toBe(400)
    expect(body.detail).toBeDefined()
    expect(readSchedules(db)).toHaveLength(0)
  })

  test('an impossible date is rejected', async () => {
    const { status } = await post('/api/schedules', {
      title: 'Never',
      cron: '0 9 31 2 *',
      prompt: 'Prepare the report',
    })
    expect(status).toBe(400)
    expect(readSchedules(db)).toHaveLength(0)
  })

  test('the required fields are required', async () => {
    expect((await post('/api/schedules', { cron: '0 9 * * *', prompt: 'x' })).status).toBe(400)
    expect((await post('/api/schedules', { title: 'x', prompt: 'x' })).status).toBe(400)
    expect((await post('/api/schedules', { title: 'x', cron: '0 9 * * *' })).status).toBe(400)
  })

  test('a non-JSON body is a 400, not a crash', async () => {
    const response = await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(response.status).toBe(400)
  })

  test('the limit is enforced', async () => {
    for (let i = 0; i < MAX_SCHEDULES; i++) seed({ title: `existing ${i}` })

    const { status } = await post('/api/schedules', {
      title: 'One too many',
      cron: '0 9 * * *',
      prompt: 'Prepare the report',
    })

    expect(status).toBe(409)
    expect(readSchedules(db)).toHaveLength(MAX_SCHEDULES)
  })
})

describe('PATCH /api/schedules/:id — pause and resume', () => {
  test('pausing stops it from firing', async () => {
    const created = seed()
    const { status, body } = await patch(`/api/schedules/${created.id}`, { status: 'paused' })

    expect(status).toBe(200)
    expect((body.schedule as Schedule).status).toBe('paused')
  })

  test('resuming moves the next run forward instead of firing immediately', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // A schedule paused last week has a `runAt` in the past. Switching it
    // straight back to active would fire it on the very next tick — "resume
    // this" means "carry on from the next scheduled time".
    // ─────────────────────────────────────────────────────────────────────
    const created = seed({ runAt: Date.now() - 5 * 24 * HOUR })
    await patch(`/api/schedules/${created.id}`, { status: 'paused' })

    const { body } = await patch(`/api/schedules/${created.id}`, { status: 'active' })

    const schedule = body.schedule as Schedule
    expect(schedule.status).toBe('active')
    expect(schedule.runAt).toBeGreaterThan(Date.now())
  })

  test('an outcome status cannot be set by a client', async () => {
    // 'done' and 'failed' are written by the scheduler AFTER a run. Letting a
    // client set them would make the history a claim rather than a record.
    const created = seed()
    for (const status of ['done', 'failed', 'nonsense']) {
      const result = await patch(`/api/schedules/${created.id}`, { status })
      expect(result.status).toBe(400)
    }
    expect(readSchedule(created.id, db)!.status).toBe('active')
  })

  test('an unknown id is a 404', async () => {
    expect((await patch('/api/schedules/nope', { status: 'paused' })).status).toBe(404)
  })
})

describe('DELETE /api/schedules/:id', () => {
  test('deletes it', async () => {
    const created = seed()
    const response = await app.request(`/api/schedules/${created.id}`, { method: 'DELETE' })

    expect(response.status).toBe(200)
    expect(readSchedules(db)).toHaveLength(0)
  })

  test('an unknown id is a 404', async () => {
    const response = await app.request('/api/schedules/nope', { method: 'DELETE' })
    expect(response.status).toBe(404)
  })
})

describe('the list is kept current over WS', () => {
  test('create, pause and delete each announce themselves', async () => {
    const collected: { type: string }[] = []
    hub.connected({
      data: { id: 'x', channels: new Set(['schedules']) },
      send: (m: string) => collected.push(JSON.parse(m) as { type: string }),
    } as never)

    const { body } = await post('/api/schedules', {
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })
    const id = (body.schedule as Schedule).id

    await patch(`/api/schedules/${id}`, { status: 'paused' })
    await app.request(`/api/schedules/${id}`, { method: 'DELETE' })

    const types = collected.map((e) => e.type)
    expect(types.filter((t) => t === 'schedule.changed')).toHaveLength(2)
    expect(types).toContain('schedule.removed')
  })
})

// ===========================================================================
// Deleting a conversation must not delete the schedule that made it
// ===========================================================================

describe('a recurring schedule survives its session being deleted', () => {
  /**
   * ┌────────────────────────────────────────────────────────────────────┐
   * │ A REAL BUG, found by tidying up test conversations and watching   │
   * │ the schedule count drop to zero.                                   │
   * │                                                                    │
   * │ `schedules.session_id` cascades on delete, which is right for a    │
   * │ `resume` (its session IS the work) and wrong for a `recurring`,    │
   * │ where the column is only a link to the LATEST run. Without the     │
   * │ trigger from migration 017, deleting last week's conversation      │
   * │ silently cancelled the user's daily report — no error, no warning, │
   * │ the row simply gone.                                               │
   * │                                                                    │
   * │ Migration 016's own comment claimed `scheduler.ts` prevented this. │
   * │ It never did.                                                      │
   * └────────────────────────────────────────────────────────────────────┘
   */
  test('the schedule stays, and only its link is cleared', () => {
    const session = createSession('a run of the schedule', db)
    const schedule = seed()
    setScheduleSession(schedule.id, session.id, db)
    expect(readSchedule(schedule.id, db)!.sessionId).toBe(session.id)

    deleteSession(session.id, db)

    const after = readSchedule(schedule.id, db)
    expect(after).not.toBeNull()
    expect(after!.sessionId).toBeUndefined()
    // Still armed for its next run — the deletion changed nothing else
    expect(after!.status).toBe('active')
    expect(after!.cron).toBe('0 9 * * *')
  })

  test('a resume schedule DOES go with its session', () => {
    // The opposite case, and it must keep working: a continuation whose
    // conversation is gone has nothing left to continue.
    const session = createSession('interrupted', db)
    const schedule = createSchedule(
      {
        kind: 'resume',
        title: 'continue',
        prompt: 'carry on',
        runAt: Date.now() + HOUR,
        createdBy: 'system',
        sessionId: session.id,
      },
      db,
    )

    deleteSession(session.id, db)

    expect(readSchedule(schedule.id, db)).toBeNull()
  })

  test('only the affected schedule is touched', () => {
    // The trigger updates by `session_id`; a bug there could clear every
    // recurring row on the platform.
    const session = createSession('a run', db)
    const linked = seed({ title: 'linked' })
    const other = seed({ title: 'untouched' })
    setScheduleSession(linked.id, session.id, db)

    deleteSession(session.id, db)

    expect(readSchedule(linked.id, db)!.sessionId).toBeUndefined()
    expect(readSchedule(other.id, db)!.sessionId).toBeUndefined()
    expect(readSchedules(db)).toHaveLength(2)
  })
})
