// The `appPublish` tool — the ONLY way the agent can publish a dynamic dashboard.
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
// │ So the flow is INVERTED: the agent hands the DATA to this tool, and  │
// │ the platform stores and renders it. There is one write point, and    │
// │ validation lives in one place too.                                   │
// └──────────────────────────────────────────────────────────────────────┘
//
// THREE KINDS OF CODE, RUN IN TWO PLACES:
//
//   `view`        — JSX. Renders in the browser, inside the host React tree
//                   (`AiView.tsx`). It mostly DRAWS; when there are controls
//                   it writes to ITS OWN app via `ui.save`/`ui.action`.
//
//   `states`      — server JS. Runs repeatedly on an interval inside the
//                   platform process (`state-run.ts`). THIS is the layer
//                   that collects data.
//
//   `settings`    — server JS. Runs ONCE when the user presses
//   and `actions`   (`action-run.ts`) and is recorded in the audit trail.
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
// LAYER BOUNDARY — the same inversion as in `server-tools.ts`. Manifests
// live in SQLite, i.e. in `platform-server`. `@platforma/ai` does NOT
// DEPEND on the server, so the storing function is supplied from outside
// (`DashboardSink`). This file knows neither the database nor `repo.ts`.
//
// WHY IT DOES NOT ASK FOR PERMISSION. The tool publishes a dashboard the
// user asked for THEMSELVES, on their OWN platform — this is not the same
// category of action as the `write` tool: it does not touch the file
// system, does not run commands, does not reach the network. The result is
// visible immediately and can be undone (publish again). Showing a modal
// for every publish would lead to "permission fatigue".

import { Type, type Static } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { SearchTool } from './search-tools.ts'

/**
 * The result of storing — the caller (the server) answers in this shape.
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
  /** Whether a new app was created or an existing one updated */
  isNew?: boolean
}

/**
 * The provider that stores the manifest (supplied by the caller).
 *
 * The input is DELIBERATELY `unknown`: validation happens at the boundary —
 * on the server side (`validateManifest`). If it were typed here we would
 * have to cast the raw JSON the model sent inside the tool, and validation
 * would be duplicated in two places.
 */
export type DashboardSink = (manifest: unknown) => DashboardResult | Promise<DashboardResult>

/** Detail for the UI and the logs — shown on the tool card */
export interface DashboardDetail {
  appId: string
  ok: boolean
  widgets: number
  hasCode: boolean
  /** Number of settings fields — 0 means there is no form */
  settings: number
  /** Number of action buttons */
  actions: number
}

/**
 * The widget schema is DELIBERATELY left open with `Type.Any()`.
 *
 * The reason: `Widget` is a discriminated union with 7 variants. Writing it
 * out fully in JSON Schema would stretch the tool description to several
 * hundred lines and put it in the context on every request. Instead the
 * shape is explained with examples in the SKILL file (progressive
 * disclosure — the model reads it when it needs it), while validation is
 * enforced strictly in `manifest-validate.ts`. That is: freedom in the
 * schema, strictness at the boundary.
 */
const appPublishSchema = Type.Object({
  id: Type.String({
    description:
      'Stable app id: lowercase letters, digits and dashes only (e.g. "ai-news-bot"). ' +
      'Publishing again with the same id REPLACES the previous dashboard.',
  }),
  name: Type.String({ description: 'Display name shown as the page title' }),
  icon: Type.Optional(Type.String({ description: 'A single emoji shown next to the name' })),
  tagline: Type.Optional(Type.String({ description: 'One-line description under the title' })),
  version: Type.Optional(Type.String({ description: 'Version label, e.g. "v1.4.2"' })),
  service: Type.Optional(
    Type.String({ description: 'Runtime line, e.g. "helsinki-1 · docker · uptime 31 days"' }),
  ),
  status: Type.Optional(
    Type.Union([Type.Literal('running'), Type.Literal('idle')], {
      description: 'Status dot next to the title',
    }),
  ),
  widgets: Type.Optional(
    Type.Array(Type.Any(), {
      description:
        'Built-in widgets rendered by the platform. Each item is an object with a "type" field: ' +
        'stats | bars | table | logs | note | deploy | git. ' +
        'Read the dashboard skill for the exact shape of each type.',
    }),
  ),
  data: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          'Values the dashboard shows, as a one-time snapshot. They arrive as the `data` prop ' +
          'and NEVER change again — for anything that updates over time use `states` instead. ' +
          'Never write an API or a fetch: the view only renders.',
      },
    ),
  ),
  states: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String({
          description:
            'State key: lowercase letters, digits and underscore (e.g. "cpu", "disk_usage"). ' +
            'The value lands in `data[name]`.',
        }),
        code: Type.String({
          description:
            'Server-side JS: `module.exports = async function () { return {...} }`. ' +
            'Runs in the platform process — `require("child_process")`, `fs` and the network are ' +
            'available. Return the values themselves, NOT a rendered layout.',
        }),
        interval: Type.Optional(
          Type.Number({
            description:
              'Refresh interval in seconds. Omit for values that never change. ' +
              'Pick per state: a CPU reading may need 5, a disk total 30 or more. ' +
              'Minimum enforced is 3.',
          }),
        ),
      }),
      {
        description:
          'LIVE data sources, each refreshed on its OWN interval. Use these whenever a value ' +
          'changes over time — otherwise the dashboard shows a frozen snapshot forever. ' +
          'You do NOT write an endpoint: the platform already serves them at ' +
          '/api/apps/:id/state/:name and the page polls that.',
      },
    ),
  ),
  view: Type.Optional(
    Type.String({
      description:
        'OPTIONAL custom view as JSX source. Must `export default function View({ data, ui }) {...}`. ' +
        'Platform components arrive as `ui` (ui.Card, ui.StatTile, ui.StatusDot) and Tailwind classes ' +
        'work, so the page matches the rest of the UI. React hooks are available directly ' +
        '(useState, useEffect, ...) — no imports. The view only RENDERS: no fetch, no storage; ' +
        'changing values belong in `states`. When the app has `settings` or `actions`, the view ' +
        'additionally gets `ui.action(name)` and `ui.save({...})` to trigger them — those are the ' +
        'ONLY way it may write anything. Use this only when the built-in widgets cannot ' +
        'express the layout — widgets are more robust.',
    }),
  ),
  settings: Type.Optional(
    Type.Object(
      {
        fields: Type.Array(Type.Any(), {
          description:
            'Form fields. Each: { key, kind, label, hint?, required?, default?, options?, ' +
            'pattern?, patternHint? }. `kind` is one of: text | secret | number | select | toggle | textarea. ' +
            'Use `secret` for tokens and passwords — the platform never shows or returns them. ' +
            'Add `pattern` (a regex string) whenever the value has a known format, e.g. a Telegram ' +
            'token: "^\\\\d+:[A-Za-z0-9_-]+$". Read the dashboard skill for the exact shape.',
        }),
        write: Type.String({
          description:
            'Server-side JS that writes the values to the APP ITSELF on its server: ' +
            '`module.exports = async function ({ values, ssh }) { ... }`. ' +
            'Use `ssh(serverName)` to reach the server, then `envWrite(path, {KEY: value})` to update ' +
            'its config and `command([...])` to restart it. NEVER build a shell string — ' +
            '`command` takes an ARGV ARRAY, and `envWrite` sends values over stdin so tokens never ' +
            'appear in `ps`. Only keys the user actually changed arrive in `values`.',
        }),
        read: Type.Optional(
          Type.String({
            description:
              'OPTIONAL server-side JS returning the CURRENT values so the form opens filled in: ' +
              '`module.exports = async function ({ ssh }) { return { mode: "polling" } }`. ' +
              'For a SECRET field return a BOOLEAN, not the value — `{ token: Boolean(cfg.TOKEN) }`. ' +
              'That tells the platform to show "already set" without the token ever reaching the ' +
              'browser. If you return the secret itself the platform drops it.',
          }),
        ),
      },
      {
        description:
          'A settings FORM for this app. The platform renders it from this schema and writes the ' +
          'values to the app on its server — NOT to the platform database. This is how the user ' +
          'supplies a bot token, an admin id or a mode. You write no endpoint and no UI: the ' +
          'platform already serves PUT /api/apps/:id/settings.',
      },
    ),
  ),
  actions: Type.Optional(
    Type.Array(Type.Any(), {
      description:
        'Buttons the user can press: restart, stop, clear cache. Each item is an object: ' +
        '{ name, label, hint?, risk?, confirm?, code, refresh? }. `name` is lowercase a-z0-9_ (it ' +
        'becomes a URL path). `code` is server-side JS: ' +
        '`module.exports = async function ({ ssh, settings }) { ... return { message: "done" } }` — ' +
        'the returned `message` is shown to the user. Set `confirm: true` for anything the user ' +
        'should confirm first, and `risk: "dangerous"` for destructive actions. List state names in ' +
        '`refresh` to refresh them right after the action (e.g. a status tile after a restart). ' +
        'Use `ssh(serverName).command([...])` with an ARGV ARRAY — never a shell string.',
    }),
  ),
})

export type AppPublishInput = Static<typeof appPublishSchema>

/**
 * Turns the result into text the model reads.
 *
 * On rejection the errors are given as a LIST and a concrete next step is
 * shown at the end — so the model is never left wondering "what now?".
 */
export function resultToText(appId: string, n: DashboardResult): string {
  if (!n.ok) {
    return [
      `Dashboard "${appId}" was REJECTED and nothing was saved.`,
      '',
      'Problems:',
      ...(n.errors ?? ['unknown error']).map((x) => `  - ${x}`),
      '',
      'Fix these and call appPublish again.',
    ].join('\n')
  }

  const lines = [
    n.isNew
      ? `Dashboard "${appId}" published. It now appears in the sidebar under "Apps".`
      : `Dashboard "${appId}" updated.`,
  ]

  if (n.warnings?.length) {
    lines.push(
      '',
      'Accepted, but some parts were dropped or adjusted:',
      ...n.warnings.map((o) => `  - ${o}`),
      '',
      'Publish again if you want to correct them.',
    )
  }

  return lines.join('\n')
}

/**
 * Creates the `appPublish` tool.
 *
 * Context (`env.cwd`) IS NOT NEEDED BY THIS TOOL — the manifest does not
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
      'Publish or update a dashboard page for an app on this platform.',
      'The dashboard appears in the sidebar under "Apps" and is rendered by the platform itself.',
      '',
      'You do NOT write an API, a route, or a server file for this — you pass the DATA here and the',
      'platform renders it. Publishing again with the same id replaces the previous version.',
      '',
      'Two ways to describe the page, and they can be combined:',
      '  - `widgets`: built-in blocks (stats, bars, table, logs, note, deploy, git) — robust, preferred.',
      '  - `view`: your own JSX, for layouts the widgets cannot express. It receives `data` plus',
      '    `ui` (platform components) and can use Tailwind classes. It only renders — no fetching.',
      '',
      'LIVE DATA: values passed in `data` are frozen forever. For anything that changes over time',
      '(CPU, memory, queue depth, last run) add a `states` entry instead — server-side code with its',
      'OWN refresh interval. Give each value the interval it actually needs: a CPU reading may want 5',
      'seconds while a disk total is fine at 60. You still write no endpoint — the platform serves',
      'them and the page polls automatically.',
      '',
      'CONTROL: a dashboard can also be a control panel.',
      '  - `settings`: a settings form (bot token, admin id, mode). The values are written to the',
      '    APP ITSELF on its server — a token lives in the app\'s own config, not in the platform.',
      '  - `actions`: buttons the user presses (restart, stop). Each runs server-side code.',
      'Both take an `ssh` helper: `ssh(serverName).command([...])` takes an ARGV ARRAY and',
      '`ssh(...).envWrite(path, {KEY: val})` sends values over stdin. NEVER assemble a shell string —',
      'user-supplied values would become commands, and a token would show up in `ps`.',
      '`command` THROWS when the command fails, so you do not check the exit code — just return your',
      'success message after it. Use `commandRaw` when a non-zero exit is an answer, not a failure.',
      '',
      'Read the dashboard skill before your first call — it has the exact widget shapes, the form',
      'field types and full examples.',
    ].join('\n'),
    parameters: appPublishSchema,
    async execute(
      _toolCallId: string,
      params: AppPublishInput,
    ): Promise<AgentToolResult<DashboardDetail>> {
      // At the tool level `view` is a STRING (the JSX source), but in the
      // manifest it is an OBJECT (`{ code, hash }`). The conversion happens
      // here: asking the model for a nested object confuses it, while the
      // contract is incomplete without the hash. The server fills the hash
      // in at compile time.
      const manifest: Record<string, unknown> = { ...params }
      if (typeof params.view === 'string' && params.view.trim().length > 0) {
        manifest.view = { code: params.view, hash: '' }
      } else {
        delete manifest.view
      }

      const result = await provider(manifest)
      const widgets = Array.isArray(params.widgets) ? params.widgets.length : 0

      return {
        content: [{ type: 'text', text: resultToText(params.id, result) }],
        details: {
          appId: params.id,
          ok: result.ok,
          widgets,
          hasCode: typeof params.view === 'string' && params.view.trim().length > 0,
          settings: Array.isArray(params.settings?.fields) ? params.settings.fields.length : 0,
          actions: Array.isArray(params.actions) ? params.actions.length : 0,
        },
        // A rejected call must look like an ERROR to the model, otherwise it
        // would carry on thinking the publish "succeeded".
        isError: !result.ok,
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
 */
export function dashboardToolsRaw(provider?: DashboardSink): SearchTool<never>[] {
  if (!provider) return []
  return [createAppPublishTool(provider)] as unknown as SearchTool<never>[]
}

/**
 * The dashboard tools — the shape with context attached (for tests and
 * direct use; `agent.ts` wraps the raw shape itself).
 */
export function dashboardTools(provider?: DashboardSink): AgentTool<never>[] {
  return dashboardToolsRaw(provider).map((tool) => ({
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
    '- appPublish: publish or update an app dashboard page on this platform, including its',
    '  settings form and control buttons',
  ],
  rules: [
    'When the user asks for a dashboard, a status page, or a UI for an app, use `appPublish` —',
    'do NOT write an HTTP endpoint, a route file, or a frontend file for it. The platform renders',
    'what you pass to the tool.',
    'Pass the values themselves in `data`; a custom `view` receives them as props and must not',
    'fetch anything — it only renders. Prefer the built-in widgets, and reach for `view` only',
    'when the layout genuinely needs it.',
    'Anything that changes over time belongs in `states` (server-side code, per-state refresh',
    'interval) — values in `data` alone never update again.',
    'When you deploy something the user will need to configure or control (a bot token, a restart',
    'button), publish `settings` and `actions` along with the dashboard — that is what makes the',
    'page usable instead of just readable.',
    'Settings values are written to the DEPLOYED APP on its own server, never stored in the',
    'platform: the app reads its token from its own config, so that is where it must go.',
    'In `write`, `read` and `actions[].code`, reach the server ONLY through the provided `ssh` helper',
    'and pass commands as an ARGV ARRAY (`["docker","restart","bot"]`). Never assemble a shell',
    'string and never interpolate a user-supplied value into one — use `ssh(...).envWrite()` for',
    'config values so tokens travel over stdin instead of the command line.',
    'Never return a secret field from `read`.',
    'If a dashboard skill is installed, read it before the first call.',
  ],
} as const
