// The link between the `appPublish` tool and the platform.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ PUBLISHING NO LONGER WRITES THE APP — IT REGISTERS A FOLDER.         │
// │                                                                      │
// │ The agent writes `app.json`, `view.jsx` and the state files with the │
// │ ordinary `write`/`edit` tools. This step reads that folder, checks    │
// │ it, and records it as published.                                     │
// │                                                                      │
// │ The consequence is the one the whole change was made for: UPDATING   │
// │ AN APP NO LONGER GOES THROUGH THIS PATH AT ALL. `edit view.jsx` is   │
// │ the update. Nothing has to be republished, and nothing the model     │
// │ forgot to repeat can be lost, because it never resends the manifest. │
// └──────────────────────────────────────────────────────────────────────┘
//
// Validation still happens HERE as well as on read. The reason is timing: at
// publish the AI is still in the loop and can fix what it wrote, so errors are
// worth far more now than when the user opens the page three days later.

import type { DashboardResult } from '@platforma/ai'
import type { Database } from 'bun:sqlite'
import { readAppFolder } from './app-store.ts'
import { appDir, isValidAppId, APP_FILES } from './apps-dir.ts'
import { publishApp } from './repo.ts'
import { validateCode } from './state-run.ts'
import { clearAppCache } from './state-cache.ts'
import { hub } from './ws/hub.ts'

/**
 * Registers an app folder as published.
 *
 * IT DOES NOT THROW — the outcome comes back as a `DashboardResult`, and
 * `appPublish` turns it into text the model reads and acts on.
 */
export async function publishDashboard(
  id: unknown,
  database?: Database,
): Promise<DashboardResult> {
  if (typeof id !== 'string' || !isValidAppId(id)) {
    return {
      ok: false,
      errors: [
        'The app id must be lowercase letters, digits and dashes only (e.g. "ai-news-bot").',
      ],
    }
  }

  const dir = appDir(id)
  if (!dir) {
    return { ok: false, errors: [`"${id}" is not a usable app id.`] }
  }

  const folder = await readAppFolder(dir)

  // Checked BEFORE the manifest is judged. A mismatch explains why the app is
  // not where the user expected it, which is more useful than whatever the
  // validator would otherwise report first.
  if (folder.declaredId != null && folder.declaredId !== id) {
    return {
      ok: false,
      errors: [
        `"${APP_FILES.manifest}" declares id "${folder.declaredId}" but the folder is "${id}". ` +
          'They must match.',
      ],
    }
  }

  if (!folder.manifest) {
    // Nothing renderable. The most likely cause by far is that the agent
    // called publish before writing the files, so the message says where the
    // files belong rather than just reporting the failure.
    return {
      ok: false,
      errors: [
        ...folder.errors,
        `Expected the app files in ${dir} — write ${APP_FILES.manifest} there first, ` +
          `then call appPublish again.`,
      ],
    }
  }

  const manifest = folder.manifest
  const warnings = [...folder.errors]

  // State code is checked for SYNTAX at publish time, so the error reaches the
  // AI while it can still fix it rather than surfacing on the first poll.
  //
  // Unlike the old path this does NOT drop the state from what gets stored —
  // there is nothing stored to drop it from. The file stays where the agent
  // wrote it and the problem is reported instead. Silently deleting a file the
  // user can see would be a worse surprise than a broken state.
  for (const state of manifest.states ?? []) {
    const errors = validateCode(state.code)
    if (errors.length > 0) {
      warnings.push(`${APP_FILES.states}/${state.name}.js: ${errors.join('; ')}`)
    }
  }

  try {
    const { isNew } = publishApp(id, dir, manifest.status, database)

    // The code may have changed — old results must not be reused.
    clearAppCache(id)

    // Tell the UI straight away — the user should not have to reload the page.
    // Errors are SWALLOWED: the app is published either way and shows up on a
    // refresh, so failing the tool over a WS problem would be wrong.
    try {
      hub.broadcast({ type: isNew ? 'app.installed' : 'app.updated', manifest })
    } catch {
      // A WS error does not undo the publish
    }

    return {
      ok: true,
      isNew,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (error) {
    return { ok: false, errors: [`Could not record the publish: ${String(error)}`] }
  }
}
