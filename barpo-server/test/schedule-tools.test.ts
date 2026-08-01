// The agent's schedule tools, and the server-side sink behind them.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHAT IS BEING PROTECTED HERE. These tools let a MODEL commit the     │
// │ platform to unattended work, repeatedly, spending the user's plan    │
// │ quota each time. Two things therefore have to hold:                  │
// │                                                                      │
// │   1. Nothing is created without the user agreeing to it.             │
// │   2. Nothing that CANNOT WORK is ever stored. A schedule with an     │
// │      unparsable expression would sit in the list looking active and  │
// │      never fire once — the worst kind of failure, because it looks   │
// │      like success.                                                   │
// └──────────────────────────────────────────────────────────────────────┘

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { PermissionAnswer, PermissionRequest } from '@barpo/shared'
import {
  createScheduleCreateTool,
  createScheduleDeleteTool,
  createScheduleListTool,
  scheduleToolsRaw,
} from '@barpo/ai'
import { openDb, setDb } from '../src/db.ts'
import {
  createProject,
  createSchedule,
  createSession,
  lockSessionModel,
  readSchedules,
} from '../src/repo.ts'
import {
  MAX_SCHEDULES,
  createFromAgent,
  listForAgent,
  removeForAgent,
} from '../src/schedule/schedule-sink.ts'
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

/** A permission manager stub that always answers the same way */
function permission(answer: PermissionAnswer) {
  const asked: {
    action: string
    target: string
    reason?: string
    requireUser?: boolean
  }[] = []
  return {
    asked,
    manager: {
      ask: async (request: {
        action: string
        target: string
        reason?: string
        requireUser?: boolean
      }) => {
        asked.push(request)
        return answer
      },
      pendingRequests: [] as PermissionRequest[],
    } as never,
  }
}

/**
 * Runs a tool's execute and returns the text the model would read.
 *
 * The tool is taken as `unknown` and narrowed here: the three tools have three
 * different input types, and a signature covering all of them would either be
 * generic noise or the wrong shape for at least one caller.
 */
async function runTool(tool: unknown, params: unknown): Promise<string> {
  const execute = (tool as { execute: (id: string, p: unknown) => Promise<unknown> }).execute
  const result = (await execute('call-1', params)) as {
    content: { type: string; text?: string }[]
  }
  return result.content.map((c) => c.text ?? '').join('\n')
}

// ===========================================================================
// scheduleCreate — the permission gate
// ===========================================================================

describe('scheduleCreate — nothing is created without the user', () => {
  test('a denied request creates nothing', async () => {
    const p = permission('deny')
    const tool = createScheduleCreateTool(createFromAgent, p.manager)

    const text = await runTool(tool, {
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(text).toContain('did NOT allow')
    expect(readSchedules(db)).toHaveLength(0)
  })

  test('the user is asked BEFORE anything is written', async () => {
    const p = permission('deny')
    const tool = createScheduleCreateTool(createFromAgent, p.manager)

    await runTool(tool, {
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(p.asked).toHaveLength(1)
    expect(p.asked[0]!.action).toBe('scheduleCreate')
    expect(p.asked[0]!.target).toBe('Daily report')
  })

  test('an allowed request creates the schedule', async () => {
    const p = permission('allow')
    const tool = createScheduleCreateTool(createFromAgent, p.manager)

    const text = await runTool(tool, {
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(text).toContain('created')
    const stored = readSchedules(db)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.title).toBe('Daily report')
    expect(stored[0]!.createdBy).toBe('agent')
    expect(stored[0]!.kind).toBe('recurring')
  })

  test('it does NOT use requireUser — a schedule is reversible', async () => {
    // Unlike `appDelete`, which erases files with no undo. Forcing a human
    // answer even in auto mode would be permission fatigue for something the
    // user can pause in one click.
    const p = permission('allow')
    const tool = createScheduleCreateTool(createFromAgent, p.manager)

    await runTool(tool, {
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(p.asked[0]!.requireUser).toBeUndefined()
  })
})

// ===========================================================================
// createFromAgent — what must never reach the database
// ===========================================================================

describe('createFromAgent — a schedule that cannot fire is never stored', () => {
  test('an unparsable cron expression is rejected with a usable reason', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // The expression comes from a MODEL, so it can be anything. Storing it
    // unvalidated would produce a row that looks active in the list and
    // never fires — failure disguised as success.
    // ─────────────────────────────────────────────────────────────────────
    const result = createFromAgent({
      title: 'Broken',
      cron: 'every day at nine',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(readSchedules(db)).toHaveLength(0)
  })

  test('a shorthand is rejected, and the message says what to write instead', async () => {
    const result = createFromAgent({
      title: 'Daily',
      cron: '@daily',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(result.ok).toBe(false)
    // The model has to be able to fix its own argument from this text alone
    expect(result.error).toContain('0 9 * * *')
  })

  test('an impossible date is rejected', async () => {
    const result = createFromAgent({
      title: 'Never',
      cron: '0 9 31 2 *',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('never occurs')
    expect(readSchedules(db)).toHaveLength(0)
  })

  test('an empty title or prompt is rejected', async () => {
    expect(
      createFromAgent({ title: '  ', cron: '0 9 * * *', prompt: 'a real instruction here' }).ok,
    ).toBe(false)
    expect(createFromAgent({ title: 'x', cron: '0 9 * * *', prompt: '   ' }).ok).toBe(false)
    expect(readSchedules(db)).toHaveLength(0)
  })

  test('a prompt too short to be self-contained is rejected', async () => {
    // Each run starts in an EMPTY conversation, so "do it" produces nothing —
    // silently, every day, for as long as the schedule lives.
    const result = createFromAgent({ title: 'Report', cron: '0 9 * * *', prompt: 'do it' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('new, empty conversation')
  })

  test('the runaway guard stops a model creating schedules in a loop', async () => {
    for (let i = 0; i < MAX_SCHEDULES; i++) {
      createSchedule(
        {
          kind: 'recurring',
          title: `existing ${i}`,
          prompt: 'x',
          cron: '0 9 * * *',
          runAt: Date.now() + 3600_000,
          createdBy: 'agent',
        },
        db,
      )
    }

    const result = createFromAgent({
      title: 'One too many',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('limit')
    expect(readSchedules(db)).toHaveLength(MAX_SCHEDULES)
  })
})

describe('createFromAgent — what a valid schedule looks like', () => {
  test('the first firing is computed from the expression, not left at zero', async () => {
    const result = createFromAgent({
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(result.ok).toBe(true)
    expect(result.schedule!.nextRun).toBeDefined()
    expect(new Date(result.schedule!.nextRun).getTime()).toBeGreaterThan(Date.now())
  })

  test('the agent is told when it will run, in plain language', async () => {
    const result = createFromAgent({
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(result.schedule!.when).toBe('every day at 09:00')
  })

  test('the list is told about the new schedule', async () => {
    const collected: unknown[] = []
    hub.connected({
      data: { id: 'x', channels: new Set(['schedules']) },
      send: (m: string) => collected.push(JSON.parse(m)),
    } as never)

    createFromAgent({
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(collected.some((e) => (e as { type: string }).type === 'schedule.changed')).toBe(true)
  })
})

// ===========================================================================
// scheduleList
// ===========================================================================

describe('scheduleList', () => {
  test('an empty platform says so plainly', async () => {
    const tool = createScheduleListTool(listForAgent)
    expect(await runTool(tool, {})).toContain('no schedules')
  })

  test('it shows what exists, so a duplicate is not created', async () => {
    createFromAgent({
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })

    const tool = createScheduleListTool(listForAgent)
    const text = await runTool(tool, {})

    expect(text).toContain('Daily report')
    expect(text).toContain('every day at 09:00')
  })

  test('a failing schedule reports its last error', async () => {
    const s = createFromAgent({
      title: 'Broken report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })
    db.prepare('UPDATE schedules SET last_error = ? WHERE id = ?').run(
      'the API returned 500',
      s.schedule!.id,
    )

    const tool = createScheduleListTool(listForAgent)
    expect(await runTool(tool, {})).toContain('the API returned 500')
  })
})

// ===========================================================================
// scheduleDelete
// ===========================================================================

describe('scheduleDelete', () => {
  test('a denied request leaves the schedule active', async () => {
    const created = createFromAgent({
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })
    const p = permission('deny')
    const tool = createScheduleDeleteTool(removeForAgent, p.manager)

    const text = await runTool(tool, { id: created.schedule!.id })

    expect(text).toContain('did NOT allow')
    expect(readSchedules(db)).toHaveLength(1)
  })

  test('an allowed request deletes it', async () => {
    const created = createFromAgent({
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })
    const p = permission('allow')
    const tool = createScheduleDeleteTool(removeForAgent, p.manager)

    await runTool(tool, { id: created.schedule!.id })

    expect(readSchedules(db)).toHaveLength(0)
  })

  test('an unknown id fails as TEXT, not as an exception', async () => {
    // The model has to read the reason and correct itself; a thrown error
    // would abort the call and tell it nothing.
    const p = permission('allow')
    const tool = createScheduleDeleteTool(removeForAgent, p.manager)

    const text = await runTool(tool, { id: 'does-not-exist' })

    expect(text).toContain('no schedule')
  })
})

// ===========================================================================
// Which tools are declared at all
// ===========================================================================

describe('scheduleToolsRaw — a missing provider means the tool does not exist', () => {
  const p = permission('allow')

  test('no providers, no tools', () => {
    expect(scheduleToolsRaw()).toHaveLength(0)
  })

  test('create and delete are NOT declared without a permission manager', () => {
    // ─────────────────────────────────────────────────────────────────────
    // A tool that commits the platform to unattended work and cannot ask
    // first is exactly what this design refuses to ship. Not declaring it is
    // stronger than refusing at call time: the model never learns it exists.
    // ─────────────────────────────────────────────────────────────────────
    const tools = scheduleToolsRaw(createFromAgent, listForAgent, removeForAgent, undefined)
    expect(tools.map((t) => t.name)).toEqual(['scheduleList'])
  })

  test('with everything present, all three are declared', () => {
    const tools = scheduleToolsRaw(createFromAgent, listForAgent, removeForAgent, p.manager)
    expect(tools.map((t) => t.name).sort()).toEqual([
      'scheduleCreate',
      'scheduleDelete',
      'scheduleList',
    ])
  })

  test('read-only access can be handed out on its own', () => {
    const tools = scheduleToolsRaw(undefined, listForAgent, undefined, p.manager)
    expect(tools.map((t) => t.name)).toEqual(['scheduleList'])
  })
})

// ===========================================================================
// Which model a schedule pins
// ===========================================================================

describe('the model a new schedule inherits', () => {
  /** A conversation with a model locked, as a real one has after its first reply */
  function conversation(provider = 'anthropic', model = 'claude-x') {
    const session = createSession('chat', db)
    lockSessionModel(session.id, provider, model, db)
    return session
  }

  test('it takes the model of the conversation it was created from', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // Without this the schedule stored no model and every run picked
    // whatever happened to be first in the detected list — so a user who set
    // up a report while talking to one model would get it written by a
    // different one, with nothing to indicate the change.
    // ─────────────────────────────────────────────────────────────────────
    const session = conversation('anthropic', 'claude-x')

    const result = createFromAgent(
      { title: 'Daily report', cron: '0 9 * * *', prompt: 'Prepare the daily report' },
      session.id,
    )

    expect(result.ok).toBe(true)
    const stored = readSchedules(db)[0]!
    expect(stored.provider).toBe('anthropic')
    expect(stored.model).toBe('claude-x')
  })

  test('an explicit choice from the agent overrides the conversation', async () => {
    // "Run it on a cheaper model" has to be able to win.
    const session = conversation('anthropic', 'claude-x')

    createFromAgent(
      {
        title: 'Daily report',
        cron: '0 9 * * *',
        prompt: 'Prepare the daily report',
        provider: 'ollama',
        model: 'qwen3:0.6b',
      },
      session.id,
    )

    const stored = readSchedules(db)[0]!
    expect(stored.provider).toBe('ollama')
    expect(stored.model).toBe('qwen3:0.6b')
  })

  test('half an argument is treated as none, and the conversation wins', async () => {
    // A provider without a model cannot start a session. Storing half of one
    // would fail at run time instead of here.
    const session = conversation('anthropic', 'claude-x')

    createFromAgent(
      { title: 'Daily report', cron: '0 9 * * *', prompt: 'Prepare the daily report', provider: 'ollama' },
      session.id,
    )

    const stored = readSchedules(db)[0]!
    expect(stored.provider).toBe('anthropic')
    expect(stored.model).toBe('claude-x')
  })

  test('a session with no model locked yet pins nothing', async () => {
    // The schedule still runs — it just does not promise which model. The
    // scheduler picks from the detected list at run time.
    const session = createSession('brand new', db)

    const result = createFromAgent(
      { title: 'Daily report', cron: '0 9 * * *', prompt: 'Prepare the daily report' },
      session.id,
    )

    expect(result.ok).toBe(true)
    const stored = readSchedules(db)[0]!
    expect(stored.provider).toBeUndefined()
    expect(stored.model).toBeUndefined()
  })

  test('with no session at all it pins nothing, rather than throwing', async () => {
    // The REST route and the tests call it this way.
    const result = createFromAgent({
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report',
    })

    expect(result.ok).toBe(true)
    expect(readSchedules(db)[0]!.provider).toBeUndefined()
  })

  test('the agent is told which model the schedule will use', async () => {
    const session = conversation('anthropic', 'claude-x')
    const p = permission('allow')
    const tool = createScheduleCreateTool(
      (input) => createFromAgent(input, session.id),
      p.manager,
    )

    const text = await runTool(tool, {
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(text).toContain('anthropic/claude-x')
  })

  test('the permission request warns that runs are unattended', async () => {
    // The user is agreeing to commands being run with no confirmation
    // prompts — that has to be on the request, not only in the docs.
    const p = permission('allow')
    const tool = createScheduleCreateTool(createFromAgent, p.manager)

    await runTool(tool, {
      title: 'Daily report',
      cron: '0 9 * * *',
      prompt: 'Prepare the daily report from the sales API',
    })

    expect(p.asked[0]!.reason).toContain('AUTO')
  })
})

// ===========================================================================
// Which project a schedule belongs to
// ===========================================================================

describe('the project a new schedule inherits', () => {
  test('it belongs to the project the conversation was in', () => {
    // ─────────────────────────────────────────────────────────────────────
    // "Every morning, update the notes in rules.md" said inside a project
    // means THAT project's `rules.md`. Without the project on the row,
    // `runRecurring` opened its session with none and the run landed in a
    // bare session directory: the file the prompt names is missing, and
    // whatever the run writes appears where the user never looks. Both
    // failures are quiet — the schedule reports success either way.
    // ─────────────────────────────────────────────────────────────────────
    const project = createProject('Work', '/tmp/work-project', db)
    const session = createSession('chat', db, project.id)
    lockSessionModel(session.id, 'anthropic', 'claude-x', db)

    const result = createFromAgent(
      { title: 'Daily notes', cron: '0 9 * * *', prompt: 'Update the notes in rules.md' },
      session.id,
    )

    expect(result.ok).toBe(true)
    expect(readSchedules(db)[0]!.projectId).toBe(project.id)
  })

  test('a conversation outside any project pins no project', () => {
    const session = createSession('chat', db)
    lockSessionModel(session.id, 'anthropic', 'claude-x', db)

    createFromAgent(
      { title: 'Daily report', cron: '0 9 * * *', prompt: 'Prepare the daily report' },
      session.id,
    )

    expect(readSchedules(db)[0]!.projectId).toBeUndefined()
  })

  test('the project is inherited even when the agent names its own model', () => {
    // The two are independent: overriding the model must not quietly drop the
    // project along with it.
    const project = createProject('Work', '/tmp/work-project-2', db)
    const session = createSession('chat', db, project.id)
    lockSessionModel(session.id, 'anthropic', 'claude-x', db)

    createFromAgent(
      {
        title: 'Daily notes',
        cron: '0 9 * * *',
        prompt: 'Update the notes in rules.md',
        provider: 'ollama',
        model: 'qwen3:0.6b',
      },
      session.id,
    )

    const stored = readSchedules(db)[0]!
    expect(stored.projectId).toBe(project.id)
    expect(stored.provider).toBe('ollama')
  })
})
