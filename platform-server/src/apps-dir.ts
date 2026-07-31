// Where an app's files live on disk, and the rules that keep a path inside
// that root.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ AN APP IS A FOLDER, NOT A DATABASE ROW.                              │
// │                                                                      │
// │ The manifest used to be a JSON blob in SQLite: the agent could not   │
// │ `read` it, could not `edit` one line of it, and the user could not   │
// │ open it in an editor at all. Every update meant rewriting the whole  │
// │ manifest from memory — and whatever the model forgot to repeat       │
// │ (`states`, `settings`) was silently lost.                            │
// │                                                                      │
// │ Now the folder IS the app. The database only records that a folder   │
// │ was published; the content is read from disk on every request.       │
// └──────────────────────────────────────────────────────────────────────┘
//
// The root is relocatable with `PLATFORM_APPS` — the same convention as
// `PLATFORM_WORKS` and `PLATFORM_PROJECTS` in `work-dir.ts` (tests point it at
// a temporary directory).

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** The root that holds every app folder */
export function appsRoot(): string {
  const env = process.env.PLATFORM_APPS?.trim()
  if (env) return env
  return join(homedir(), '.platforma', 'apps')
}

/**
 * The app id pattern — lowercase letters, digits and dashes.
 *
 * The id becomes a DIRECTORY NAME and a URL segment, so it is filtered on an
 * allowlist principle: `..`, `/`, NUL and every other path trick simply are
 * not part of the allowed set. This is the same reasoning as `projectSlug()`
 * in `work-dir.ts` — with a denylist there is always one more character to
 * remember.
 */
export const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export function isValidAppId(id: string): boolean {
  return APP_ID_PATTERN.test(id) && id.length <= 64
}

/**
 * The folder belonging to an app id.
 *
 * It does NOT create the directory and does NOT check that it exists — this is
 * a pure path computation. Returns `null` for an invalid id, so the caller is
 * forced to handle it rather than receiving a path built from a bad id.
 */
export function appDir(id: string): string | null {
  if (!isValidAppId(id)) return null
  return join(appsRoot(), id)
}

/**
 * Confirms that `path` really sits inside the apps root.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE CHECK THAT GUARDS DELETION.                            │
 * │                                                                    │
 * │ `isValidAppId` already rules out `..` and `/`, so this is a SECOND │
 * │ layer — and it catches something the pattern cannot: a SYMLINK.    │
 * │ A folder named `my-app` is a perfectly valid id, but if it is a    │
 * │ symlink to `/home/user`, deleting it recursively would follow the  │
 * │ link.                                                              │
 * │                                                                    │
 * │ `realpathSync` resolves the link and we compare the REAL location. │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Returns `false` when the path does not exist — a caller about to delete
 * something must not treat "missing" as "safe to recurse into".
 */
export function isInsideAppsRoot(path: string): boolean {
  if (!existsSync(path)) return false

  try {
    const root = realpathSync(appsRoot())
    const real = realpathSync(path)
    // The root itself is NOT a valid target: deleting it would wipe every app.
    if (real === root) return false
    return real.startsWith(root + sep)
  } catch {
    // A broken symlink or a permission error — we do not guess, we refuse.
    return false
  }
}

/** File and folder names inside an app directory */
export const APP_FILES = {
  /** The manifest: metadata, widgets and data. Never contains code. */
  manifest: 'app.json',
  /** The optional custom view, as JSX source */
  view: 'view.jsx',
  /** One file per state: `states/<name>.js` */
  states: 'states',
  /** The settings `write` code */
  settingsWrite: 'settings.js',
  /** The optional settings `read` code */
  settingsRead: 'settings.read.js',
  /** One file per action: `actions/<name>.js` */
  actions: 'actions',
  /** The compilation cache — generated, never edited by hand */
  build: '.build',
} as const

/**
 * The path of a file inside an app folder, checked against escape attempts.
 *
 * Used for the per-state and per-action files, whose names come from
 * `app.json` — that is, from a file the user or the AI wrote. A name like
 * `../../etc/passwd` must not turn into a real path.
 */
export function appFilePath(dir: string, ...parts: string[]): string | null {
  const path = resolve(dir, ...parts)
  const base = resolve(dir)
  if (path !== base && !path.startsWith(base + sep)) return null
  return path
}
