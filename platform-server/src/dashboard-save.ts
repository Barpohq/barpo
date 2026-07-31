// The link between the `appPublish` tool and the database.
//
// `platform-ai` KNOWS NOTHING about the database (an inversion — see
// `dashboard-tools.ts`), so the agent's tool is handed the function from this
// module. Three things happen here, one after another:
//
//   1. VALIDATION  — the manifest shape (`validateManifest`)
//   2. COMPILATION — when there is JSX (`buildView`)
//   3. SAVING      — an upsert into the database (`saveApp`)
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THE KEY ERROR-ISOLATION DECISION LIVES HERE.                         │
// │                                                                      │
// │ When the code does not compile the manifest is NOT REJECTED — it is  │
// │ saved WITHOUT its `view` and the widgets keep working as before.     │
// │ In other words a mistake in the AI's code does not lose the whole    │
// │ dashboard, it only turns off the custom view.                        │
// │                                                                      │
// │ There is a condition: there have to be widgets. In a manifest with   │
// │ no widgets, a failing bit of code leaves nothing to display — in     │
// │ that case we reject, and the AI sees the error and fixes it.         │
// └──────────────────────────────────────────────────────────────────────┘

import type { DashboardResult } from '@platforma/ai'
import { validateManifest } from '@platforma/shared'
import type { Database } from 'bun:sqlite'
import { saveApp } from './repo.ts'
import { validateCode } from './state-run.ts'
import { clearAppCache } from './state-cache.ts'
import { buildView } from './view-build.ts'
import { hub } from './ws/hub.ts'

/**
 * Validates the manifest, builds the code and saves it.
 *
 * IT DOES NOT THROW — the outcome comes back as a `DashboardResult`, and
 * `appPublish` turns it into text the model reads.
 */
export async function saveDashboard(
  raw: unknown,
  database?: Database,
): Promise<DashboardResult> {
  const validation = validateManifest(raw)
  if (!validation.ok || !validation.value) {
    return { ok: false, errors: validation.errors }
  }

  const manifest = validation.value
  const warnings = [...validation.warnings]

  // State code is checked for SYNTAX here — so the error shows up at publish
  // time rather than on the first poll, and the AI can fix it itself. Invalid
  // ones are DROPPED, the rest keep working.
  //
  // NEXT STAGE: the prompt injection classifier gets wired in here (see
  // `validateCode()` in `state-run.ts`).
  if (manifest.states?.length) {
    const valid = manifest.states.filter((s) => {
      const errors = validateCode(s.code)
      if (errors.length === 0) return true
      warnings.push(`State "${s.name}" dropped: ${errors.join('; ')}`)
      return false
    })
    if (valid.length > 0) manifest.states = valid
    else delete manifest.states
  }

  if (manifest.view) {
    const build = await buildView(manifest.view.code)

    if (build.ok && build.code) {
      // The COMPILED code is what gets stored in the manifest: no transform
      // load on the browser, and no rebuild on every open.
      manifest.view = { code: build.code, hash: build.hash ?? '' }
    } else if (manifest.widgets.length > 0) {
      // There IS something else to show — we do not lose the app.
      delete manifest.view
      warnings.push(
        'The view code did not compile and was DROPPED (widgets were kept): ' +
          build.errors.join('; '),
      )
    } else {
      // Nothing would be left to show — we reject, otherwise the user would
      // be looking at a blank page.
      return {
        ok: false,
        errors: [
          ...build.errors,
          'No widgets were provided either, so there is nothing left to display.',
        ],
      }
    }
  }

  try {
    const { isNew } = saveApp(manifest, database)

    // The code may have changed — old results must not be reused.
    // (The cache checks the code hash too, but clearing here also refreshes
    // the FIRST request after a republish.)
    clearAppCache(manifest.id)

    // Tell the UI straight away — the user should not have to reload the page.
    // Errors are SWALLOWED: the dashboard is saved either way and shows up on
    // a refresh, so failing the tool over a WS problem would be wrong.
    try {
      hub.broadcast({ type: isNew ? 'app.installed' : 'app.updated', manifest })
    } catch {
      // A WS error does not undo the save
    }

    return {
      ok: true,
      isNew,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (error) {
    // A database error (disk full, locked) — we tell the agent, but we do not
    // bring the process down.
    return { ok: false, errors: [`Could not save to the database: ${String(error)}`] }
  }
}
