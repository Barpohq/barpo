// Reading an app FOLDER into an `AppManifest`.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THIS MODULE IS A TRANSLATOR, NOT A NEW MODEL.                        │
// │                                                                      │
// │ `AppManifest` is UNCHANGED — it still carries `states[].code`,       │
// │ `view.code` and `settings.write` as strings. Everything downstream   │
// │ (`state-run.ts`, `action-run.ts`, `AiView.tsx`, every route) keeps    │
// │ working without knowing that the source is now a directory.          │
// │                                                                      │
// │ What changed is only WHERE those strings come from: a file each,     │
// │ instead of one JSON blob in SQLite.                                  │
// └──────────────────────────────────────────────────────────────────────┘
//
// WHY CODE IS NOT KEPT IN `app.json`. The whole point of the move is that the
// user can open the app in an editor. JSX embedded in a JSON string is the one
// shape that defeats that: no syntax highlighting, escaped newlines, and a
// single stray quote breaks the entire manifest. So `app.json` holds metadata,
// widgets and data — and the code lives in real `.jsx` / `.js` files next to
// it.
//
// ERRORS DO NOT THROW. A hand-edited folder can be broken in a dozen ways, and
// a broken folder must not take the page down. Problems come back in
// `manifest.errors`, the good parts still render, and the user reads the
// reason on the dashboard itself.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  validateManifest,
  STATE_NAME_PATTERN,
  ACTION_NAME_PATTERN,
} from '@platforma/shared'
import type { AppManifest, AppState, AppAction } from '@platforma/shared'
import { APP_FILES, appFilePath } from './apps-dir.ts'
import { buildViewCached } from './view-cache.ts'

/** What `readAppFolder` gives back */
export interface FolderResult {
  ok: boolean
  manifest: AppManifest | null
  /** Problems found while reading — shown on the dashboard, not thrown */
  errors: string[]
  /**
   * The `id` written in `app.json`, whatever else was wrong with the file.
   *
   * Reported SEPARATELY from the manifest so the publish path can compare it
   * with the folder name even when validation failed for some other reason —
   * "the id does not match the folder" is a far more useful message than
   * whatever the validator happened to complain about first.
   */
  declaredId?: string | null
}

/**
 * Reads a text file, returning `null` when it is missing or unreadable.
 *
 * A missing optional file is NOT an error (there simply is no view), so the
 * distinction between "missing" and "broken" is made by the caller, which
 * knows whether the file was required.
 */
function readTextFile(path: string | null): string | null {
  if (!path || !existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Collects `states/<name>.js` into the manifest shape.
 *
 * The interval comes from `app.json` (`states: { cpu: { interval: 5 } }`),
 * because an interval is configuration, not code — putting it in a comment
 * inside the JS file would mean parsing comments to find it.
 *
 * A file whose name is not a valid state name is SKIPPED with a warning rather
 * than failing the whole folder: `states/.cpu.js.swp` left behind by an editor
 * should not break the app.
 */
function readStates(dir: string, config: Record<string, unknown>, errors: string[]): AppState[] {
  const statesDir = appFilePath(dir, APP_FILES.states)
  if (!statesDir || !existsSync(statesDir)) return []

  let files: string[]
  try {
    files = readdirSync(statesDir).filter((f) => f.endsWith('.js'))
  } catch {
    errors.push(`Could not read the "${APP_FILES.states}/" folder`)
    return []
  }

  const states: AppState[] = []

  for (const file of files.sort()) {
    const name = basename(file, '.js')

    if (!STATE_NAME_PATTERN.test(name)) {
      errors.push(
        `states/${file} was skipped: "${name}" is not a valid state name ` +
          '(lowercase letters, digits and underscore only).',
      )
      continue
    }

    const code = readTextFile(appFilePath(statesDir, file))
    if (code === null) {
      errors.push(`states/${file} could not be read`)
      continue
    }

    // The per-state settings from `app.json`. Absent is fine — it just means
    // no automatic refresh.
    const entry = config[name]
    const interval =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as { interval?: unknown }).interval
        : undefined

    states.push({
      name,
      code,
      ...(typeof interval === 'number' ? { interval } : {}),
    })
  }

  return states
}

/**
 * Collects `actions/<name>.js` into the manifest shape.
 *
 * Unlike a state, an action NEEDS its config entry: the button has to have a
 * label. A file with no entry in `app.json` is reported — silently hiding a
 * button the user wrote would be worse than saying why it is missing.
 */
function readActions(dir: string, config: Record<string, unknown>, errors: string[]): AppAction[] {
  const actionsDir = appFilePath(dir, APP_FILES.actions)
  if (!actionsDir || !existsSync(actionsDir)) return []

  let files: string[]
  try {
    files = readdirSync(actionsDir).filter((f) => f.endsWith('.js'))
  } catch {
    errors.push(`Could not read the "${APP_FILES.actions}/" folder`)
    return []
  }

  const actions: AppAction[] = []

  for (const file of files.sort()) {
    const name = basename(file, '.js')

    if (!ACTION_NAME_PATTERN.test(name)) {
      errors.push(
        `actions/${file} was skipped: "${name}" is not a valid action name ` +
          '(lowercase letters, digits and underscore only).',
      )
      continue
    }

    const code = readTextFile(appFilePath(actionsDir, file))
    if (code === null) {
      errors.push(`actions/${file} could not be read`)
      continue
    }

    const entry = config[name]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(
        `actions/${file} has no entry in ${APP_FILES.manifest} — ` +
          `add { "actions": { "${name}": { "label": "..." } } } so the button has a label.`,
      )
      continue
    }

    const meta = entry as Record<string, unknown>

    actions.push({
      name,
      label: typeof meta.label === 'string' ? meta.label : name,
      code,
      ...(typeof meta.hint === 'string' ? { hint: meta.hint } : {}),
      ...(meta.risk === 'read' || meta.risk === 'write' || meta.risk === 'dangerous'
        ? { risk: meta.risk }
        : {}),
      ...(meta.confirm === true ? { confirm: true } : {}),
      ...(Array.isArray(meta.refresh)
        ? { refresh: meta.refresh.filter((r): r is string => typeof r === 'string') }
        : {}),
    })
  }

  return actions
}

/**
 * Reads an app folder and assembles the manifest.
 *
 * THE VIEW IS COMPILED HERE, through the on-disk cache (`view-cache.ts`): the
 * manifest carries COMPILED js, exactly as it did when the blob lived in the
 * database. The difference is that the cache is keyed by a hash of the source,
 * so editing `view.jsx` by hand rebuilds it on the next read and nothing else
 * has to be told about the change.
 */
export async function readAppFolder(dir: string): Promise<FolderResult> {
  const errors: string[] = []

  const manifestPath = appFilePath(dir, APP_FILES.manifest)
  const rawText = readTextFile(manifestPath)

  if (rawText === null) {
    return {
      ok: false,
      manifest: null,
      errors: [`${APP_FILES.manifest} is missing or unreadable in ${dir}`],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch (error) {
    // A JSON syntax error is fatal for the folder — there is no id, no name,
    // nothing to fall back to. This is the one case the user MUST fix by hand.
    return {
      ok: false,
      manifest: null,
      errors: [`${APP_FILES.manifest} is not valid JSON: ${String(error)}`],
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, manifest: null, errors: [`${APP_FILES.manifest} must be a JSON object`] }
  }

  const config = parsed as Record<string, unknown>

  // The declared id is surfaced before anything else is judged, so the caller
  // can compare it with the folder name and report THAT rather than whatever
  // else happens to be wrong. A mismatch is the more useful message: it
  // explains why the app is not where the user expected it.
  const declaredId = typeof config.id === 'string' ? config.id : null

  // `states` and `actions` in `app.json` are CONFIGURATION maps keyed by name
  // (interval, label, risk), not the code itself. The code comes from files.
  const stateConfig =
    config.states && typeof config.states === 'object' && !Array.isArray(config.states)
      ? (config.states as Record<string, unknown>)
      : {}
  const actionConfig =
    config.actions && typeof config.actions === 'object' && !Array.isArray(config.actions)
      ? (config.actions as Record<string, unknown>)
      : {}

  const states = readStates(dir, stateConfig, errors)
  const actions = readActions(dir, actionConfig, errors)

  // Build the shape `validateManifest` expects: code strings folded back in.
  const assembled: Record<string, unknown> = {
    ...config,
    ...(states.length > 0 ? { states } : { states: undefined }),
    ...(actions.length > 0 ? { actions } : { actions: undefined }),
  }

  // --- the view -----------------------------------------------------------
  const viewSource = readTextFile(appFilePath(dir, APP_FILES.view))
  if (viewSource !== null && viewSource.trim().length > 0) {
    const build = await buildViewCached(dir, viewSource)
    if (build.ok && build.code) {
      assembled.view = { code: build.code, hash: build.hash ?? '' }
    } else {
      // ERROR ISOLATION, unchanged from the database era: a view that does not
      // compile is dropped and the widgets keep working. The difference is
      // that the reason now reaches the USER as well — they wrote the file, so
      // they are the one who has to see the compiler error.
      delete assembled.view
      errors.push(`${APP_FILES.view} did not compile: ${build.errors.join('; ')}`)
    }
  } else {
    delete assembled.view
  }

  // --- settings -----------------------------------------------------------
  const settingsWrite = readTextFile(appFilePath(dir, APP_FILES.settingsWrite))
  const rawSettings =
    config.settings && typeof config.settings === 'object' && !Array.isArray(config.settings)
      ? (config.settings as Record<string, unknown>)
      : null

  if (rawSettings) {
    if (settingsWrite === null) {
      errors.push(
        `${APP_FILES.manifest} declares "settings" but ${APP_FILES.settingsWrite} is missing — ` +
          'the form has no code to write the values with.',
      )
      delete assembled.settings
    } else {
      const settingsRead = readTextFile(appFilePath(dir, APP_FILES.settingsRead))
      assembled.settings = {
        ...rawSettings,
        write: settingsWrite,
        ...(settingsRead !== null ? { read: settingsRead } : {}),
      }
    }
  } else {
    delete assembled.settings
  }

  const validation = validateManifest(assembled)

  if (!validation.ok || !validation.value) {
    return { ok: false, manifest: null, errors: [...errors, ...validation.errors], declaredId }
  }

  return {
    ok: true,
    manifest: validation.value,
    errors: [...errors, ...validation.warnings],
    declaredId,
  }
}

/**
 * The list of state names declared by a folder — used by the publish path to
 * report what was picked up, without reading the code again.
 */
export function stateNames(dir: string): string[] {
  const statesDir = appFilePath(dir, APP_FILES.states)
  if (!statesDir || !existsSync(statesDir)) return []
  try {
    return readdirSync(statesDir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => basename(f, '.js'))
      .filter((n) => STATE_NAME_PATTERN.test(n))
      .sort()
  } catch {
    return []
  }
}

/** Whether a directory looks like an app folder at all */
export function isAppFolder(dir: string): boolean {
  const path = join(dir, APP_FILES.manifest)
  return existsSync(path)
}
