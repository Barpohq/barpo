// The app lifecycle tools — `appPublish` and `appDelete`.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ CORE RULE: THE AGENT DOES NOT WRITE APIs.                            │
// │                                                                      │
// │ Letting the agent write an endpoint for a dashboard looks tempting   │
// │ ("let it add its own route"), but that would break two things:       │
// │   1) Every dashboard would add NEW CODE to the server — i.e. an AI   │
// │      mistake could take the whole platform down.                     │
// │   2) That code would get full access to the database and the         │
// │      internal network.                                               │
// │                                                                      │
// │ The platform still owns every route. What changed is WHERE the       │
// │ dashboard itself lives — see below.                                  │
// └──────────────────────────────────────────────────────────────────────┘
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ AN APP IS A FOLDER, AND THAT IS WHAT MAKES UPDATES WORK.             │
// │                                                                      │
// │ `appPublish` used to receive the ENTIRE manifest as arguments, and   │
// │ the platform stored it as a JSON blob. Republishing replaced the     │
// │ whole thing — so "add one widget" meant the model rewriting every    │
// │ state, every setting and the full view from memory, and whatever it  │
// │ failed to repeat was silently gone.                                  │
// │                                                                      │
// │ Now the agent writes ordinary files with `write`/`edit`:             │
// │                                                                      │
// │     ~/.barpo/apps/<id>/app.json      metadata, widgets, data     │
// │                          view.jsx        optional custom view        │
// │                          states/<n>.js   one file per live value     │
// │                          settings.js     writes the form values      │
// │                          actions/<n>.js  one file per button         │
// │                                                                      │
// │ …and `appPublish` only says "this folder is an app". UPDATING NEEDS  │
// │ NO TOOL AT ALL: `edit view.jsx` IS the update, because every request │
// │ reads the folder. The user can open the same files in their own      │
// │ editor, and nothing can be lost by omission.                         │
// └──────────────────────────────────────────────────────────────────────┘
//
// THREE KINDS OF CODE, RUN IN TWO PLACES:
//
//   `view.jsx`    — JSX. Renders in the browser, inside the host React tree
//                   (`AiView.tsx`). It mostly DRAWS; when there are controls
//                   it writes to ITS OWN app via `ui.save`/`ui.action`.
//
//   `states/*.js` — server JS. Runs repeatedly on an interval inside the
//                   platform process (`state-run.ts`). THIS is the layer
//                   that collects data.
//
//   `settings.js` — server JS. Runs ONCE when the user presses
//   `actions/*.js`  (`action-run.ts`) and is recorded in the audit trail.
//
// All of it runs with the platform's own privileges — that is a DELIBERATE
// decision. The next stage adds the same classifier as a check (prompt
// injection defence); the hook points are `validateCode()` in
// `state-run.ts`, `validateActionCode()` in `action-run.ts` and
// `findForbidden()` in `view-build.ts`.
//
// USER INPUT — THE NEW RISK OF THE CONTROL LAYER. `states` had NO input,
// `settings` DOES (a token, a container name). That is why the code is
// not given `exec`: it gets a narrow `ssh` object (`app-ssh.ts`), which
// forces an argv array and passes secrets over stdin. In other words the AI
// says WHAT to do, and the platform knows HOW it gets done.
//
// LAYER BOUNDARY — the same inversion as in `server-tools.ts`. The publish
// record lives in SQLite and the folders live under the server's storage
// root, i.e. both are `platform-server`'s business. `@barpo/ai` does NOT
// DEPEND on the server, so the functions are supplied from outside
// (`DashboardSink`, `DashboardRemover`). This file knows neither the database
// nor `repo.ts`.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY PUBLISH DOES NOT ASK, AND DELETE DOES.                           │
// │                                                                      │
// │ `appPublish` registers a folder the user asked for on their OWN      │
// │ platform. It is reversible (publish again, delete it) and its result │
// │ is visible immediately, so a modal on every publish would only breed │
// │ permission fatigue.                                                  │
// │                                                                      │
// │ `appDelete` ERASES THE FOLDER. There is no trash and no undo, and    │
// │ the files may include work the user edited by hand. So it goes       │
// │ through the permission layer, and — unlike every other tool — it     │
// │ does so even in AUTO MODE: `requireUser` bypasses the classifier so  │
// │ a deletion is never granted by a model's judgement. The user's rule  │
// │ is that an app disappears only when a HUMAN said so.                 │
// └──────────────────────────────────────────────────────────────────────┘


import { Type, type Static } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { PermissionManager } from './permission.ts'
import type { SearchTool } from './search-tools.ts'

/**
 * The result of publishing — the caller (the server) answers in this shape.
 *
 * A result is RETURNED instead of THROWING an error: the agent needs to see
 * the error as TEXT, so it can fix things itself and retry. A thrown error
 * would abort the tool call and leave the model in an opaque state.
 */
export interface DashboardResult {
  ok: boolean
  /** When rejected — the reasons. The agent reads this text and fixes them. */
  errors?: string[]
  /** Accepted, but some part was dropped/adjusted */
  warnings?: string[]
  /** Whether a new app was registered or an existing one re-published */
  isNew?: boolean
}

/**
 * The function that registers an app folder (supplied by the caller).
 *
 * It receives the ID ONLY. The folder path is the server's business — letting
 * the agent name a directory would mean an app could be published from
 * anywhere on disk, and the id would no longer determine where its files live.
 */
export type DashboardSink = (id: string) => DashboardResult | Promise<DashboardResult>

/** The outcome of a deletion */
export interface DashboardDeleteResult {
  ok: boolean
  /** Whether the folder itself was erased */
  folderRemoved?: boolean
  error?: string
}

/**
 * The function that deletes an app (supplied by the caller).
 *
 * Called ONLY after the permission layer has granted the request — this tool
 * never deletes on its own authority.
 */
export type DashboardRemover = (
  id: string,
) => DashboardDeleteResult | Promise<DashboardDeleteResult>

/** Detail for the UI and the logs — shown on the tool card */
export interface DashboardDetail {
  appId: string
  ok: boolean
  isNew?: boolean
}

/** Detail for a deletion tool card */
export interface DashboardDeleteDetail {
  appId: string
  ok: boolean
  /** `true` when the user refused — the card shows that differently from a failure */
  denied?: boolean
  folderRemoved?: boolean
}

const appPublishSchema = Type.Object({
  id: Type.String({
    description:
      'The app id — it is also the FOLDER NAME the files were written to. ' +
      'Lowercase letters, digits and dashes only (e.g. "ai-news-bot"). ' +
      'The `id` inside app.json must be this same value.',
  }),
})

export type AppPublishInput = Static<typeof appPublishSchema>

const appDeleteSchema = Type.Object({
  id: Type.String({
    description: 'The id of the app to delete. Its entire folder is erased.',
  }),
})

export type AppDeleteInput = Static<typeof appDeleteSchema>

/**
 * Turns the publish result into text the model reads.
 *
 * On rejection the errors are given as a LIST and a concrete next step is
 * shown at the end — so the model is never left wondering "what now?".
 */
export function resultToText(appId: string, n: DashboardResult): string {
  if (!n.ok) {
    return [
      `Publishing "${appId}" FAILED and nothing was registered.`,
      '',
      'Problems:',
      ...(n.errors ?? ['unknown error']).map((x) => `  - ${x}`),
      '',
      'Fix the files and call appPublish again.',
    ].join('\n')
  }

  const lines = [
    n.isNew
      ? `App "${appId}" published. It now appears in the sidebar under "Apps".`
      : `App "${appId}" re-published.`,
  ]

  if (n.warnings?.length) {
    lines.push(
      '',
      'Published, but with problems worth fixing:',
      ...n.warnings.map((o) => `  - ${o}`),
    )
  }

  // The single most useful thing the model can know after publishing: it does
  // not have to come back here to change anything.
  lines.push(
    '',
    'To change this app later, EDIT ITS FILES — the page reads them on every',
    'request. You do not need to call appPublish again.',
  )

  return lines.join('\n')
}

/**
 * Creates the `appPublish` tool.
 *
 * Context (`env.cwd`) IS NOT NEEDED BY THIS TOOL — the app folder does not
 * depend on the working directory. The `SearchTool` shape is kept anyway,
 * because `prepareTools()` puts every tool through the same wrapper.
 */
export function createAppPublishTool(
  provider: DashboardSink,
): SearchTool<AppPublishInput, DashboardDetail> {
  return {
    name: 'appPublish',
    label: 'appPublish',
    description: [
      'Register an app folder as a dashboard page on this platform.',
      'The app appears in the sidebar under "Apps" and is rendered by the platform itself.',
      '',
      'WRITE THE FILES FIRST, then call this once. The folder is ~/.barpo/apps/<id>/ :',
      '  app.json          required — id, name, icon, widgets, data, and the state/action config',
      '  view.jsx          optional — a custom view; only when widgets cannot express the layout',
      '  states/<name>.js  optional — one file per live value, each with its own interval',
      '  settings.js       optional — writes the settings form values to the app on its server',
      '  actions/<name>.js optional — one file per button',
      '',
      'TO UPDATE AN APP, EDIT ITS FILES — that is the whole update. Every page request reads',
      'the folder, so an `edit` to view.jsx or states/cpu.js takes effect on the next refresh.',
      'Do NOT rewrite the whole app to change one thing, and do NOT call appPublish again',
      'unless you added or renamed a file the config has to know about.',
      '',
      'You do NOT write an API, a route, or a frontend file. The platform serves',
      '/api/apps/:id/state/:name and the settings and action endpoints already.',
      '',
      'Read the dashboard skill before your first call — it has the exact file layout, the',
      'widget shapes, the form field types and full examples.',
    ].join('\n'),
    parameters: appPublishSchema,
    async execute(
      _toolCallId: string,
      params: AppPublishInput,
    ): Promise<AgentToolResult<DashboardDetail>> {
      const result = await provider(params.id)

      return {
        content: [{ type: 'text', text: resultToText(params.id, result) }],
        details: {
          appId: params.id,
          ok: result.ok,
          ...(result.isNew !== undefined ? { isNew: result.isNew } : {}),
        },
        // A rejected call has to read as a FAILURE to the model, otherwise it
        // carries on believing the publish succeeded. `AgentToolResult` has no
        // `isError` field, so the signal is carried by the text itself —
        // `resultToText` opens with "FAILED and nothing was registered" — and
        // by `details.ok` for the UI.
      }
    },
  }
}

/**
 * Creates the `appDelete` tool.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ THE ONLY TOOL HERE THAT ASKS FOR PERMISSION — AND THE ONLY TOOL      │
 * │ ANYWHERE THAT REFUSES TO ACCEPT AN AUTOMATED ANSWER.                 │
 * │                                                                      │
 * │ `requireUser` makes the permission layer skip both auto mode and any │
 * │ stored "always" pattern. Deleting an app erases a folder the user    │
 * │ may have edited by hand, with no trash and no undo, so the decision  │
 * │ belongs to a person rather than to a classifier's judgement.         │
 * └──────────────────────────────────────────────────────────────────────┘
 */
export function createAppDeleteTool(
  remover: DashboardRemover,
  permission: PermissionManager,
): SearchTool<AppDeleteInput, DashboardDeleteDetail> {
  return {
    name: 'appDelete',
    label: 'appDelete',
    description: [
      'Delete an app from this platform — the sidebar entry AND its entire folder',
      '(~/.barpo/apps/<id>/, including view.jsx, states and settings).',
      '',
      'THIS CANNOT BE UNDONE. There is no trash: the files are erased. The user is always',
      'asked to confirm, and their answer is the only thing that authorises it.',
      '',
      'Use it when the user asks to remove or delete an app. To REPLACE an app with a',
      'different one, prefer editing its files — deleting first throws away work for',
      'no reason. Never call this to "clean up" on your own initiative.',
    ].join('\n'),
    parameters: appDeleteSchema,
    async execute(
      _toolCallId: string,
      params: AppDeleteInput,
    ): Promise<AgentToolResult<DashboardDeleteDetail>> {
      const answer = await permission.ask({
        kind: 'file',
        action: 'appDelete',
        target: params.id,
        reason: `Deletes the app "${params.id}" and erases its entire folder. This cannot be undone.`,
        // The pattern is per-app on purpose. It is never stored as an "always"
        // rule (`requireUser` prevents that), but it still identifies WHICH
        // app the decision was about in the audit trail.
        pattern: `appDelete:${params.id}`,
        requireUser: true,
      })

      if (answer === 'deny') {
        return {
          content: [
            {
              type: 'text',
              text:
                `The user did NOT allow "${params.id}" to be deleted. Nothing was removed.\n` +
                'Do not try again — ask what they would like to do instead.',
            },
          ],
          details: { appId: params.id, ok: false, denied: true },
        }
      }

      const result = await remover(params.id)

      if (!result.ok) {
        return {
          content: [
            { type: 'text', text: `Could not delete "${params.id}": ${result.error ?? 'unknown error'}` },
          ],
          details: { appId: params.id, ok: false },
        }
      }

      const text = result.folderRemoved
        ? `App "${params.id}" was deleted, along with its folder.`
        : `App "${params.id}" was removed from the platform. Its folder was already gone.`

      return {
        content: [{ type: 'text', text: result.error ? `${text}\n${result.error}` : text }],
        details: { appId: params.id, ok: true, folderRemoved: result.folderRemoved },
      }
    },
  }
}

/**
 * The dashboard tools — the raw shape, with no context attached.
 *
 * When no provider is given an EMPTY list is returned: the tool is not
 * declared at all, i.e. the agent does not know it exists. (Same logic as
 * `serverToolsRaw()`.)
 *
 * `appDelete` needs BOTH a remover and the permission manager. Without the
 * permission manager it is not declared — a delete tool that cannot ask is
 * exactly the thing this design refuses to ship.
 */
export function dashboardToolsRaw(
  provider?: DashboardSink,
  remover?: DashboardRemover,
  permission?: PermissionManager,
): SearchTool<never>[] {
  const tools: SearchTool<never>[] = []
  if (provider) tools.push(createAppPublishTool(provider) as unknown as SearchTool<never>)
  if (remover && permission) {
    tools.push(createAppDeleteTool(remover, permission) as unknown as SearchTool<never>)
  }
  return tools
}

/**
 * The dashboard tools — the shape with context attached (for tests and
 * direct use; `agent.ts` wraps the raw shape itself).
 */
export function dashboardTools(
  provider?: DashboardSink,
  remover?: DashboardRemover,
  permission?: PermissionManager,
): AgentTool<never>[] {
  return dashboardToolsRaw(provider, remover, permission).map((tool) => ({
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
 * Same reason as `SERVER_PROMPT_SECTION`: the tool's behaviour and the text
 * describing it should live in ONE FILE.
 *
 * The prompt is added CONDITIONALLY (`agent.ts`): no provider, no tool.
 */
export const DASHBOARD_PROMPT_SECTION = {
  list: [
    '- appPublish: register an app folder as a dashboard page on this platform',
    '- appDelete: delete an app and its folder (asks the user first)',
  ],
  rules: [
    'An app on this platform IS A FOLDER: ~/.barpo/apps/<id>/ with app.json, and',
    'optionally view.jsx, states/<name>.js, settings.js and actions/<name>.js.',
    'Write those files with `write`/`edit` like any other files, then call `appPublish`',
    'ONCE to register the folder.',
    'TO UPDATE AN APP, EDIT ITS FILES. The page reads the folder on every request, so an',
    '`edit` to one state file is the whole update — never rewrite the app to change one',
    'widget, and do not re-publish unless you added or renamed a file.',
    'When the user asks for a dashboard, a status page, or a UI for an app, use this flow —',
    'do NOT write an HTTP endpoint, a route file, or a frontend file for it. The platform',
    'renders the folder.',
    'Prefer the built-in widgets in app.json; reach for view.jsx only when the layout',
    'genuinely needs it. A view only RENDERS — it must not fetch anything.',
    'Anything that changes over time belongs in states/<name>.js (server-side code, with',
    'its own refresh interval) — values in app.json alone never update again.',
    'When you deploy something the user will need to configure or control (a bot token, a',
    'restart button), write settings.js and actions/ alongside the dashboard — that is what',
    'makes the page usable instead of just readable.',
    'Settings values are written to the DEPLOYED APP on its own server, never stored in the',
    'platform: the app reads its token from its own config, so that is where it must go.',
    'In settings.js and actions/*.js, reach the server ONLY through the provided `ssh` helper',
    'and pass commands as an ARGV ARRAY (`["docker","restart","bot"]`). Never assemble a shell',
    'string and never interpolate a user-supplied value into one — use `ssh(...).envWrite()` for',
    'config values so tokens travel over stdin instead of the command line.',
    'Never return a secret field from the settings read code.',
    'Use `appDelete` only when the user asks for an app to be removed. It erases the folder',
    'and cannot be undone, so never call it to tidy up or to "replace" an app you could edit.',
    'If a dashboard skill is installed, read it before the first call.',
  ],
} as const
