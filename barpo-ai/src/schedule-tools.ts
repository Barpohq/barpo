// The schedule tools — `scheduleCreate`, `scheduleList`, `scheduleDelete`.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHAT THESE TOOLS ARE FOR. The user says "I have to prepare this      │
// │ report every day" — and that sentence should be enough. The agent    │
// │ writes the rule down, and from then on the platform opens a fresh    │
// │ conversation at the right time and does the work.                    │
// │                                                                      │
// │ The alternative is the user remembering, every morning, to come      │
// │ back and paste the same instruction. That is precisely the clerical  │
// │ work the platform exists to remove.                                  │
// └──────────────────────────────────────────────────────────────────────┘
//
// LAYER BOUNDARY — the same inversion as `dashboard-tools.ts` and
// `server-tools.ts`. Schedules live in SQLite and the tick lives in
// `barpo-server`; `@barpo/ai` does NOT DEPEND on the server, so the
// functions are supplied from outside (`ScheduleSink`, `ScheduleLister`,
// `ScheduleRemover`). This file knows neither the database nor the timer.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY CREATE AND DELETE ASK, AND LIST DOES NOT.                        │
// │                                                                      │
// │ `scheduleCreate` commits the platform to acting on its own, later,   │
// │ with nobody watching — including spending tokens against the user's  │
// │ plan every single day. That is a decision a person should see        │
// │ before it is made, so it goes through the permission layer.          │
// │                                                                      │
// │ It does NOT use `requireUser`, unlike `appDelete`. A schedule is     │
// │ reversible (pause it, delete it), it is visible in a list, and it    │
// │ destroys nothing. Forcing a human answer even in auto mode would be  │
// │ permission fatigue for an action the user can undo in one click.     │
// │                                                                      │
// │ `scheduleList` only reads, so it asks nothing — the agent needs to   │
// │ see what already exists before proposing another one.                │
// └──────────────────────────────────────────────────────────────────────┘

import { Type, type Static } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { PermissionManager } from './permission.ts'
import type { SearchTool } from './search-tools.ts'

/** One schedule, as the agent sees it — a deliberately small subset */
export interface ScheduleSummary {
  id: string
  title: string
  kind: 'resume' | 'recurring'
  /** Plain-language rendering, e.g. "every day at 09:00" */
  when: string
  status: string
  /** ISO time of the next firing */
  nextRun: string
  createdBy: string
  runs: number
  lastError?: string
  /** `provider/model` when the schedule pins one; absent means the default */
  model?: string
}

/** The outcome of creating one */
export interface ScheduleCreateResult {
  ok: boolean
  /** On success — the stored schedule */
  schedule?: ScheduleSummary
  /** On failure — why. The agent reads this and fixes its arguments. */
  error?: string
}

export interface ScheduleDeleteResult {
  ok: boolean
  error?: string
}

/** Supplied by the caller: writes the schedule and returns it */
export type ScheduleSink = (input: {
  title: string
  prompt: string
  cron: string
  /**
   * The model the runs should use. OPTIONAL, and normally omitted — the caller
   * then falls back to the model of the conversation the tool was called from
   * (see `createFromAgent` in the server).
   *
   * Only set when the user asked for a specific one ("run it on Haiku to keep
   * it cheap"). Both fields go together: a provider without a model, or the
   * other way round, is not enough to start a session.
   */
  provider?: string
  model?: string
}) => ScheduleCreateResult | Promise<ScheduleCreateResult>

/** Supplied by the caller: the current schedules */
export type ScheduleLister = () => ScheduleSummary[] | Promise<ScheduleSummary[]>

/** Supplied by the caller: deletes one by id */
export type ScheduleRemover = (
  id: string,
) => ScheduleDeleteResult | Promise<ScheduleDeleteResult>

/** Detail for the tool card in the UI */
export interface ScheduleDetail {
  scheduleId?: string
  ok: boolean
  denied?: boolean
}

const scheduleCreateSchema = Type.Object({
  title: Type.String({
    description:
      'A short name for the list, e.g. "Daily API report". This also becomes the title of ' +
      'each conversation the schedule opens.',
  }),
  cron: Type.String({
    description:
      'When to run, as a 5-field cron expression: "minute hour day month weekday". ' +
      'Examples: "0 9 * * *" every day at 09:00; "30 8 * * mon-fri" weekdays at 08:30; ' +
      '"0 18 * * fri" every Friday at 18:00; "0 9 1 * *" on the 1st of each month. ' +
      'Times are the user\'s LOCAL time. Shorthands like @daily are not accepted.',
  }),
  prompt: Type.String({
    description:
      'The instruction sent when it fires. WRITE IT AS IF TO SOMEONE WHO HAS NEVER SEEN ' +
      'this conversation: every run starts in a brand-new chat with no memory of this one. ' +
      'Include the sources, the rules to apply and where the result should go.',
  }),
  provider: Type.Optional(
    Type.String({
      description:
        'OMIT THIS unless the user asked for a specific model. Left out, the runs use the ' +
        'model of this conversation, which is almost always what they expect. Only set it ' +
        'when they said so ("run it on a cheaper model"), and set `model` with it.',
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: 'Goes with `provider`. Omit unless the user named a model.',
    }),
  ),
})

export type ScheduleCreateInput = Static<typeof scheduleCreateSchema>

const scheduleDeleteSchema = Type.Object({
  id: Type.String({ description: 'The id of the schedule to delete (from scheduleList).' }),
})

export type ScheduleDeleteInput = Static<typeof scheduleDeleteSchema>

/** `scheduleList` takes no arguments */
const scheduleListSchema = Type.Object({})
export type ScheduleListInput = Static<typeof scheduleListSchema>

/**
 * Creates the `scheduleCreate` tool.
 *
 * The description spends most of its length on ONE point: the prompt is read
 * by a model with no memory of the conversation that created it. That is the
 * mistake this tool invites — the agent writes "do what we discussed", the
 * schedule fires a week later into an empty session, and the run produces
 * nothing useful. A wrong cron expression is caught by the parser; a prompt
 * that assumes context fails silently, every day, for as long as it runs.
 */
export function createScheduleCreateTool(
  sink: ScheduleSink,
  permission: PermissionManager,
): SearchTool<ScheduleCreateInput, ScheduleDetail> {
  return {
    name: 'scheduleCreate',
    label: 'scheduleCreate',
    description: [
      'Set up recurring work: the platform opens a NEW conversation at the given time and',
      'sends your prompt to it, on its own, for as long as the schedule exists.',
      '',
      'Use it when the user describes something they do REPEATEDLY — "every day", "every',
      'Monday", "at the end of each month". Do not use it for a one-off task you can simply',
      'do now.',
      '',
      'THE PROMPT IS THE WHOLE INSTRUCTION. Each run happens in a brand-new chat that cannot',
      'see this conversation, this project, or anything you have already worked out. Write',
      'out the sources, the rules and the destination in full. "Prepare the report we',
      'discussed" produces nothing; "Read the sales figures from the /api/sales endpoint,',
      'group them by region, apply the discount rules in rules.md and write the result to',
      'report-YYYY-MM-DD.md" works every time.',
      '',
      'THE MODEL: leave `provider`/`model` out and the runs use the model of this',
      'conversation. Only set them if the user asked for something specific.',
      '',
      'The user is asked to confirm before it is created, and they can pause or delete it',
      'from the Schedules page at any time.',
      '',
      'A scheduled run works in AUTO permission mode: it has to, since nobody is there to',
      'answer a confirmation prompt. Commands are checked by the classifier instead. Keep',
      'that in mind when writing the prompt — do not set up work you would not want run',
      'unattended.',
    ].join('\n'),
    parameters: scheduleCreateSchema,
    async execute(
      _toolCallId: string,
      params: ScheduleCreateInput,
    ): Promise<AgentToolResult<ScheduleDetail>> {
      const answer = await permission.ask({
        kind: 'file',
        action: 'scheduleCreate',
        target: params.title,
        reason:
          `Creates a recurring task: "${params.title}" (${params.cron}). The platform will ` +
          'open a new conversation and run it automatically, in AUTO permission mode ' +
          '(no confirmation prompts — nobody is there to answer them), using the plan ' +
          'quota each time.' +
          // Only mentioned when the model differs from the obvious default. A
          // line saying "on the model you are already using" would be noise on
          // every single request.
          (params.provider && params.model ? ` Runs on ${params.provider}/${params.model}.` : ''),
        // Per-schedule, so an "always" answer authorises THIS schedule rather
        // than every future one. The title is the user's own words.
        pattern: `scheduleCreate:${params.title}`,
      })

      if (answer === 'deny') {
        return {
          content: [
            {
              type: 'text',
              text:
                `The user did NOT allow the schedule "${params.title}" to be created. ` +
                'Nothing was set up.\nAsk what they would prefer instead of trying again.',
            },
          ],
          details: { ok: false, denied: true },
        }
      }

      const result = await sink(params)

      if (!result.ok || !result.schedule) {
        // Returned as TEXT rather than thrown: the agent has to read the
        // reason and fix its own arguments (a bad cron expression is the
        // common case), which a thrown error would not allow.
        return {
          content: [
            {
              type: 'text',
              text:
                `The schedule was NOT created: ${result.error ?? 'unknown error'}\n` +
                'Fix the arguments and call scheduleCreate again.',
            },
          ],
          details: { ok: false },
        }
      }

      const s = result.schedule
      return {
        content: [
          {
            type: 'text',
            text: [
              `Schedule "${s.title}" created — ${s.when}.`,
              `First run: ${s.nextRun}.`,
              s.model ? `Model: ${s.model}.` : '',
              '',
              'It now appears on the Schedules page, where the user can pause or delete it.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
        details: { scheduleId: s.id, ok: true },
      }
    },
  }
}

/**
 * Creates the `scheduleList` tool.
 *
 * Read-only, so it asks for nothing. Its real job is preventing duplicates:
 * without it the agent has no way to know a daily report already exists, and
 * "set up my daily report" said twice produces two reports every morning.
 */
export function createScheduleListTool(
  lister: ScheduleLister,
): SearchTool<ScheduleListInput, ScheduleDetail> {
  return {
    name: 'scheduleList',
    label: 'scheduleList',
    description: [
      'List the recurring tasks set up on this platform: what they do, when they next run,',
      'and whether the last run failed.',
      '',
      'CHECK THIS BEFORE CREATING A NEW SCHEDULE — if a similar one already exists, change',
      'or replace it rather than adding a second one that does the same work twice.',
    ].join('\n'),
    parameters: scheduleListSchema,
    async execute(): Promise<AgentToolResult<ScheduleDetail>> {
      const schedules = await lister()

      if (schedules.length === 0) {
        return {
          content: [{ type: 'text', text: 'There are no schedules on this platform yet.' }],
          details: { ok: true },
        }
      }

      const lines = schedules.map((s) => {
        const parts = [
          `- ${s.title} [${s.id}]`,
          `    ${s.kind === 'resume' ? 'one-off continuation' : s.when} · ${s.status} · next: ${s.nextRun}`,
          `    created by: ${s.createdBy} · runs so far: ${s.runs}${s.model ? ` · ${s.model}` : ''}`,
        ]
        if (s.lastError) parts.push(`    last error: ${s.lastError}`)
        return parts.join('\n')
      })

      return {
        content: [{ type: 'text', text: `${schedules.length} schedule(s):\n\n${lines.join('\n')}` }],
        details: { ok: true },
      }
    },
  }
}

/**
 * Creates the `scheduleDelete` tool.
 *
 * Asks for permission, but NOT with `requireUser`. Deleting a schedule stops
 * future work; it destroys nothing that already happened — the conversations
 * its past runs produced stay exactly where they are. That is a materially
 * smaller loss than `appDelete`, which erases files the user may have written
 * by hand, so it does not warrant the same absolute rule.
 */
export function createScheduleDeleteTool(
  remover: ScheduleRemover,
  permission: PermissionManager,
): SearchTool<ScheduleDeleteInput, ScheduleDetail> {
  return {
    name: 'scheduleDelete',
    label: 'scheduleDelete',
    description: [
      'Delete a recurring task, so it stops running. Get the id from scheduleList first.',
      '',
      'The conversations its past runs produced are NOT affected — only future runs stop.',
      'To pause one temporarily the user can do that themselves on the Schedules page;',
      'deleting is for when it is no longer wanted at all.',
    ].join('\n'),
    parameters: scheduleDeleteSchema,
    async execute(
      _toolCallId: string,
      params: ScheduleDeleteInput,
    ): Promise<AgentToolResult<ScheduleDetail>> {
      const answer = await permission.ask({
        kind: 'file',
        action: 'scheduleDelete',
        target: params.id,
        reason: `Stops the recurring task "${params.id}". Future runs will not happen.`,
        pattern: `scheduleDelete:${params.id}`,
      })

      if (answer === 'deny') {
        return {
          content: [
            {
              type: 'text',
              text:
                `The user did NOT allow the schedule "${params.id}" to be deleted. ` +
                'It is still active.',
            },
          ],
          details: { scheduleId: params.id, ok: false, denied: true },
        }
      }

      const result = await remover(params.id)

      if (!result.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `Could not delete the schedule: ${result.error ?? 'unknown error'}`,
            },
          ],
          details: { scheduleId: params.id, ok: false },
        }
      }

      return {
        content: [{ type: 'text', text: `The schedule was deleted. It will not run again.` }],
        details: { scheduleId: params.id, ok: true },
      }
    },
  }
}

/**
 * The schedule tools — the raw shape, with no context attached.
 *
 * When the providers are missing an EMPTY list is returned: the tools are not
 * declared at all, so the agent does not know they exist (the same logic as
 * `dashboardToolsRaw`). Create and delete additionally require the permission
 * manager — a tool that commits the platform to unattended work, and cannot
 * ask first, is exactly what this design refuses to ship.
 */
export function scheduleToolsRaw(
  sink?: ScheduleSink,
  lister?: ScheduleLister,
  remover?: ScheduleRemover,
  permission?: PermissionManager,
): SearchTool<never>[] {
  const tools: SearchTool<never>[] = []
  if (sink && permission) {
    tools.push(createScheduleCreateTool(sink, permission) as unknown as SearchTool<never>)
  }
  if (lister) tools.push(createScheduleListTool(lister) as unknown as SearchTool<never>)
  if (remover && permission) {
    tools.push(createScheduleDeleteTool(remover, permission) as unknown as SearchTool<never>)
  }
  return tools
}

/** The context-attached shape, for tests and direct use */
export function scheduleTools(
  sink?: ScheduleSink,
  lister?: ScheduleLister,
  remover?: ScheduleRemover,
  permission?: PermissionManager,
): AgentTool<never>[] {
  return scheduleToolsRaw(sink, lister, remover, permission).map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: never) =>
      tool.execute(toolCallId, params, signal, onUpdate, { env: { cwd: '' } }),
  })) as unknown as AgentTool<never>[]
}

/**
 * The section appended to `AGENT_SYSTEM_PROMPT`.
 *
 * Same reason as `DASHBOARD_PROMPT_SECTION`: the tool's behaviour and the text
 * describing it belong in ONE FILE. Added conditionally by `agent.ts` — no
 * providers, no tools, no prompt text.
 */
export const SCHEDULE_PROMPT_SECTION = {
  list: [
    '- scheduleCreate: set up work that repeats on a timetable (asks the user first)',
    '- scheduleList: see the schedules that already exist',
    '- scheduleDelete: stop a recurring task (asks the user first)',
  ],
  rules: [
    'When the user describes work they do REPEATEDLY ("every day", "each Monday", "at the',
    'end of every month"), offer to set up a schedule. Do not create one for a task you',
    'can simply carry out now.',
    '',
    'A scheduled run starts in a NEW, EMPTY conversation: it cannot see this chat, and it',
    'has no memory of anything you have worked out here. So the prompt you store must be',
    'self-contained — name the sources, the rules and where the output goes. This is the',
    'single most common way a schedule fails, and it fails silently, every day.',
    '',
    'Call scheduleList before creating one, so you do not add a second schedule that does',
    'the same work as an existing one.',
    '',
    'A schedule inherits the model of the conversation that created it — do not pass',
    '`provider`/`model` unless the user asked for a particular one.',
    '',
    'Scheduled runs work in AUTO permission mode, because there is nobody present to',
    'answer a confirmation. The classifier checks each command instead. Do not set up',
    'work on a schedule that you would not be comfortable running unattended.',
  ],
}
