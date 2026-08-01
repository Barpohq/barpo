// The tick that fires schedules, and what happens when one fires.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THIS CODE RUNS WHEN NOBODY IS WATCHING. That single fact drives      │
// │ every decision below:                                                │
// │                                                                      │
// │   - it never throws. A failed run is RECORDED on the row and the     │
// │     tick carries on; an exception escaping here would kill the timer │
// │     and every other schedule with it, silently, until the next       │
// │     restart.                                                         │
// │   - a missed run is caught up, but only if it is still worth doing   │
// │     (see MAX_LATENESS_MS). A week of missed daily reports must not   │
// │     arrive as seven reports at breakfast.                            │
// │   - one run at a time per schedule. The timer cannot overtake        │
// │     itself, and a stream that outlives the interval must not be      │
// │     started twice.                                                   │
// └──────────────────────────────────────────────────────────────────────┘

import type { ModelChoice, Schedule } from '@barpo/shared'
import { cachedResult, detectModels, modeManager, pickClassifierModel } from '@barpo/ai'
import { config } from '@barpo/config'
import { auditWrite } from '../audit.ts'
import {
  createSchedule,
  createSession,
  dueSchedules,
  lockSessionModel,
  markScheduleRun,
  readSchedule,
  readSession,
  sessionProjectDir,
  setScheduleRunAt,
  setScheduleSession,
  writeMessage,
} from '../repo.ts'
import { isStreaming, stopStream, streamReply } from '../orchestrator.ts'
import { sessionWorkDir } from '../work-dir.ts'
import { hub } from '../ws/hub.ts'
import { nextRunOf } from './cron.ts'

/**
 * The config directory for a session — the project folder when it has one.
 *
 * The same rule the orchestrator applies (`sessionDir` there): the config is
 * layered per work directory, so a project-scoped setting such as
 * `permission.classifierModel` must be read from the same place the run will
 * use. Reading the global config here would enable auto mode against limits
 * the project deliberately narrowed.
 */
function scheduleWorkDir(sessionId: string): string {
  return sessionWorkDir(sessionId, sessionProjectDir(sessionId))
}

/**
 * How often the tick looks for due work.
 *
 * Thirty seconds, because cron's resolution is one minute: checking twice per
 * minute guarantees a schedule fires inside the minute it names, without the
 * tick itself being a busy loop. The query behind it is one indexed SELECT
 * over a table with tens of rows.
 */
export const TICK_MS = 30 * 1000

/**
 * How late a missed run may be before it is abandoned.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ THE LAPTOP-LID PROBLEM. The platform runs on a machine that gets     │
 * │ closed. A daily report scheduled for 09:00 does not fire if the      │
 * │ machine was asleep, and `run_at` simply stays in the past — so the   │
 * │ first tick after waking finds it.                                    │
 * │                                                                      │
 * │ That is what we want for a few hours ("the report is late") and      │
 * │ actively wrong after a week ("here are seven reports, all of them    │
 * │ about today"). Six hours is the line: a morning report that arrives  │
 * │ by lunch is still the report, and one that arrives the next day is   │
 * │ noise.                                                               │
 * │                                                                      │
 * │ An abandoned run is NOT a failure — the schedule re-arms for its     │
 * │ next firing and the skip is written to the audit log, so the         │
 * │ question "why was there no report on Tuesday?" has an answer.        │
 * └──────────────────────────────────────────────────────────────────────┘
 */
export const MAX_LATENESS_MS = 6 * 60 * 60 * 1000

/**
 * Puts a session into AUTO permission mode for an unattended run.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS IS NOT OPTIONAL. In `confirm` mode the agent stops at the   │
 * │ first `bash` and waits five minutes for an answer nobody is there to │
 * │ give, then treats the silence as a refusal. The run burns its        │
 * │ tokens, produces nothing, and reports no error — the schedule looks  │
 * │ like it worked. A scheduled run is therefore auto or it is nothing.  │
 * │                                                                      │
 * │ THE CLASSIFIER IS THE SAFETY CONDITION, AND IT IS CHECKED FIRST.     │
 * │ Auto mode is not "no checks", it is "the checks are made by a model  │
 * │ rather than a person". With no classifier available there is no      │
 * │ check at all, and running unattended with nothing standing between   │
 * │ the agent and `bash` is not a trade we make. The run is refused      │
 * │ instead, with the reason recorded.                                   │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Returns the reason for refusing, or `null` when auto mode is on.
 *
 * Note that auto mode can still turn ITSELF off mid-run (`mode.ts`: a broken
 * classifier, three consecutive blocks, twenty in total). That is handled
 * separately in `runWithAutoMode` — it is a different situation, because by
 * then work has already been done.
 */
function enableAutoMode(
  sessionId: string,
  workDir: string,
  /** The provider the run will use — the classifier is preferred from it */
  chatProvider?: string,
): string | null {
  const settings = config({ workDir }).config
  const classifier = pickClassifierModel(
    cachedResult()?.models ?? [],
    settings.permission.classifierModel,
    chatProvider,
  )

  if (!classifier) {
    return (
      'no model was available for the permission classifier, so the run would have had ' +
      'to ask a person for every command — with nobody there to answer. Configure a ' +
      'provider, or set permission.classifierModel.'
    )
  }

  const manager = modeManager(sessionId)
  manager.setLimits(
    settings.permission.consecutiveBlockLimit,
    settings.permission.totalBlockLimit,
  )
  manager.set('auto')
  return null
}

/**
 * Runs a scheduled stream and reports whether auto mode survived it.
 *
 * Auto mode turning itself off mid-run means one of three things happened: the
 * classifier broke, or the agent was blocked three times in a row, or twenty
 * times in total. All three mean the run has stopped being unattended work and
 * has become a conversation waiting for a person — so the stream is CUT SHORT
 * (`stopStream`) rather than left to time out one permission prompt at a time.
 *
 * The reason travels to `lastError`, because "the report is missing and the
 * schedule says it succeeded" is the failure this whole layer exists to avoid.
 */
async function runWithAutoMode(
  sessionId: string,
  messageId: string,
  choice: ModelChoice,
): Promise<{ error?: string }> {
  const manager = modeManager(sessionId)
  let autoOffReason: string | undefined

  const unsubscribe = manager.subscribe((change) => {
    if (change.mode !== 'auto' && change.reason) {
      autoOffReason = change.reason
      // The agent is now waiting for a person who is not coming. Stop it here
      // rather than letting each remaining tool call wait out its own timeout.
      stopStream(sessionId)
    }
  })

  try {
    const result = await streamReply(sessionId, messageId, choice)
    if (autoOffReason) {
      return { error: `the run was stopped: ${autoOffReason}` }
    }
    return { error: result.error }
  } finally {
    unsubscribe()
  }
}

/**
 * The line placed in front of a recurring schedule's prompt.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ WITHOUT THIS THE RUN DOES NOTHING, AND REPORTS SUCCESS.              │
 * │                                                                      │
 * │ A stored prompt naturally reads "Every day, check the open issues    │
 * │ and label them". To a person that is a description of recurring      │
 * │ work. To a model waking up in an EMPTY conversation, with            │
 * │ `scheduleCreate`/`scheduleList` among its tools, it reads as a       │
 * │ REQUEST TO SET UP A SCHEDULE. Observed twice on a live run: the      │
 * │ agent called `scheduleList`, found the schedule that had just        │
 * │ started it, replied "an active schedule for this already exists,     │
 * │ so I did not create a duplicate", and stopped. No error, no work     │
 * │ done, `lastError` empty — the schedule looked like it had succeeded. │
 * │                                                                      │
 * │ The fix is to tell the agent where it is. The scheduling has already │
 * │ happened; it is the RUN.                                             │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * WHY IT IS PREPENDED TO THE PROMPT rather than appended to the system
 * prompt: the system prompt is built inside `@barpo/ai`, which knows
 * nothing about schedules and should not learn. This text is part of the
 * instruction being given, so it belongs with it.
 *
 * It IS visible to the classifier, deliberately — the classifier decides
 * whether an action was asked for, and "this is a scheduled run of a task the
 * user set up" is exactly the context that makes `gh issue edit` legitimate
 * rather than the agent reaching beyond its brief.
 */
export const SCHEDULED_RUN_NOTE = [
  '[This is an automatic run of a recurring task you were set up to do.',
  'The schedule already exists and it started this conversation — do NOT create',
  'another one, and do not treat the text below as a request to set one up.',
  'Carry out the work itself now, and report what you did.]',
  '',
].join('\n')

/** The prompt sent when a rate-limited conversation is continued */
export const RESUME_PROMPT =
  'The provider limit that interrupted you has now reset. Carry on from where you stopped — ' +
  'check what you had already finished before repeating any of it.'

let timer: ReturnType<typeof setTimeout> | null = null

/**
 * The schedules being run RIGHT NOW.
 *
 * A run outliving the tick interval is entirely normal — an agent doing real
 * work takes minutes, the tick comes round every thirty seconds. Without this
 * set the same schedule would be started again on the next tick, and again on
 * the one after.
 */
const inFlight = new Set<string>()

/**
 * Starts the periodic tick.
 *
 * A `setTimeout` CHAIN rather than `setInterval`, deliberately: `setInterval`
 * queues the next call regardless of how long the previous one took, so a slow
 * tick (detection going out to the network, several schedules firing at once)
 * accumulates a backlog that all lands together. The chain schedules the next
 * tick only once the current one has finished.
 */
export function startScheduler(): void {
  if (timer) return

  const loop = async () => {
    // `tick()` handles its own errors; this catch is the outer guard that keeps
    // the chain alive even if something unforeseen escapes.
    try {
      await tick()
    } catch (error) {
      console.error('[schedule] tick failed:', error)
    }
    // `unref` so a pending timer does not hold the process open on shutdown
    timer = setTimeout(loop, TICK_MS)
    timer.unref?.()
  }

  timer = setTimeout(loop, TICK_MS)
  timer.unref?.()
}

/** Stops the tick (shutdown, and between tests) */
export function stopScheduler(): void {
  if (timer) clearTimeout(timer)
  timer = null
  inFlight.clear()
}

/**
 * One pass: find what is due and run it.
 *
 * Exported so tests can drive it directly instead of waiting on a timer, and
 * so the server can run one pass at startup (see `index.ts`) — that is what
 * catches up the runs missed while the machine was off.
 *
 * The runs are AWAITED IN SEQUENCE, not fanned out. Two agent streams starting
 * at the same second would compete for the same provider quota — which is the
 * very thing half this feature exists to work around.
 */
export async function tick(now: number = Date.now()): Promise<void> {
  const due = dueSchedules(now)

  for (const schedule of due) {
    if (inFlight.has(schedule.id)) continue
    inFlight.add(schedule.id)
    try {
      await runSchedule(schedule, now)
    } catch (error) {
      // Nothing below is expected to throw — `runSchedule` records its own
      // failures. This is the last line of defence for the loop.
      const message = error instanceof Error ? error.message : String(error)
      try {
        markScheduleRun(schedule.id, { nextRunAt: nextFiring(schedule, now), error: message })
      } catch {
        // The database itself is unavailable — there is nowhere left to record
        // this, and the tick must still survive.
      }
      console.error(`[schedule] ${schedule.id} failed:`, error)
    } finally {
      inFlight.delete(schedule.id)
      broadcast(schedule.id)
    }
  }
}

/** Runs one schedule and records the outcome */
async function runSchedule(schedule: Schedule, now: number): Promise<void> {
  const lateness = now - schedule.runAt

  // Too late to be useful — skip this firing and arm the next one.
  if (lateness > MAX_LATENESS_MS) {
    const next = nextFiring(schedule, now)
    markScheduleRun(schedule.id, {
      nextRunAt: next,
      error: `Skipped: it was due ${formatLateness(lateness)} ago (the machine was probably asleep)`,
    })
    auditWrite(
      'barpo',
      'schedule skipped',
      `${schedule.title}: ${formatLateness(lateness)} late`,
      'write',
      'OK',
    )
    // A 'resume' with no next firing is finished — there is nothing to carry
    // on to, because the conversation has moved on without it.
    return
  }

  if (schedule.kind === 'resume') {
    await runResume(schedule)
  } else {
    await runRecurring(schedule, now)
  }
}

/**
 * Continues a conversation that stopped when the provider's quota ran out.
 *
 * THE SESSION MUST STILL EXIST AND BE IDLE. Both checks matter:
 *   - deleted: the user removed the conversation while it was waiting. The
 *     schedule dies with it (the CASCADE usually gets there first, but a run
 *     already in flight can outlive the delete).
 *   - streaming: the user came back and continued it by hand. Sending a second
 *     "carry on" would interrupt their own message — `acceptMessage` would
 *     reject it with a 409 anyway, but arriving at that as a FAILURE would
 *     mark the schedule failed for doing exactly the right thing.
 */
async function runResume(schedule: Schedule): Promise<void> {
  if (!schedule.sessionId) {
    markScheduleRun(schedule.id, { error: 'The schedule has no session to continue' })
    return
  }

  const session = readSession(schedule.sessionId)
  if (!session) {
    markScheduleRun(schedule.id, { error: 'The conversation was deleted' })
    return
  }

  if (isStreaming(schedule.sessionId)) {
    // Not an error: the user got there first. The schedule has done its job by
    // becoming unnecessary.
    markScheduleRun(schedule.id, {})
    auditWrite('barpo', 'schedule not needed', schedule.title, 'read', 'OK')
    return
  }

  if (!session.provider || !session.model) {
    markScheduleRun(schedule.id, { error: 'The conversation has no model locked in' })
    return
  }

  // The continuation is unattended too — the user is not sitting there at
  // 3am. Same rule as a recurring run: auto or nothing.
  const refusal = enableAutoMode(
    schedule.sessionId,
    scheduleWorkDir(schedule.sessionId),
    session.provider,
  )
  if (refusal) {
    markScheduleRun(schedule.id, { error: refusal })
    auditWrite('barpo', 'schedule refused', `${schedule.title}: ${refusal}`.slice(0, 120), 'write', 'denied')
    return
  }

  const messageId = crypto.randomUUID()
  writeMessage({ sessionId: schedule.sessionId, role: 'user', text: schedule.prompt })

  auditWrite('barpo', 'schedule resumed a conversation', schedule.title, 'write', 'OK')

  const result = await runWithAutoMode(schedule.sessionId, messageId, {
    provider: session.provider,
    model: session.model,
  })

  // ┌──────────────────────────────────────────────────────────────────────┐
  // │ THE ROW MAY HAVE BEEN RE-ARMED WHILE THIS RUN WAS STREAMING.         │
  // │                                                                      │
  // │ If the continuation hit the SAME limit again, `planResume` moved      │
  // │ this row's `runAt` to the new reset time rather than creating a       │
  // │ second one (see the box there) — and the user has been told the      │
  // │ conversation carries on then. Writing 'failed' over that would       │
  // │ cancel the very continuation just promised, which is exactly the     │
  // │ silent dead end this layer exists to avoid.                          │
  // │                                                                      │
  // │ Re-read rather than trusting the copy captured before the stream:    │
  // │ minutes of agent work happened in between.                           │
  // └──────────────────────────────────────────────────────────────────────┘
  const current = readSchedule(schedule.id)
  if (current && current.runAt > schedule.runAt) {
    // Still pending, at a later time. Record the attempt, keep it armed.
    markScheduleRun(schedule.id, { nextRunAt: current.runAt, error: result.error })
    return
  }

  // A 'resume' passes no `nextRunAt`, so it becomes 'done' (or 'failed').
  markScheduleRun(schedule.id, { error: result.error })
}

/**
 * Fires a recurring schedule: a NEW session, the stored prompt, one reply.
 *
 * WHY A NEW SESSION EVERY TIME. The alternative — appending to one long
 * conversation — makes today's report depend on yesterday's context: it grows
 * without bound, hits compaction, and the model starts referring to work it
 * did last week. A fresh session gives every run identical starting
 * conditions, which is what makes a daily report reproducible.
 *
 * The project is carried across, so all the runs share one work directory and
 * the files build up where they are expected.
 */
async function runRecurring(schedule: Schedule, now: number): Promise<void> {
  const next = nextFiring(schedule, now)

  const choice = await pickModel(schedule)
  if (!choice) {
    markScheduleRun(schedule.id, {
      nextRunAt: next,
      error: 'No usable model was found — check that a provider is configured',
    })
    return
  }

  const stamp = new Date(now).toLocaleDateString('en-CA') // YYYY-MM-DD
  const session = createSession(`${schedule.title} — ${stamp}`, undefined, schedule.projectId)
  lockSessionModel(session.id, choice.provider, choice.model)

  // Point the schedule at this run's session BEFORE streaming: if the run
  // fails, the list still links to the conversation where the failure is
  // visible.
  setScheduleSession(schedule.id, session.id)

  // AUTO MODE, OR THE RUN DOES NOT HAPPEN. In `confirm` mode the agent would
  // stop at the first command and wait five minutes for nobody — see the box
  // on `enableAutoMode`. The session is created first either way, so the
  // refusal is visible in the conversation list rather than being invisible.
  const refusal = enableAutoMode(session.id, scheduleWorkDir(session.id), choice.provider)
  if (refusal) {
    markScheduleRun(schedule.id, { nextRunAt: next, error: refusal })
    auditWrite('barpo', 'schedule refused', `${schedule.title}: ${refusal}`.slice(0, 120), 'write', 'denied')
    return
  }

  const messageId = crypto.randomUUID()
  // The note goes FIRST — see `SCHEDULED_RUN_NOTE` for what happens without it.
  writeMessage({
    sessionId: session.id,
    role: 'user',
    text: `${SCHEDULED_RUN_NOTE}${schedule.prompt}`,
  })

  auditWrite('barpo', 'schedule started a conversation', schedule.title, 'write', 'OK')

  const result = await runWithAutoMode(session.id, messageId, choice)

  markScheduleRun(schedule.id, { nextRunAt: next, error: result.error })
}

/**
 * The model a recurring run uses.
 *
 * The schedule's own choice wins when it still exists — a model can be removed
 * between the schedule being created and it firing (a key revoked, Ollama not
 * running), and starting a session locked to a model that is gone would fail on
 * the first token with an opaque provider error.
 *
 * Otherwise the first model in the detected list, which is ordered so that
 * local and subscription models come before paid API keys — the right default
 * for work that runs unattended and repeatedly.
 */
async function pickModel(schedule: Schedule): Promise<ModelChoice | null> {
  let detected = cachedResult()
  if (!detected) {
    try {
      detected = await detectModels()
    } catch {
      return null
    }
  }

  if (schedule.provider && schedule.model) {
    const exists = detected.models.some(
      (m) => m.provider === schedule.provider && m.id === schedule.model,
    )
    if (exists) return { provider: schedule.provider, model: schedule.model }
    // Falls through to the default rather than failing: a report that arrives
    // from a different model beats no report and a stale error.
  }

  const first = detected.models[0]
  return first ? { provider: first.provider, model: first.id } : null
}

/**
 * When this schedule next fires — `undefined` for a one-shot.
 *
 * A cron expression that no longer yields a firing (or has become invalid
 * somehow) returns `undefined` too, which retires the schedule rather than
 * leaving a row that can never run again.
 */
function nextFiring(schedule: Schedule, now: number): number | undefined {
  if (schedule.kind !== 'recurring' || !schedule.cron) return undefined
  try {
    return nextRunOf(schedule.cron, new Date(now)) ?? undefined
  } catch {
    return undefined
  }
}

/** Tells the UI list that a schedule changed */
function broadcast(id: string): void {
  const schedule = readSchedule(id)
  if (schedule) hub.broadcast({ type: 'schedule.changed', schedule })
}

/** "3 hours", "2 days" — for the skip message */
function formatLateness(ms: number): string {
  const hours = Math.round(ms / (60 * 60 * 1000))
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------------------
// Creating a resume schedule — called by the orchestrator on a limit error
// ---------------------------------------------------------------------------

export interface ResumePlan {
  sessionId: string
  /** When to continue — epoch ms, already including the margin */
  resumeAt: number
  /** The provider error, for the schedule's title */
  reason: string
}

/**
 * Books a continuation for a conversation that hit the provider's quota.
 *
 * Returns the schedule, or `null` when one is already pending for this session
 * — a limit error can arrive several times in a row (the user retries, two
 * streams overlap), and without that check the same conversation would be
 * queued to continue three times over.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ A CONTINUATION THAT HITS THE LIMIT AGAIN IS RE-ARMED, NOT DROPPED.   │
 * │                                                                      │
 * │ When a `resume` run is what hit the quota, the row driving that run  │
 * │ is still 'active' (`markScheduleRun` only writes when the stream     │
 * │ ends), so `pendingResume` hands it back as `existing` — a row whose  │
 * │ `runAt` is in the PAST, because it is the firing happening right     │
 * │ now. Returning `null` there did two wrong things at once: the user   │
 * │ was shown "continues at <a time that has already gone>", and the     │
 * │ stream then retired that same row as 'failed', leaving nothing       │
 * │ pending at all. The promise on screen had no schedule behind it.     │
 * │                                                                      │
 * │ So a row already due moves to the new reset time and is returned.    │
 * │ `runResume` sees the moved `runAt` and leaves the row alone (see     │
 * │ the completion check there), which is what makes the fallback        │
 * │ repeat: a guessed reset time that was too early costs another hour,  │
 * │ not the whole continuation.                                          │
 * └──────────────────────────────────────────────────────────────────────┘
 */
export function planResume(
  plan: ResumePlan,
  existing?: Schedule | null,
  now: number = Date.now(),
): Schedule | null {
  if (existing) {
    // Still in the future: a genuine duplicate — the conversation is already
    // booked to continue and one booking is enough.
    if (existing.runAt > now) return null

    // Due or overdue: this IS the run that just hit the limit again. Move it
    // to the new reset time so a continuation remains pending.
    setScheduleRunAt(existing.id, plan.resumeAt)
    const rearmed = readSchedule(existing.id)
    if (rearmed) {
      auditWrite(
        'barpo',
        'continuation re-armed',
        `${new Date(plan.resumeAt).toISOString()} — ${plan.reason.slice(0, 80)}`,
        'write',
        'OK',
      )
      hub.broadcast({ type: 'schedule.changed', schedule: rearmed })
      return rearmed
    }
    return null
  }

  const schedule = createSchedule({
    kind: 'resume',
    title: 'Continue after the provider limit',
    prompt: RESUME_PROMPT,
    runAt: plan.resumeAt,
    createdBy: 'system',
    sessionId: plan.sessionId,
  })

  auditWrite(
    'barpo',
    'continuation scheduled',
    `${new Date(plan.resumeAt).toISOString()} — ${plan.reason.slice(0, 80)}`,
    'write',
    'OK',
  )
  hub.broadcast({ type: 'schedule.changed', schedule })
  return schedule
}

/**
 * Recomputes `runAt` when a paused schedule is switched back on.
 *
 * Un-pausing a schedule whose `runAt` is in the past would fire it on the very
 * next tick, which is rarely what "resume this" means — the user wants the next
 * SCHEDULED time, not an immediate catch-up.
 */
export function rearm(schedule: Schedule, now: number = Date.now()): void {
  const next = nextFiring(schedule, now)
  if (next) setScheduleRunAt(schedule.id, next)
}
