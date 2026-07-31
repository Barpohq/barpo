// The server side of the agent's schedule tools.
//
// `@platforma/ai` declares the tools and knows nothing else: it hands over a
// title, a cron expression and a prompt. Everything that requires the database
// or the clock happens here — parsing the expression, computing the first
// firing, writing the row, telling the list.
//
// WHY THIS FILE EXISTS RATHER THAN THE LOGIC LIVING IN `orchestrator.ts`: the
// orchestrator already carries the whole reply stream, and three more inline
// closures would bury the one thing this code has to get right — that a cron
// expression the model invented is validated BEFORE a row is written, so a
// schedule that can never fire is never stored.

import type { ScheduleCreateResult, ScheduleDeleteResult, ScheduleSummary } from '@platforma/ai'
import type { Schedule } from '@platforma/shared'
import { auditWrite } from '../audit.ts'
import {
  createSchedule,
  deleteSchedule,
  readSchedule,
  readSchedules,
  readSession,
} from '../repo.ts'
import { hub } from '../ws/hub.ts'
import { describeCron, nextRunOf } from './cron.ts'

/**
 * How many schedules one platform may hold.
 *
 * Not a resource limit — the table is tiny. It is a runaway guard: a model in a
 * loop calling `scheduleCreate` would otherwise commit the user to hundreds of
 * unattended runs against their plan quota, and each one would keep firing
 * long after the conversation that produced it was forgotten.
 */
export const MAX_SCHEDULES = 50

/** Turns a stored row into the small shape the agent sees */
export function toSummary(schedule: Schedule): ScheduleSummary {
  return {
    id: schedule.id,
    title: schedule.title,
    kind: schedule.kind,
    when: schedule.cronText ?? schedule.cron ?? 'once',
    status: schedule.status,
    nextRun: new Date(schedule.runAt).toISOString(),
    createdBy: schedule.createdBy,
    runs: schedule.runs,
    ...(schedule.lastError ? { lastError: schedule.lastError } : {}),
    ...(schedule.provider && schedule.model
      ? { model: `${schedule.provider}/${schedule.model}` }
      : {}),
  }
}

/**
 * Creates a schedule on the agent's behalf.
 *
 * EVERY FAILURE COMES BACK AS TEXT, never as an exception: the tool passes the
 * message straight to the model, which then fixes its own arguments and tries
 * again. A thrown error would abort the tool call and leave the model with no
 * idea what was wrong with its cron expression.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ THE MODEL IS INHERITED FROM THE CONVERSATION, unless the agent named │
 * │ one explicitly.                                                      │
 * │                                                                      │
 * │ Without this the schedule stored no model at all and every run       │
 * │ picked whatever happened to be first in the detected list — so a     │
 * │ user who set up a report while talking to one model would get their  │
 * │ report written by a different one, with no indication that anything  │
 * │ had changed. Inheriting makes the obvious reading the true one: the  │
 * │ schedule runs on the model you set it up with.                       │
 * │                                                                      │
 * │ `sessionId` is what makes that possible, which is why this function  │
 * │ takes one. When it is absent (the REST route, a test) the caller     │
 * │ supplies the model itself or accepts the platform default.           │
 * └──────────────────────────────────────────────────────────────────────┘
 */
export function createFromAgent(
  input: {
    title: string
    prompt: string
    cron: string
    provider?: string
    model?: string
  },
  sessionId?: string,
): ScheduleCreateResult {
  const title = input.title.trim()
  const prompt = input.prompt.trim()

  if (!title) return { ok: false, error: 'The title must not be empty' }
  if (!prompt) return { ok: false, error: 'The prompt must not be empty' }

  // The prompt is the whole instruction for a conversation that starts empty,
  // so a one-word prompt is almost certainly the model assuming context it
  // will not have. The floor is deliberately low — this catches "do it", not
  // terseness.
  if (prompt.length < 10) {
    return {
      ok: false,
      error:
        'The prompt is too short to be a self-contained instruction. Each run starts in a ' +
        'new, empty conversation — write out what to do, where the data comes from and ' +
        'where the result goes.',
    }
  }

  if (readSchedules().length >= MAX_SCHEDULES) {
    return {
      ok: false,
      error: `This platform already has ${MAX_SCHEDULES} schedules, which is the limit. Delete one first.`,
    }
  }

  // THE VALIDATION THAT MATTERS: parse before writing. A stored schedule with
  // an unparsable expression would sit in the list looking active and never
  // fire once.
  let runAt: number | null
  try {
    runAt = nextRunOf(input.cron)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (runAt === null) {
    return {
      ok: false,
      error:
        'That expression is valid but has no run within the next five years. ' +
        'Check the day and month fields.',
    }
  }

  const choice = pickScheduleModel(input, sessionId)

  const schedule = createSchedule({
    kind: 'recurring',
    title,
    prompt,
    cron: input.cron.trim(),
    runAt,
    createdBy: 'agent',
    provider: choice?.provider,
    model: choice?.model,
  })

  auditWrite(
    'agent',
    'schedule created',
    `${title}: ${describeCron(input.cron)}`.slice(0, 120),
    'write',
    'OK',
  )
  hub.broadcast({ type: 'schedule.changed', schedule })

  return { ok: true, schedule: toSummary(schedule) }
}

/**
 * Which model the schedule pins — the agent's choice, else the conversation's.
 *
 * BOTH FIELDS ARE REQUIRED TOGETHER. A provider without a model (or the other
 * way round) cannot start a session, and storing half of one would fail at
 * run time rather than here — a half-argument is treated as no argument, and
 * the conversation's model is used instead.
 *
 * `undefined` means "no model pinned": the scheduler then picks from the
 * detected list at run time. That is the right outcome for a session with no
 * model locked yet (the tool was somehow called before the first reply) — a
 * schedule with no model still runs, it just does not promise which one.
 */
function pickScheduleModel(
  input: { provider?: string; model?: string },
  sessionId?: string,
): { provider: string; model: string } | undefined {
  if (input.provider && input.model) {
    return { provider: input.provider, model: input.model }
  }

  if (!sessionId) return undefined
  const session = readSession(sessionId)
  if (!session?.provider || !session.model) return undefined

  return { provider: session.provider, model: session.model }
}

/** The schedules, as the agent sees them */
export function listForAgent(): ScheduleSummary[] {
  return readSchedules().map(toSummary)
}

/**
 * Deletes a schedule on the agent's behalf.
 *
 * The permission layer has already granted this (the tool asks first), so the
 * only checks left are that the row exists.
 */
export function removeForAgent(id: string): ScheduleDeleteResult {
  const schedule = readSchedule(id)
  if (!schedule) {
    return { ok: false, error: `There is no schedule with the id "${id}"` }
  }

  const removed = deleteSchedule(id)
  if (!removed) return { ok: false, error: 'The schedule could not be deleted' }

  auditWrite('agent', 'schedule deleted', schedule.title.slice(0, 120), 'write', 'OK')
  hub.broadcast({ type: 'schedule.removed', id })

  return { ok: true }
}
