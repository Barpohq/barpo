// Runs the AI-written view code inside the HOST React tree.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY NOT AN IFRAME. This code used to run inside an iframe with       │
// │ `sandbox="allow-scripts"`. That was safe, but it cost two things:    │
// │                                                                      │
// │  1) VISUALS. An iframe brings its own document, its own scrollbar    │
// │     and its own size — it read as a page inside a page. Even         │
// │     adjusting the height via `postMessage` could not fully hide it.  │
// │                                                                      │
// │  2) STYLING. Inside the iframe there was neither Tailwind nor the    │
// │     platform's components — the AI was forced to write inline        │
// │     `style` and the dashboard stood out from the rest of the UI.     │
// │                                                                      │
// │ Now the code runs in the host tree: `Card`, `StatTile` and the       │
// │ Tailwind classes are available to it, and the result looks like part │
// │ of the platform.                                                     │
// └──────────────────────────────────────────────────────────────────────┘
//
// ⚠️ TRUST LEVEL. This code runs in the host page, i.e. with the platform's
// privileges. That is a DELIBERATE decision and it sits at the same level as
// the `states` layer (see `state-run.ts`): AI code is executed there on the
// server with full privileges too. In a later stage the same classifier will
// check both (prompt-injection protection) — the hook-up points are
// `validateCode()` in `state-run.ts` and `findForbidden()` in `view-build.ts`.
//
// ERROR ISOLATION IS PRESERVED: if the code throws, `ViewErrorBoundary`
// catches it and only this block goes dark — the widgets and the whole
// platform keep working.

import { Component, useMemo, type ErrorInfo, type ReactNode } from 'react'
import * as React from 'react'
import {
  runAppAction,
  saveAppSettings,
  type ActionResponse,
} from '../lib/api'
import { Card, StatTile, StatusDot } from '../ui'

/**
 * The components handed to the AI code.
 *
 * Used as `ui.Card` — so they never collide with global names and the AI can
 * see everything available in one place.
 */
const UI_COMPONENTS = { Card, StatTile, StatusDot } as const

/**
 * The React hooks handed to the code.
 *
 * Imports are forbidden (`view-build.ts`), so the hooks are passed as
 * arguments — the code uses them as if they were plain globals.
 */
const HOOKS = {
  useState: React.useState,
  useEffect: React.useEffect,
  useMemo: React.useMemo,
  useCallback: React.useCallback,
  useRef: React.useRef,
  useReducer: React.useReducer,
  useLayoutEffect: React.useLayoutEffect,
  useId: React.useId,
} as const

/**
 * The shape of the `ui` object handed to the AI code.
 *
 * `save`/`action` are OPTIONAL: they are only added when an `appId` is given
 * (`createWriteApi`). In other words, an app without controls can only draw.
 */
type UiObject = typeof UI_COMPONENTS & {
  settings: Record<string, string>
  action?: (name: string) => Promise<ActionResponse>
  save?: (values: Record<string, string>) => Promise<unknown>
}

type ViewComponent = (props: { data: Record<string, unknown>; ui: UiObject }) => ReactNode

/**
 * Builds a component from the compiled code.
 *
 * The code arrives shaped as `let __result__; ...; return __result__;`
 * (`view-build.ts`), so `new Function` executes it directly and returns the
 * component.
 *
 * IT NEVER THROWS — on failure it returns `{ error }`.
 */
function buildComponent(code: string): { component?: ViewComponent; error?: string } {
  try {
    const names = ['React', ...Object.keys(HOOKS)]
    const values = [React, ...Object.values(HOOKS)]

    const factory = new Function(...names, code)
    const result = factory(...values)

    if (typeof result !== 'function') {
      return { error: 'The code did not return `export default function View({ data }) {...}`' }
    }
    return { component: result as ViewComponent }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

interface BoundaryProps {
  children: ReactNode
  /** Used to reset the boundary when the code changes */
  resetKey: string
  onError: (message: string) => void
}

/**
 * The boundary that catches render errors.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ THIS IS A DIRECT IMPLEMENTATION OF THE USER'S REQUIREMENT: "if the │
 * │ code it wrote has a bug, only the dashboard should stop working,  │
 * │ not the whole program".                                            │
 * │                                                                    │
 * │ In React an uncaught render error brings down THE ENTIRE TREE —    │
 * │ so without the boundary the platform would turn into a white       │
 * │ screen.                                                            │
 * └────────────────────────────────────────────────────────────────────┘
 */
class ViewErrorBoundary extends Component<BoundaryProps, { error: string | null }> {
  state = { error: null as string | null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    this.props.onError(error.message)
  }

  componentDidUpdate(previous: BoundaryProps) {
    // When new code arrives the old error state is cleared — otherwise the
    // fixed version would stay stuck as "broken".
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) return null
    return this.props.children
  }
}

interface Props {
  /** The compiled JS (the output of `view-build.ts`) */
  code: string
  /** The data handed to the view (`data` + the live states) */
  data: Record<string, unknown>
  /**
   * The app id — it decides WHERE `ui.save` / `ui.action` are routed.
   *
   * If omitted those two functions are NOT PROVIDED: the `view` only draws.
   */
  appId?: string
  /** Non-secret setting values — `ui.settings` */
  settings?: Record<string, string>
  /** After an action ran (so the states can be refreshed) */
  onAction?: (response: ActionResponse) => void
  /** After the settings were saved */
  onSaved?: () => void
}

/**
 * `ui.save` / `ui.action` — the WRITE path handed to the AI view.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS DOES NOT BREAK THE `fetch` BAN.                           │
 * │                                                                    │
 * │ `view-build.ts` forbids `fetch` and that STAYS IN FORCE: the code  │
 * │ cannot send a request to an ARBITRARY URL. These two functions are │
 * │ a narrow path granted by THE PLATFORM — they only reach THIS app's │
 * │ routes, because `appId` is locked inside the closure and is never  │
 * │ passed as an argument.                                             │
 * │                                                                    │
 * │ In other words the AI can write `ui.action('restart')`, but it     │
 * │ CANNOT write `ui.action('/api/apps/other-app/action/delete')`.     │
 * └────────────────────────────────────────────────────────────────────┘
 */
function createWriteApi(
  appId: string,
  onAction?: (response: ActionResponse) => void,
  onSaved?: () => void,
) {
  return {
    /** Runs an action — by `actions[].name` from the manifest */
    async action(name: string) {
      const response = await runAppAction(appId, name)
      onAction?.(response)
      return response
    },
    /** Writes the setting values to the server */
    async save(values: Record<string, string>) {
      const response = await saveAppSettings(appId, values)
      onSaved?.()
      return response
    },
  }
}

/** The block shown when something went wrong */
function ErrorBlock({ message }: { message: string }) {
  return (
    <Card className="p-5">
      <div className="text-xs font-medium uppercase tracking-wider text-gold">
        Dashboard view failed
      </div>
      <p className="mt-2 text-sm text-muted">
        This app's custom view threw an error. The rest of the platform is working normally —
        the widgets below (if any) are shown as usual.
      </p>
      <pre className="thin-scroll mt-3 max-h-32 overflow-auto rounded-lg bg-bg px-3 py-2 font-mono text-[11px] text-faint">
        {message}
      </pre>
    </Card>
  )
}

/**
 * Renders the AI view.
 *
 * It can fail in two stages and BOTH are caught:
 *   1. The code does not execute (`buildComponent`) — a syntax or shape error
 *   2. During render (`ViewErrorBoundary`) — e.g. `undefined.map()`
 */
export default function AiView({
  code,
  data,
  appId,
  settings,
  onAction,
  onSaved,
}: Props) {
  // The component is NOT REBUILT until the code changes: calling
  // `new Function` on every render would change the component identity and
  // React would remount it from scratch each time (losing its internal state).
  const { component, error } = useMemo(() => buildComponent(code), [code])

  // The render error is stored TOGETHER WITH THE CODE.
  //
  // ┌────────────────────────────────────────────────────────────────┐
  // │ WHY NOT CLEAR IT WITH `useEffect`. It used to be:              │
  // │     useEffect(() => setRenderError(null), [code])              │
  // │ The effect also runs on the FIRST mount and cleared the error  │
  // │ immediately — so the block never appeared (which is exactly    │
  // │ what happened in the browser: the error was in the console but │
  // │ not on screen).                                                │
  // │                                                                │
  // │ Storing the error alongside the code closes that race for      │
  // │ good: when new code arrives the stored `code` no longer        │
  // │ matches and the error is ignored on its own.                   │
  // └────────────────────────────────────────────────────────────────┘
  const [renderError, setRenderError] = React.useState<{
    code: string
    message: string
  } | null>(null)

  const activeError = renderError?.code === code ? renderError.message : null

  // The `ui` object — components plus (when appId is given) the write path.
  //
  // `useMemo` MATTERS: a fresh object on every render would send an
  // `useEffect(..., [ui])` inside the AI code into an infinite loop.
  const ui = React.useMemo(
    () => ({
      ...UI_COMPONENTS,
      ...(appId ? createWriteApi(appId, onAction, onSaved) : {}),
      settings: settings ?? {},
    }),
    [appId, settings, onAction, onSaved],
  )

  if (error) return <ErrorBlock message={error} />
  if (activeError) return <ErrorBlock message={activeError} />
  if (!component) return null

  const View = component
  return (
    <ViewErrorBoundary
      resetKey={code}
      onError={(message) => setRenderError({ code, message })}
    >
      <View data={data} ui={ui} />
    </ViewErrorBoundary>
  )
}
