// Writing a refreshed OAuth token back to the SOURCE file
// (~/.codex/auth.json).
//
// Why is it needed? OpenAI ROTATES the refresh token: a
// `grant_type=refresh_token` request returns a new `refresh_token` and
// revokes the old one (pi-ai's `readTokenResponse` function requires the new
// refresh token to be present).
//
// If we only READ from the local file, the refresh_token in
// ~/.codex/auth.json is left dead after the first refresh. As a result
// `codex` does not start in the terminal — the user is forced to log in
// again. This exact problem used to come back every week.
//
// So when we refresh the token we write it back to the source file too.
// This means modifying another program's file — the precautions:
//   1. Only specific fields inside `tokens.*` are updated. Everything else
//      (auth_mode, OPENAI_API_KEY, account_id, future fields) is left as it
//      is.
//   2. Atomic write: write to a temporary file, then rename. Codex never
//      sees a half-written file.
//   3. File permissions stay at 600.
//   4. If the file does not exist it is NOT CREATED. If Codex is not
//      installed, we do not interfere.
//   5. Never throws: even if the sync fails, the platform's own work carries
//      on.
//
// The token itself is never logged anywhere.

import { renameSync, writeFileSync, chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OAuthCredential } from '@earendil-works/pi-ai'

/** The sync result — for diagnostics, contains no secrets */
export interface SyncResult {
  written: boolean
  /** If nothing was written — why */
  reason?: string
}

/**
 * Updates the Codex `auth.json` with the new token.
 *
 * `id_token` is deliberately left alone: it is not returned in the refresh
 * response (only access_token / refresh_token / expires_in come back), so we
 * keep the old one. Even if it has expired it does no harm — codex refreshes
 * it itself when it needs to.
 */
export function writeToCodex(credential: OAuthCredential, home = homedir()): SyncResult {
  const path = join(home, '.codex', 'auth.json')

  if (!existsSync(path)) {
    // Codex is not installed — none of our business
    return { written: false, reason: 'file not found' }
  }

  let current: Record<string, unknown>
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { written: false, reason: 'unexpected shape' }
    }
    current = value as Record<string, unknown>
  } catch (error) {
    return { written: false, reason: `could not be read (${shortError(error)})` }
  }

  const oldTokens =
    typeof current.tokens === 'object' && current.tokens !== null && !Array.isArray(current.tokens)
      ? (current.tokens as Record<string, unknown>)
      : {}

  // If the file already holds the same token — do not write. Avoids a
  // pointless disk write and avoids disturbing codex's file watcher.
  if (oldTokens.access_token === credential.access && oldTokens.refresh_token === credential.refresh) {
    return { written: false, reason: 'no change' }
  }

  const updated = {
    ...current,
    tokens: {
      ...oldTokens,
      access_token: credential.access,
      refresh_token: credential.refresh,
    },
    // Codex stores this field as an ISO string
    last_refresh: new Date().toISOString(),
  }

  return atomicWrite(path, JSON.stringify(updated, null, 2))
}

/**
 * Replaces the file atomically: writes to a temporary file next to it, then
 * renames. `rename` is atomic within the same filesystem — a reader sees
 * either the old or the new file, never half of one.
 */
function atomicWrite(path: string, content: string): SyncResult {
  // The temporary file MUST be in that exact directory — if /tmp is on a
  // different filesystem the rename would not be atomic (it fails with EXDEV)
  const temporary = `${path}.${process.pid}.tmp`
  try {
    // Set the permissions BEFORE writing — the token must never sit, not even
    // for an instant, in a file others can read
    writeFileSync(temporary, content, { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
    return { written: true }
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // could not clean up — not critical
    }
    return { written: false, reason: `could not be written (${shortError(error)})` }
  }
}

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 80)
}
