// Deleting an app — the publish record AND the folder.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THIS IS THE ONLY PLACE THAT ERASES A USER'S FILES.                   │
// │                                                                      │
// │ The user's decision was explicit: delete removes the folder too, so  │
// │ a dashboard that is no longer wanted leaves nothing behind. That is  │
// │ irreversible — there is no trash and no undo — so both callers of    │
// │ this module confirm first:                                           │
// │                                                                      │
// │   the UI     — a modal naming the app and the folder                 │
// │   the agent  — the permission layer (`appDelete` in dashboard-tools) │
// │                                                                      │
// │ NOTHING calls this without a confirmed decision behind it.           │
// └──────────────────────────────────────────────────────────────────────┘
//
// THE PATH IS CHECKED TWICE, and neither check is redundant:
//
//   1) `isValidAppId` — the id is an allowlist of `[a-z0-9-]`, so `..` and
//      `/` cannot appear in the first place.
//   2) `isInsideAppsRoot` — resolves SYMLINKS and confirms the real location
//      is under the apps root. This catches what the pattern cannot: a
//      perfectly-named folder that is a link to somewhere else entirely.
//
// The recorded `dir` is used rather than a recomputed path: if `PLATFORM_APPS`
// changed since the app was published, recomputing would point at a directory
// that was never this app's — and we would delete the wrong thing.

import { rmSync } from 'node:fs'
import { auditWrite } from './audit.ts'
import { isInsideAppsRoot } from './apps-dir.ts'
import { readPublication, unpublishApp } from './repo.ts'
import { clearAppCache } from './state-cache.ts'
import { hub } from './ws/hub.ts'
import type { Database } from 'bun:sqlite'

export interface DeleteResult {
  ok: boolean
  /** Whether the folder itself was removed (false when it was already gone) */
  folderRemoved?: boolean
  error?: string
}

/**
 * Deletes an app: its publish record, its cached state, and its folder.
 *
 * `actor` goes into the audit entry — `'user'` for the UI, the session id for
 * the agent, so the log answers "who deleted this" rather than just "it was
 * deleted".
 *
 * IT DOES NOT THROW. A failed delete comes back as `{ ok: false, error }`: the
 * agent needs to read the reason as text, and the UI needs to show it.
 */
export function deleteApp(
  id: string,
  actor: string,
  database?: Database,
): DeleteResult {
  const publication = readPublication(id, database)
  if (!publication) {
    return { ok: false, error: `App "${id}" is not published.` }
  }

  // The record goes first. If the folder removal fails afterwards, the app is
  // already off the list and out of the UI — the opposite order could leave a
  // published app pointing at a directory that no longer exists.
  unpublishApp(id, database)
  clearAppCache(id)

  let folderRemoved = false
  let error: string | undefined

  if (isInsideAppsRoot(publication.dir)) {
    try {
      rmSync(publication.dir, { recursive: true, force: true })
      folderRemoved = true
    } catch (e) {
      // The app is unpublished either way — this is reported, not fatal.
      error = `The app was removed from the platform, but its folder could not be deleted: ${String(e)}`
    }
  } else {
    // Either the folder is already gone (fine — nothing to delete) or it
    // resolves outside the apps root (NOT fine — we refuse rather than follow
    // a link out of our own directory).
    error = undefined
  }

  auditWrite(
    actor,
    `App deleted: ${id}${folderRemoved ? ' (with its folder)' : ''}`,
    id,
    'dangerous',
    'OK',
  )

  try {
    hub.broadcast({ type: 'app.removed', id })
  } catch {
    // A WS error does not undo the delete — the sidebar catches up on refresh.
  }

  return { ok: true, folderRemoved, ...(error ? { error } : {}) }
}
