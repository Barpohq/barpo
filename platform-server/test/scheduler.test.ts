// The scheduler: the tick, what firing does, and the limit → resume path.
//
// The LLM is never called — `@platforma/ai` is mocked the same way
// `orchestrator.test.ts` does it (the mock must run before the imports, hence
// the shape of this file).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHAT THESE TESTS ARE REALLY PROTECTING. This code runs when nobody   │
// │ is watching, so its failure modes are silent by construction: a      │
// │ report that never arrives, a conversation resumed twice, a timer     │
// │ that died three days ago. None of them produce a stack trace anyone  │
// │ will read. The properties below are the ones that would otherwise    │
// │ be discovered by their absence.                                      │
// └──────────────────────────────────────────────────────────────────────┘

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerEvent } from '@platforma/shared'

let fakeEvents: unknown[] = []
/** Set by the fake stream so tests can see WHICH session was streamed */
let streamedSessions: string[] = []
/**
 * Awaited by the fake stream before it yields — lets a test hold a run open
 * and prove that a second tick does not start the same schedule again.
 */
let streamHold: Promise<void> | null = null

const realAi = await import('@platforma/ai')
const realPermissionManager = realAi.permissionManager
const listenerAdded = new WeakSet<object>()

function denyingPermissions(sessionId: string) {
  const manager = realPermissionManager(sessionId)
  if (!listenerAdded.has(manager)) {
    listenerAdded.add(manager)
    manager.subscribe((request) => manager.answer(request.id, 'deny'))
  }
  return manager
}

/** A model list the scheduler can pick from, without touching the network */
const fakeModels = {
  models: [
    { provider: 'ollama', id: 'qwen3:0.6b', name: 'Qwen', vision: false },
    { provider: 'anthropic', id: 'claude-x', name: 'Claude', vision: true },
  ],
  providers: [],
  warnings: [],
  time: new Date().toISOString(),
}

mock.module('@platforma/ai', () => ({
  ...realAi,
  conversationStream: async function* (_c: unknown, _m: unknown, _o: unknown) {
    for (const e of fakeEvents) yield e
  },
  agentStream: async function* (_c: unknown, _m: unknown, options: { sessionId?: string }) {
    if (options?.sessionId) streamedSessions.push(options.sessionId)
    // Held open when a test wants to observe two ticks overlapping
    if (streamHold) await streamHold
    for (const e of fakeEvents) yield e
  },
  permissionManager: denyingPermissions,
  // ┌──────────────────────────────────────────────────────────────────────┐
  // │ `cachedResult` IS DELIBERATELY NOT MOCKED, even though the scheduler │
  // │ calls it. `mock.module` replaces the module GLOBALLY, for every test │
  // │ file in the process — and `chat-send.ts` uses `cachedResult()` for   │
  // │ the vision guard. Overriding it here made `chat.test.ts` see this    │
  // │ file's fake model list, so an image sent to a text-only model was    │
  // │ accepted instead of rejected: a security check silently disabled by  │
  // │ an unrelated test file.                                              │
  // │                                                                      │
  // │ Only `detectModels` is replaced. The scheduler falls back to it when │
  // │ the cache is empty, which is exactly the state in these tests.       │
  // └──────────────────────────────────────────────────────────────────────┘
  detectModels: async () => fakeModels,
}))

const { openDb, setDb } = await import('../src/db.ts')
const { clearRunningStreams, streamReply } = await import('../src/orchestrator.ts')
const {
  createSchedule,
  createSession,
  deleteSession,
  lockSessionModel,
  readMessages,
  readSchedule,
  readSchedules,
  readSessions,
  pendingResume,
} = await import('../src/repo.ts')
const {
  MAX_LATENESS_MS,
  RESUME_PROMPT,
  SCHEDULED_RUN_NOTE,
  planResume,
  rearm,
  tick,
  stopScheduler,
} = await import(
  '../src/schedule/scheduler.ts'
)
const { hub } = await import('../src/ws/hub.ts')
const { clearModes, modeManager } = realAi

let db: Database
let received: ServerEvent[]
let worksDir: string

function fakeWs() {
  const collected: ServerEvent[] = []
  const ws = {
    data: { id: 'fake', channels: new Set(['chat', 'audit', 'schedules']) },
    send: (m: string) => collected.push(JSON.parse(m) as ServerEvent),
  }
  return { ws: ws as never, collected }
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

/** A successful one-line reply */
const okReply = [
  { kind: 'delta', text: 'done' },
  { kind: 'done', text: 'done', usage: { input: 1, output: 1, cost: 0 } },
]

beforeEach(() => {
  clearRunningStreams()
  stopScheduler()
  clearModes()
  worksDir = mkdtempSync(join(tmpdir(), 'sched-works-'))
  process.env.PLATFORM_WORKS = worksDir

  // ┌──────────────────────────────────────────────────────────────────────┐
  // │ A SCHEDULED RUN REFUSES TO START WITHOUT A PERMISSION CLASSIFIER,    │
  // │ so most of these tests need one to exist.                            │
  // │                                                                      │
  // │ `PLATFORM_CLASSIFIER_MODEL` is used rather than mocking              │
  // │ `cachedResult`, because that mock is GLOBAL: overriding it here once │
  // │ disabled the vision guard in `chat.test.ts` (an unrelated file), and │
  // │ a security check silently switched off by a test is not a trade      │
  // │ worth repeating. The env var is read first by `pickClassifierModel`  │
  // │ and touches nothing else.                                            │
  // │                                                                      │
  // │ The tests that check the REFUSAL path delete it deliberately.        │
  // └──────────────────────────────────────────────────────────────────────┘
  process.env.PLATFORM_CLASSIFIER_MODEL = 'ollama/qwen3:0.6b'

  db = openDb(':memory:')
  setDb(db)
  const fake = fakeWs()
  received = fake.collected
  hub.connected(fake.ws)
  received.length = 0
  fakeEvents = okReply
  streamedSessions = []
  streamHold = null
})

afterEach(() => {
  stopScheduler()
  clearModes()
  delete process.env.PLATFORM_WORKS
  delete process.env.PLATFORM_CLASSIFIER_MODEL
  rmSync(worksDir, { recursive: true, force: true })
  setDb(null)
  hub.clear()
  db.close()
})

// ===========================================================================
// The tick: what it picks up and what it leaves alone
// ===========================================================================

describe('tick — selecting what is due', () => {
  test('a schedule in the future is left alone', async () => {
    const now = Date.now()
    createSchedule(
      {
        kind: 'recurring',
        title: 'later',
        prompt: 'do it',
        cron: '0 9 * * *',
        runAt: now + HOUR,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)

    expect(readSessions(db)).toHaveLength(0)
    expect(readSchedules(db)[0]!.runs).toBe(0)
  })

  test('a paused schedule never fires, even when overdue', async () => {
    const now = Date.now()
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'paused',
        prompt: 'do it',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )
    db.prepare("UPDATE schedules SET status = 'paused' WHERE id = ?").run(s.id)

    await tick(now)

    expect(readSessions(db)).toHaveLength(0)
    expect(readSchedule(s.id, db)!.runs).toBe(0)
  })

  test('a due schedule fires', async () => {
    const now = Date.now()
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'daily report',
        prompt: 'Prepare the report',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)

    expect(readSchedule(s.id, db)!.runs).toBe(1)
    expect(readSessions(db)).toHaveLength(1)
  })

  test('a pause made DURING a run survives the run finishing', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // An agent run takes minutes, and Pause is a button the user can press
    // in any of them. Recording the outcome afterwards used to write
    // 'active' unconditionally, so the pause was undone seconds after the
    // UI confirmed it — and the schedule carried on doing unattended work
    // the user believed they had stopped. The next firing is still
    // recorded, so unpausing later resumes the right rhythm; only the
    // status is left alone.
    // ─────────────────────────────────────────────────────────────────────
    const now = Date.now()
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'daily report',
        prompt: 'Prepare the report',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    // Hold the stream open, so the pause lands while the run is in flight.
    let release: () => void = () => {}
    streamHold = new Promise<void>((resolve) => {
      release = resolve
    })

    const running = tick(now)
    // The user presses Pause — exactly what the PATCH route writes.
    db.prepare("UPDATE schedules SET status = 'paused' WHERE id = ?").run(s.id)
    release()
    await running

    const after = readSchedule(s.id, db)!
    expect(after.status).toBe('paused')
    expect(after.runs).toBe(1)
    // …and it stays paused: the next tick must not pick it up.
    await tick(after.runAt + MINUTE)
    expect(readSchedule(s.id, db)!.runs).toBe(1)
  })
})

// ===========================================================================
// Recurring runs
// ===========================================================================

describe('a recurring schedule fires into a NEW session', () => {
  test('every firing opens its own conversation', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // The property that keeps a daily report reproducible: run number seven
    // must start from the same blank context as run number one. Appending to
    // one long session would make today's report depend on last week's.
    // ─────────────────────────────────────────────────────────────────────
    const start = Date.now()
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'daily report',
        prompt: 'Prepare the report',
        cron: '0 9 * * *',
        runAt: start - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(start)
    const afterFirst = readSchedule(s.id, db)!
    // Fire it again by moving the clock to its next firing
    await tick(afterFirst.runAt + MINUTE)

    expect(readSchedule(s.id, db)!.runs).toBe(2)
    const sessions = readSessions(db)
    expect(sessions).toHaveLength(2)
    expect(sessions[0]!.id).not.toBe(sessions[1]!.id)
  })

  test('the prompt is written as the user message of the new session', async () => {
    const now = Date.now()
    createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'Prepare the daily report from the APIs',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)

    const session = readSessions(db)[0]!
    const messages = readMessages(session.id, db)
    expect(messages[0]!.role).toBe('user')
    // The stored prompt is carried through UNCHANGED — it is only preceded by
    // the note telling the agent it is inside a scheduled run (see the
    // `SCHEDULED_RUN_NOTE` tests below).
    expect(messages[0]!.text).toContain('Prepare the daily report from the APIs')
    expect(messages[0]!.text.endsWith('Prepare the daily report from the APIs')).toBe(true)
  })

  test('the session title carries the date, so the list is readable', async () => {
    const now = new Date(2026, 7, 1, 9, 0).getTime()
    createSchedule(
      {
        kind: 'recurring',
        title: 'daily report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)

    expect(readSessions(db)[0]!.title).toBe('daily report — 2026-08-01')
  })

  test('the next firing is armed from the cron expression', async () => {
    const now = new Date(2026, 7, 1, 9, 0, 30).getTime()
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)

    const after = readSchedule(s.id, db)!
    expect(after.status).toBe('active')
    expect(new Date(after.runAt)).toEqual(new Date(2026, 7, 2, 9, 0))
  })

  test('the project is carried into the new session', async () => {
    const now = Date.now()
    const project = db.prepare(
      "INSERT INTO projects (id, name, folder, created_at) VALUES ('p1', 'proj', ?, ?)",
    )
    project.run(worksDir, new Date().toISOString())

    createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
        projectId: 'p1',
      },
      db,
    )

    await tick(now)

    // All the runs of one schedule share a work directory — otherwise each
    // day's files would land somewhere new.
    expect(readSessions(db)[0]!.projectId).toBe('p1')
  })

  test('the schedule points at the session its run created', async () => {
    const now = Date.now()
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)

    expect(readSchedule(s.id, db)!.sessionId).toBe(readSessions(db)[0]!.id)
  })
})

describe('a recurring schedule that fails', () => {
  test('re-arms anyway — one broken report is not a reason to stop reporting', async () => {
    fakeEvents = [{ kind: 'error', message: 'provider exploded' }]
    const now = new Date(2026, 7, 1, 9, 0, 30).getTime()
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)

    const after = readSchedule(s.id, db)!
    expect(after.status).toBe('active')
    expect(after.lastError).toContain('provider exploded')
    expect(new Date(after.runAt)).toEqual(new Date(2026, 7, 2, 9, 0))
  })

  test('the error is cleared by the next successful run', async () => {
    fakeEvents = [{ kind: 'error', message: 'transient failure' }]
    const now = new Date(2026, 7, 1, 9, 0, 30).getTime()
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)
    expect(readSchedule(s.id, db)!.lastError).toBeDefined()

    fakeEvents = okReply
    await tick(readSchedule(s.id, db)!.runAt + MINUTE)

    expect(readSchedule(s.id, db)!.lastError).toBeUndefined()
    expect(readSchedule(s.id, db)!.runs).toBe(2)
  })
})

// ===========================================================================
// The laptop-lid problem
// ===========================================================================

describe('a missed run — the machine was asleep', () => {
  test('a slightly late run still happens', async () => {
    // The whole reason `dueSchedules` uses `<=`: a report that arrives by
    // lunch is still the report.
    const due = new Date(2026, 7, 1, 9, 0).getTime()
    const wokeUp = due + 2 * HOUR
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: due,
        createdBy: 'user',
      },
      db,
    )

    await tick(wokeUp)

    expect(readSchedule(s.id, db)!.runs).toBe(1)
    expect(readSessions(db)).toHaveLength(1)
  })

  test('a run that is too late is SKIPPED, not run', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // A week away from the machine must not produce seven reports at
    // breakfast, all of them about today.
    // ─────────────────────────────────────────────────────────────────────
    const due = new Date(2026, 7, 1, 9, 0).getTime()
    const wokeUp = due + MAX_LATENESS_MS + HOUR
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: due,
        createdBy: 'user',
      },
      db,
    )

    await tick(wokeUp)

    expect(readSessions(db)).toHaveLength(0)
    const after = readSchedule(s.id, db)!
    // It re-arms — a skip is not a failure of the schedule itself
    expect(after.status).toBe('active')
    expect(after.lastError).toContain('Skipped')
    expect(after.runAt).toBeGreaterThan(wokeUp)
  })

  test('a skipped run says WHY, so the missing report has an explanation', async () => {
    const due = new Date(2026, 7, 1, 9, 0).getTime()
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: due,
        createdBy: 'user',
      },
      db,
    )

    await tick(due + 2 * 24 * HOUR)

    expect(readSchedule(s.id, db)!.lastError).toMatch(/2 days ago/)
  })
})

// ===========================================================================
// Resume — continuing after a provider limit
// ===========================================================================

describe('a resume schedule', () => {
  /** A session with a model locked, as a real conversation would have */
  function conversation() {
    const session = createSession('interrupted', db)
    lockSessionModel(session.id, 'ollama', 'qwen3:0.6b', db)
    return session
  }

  test('continues the SAME conversation, not a new one', async () => {
    const now = Date.now()
    const session = conversation()
    createSchedule(
      {
        kind: 'resume',
        title: 'continue',
        prompt: RESUME_PROMPT,
        runAt: now - MINUTE,
        createdBy: 'system',
        sessionId: session.id,
      },
      db,
    )

    await tick(now)

    expect(readSessions(db)).toHaveLength(1)
    expect(streamedSessions).toEqual([session.id])
    expect(readMessages(session.id, db).some((m) => m.text === RESUME_PROMPT)).toBe(true)
  })

  test('is finished after one run — it does not re-arm', async () => {
    const now = Date.now()
    const session = conversation()
    const s = createSchedule(
      {
        kind: 'resume',
        title: 'continue',
        prompt: RESUME_PROMPT,
        runAt: now - MINUTE,
        createdBy: 'system',
        sessionId: session.id,
      },
      db,
    )

    await tick(now)
    expect(readSchedule(s.id, db)!.status).toBe('done')

    // A second tick must not run it again
    await tick(now + HOUR)
    expect(readSchedule(s.id, db)!.runs).toBe(1)
  })

  test('a deleted conversation retires the schedule instead of crashing', async () => {
    const now = Date.now()
    const session = conversation()
    const s = createSchedule(
      {
        kind: 'resume',
        title: 'continue',
        prompt: RESUME_PROMPT,
        runAt: now - MINUTE,
        createdBy: 'system',
        sessionId: session.id,
      },
      db,
    )
    // A run already in flight can outlive the delete, so this path has to hold
    // even though the CASCADE usually gets there first.
    db.exec('PRAGMA foreign_keys = OFF')
    deleteSession(session.id, db)

    await tick(now)

    expect(readSchedule(s.id, db)!.status).toBe('failed')
    expect(readSchedule(s.id, db)!.lastError).toContain('deleted')
  })

  test('a conversation the user already continued is left alone', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // The user came back before the limit reset and carried on by hand.
    // Sending a second "carry on" would interrupt their own message — and
    // marking the schedule FAILED for correctly doing nothing would be a lie
    // in the audit trail.
    // ─────────────────────────────────────────────────────────────────────
    const now = Date.now()
    const session = conversation()
    const s = createSchedule(
      {
        kind: 'resume',
        title: 'continue',
        prompt: RESUME_PROMPT,
        runAt: now - MINUTE,
        createdBy: 'system',
        sessionId: session.id,
      },
      db,
    )

    // Start a stream and leave it running
    fakeEvents = [{ kind: 'delta', text: 'still going' }]
    const running = streamReply(session.id, 'msg-live', {
      provider: 'ollama',
      model: 'qwen3:0.6b',
    })

    await tick(now)

    const after = readSchedule(s.id, db)!
    expect(after.status).toBe('done')
    expect(after.lastError).toBeUndefined()

    await running
  })
})

// ===========================================================================
// planResume — the orchestrator's entry point
// ===========================================================================

describe('planResume', () => {
  test('books a continuation and announces it', () => {
    const session = createSession('limited', db)
    const resumeAt = Date.now() + HOUR

    const schedule = planResume(
      { sessionId: session.id, resumeAt, reason: 'rate limit reached' },
      null,
    )

    expect(schedule).not.toBeNull()
    expect(schedule!.kind).toBe('resume')
    expect(schedule!.createdBy).toBe('system')
    expect(schedule!.runAt).toBe(resumeAt)
    expect(received.some((e) => e.type === 'schedule.changed')).toBe(true)
  })

  test('does not book a SECOND continuation for the same conversation', () => {
    // ─────────────────────────────────────────────────────────────────────
    // A limit error arrives more than once in normal use: the user retries,
    // or two streams overlap. Without this check the conversation would be
    // queued to continue three times and would answer itself three times.
    // ─────────────────────────────────────────────────────────────────────
    const session = createSession('limited', db)
    const first = planResume(
      { sessionId: session.id, resumeAt: Date.now() + HOUR, reason: 'rate limit' },
      null,
    )

    const second = planResume(
      { sessionId: session.id, resumeAt: Date.now() + 2 * HOUR, reason: 'rate limit' },
      pendingResume(session.id, db),
    )

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(readSchedules(db).filter((s) => s.kind === 'resume')).toHaveLength(1)
  })

  test('a finished continuation does not block a new one', () => {
    // The conversation hit the limit again a week later — that IS a new
    // continuation, and `pendingResume` only looks at active rows.
    const session = createSession('limited', db)
    const first = planResume(
      { sessionId: session.id, resumeAt: Date.now() + HOUR, reason: 'rate limit' },
      null,
    )
    db.prepare("UPDATE schedules SET status = 'done' WHERE id = ?").run(first!.id)

    const second = planResume(
      { sessionId: session.id, resumeAt: Date.now() + HOUR, reason: 'rate limit' },
      pendingResume(session.id, db),
    )

    expect(second).not.toBeNull()
  })

  test('a continuation that is ALREADY DUE is moved, not treated as a duplicate', () => {
    // ─────────────────────────────────────────────────────────────────────
    // The row that is due is the run happening right now — it is still
    // 'active' because `markScheduleRun` only writes when the stream ends.
    // Treating it as a duplicate and returning `null` left the user with a
    // promised time that had already gone.
    // ─────────────────────────────────────────────────────────────────────
    const now = Date.now()
    const session = createSession('limited', db)
    const running = createSchedule(
      {
        kind: 'resume',
        title: 'continue',
        prompt: RESUME_PROMPT,
        runAt: now - MINUTE,
        createdBy: 'system',
        sessionId: session.id,
      },
      db,
    )

    const again = planResume(
      { sessionId: session.id, resumeAt: now + 2 * HOUR, reason: 'rate limit' },
      running,
      now,
    )

    // The SAME row, carried forward — not a second one queued behind it.
    expect(again).not.toBeNull()
    expect(again!.id).toBe(running.id)
    expect(again!.runAt).toBe(now + 2 * HOUR)
    expect(readSchedules(db).filter((s) => s.kind === 'resume')).toHaveLength(1)
  })

  test('a continuation still in the future is left exactly where it is', () => {
    // The ordinary duplicate: two streams overlapped, or the user retried.
    const now = Date.now()
    const session = createSession('limited', db)
    const booked = createSchedule(
      {
        kind: 'resume',
        title: 'continue',
        prompt: RESUME_PROMPT,
        runAt: now + HOUR,
        createdBy: 'system',
        sessionId: session.id,
      },
      db,
    )

    const again = planResume(
      { sessionId: session.id, resumeAt: now + 3 * HOUR, reason: 'rate limit' },
      booked,
      now,
    )

    expect(again).toBeNull()
    // The original time is untouched — the later error must not push a
    // continuation the user was already promised further away.
    expect(readSchedule(booked.id, db)!.runAt).toBe(now + HOUR)
  })
})

// ===========================================================================
// A continuation that hits the same limit again
// ===========================================================================

describe('a resume run that hits the limit a second time', () => {
  /**
   * The whole loop end to end: a `resume` fires, the provider refuses it for
   * the same reason, and the question is whether anything is still pending
   * when the dust settles.
   *
   * ┌──────────────────────────────────────────────────────────────────────┐
   * │ THE FAILURE THIS PROTECTS AGAINST IS INVISIBLE. The user is shown    │
   * │ "the conversation continues at 15:40" and then nothing ever happens: │
   * │ the row that would have done it was retired as 'failed' by the very  │
   * │ run that booked the new time. No error, no missing schedule in the   │
   * │ list — just a conversation that stops for good.                      │
   * └──────────────────────────────────────────────────────────────────────┘
   */
  function limitedConversation() {
    const session = createSession('interrupted', db)
    lockSessionModel(session.id, 'ollama', 'qwen3:0.6b', db)
    return session
  }

  test('stays armed at the NEW reset time instead of dying as failed', async () => {
    const now = Date.now()
    const session = limitedConversation()
    const s = createSchedule(
      {
        kind: 'resume',
        title: 'continue',
        prompt: RESUME_PROMPT,
        runAt: now - MINUTE,
        createdBy: 'system',
        sessionId: session.id,
      },
      db,
    )

    // The continuation runs, and the provider refuses it all over again.
    fakeEvents = [{ kind: 'error', message: 'Rate limit reached. Try again in 30 minutes.' }]
    await tick(now)

    const after = readSchedule(s.id, db)!
    expect(after.status).toBe('active')
    expect(after.runAt).toBeGreaterThan(now)
    // Carried forward on the same row — a second one would make the
    // conversation answer itself twice when both fired.
    expect(readSchedules(db).filter((x) => x.kind === 'resume')).toHaveLength(1)
    expect(after.runs).toBe(1)
  })

  test('the user is told a time that is still ahead of them', async () => {
    // The promise on screen and the row behind it must agree — that is the
    // difference between "paused until 15:40" being a fact and being a guess
    // about a firing that already went past.
    const now = Date.now()
    const session = limitedConversation()
    createSchedule(
      {
        kind: 'resume',
        title: 'continue',
        prompt: RESUME_PROMPT,
        runAt: now - MINUTE,
        createdBy: 'system',
        sessionId: session.id,
      },
      db,
    )

    fakeEvents = [{ kind: 'error', message: 'Rate limit reached. Try again in 30 minutes.' }]
    await tick(now)

    const event = received.find((e) => e.type === 'chat.scheduled') as
      | { runAt: number; scheduleId: string }
      | undefined
    expect(event).toBeDefined()
    expect(event!.runAt).toBeGreaterThan(now)
    expect(readSchedule(event!.scheduleId, db)!.runAt).toBe(event!.runAt)
    expect(received.map((e) => e.type)).not.toContain('chat.error')
  })

  test('a continuation that fails for an ORDINARY reason is still retired', async () => {
    // The re-arm is for quota errors only. Anything else has no reset time to
    // wait for, and leaving the row active would retry it for ever.
    const now = Date.now()
    const session = limitedConversation()
    const s = createSchedule(
      {
        kind: 'resume',
        title: 'continue',
        prompt: RESUME_PROMPT,
        runAt: now - MINUTE,
        createdBy: 'system',
        sessionId: session.id,
      },
      db,
    )

    fakeEvents = [{ kind: 'error', message: 'invalidated oauth token' }]
    await tick(now)

    expect(readSchedule(s.id, db)!.status).toBe('failed')
  })
})

// ===========================================================================
// rearm
// ===========================================================================

describe('rearm — unpausing', () => {
  test('moves the next firing forward instead of firing immediately', async () => {
    // Unpausing a schedule whose time is long past should mean "carry on from
    // the next scheduled time", not "run right now, and also catch up".
    const now = new Date(2026, 7, 5, 12, 0).getTime()
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: new Date(2026, 7, 1, 9, 0).getTime(),
        createdBy: 'user',
      },
      db,
    )

    rearm(readSchedule(s.id, db)!, now)

    const after = readSchedule(s.id, db)!
    expect(after.runAt).toBeGreaterThan(now)
    expect(new Date(after.runAt)).toEqual(new Date(2026, 7, 6, 9, 0))

    // And it does not fire on the next tick
    await tick(now)
    expect(readSchedule(s.id, db)!.runs).toBe(0)
  })
})

// ===========================================================================
// Robustness — the tick must survive everything
// ===========================================================================

describe('the tick keeps going', () => {
  test('one broken schedule does not stop the others', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // If an exception escaped the loop the timer chain would die and EVERY
    // schedule would stop firing — silently, until the next restart.
    // ─────────────────────────────────────────────────────────────────────
    const now = Date.now()
    // A resume pointing at a session that does not exist
    const broken = createSchedule(
      {
        kind: 'resume',
        title: 'broken',
        prompt: 'x',
        runAt: now - MINUTE,
        createdBy: 'system',
      },
      db,
    )
    const healthy = createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)

    expect(readSchedule(broken.id, db)!.status).toBe('failed')
    expect(readSchedule(healthy.id, db)!.runs).toBe(1)
  })

  test('a schedule already running is not started a second time', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // A real agent run takes minutes while the tick comes round every thirty
    // seconds. Without the in-flight guard the same report would be started
    // again on every tick until the first one finished — several identical
    // conversations, several times the token spend.
    //
    // The stream is HELD OPEN until both ticks have been started, so the
    // second genuinely overlaps the first. Without the gate the two ticks
    // would run to completion in sequence and the test would pass whether
    // the guard existed or not.
    // ─────────────────────────────────────────────────────────────────────
    const now = Date.now()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    // `streamHold` is awaited by the mocked stream before it yields anything,
    // so the first run stays open until the gate is released.
    streamHold = gate

    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'slow',
        prompt: 'x',
        cron: '*/5 * * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    const first = tick(now)
    // Start the second tick before the first can possibly have finished
    const second = tick(now)
    release()
    await Promise.all([first, second])

    expect(readSchedule(s.id, db)!.runs).toBe(1)
    expect(readSessions(db)).toHaveLength(1)
  })

  test('an unparsable cron expression retires the schedule rather than looping', async () => {
    const now = Date.now()
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'bad',
        prompt: 'x',
        cron: 'not a cron expression',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)

    // No next firing could be computed, so it does not stay active with a
    // `runAt` in the past — which would fire it on every tick for ever.
    expect(readSchedule(s.id, db)!.status).not.toBe('active')
  })
})

// ===========================================================================
// The orchestrator hand-off: a provider limit becomes a booking, not an error
// ===========================================================================

describe('a provider limit reaching the orchestrator', () => {
  test('is announced as SCHEDULED, not as an error', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // The point of the whole feature. The user should be told "paused until
    // 14:35", not "failed" — because nothing is left for them to do.
    // ─────────────────────────────────────────────────────────────────────
    fakeEvents = [{ kind: 'error', message: 'Rate limit reached. Try again in 30 minutes.' }]
    const session = createSession('limited', db)

    await streamReply(session.id, 'msg-1', { provider: 'ollama', model: 'qwen3:0.6b' })

    const types = received.map((e) => e.type)
    expect(types).toContain('chat.scheduled')
    expect(types).not.toContain('chat.error')
  })

  test('the booking is a real resume schedule for this conversation', async () => {
    fakeEvents = [{ kind: 'error', message: 'Rate limit reached. Try again in 30 minutes.' }]
    const session = createSession('limited', db)

    await streamReply(session.id, 'msg-1', { provider: 'ollama', model: 'qwen3:0.6b' })

    const schedule = pendingResume(session.id, db)
    expect(schedule).not.toBeNull()
    expect(schedule!.kind).toBe('resume')
    expect(schedule!.createdBy).toBe('system')

    const event = received.find((e) => e.type === 'chat.scheduled') as
      | { scheduleId: string; runAt: number; reason: string }
      | undefined
    expect(event?.scheduleId).toBe(schedule!.id)
    expect(event?.runAt).toBe(schedule!.runAt)
    expect(event?.reason).toContain('limit')
  })

  test('an ordinary error still travels the error path untouched', async () => {
    fakeEvents = [{ kind: 'error', message: 'invalidated oauth token' }]
    const session = createSession('broken', db)

    await streamReply(session.id, 'msg-1', { provider: 'ollama', model: 'qwen3:0.6b' })

    const types = received.map((e) => e.type)
    expect(types).toContain('chat.error')
    expect(types).not.toContain('chat.scheduled')
    expect(pendingResume(session.id, db)).toBeNull()
  })

  test('a context-length error is an error, not a booking', async () => {
    // It contains the word "limit" — rescheduling it would retry the same
    // doomed request once an hour for ever.
    fakeEvents = [{ kind: 'error', message: "This model's maximum context length is 8192 tokens" }]
    const session = createSession('too-long', db)

    await streamReply(session.id, 'msg-1', { provider: 'ollama', model: 'qwen3:0.6b' })

    expect(received.map((e) => e.type)).toContain('chat.error')
    expect(pendingResume(session.id, db)).toBeNull()
  })

  test('hitting the limit twice does not book two continuations', async () => {
    fakeEvents = [{ kind: 'error', message: 'Rate limit reached' }]
    const session = createSession('limited', db)

    await streamReply(session.id, 'msg-1', { provider: 'ollama', model: 'qwen3:0.6b' })
    await streamReply(session.id, 'msg-2', { provider: 'ollama', model: 'qwen3:0.6b' })

    expect(readSchedules(db).filter((s) => s.kind === 'resume')).toHaveLength(1)
    // …and the second attempt STILL suppresses the error: the conversation is
    // scheduled, so reporting a failure would contradict the notice already
    // shown.
    expect(received.map((e) => e.type)).not.toContain('chat.error')
  })

  test('the reply text is still stored, so the user sees what did arrive', async () => {
    fakeEvents = [
      { kind: 'delta', text: 'I started working and then' },
      { kind: 'error', message: 'Rate limit reached' },
    ]
    const session = createSession('limited', db)

    await streamReply(session.id, 'msg-1', { provider: 'ollama', model: 'qwen3:0.6b' })

    const messages = readMessages(session.id, db)
    expect(messages.at(-1)!.text).toContain('I started working and then')
  })
})

// ===========================================================================
// Auto permission mode — a scheduled run is auto or it does not run
// ===========================================================================

describe('a scheduled run works in AUTO permission mode', () => {
  test('the new session is switched to auto before the stream starts', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // In `confirm` mode the agent stops at the first `bash` and waits five
    // minutes for an answer nobody is there to give, then reads the silence
    // as a refusal. The run burns its tokens, produces nothing, and reports
    // no error — the schedule looks like it worked. That is the failure this
    // whole check exists to prevent.
    // ─────────────────────────────────────────────────────────────────────
    const now = Date.now()
    createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)

    const session = readSessions(db)[0]!
    expect(modeManager(session.id).mode).toBe('auto')
  })

  test('a resumed conversation is switched to auto as well', async () => {
    // The user is not sitting there at 3am either.
    const now = Date.now()
    const session = createSession('interrupted', db)
    lockSessionModel(session.id, 'ollama', 'qwen3:0.6b', db)
    createSchedule(
      {
        kind: 'resume',
        title: 'continue',
        prompt: RESUME_PROMPT,
        runAt: now - MINUTE,
        createdBy: 'system',
        sessionId: session.id,
      },
      db,
    )

    await tick(now)

    expect(modeManager(session.id).mode).toBe('auto')
  })

  test('WITHOUT a classifier the run is refused, not started in confirm mode', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // Auto mode is not "no checks" — it is "the checks are made by a model
    // rather than a person". With no classifier there is no check at all,
    // and running unattended with nothing between the agent and `bash` is
    // not a trade this platform makes.
    // ─────────────────────────────────────────────────────────────────────
    delete process.env.PLATFORM_CLASSIFIER_MODEL

    const now = Date.now()
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)

    // Nothing was streamed…
    expect(streamedSessions).toHaveLength(0)
    // …and the reason is recorded rather than left as a silent no-op
    const after = readSchedule(s.id, db)!
    expect(after.lastError).toContain('classifier')
    // The schedule still re-arms: the provider may be configured by tomorrow
    expect(after.status).toBe('active')
    expect(after.runAt).toBeGreaterThan(now)
  })

  test('a refused run still leaves the session behind, so it is visible', async () => {
    // A refusal that erased its own evidence would be indistinguishable from
    // the schedule never having fired.
    delete process.env.PLATFORM_CLASSIFIER_MODEL

    const now = Date.now()
    createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)

    expect(readSessions(db)).toHaveLength(1)
  })

  test('auto turning ITSELF off mid-run stops the stream and records why', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // `mode.ts` turns auto off after three consecutive blocks (or a broken
    // classifier). At that point the run has stopped being unattended work
    // and has become a conversation waiting for a person — so it is cut
    // short rather than left to time out one permission prompt at a time,
    // and the schedule must NOT report success.
    // ─────────────────────────────────────────────────────────────────────
    const now = Date.now()
    const s = createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    // The stream is held open; while it is, the mode manager reports the
    // classifier as broken — exactly what `mode.ts` does on a failure.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    streamHold = gate

    const running = tick(now)
    // Wait for the session to exist, then break auto mode
    await Bun.sleep(20)
    const session = readSessions(db)[0]
    expect(session).toBeDefined()
    modeManager(session!.id).classifierFailed('the model went away')
    release()
    await running

    const after = readSchedule(s.id, db)!
    expect(after.lastError).toContain('stopped')
    expect(after.lastError).toContain('classifier')
  })
})

// ===========================================================================
// The model a scheduled run uses
// ===========================================================================

describe('the model a recurring run uses', () => {
  test("the schedule's own choice is honoured", async () => {
    const now = Date.now()
    createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
        provider: 'anthropic',
        model: 'claude-x',
      },
      db,
    )

    await tick(now)

    const session = readSessions(db)[0]!
    expect(session.provider).toBe('anthropic')
    expect(session.model).toBe('claude-x')
  })

  test('a model that no longer exists falls back rather than failing', async () => {
    // A key can be revoked, or Ollama can be off, between the schedule being
    // created and it firing. A report from a different model beats no report
    // and a stale error.
    const now = Date.now()
    createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'x',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
        provider: 'openai',
        model: 'a-model-that-was-removed',
      },
      db,
    )

    await tick(now)

    const session = readSessions(db)[0]!
    // Fell back to the first detected model
    expect(session.provider).toBe('ollama')
    expect(readSessions(db)).toHaveLength(1)
  })
})

// ===========================================================================
// The agent has to know it is INSIDE a scheduled run
// ===========================================================================

describe('a recurring run tells the agent where it is', () => {
  test('the note is prepended to the stored prompt', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // Observed twice on a live run, and it is the worst failure shape this
    // layer can produce: a prompt reading "Every day, check the issues and
    // label them" looks — to a model waking up in an EMPTY conversation with
    // `scheduleCreate` in its toolbox — like a request to SET UP a schedule.
    // The agent called `scheduleList`, found the schedule that had just
    // started it, said "one already exists so I did not create a duplicate",
    // and stopped. No error, no work, `lastError` empty. The schedule
    // reported success.
    // ─────────────────────────────────────────────────────────────────────
    const now = Date.now()
    createSchedule(
      {
        kind: 'recurring',
        title: 'report',
        prompt: 'Har kuni issue larni tekshir',
        cron: '0 9 * * *',
        runAt: now - MINUTE,
        createdBy: 'user',
      },
      db,
    )

    await tick(now)

    const session = readSessions(db)[0]!
    const first = readMessages(session.id, db)[0]!
    expect(first.text.startsWith(SCHEDULED_RUN_NOTE)).toBe(true)
    // The user's own instruction still follows it, unchanged
    expect(first.text).toContain('Har kuni issue larni tekshir')
  })

  test('the note says not to create another schedule', async () => {
    // The specific misreading it has to prevent.
    expect(SCHEDULED_RUN_NOTE).toContain('do NOT create')
    expect(SCHEDULED_RUN_NOTE.toLowerCase()).toContain('carry out the work')
  })

  test('a resume run does NOT get the note', async () => {
    // A continuation lands in a conversation that already has its full
    // history, so it has all the context it needs — and the note would be a
    // confusing non-sequitur in the middle of an existing thread.
    const now = Date.now()
    const session = createSession('interrupted', db)
    lockSessionModel(session.id, 'ollama', 'qwen3:0.6b', db)
    createSchedule(
      {
        kind: 'resume',
        title: 'continue',
        prompt: RESUME_PROMPT,
        runAt: now - MINUTE,
        createdBy: 'system',
        sessionId: session.id,
      },
      db,
    )

    await tick(now)

    const messages = readMessages(session.id, db)
    expect(messages.some((m) => m.text === RESUME_PROMPT)).toBe(true)
    expect(messages.some((m) => m.text.includes(SCHEDULED_RUN_NOTE))).toBe(false)
  })
})
