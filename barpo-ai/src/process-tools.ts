// The background-process tools — `processStart`, `processOutput`,
// `processStop`, `processList`.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHAT THESE TOOLS ARE FOR. "Start the dev server and give me the      │
// │ link" is the single most natural request on a platform that builds   │
// │ programs — and `bash` cannot serve it: it waits for the command to   │
// │ finish, and a server never finishes. The agent either froze until    │
// │ the timeout killed the server, or refused.                           │
// │                                                                      │
// │ `processStart` runs the command in the background and RETURNS THE    │
// │ URL the server printed, so the agent's very next sentence can be     │
// │ "it is running at http://localhost:5173". The other three tools are  │
// │ the follow-through: read the logs, stop it, see what is running.     │
// └──────────────────────────────────────────────────────────────────────┘
//
// SECURITY — THE SAME GATE AS `bash`, DELIBERATELY. A background command is
// not a lesser command: `processStart` routes through the very same
// `assessCommand` chain as `RestrictedEnv.exec` — hard denies never run,
// anything not on the safe list goes through `permission.ask()`. The
// `pattern` is shared with `bash` on purpose: "always allow `bun run`" means
// the user trusts the command, not the tool it arrived through.
//
// The other three tools ask NOTHING: they only touch processes this session
// itself started. Reading their output and stopping them is strictly less
// dangerous than having started them.

import { existsSync } from 'node:fs'
import { Type, type Static } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { assessCommand } from './command-analysis.ts'
import type { PermissionManager } from './permission.ts'
import type { ProcessManager, ProcessSnapshot } from './process-manager.ts'
import type { SearchTool } from './search-tools.ts'

/** The default and maximum wait for a server to announce itself */
export const START_WAIT_DEFAULT_S = 5
export const START_WAIT_MAX_S = 30

/** How much of the output tail goes back to the model in one result */
const OUTPUT_SLICE = 4000

/** Detail for the tool card in the UI */
export interface ProcessDetail {
  processId?: string
  status?: string
  urls?: string[]
  denied?: boolean
}

const processStartSchema = Type.Object({
  command: Type.String({
    description:
      'The command to run in the background, e.g. "bun run dev". It keeps running after ' +
      'this call returns and between messages — do NOT use this for commands that finish ' +
      'on their own (builds, tests, git); those belong to `bash`.',
  }),
  name: Type.Optional(
    Type.String({
      description: 'A short label for the user, e.g. "dev server". Defaults to the command.',
    }),
  ),
  waitSeconds: Type.Optional(
    Type.Number({
      description:
        `How long to wait for the process to print a local URL before returning ` +
        `(default ${START_WAIT_DEFAULT_S}, max ${START_WAIT_MAX_S}). The call returns early as soon as a URL ` +
        'appears or the process exits.',
    }),
  ),
})

export type ProcessStartInput = Static<typeof processStartSchema>

const processIdSchema = Type.Object({
  id: Type.String({ description: 'The process id (from processStart or processList).' }),
})

export type ProcessIdInput = Static<typeof processIdSchema>

const processListSchema = Type.Object({})
export type ProcessListInput = Static<typeof processListSchema>

/** One line describing a process — shared by every result text */
function describeProcess(s: ProcessSnapshot): string {
  const state =
    s.status === 'running'
      ? 'running'
      : s.status === 'killed'
        ? 'stopped'
        : `exited with code ${s.exitCode ?? 'unknown'}`
  const urls = s.urls.length > 0 ? ` · ${s.urls.join(' ')}` : ''
  return `${s.id} (${s.name}): ${state}${urls}`
}

/** The output tail, trimmed for the context window */
function outputSlice(text: string): string {
  if (text.length <= OUTPUT_SLICE) return text
  return `… (${text.length - OUTPUT_SLICE} earlier characters omitted)\n${text.slice(-OUTPUT_SLICE)}`
}

function textResult(text: string, details: ProcessDetail): AgentToolResult<ProcessDetail> {
  return { content: [{ type: 'text', text }], details }
}

/**
 * Creates the `processStart` tool.
 *
 * The result is written for the agent's NEXT action: on success it leads
 * with the URL (report it to the user), on a fast failure it leads with the
 * exit code and the output (diagnose it), and on a quiet start it says
 * explicitly that no URL appeared yet and where to look for it.
 */
export function createProcessStartTool(
  manager: ProcessManager,
  permission: PermissionManager,
): SearchTool<ProcessStartInput, ProcessDetail> {
  return {
    name: 'processStart',
    label: 'processStart',
    description: [
      'Run a long-lived command in the BACKGROUND: a dev server, a file watcher, anything',
      'that does not finish on its own. The call returns once the process prints a local',
      'URL, exits, or the wait runs out — the process itself keeps running, including',
      'between messages.',
      '',
      'Detected local URLs come back in the result: report them to the user so they can',
      'open the app. Read later output with processOutput; stop the process with',
      'processStop when it is no longer needed.',
      '',
      'For commands that finish (builds, tests, installs, git) use `bash` instead — this',
      'tool would leave them hanging around as zombie entries.',
    ].join('\n'),
    parameters: processStartSchema,
    async execute(
      _toolCallId,
      params: ProcessStartInput,
      _signal,
      _onUpdate,
      context,
    ): Promise<AgentToolResult<ProcessDetail>> {
      const workDir = context.env.cwd
      const assessment = assessCommand(params.command, {
        workDir,
        exists: (path) => existsSync(path),
      })

      // The hard denies never run — the same unconditional guarantee as
      // `RestrictedEnv.exec`, and recorded the same way so the user can see
      // why nothing happened.
      if (assessment.category === 'forbidden') {
        permission.recordForbidden(assessment.pattern)
        return {
          content: [
            {
              type: 'text',
              text: `Forbidden command: ${assessment.reason ?? 'it would damage the system'}`,
            },
          ],
          details: { denied: true },
        }
      }

      if (assessment.category !== 'safe') {
        const answer = await permission.ask({
          kind: 'command',
          action: 'processStart',
          target: params.command,
          reason:
            `${assessment.reason ?? 'an unvetted command'} — and it will keep running in ` +
            'the background after the reply ends',
          pattern: assessment.pattern,
        })
        if (answer === 'deny') {
          return {
            content: [
              {
                type: 'text',
                text:
                  'The user did NOT allow this command to run in the background. ' +
                  'Explain and suggest another way; do not simply retry.',
              },
            ],
            details: { denied: true },
          }
        }
      }

      let started: ProcessSnapshot
      try {
        started = manager.start(params.command, {
          cwd: workDir,
          ...(params.name ? { name: params.name } : {}),
        })
      } catch (error) {
        // The per-session limit — returned as text so the agent reads the
        // instruction (stop one first) instead of seeing an opaque failure.
        return {
          content: [
            { type: 'text', text: error instanceof Error ? error.message : String(error) },
          ],
          details: {},
        }
      }

      const waitSeconds = Math.min(
        Math.max(params.waitSeconds ?? START_WAIT_DEFAULT_S, 1),
        START_WAIT_MAX_S,
      )
      const ready = await manager.waitForReady(started.id, waitSeconds * 1000)
      const read = manager.readNew(started.id)
      const output = read?.text ? `\n\nOutput so far:\n${outputSlice(read.text)}` : ''

      // Died before the wait ran out — a fast failure (port in use, missing
      // script). The agent must see this as an ERROR, not a started server.
      if (ready.status !== 'running') {
        return {
          content: [
            {
              type: 'text',
              text:
                `The process exited immediately (code ${ready.exitCode ?? 'unknown'}) — ` +
                `it did not stay running.${output}`,
            },
          ],
          details: { processId: ready.id, status: ready.status },
        }
      }

      const urlLine =
        ready.urls.length > 0
          ? `It is serving at: ${ready.urls.join(' ')} — give this link to the user.`
          : 'No local URL has appeared in the output yet. If one is expected, check ' +
            'processOutput in a moment.'

      return textResult(
        [
          `Background process ${ready.id} ("${ready.name}") is running.`,
          urlLine,
          'It keeps running between messages. Stop it with processStop when no longer needed.',
        ].join('\n') + output,
        { processId: ready.id, status: ready.status, urls: ready.urls },
      )
    },
  }
}

/**
 * Creates the `processOutput` tool.
 *
 * Returns only what appeared SINCE THE LAST READ — the agent polls servers
 * repeatedly, and resending logs it has already seen would drown the context.
 */
export function createProcessOutputTool(
  manager: ProcessManager,
): SearchTool<ProcessIdInput, ProcessDetail> {
  return {
    name: 'processOutput',
    label: 'processOutput',
    description: [
      'Read what a background process has printed SINCE YOU LAST LOOKED (stdout and stderr',
      'together). Also reports whether it is still running and any local URLs it announced.',
      'Use it to check on a server after starting it, or to diagnose one that misbehaves.',
    ].join('\n'),
    parameters: processIdSchema,
    async execute(
      _toolCallId,
      params: ProcessIdInput,
    ): Promise<AgentToolResult<ProcessDetail>> {
      const read = manager.readNew(params.id)
      if (!read) {
        return {
          content: [
            {
              type: 'text',
              text: `No process with id "${params.id}". Check processList for the ones that exist.`,
            },
          ],
          details: {},
        }
      }

      const lostNote =
        read.lost > 0 ? `\n[${read.lost} characters of older output were dropped]` : ''
      const body = read.text
        ? `New output:\n${outputSlice(read.text)}`
        : 'No new output since the last read.'

      return textResult(`${describeProcess(read.snapshot)}\n${body}${lostNote}`, {
        processId: read.snapshot.id,
        status: read.snapshot.status,
        urls: read.snapshot.urls,
      })
    },
  }
}

/**
 * Creates the `processStop` tool.
 *
 * No permission is asked: the tool can only stop processes THIS SESSION
 * started, and undoing your own work is not a dangerous capability — the
 * dangerous step was starting it, and that one did ask.
 */
export function createProcessStopTool(
  manager: ProcessManager,
): SearchTool<ProcessIdInput, ProcessDetail> {
  return {
    name: 'processStop',
    label: 'processStop',
    description: [
      'Stop a background process started in this session (SIGTERM first, then SIGKILL if',
      'it does not comply). Use it when the server is no longer needed, or before',
      'restarting one on the same port.',
    ].join('\n'),
    parameters: processIdSchema,
    async execute(
      _toolCallId,
      params: ProcessIdInput,
    ): Promise<AgentToolResult<ProcessDetail>> {
      const stopped = manager.stop(params.id)
      if (!stopped) {
        return {
          content: [
            {
              type: 'text',
              text: `No process with id "${params.id}". Check processList for the ones that exist.`,
            },
          ],
          details: {},
        }
      }
      return textResult(`Stopping ${stopped.id} ("${stopped.name}").`, {
        processId: stopped.id,
        status: stopped.status,
      })
    },
  }
}

/**
 * Creates the `processList` tool.
 *
 * Read-only, asks nothing. Its real job — like `scheduleList` — is
 * preventing duplicates: the agent checks it before starting a second dev
 * server on a port the first one already holds.
 */
export function createProcessListTool(
  manager: ProcessManager,
): SearchTool<ProcessListInput, ProcessDetail> {
  return {
    name: 'processList',
    label: 'processList',
    description: [
      'List the background processes of this session: id, label, state and any URLs they',
      'announced. CHECK THIS BEFORE STARTING A SERVER — one may already be running.',
    ].join('\n'),
    parameters: processListSchema,
    async execute(): Promise<AgentToolResult<ProcessDetail>> {
      const processes = manager.list()
      if (processes.length === 0) {
        return textResult('No background processes in this session.', {})
      }
      return textResult(
        `${processes.length} background process(es):\n${processes
          .map((s) => `- ${describeProcess(s)}`)
          .join('\n')}`,
        {},
      )
    },
  }
}

/**
 * The process tools — the raw shape, with no context attached.
 *
 * Declared only when BOTH the manager and the permission manager are present
 * (the same rule as `scheduleToolsRaw`): a tool that launches unattended
 * work and cannot ask first is not shipped.
 */
export function processToolsRaw(
  manager?: ProcessManager,
  permission?: PermissionManager,
): SearchTool<never>[] {
  if (!manager || !permission) return []
  return [
    createProcessStartTool(manager, permission),
    createProcessOutputTool(manager),
    createProcessStopTool(manager),
    createProcessListTool(manager),
  ] as unknown as SearchTool<never>[]
}

/**
 * The section appended to `AGENT_SYSTEM_PROMPT` — same file as the tools so
 * the two cannot drift apart (the rule established in `search-tools.ts`).
 */
export const PROCESS_PROMPT_SECTION = {
  list: [
    '- processStart: run a long-lived command in the background (dev server, watcher)',
    '- processOutput: read what a background process printed since you last looked',
    '- processStop: stop a background process',
    '- processList: see the background processes of this session',
  ],
  rules: [
    '`bash` WAITS for its command and times out — a dev server or watcher does not',
    'belong there. Start those with `processStart`; it returns as soon as the server',
    'announces its URL. When a server starts, GIVE THE USER ITS LINK — that is why',
    'they asked. If no URL showed up yet, check `processOutput` before concluding it',
    'failed.',
    '',
    'Background processes keep running between messages. Check `processList` before',
    'starting a second copy of the same server, and stop what is no longer needed',
    'with `processStop` — a forgotten server holds its port.',
  ],
} as const
