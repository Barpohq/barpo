// Initial data for a blank install.
//
// IDEMPOTENT: every table is filled only if it is EMPTY. Nothing is written
// over existing data when the server restarts, so changes the user made are
// preserved.
//
// AS OF NOW THERE IS NOTHING LEFT TO SEED — and that is the point. Each table
// below has its own note explaining why inventing a row for it would be a lie
// rather than a convenience. The function stays because the shape (`applySeed`
// + `SeedResult`) is what `index.ts` and the tests call, and because the next
// table that genuinely needs a starting row belongs here.

import type { Database } from 'bun:sqlite'

// There is DELIBERATELY no server seed (since migration 007): a server row
// points at a real SSH connection, so a made-up row would be a "server that
// never connects". The user adds servers from the Servers page.

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

// There is DELIBERATELY no audit seed either. It used to hold twelve invented
// entries (`ai-news-bot`, `helsinki-1`, a blocked DROP TABLE) so the page would
// not look bare — but the audit log is the one place on the platform that must
// be trustworthy: it is append-only, protected by a SQL trigger, and it is what
// you consult when you want to know what REALLY happened. Fiction in that table
// is worse than an empty table.
//
// It fills up on its own from the first real action, because every state change
// in the backend goes through `auditWrite(...)`.
export const seedAuditLog: readonly never[] = []

// ---------------------------------------------------------------------------
// Installed apps
// ---------------------------------------------------------------------------

// There is DELIBERATELY no app seed, and now there is not even a way to write
// one from here: an app is a FOLDER on disk (`apps-dir.ts`), and this table
// only records that a folder was published. Seeding a row would point the
// platform at a directory that does not exist.
//
// An app is built in the chat: the agent writes the files and calls
// `appPublish`.
export const seedApps: readonly never[] = []

// ---------------------------------------------------------------------------
// Applying the seed
// ---------------------------------------------------------------------------

export interface SeedResult {
  audit: number
  apps: number
}

/**
 * Writes the seed data to the database. Every table is checked independently —
 * only empty tables are filled, which makes calling this again safe.
 *
 * Every count is currently 0 (see the notes above); the return shape is kept so
 * callers and tests do not have to change when a table needs seeding again.
 */
export function applySeed(_db: Database): SeedResult {
  // There is DELIBERATELY no skill seed: a skill is tied to a real `SKILL.md`
  // on disk, so a made-up row would point nowhere. The user connects a GitHub
  // source themselves (the Skills page).
  return { audit: 0, apps: 0 }
}
