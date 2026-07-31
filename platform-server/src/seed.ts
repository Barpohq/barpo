// Initial data — the seed data from platform-ui/src/data/mock.ts.
//
// IDEMPOTENT: every table is filled only if it is EMPTY. Nothing is written
// over existing data when the server restarts, so changes the user made are
// preserved.
//
// In the next stage real data sources (daemon telemetry, a real skill store)
// get connected — at that point this file only remains for a blank install.

import type { Database } from 'bun:sqlite'
import type { AppManifest, AuditEntry } from '@platforma/shared'

// There is DELIBERATELY no server seed (since migration 007): a server row
// points at a real SSH connection, so a made-up row would be a "server that
// never connects". The user adds servers from the Servers page.

// ---------------------------------------------------------------------------
// Audit log (oldest to newest — the INSERT order must be this way, because
// reads are sorted by id DESC)
// ---------------------------------------------------------------------------

export const seedAuditLog: AuditEntry[] = [
  { time: '00:12', actor: 'berlin-1 daemon', action: 'Daily backup', target: 'sqlite → berlin-1', level: 'write', result: 'approved' },
  { time: '05:55', actor: 'server-monitor', action: 'Restart proposed', target: 'nyc-1 · nginx', level: 'write', result: 'pending' },
  { time: '06:00', actor: 'ai-news-bot', action: 'Pipeline started', target: 'helsinki-1', level: 'read', result: 'OK' },
  { time: '08:47', actor: 'skill:postgres-backup', action: 'DROP TABLE attempt blocked', target: 'db-01', level: 'dangerous', result: 'denied' },
  { time: '09:00', actor: 'ai-news-bot', action: 'Health report sent', target: 'admin chat', level: 'read', result: 'OK' },
  { time: '10:14', actor: 'ai-news-bot', action: 'Tavily search call', target: 'enricher', level: 'read', result: 'OK' },
  { time: '11:31', actor: 'firdavs', action: 'Deploy request (via chat)', target: 'frankfurt-1', level: 'write', result: 'OK' },
  { time: '11:32', actor: 'claude-code', action: 'tmux session opened', target: 'frankfurt-1', level: 'write', result: 'approved' },
  { time: '11:50', actor: 'server-monitor', action: 'Disk usage read', target: 'helsinki-1', level: 'read', result: 'OK' },
  { time: '11:50', actor: 'server-monitor', action: 'Alert sent', target: 'admin chat', level: 'read', result: 'OK' },
  { time: '12:04', actor: 'firdavs', action: 'Post approved (✅)', target: 'post #4', level: 'write', result: 'OK' },
  { time: '12:06', actor: 'ai-news-bot', action: 'Post published', target: 't.me/kanal/6', level: 'write', result: 'approved' },
]

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

function isEmpty(db: Database, table: string): boolean {
  const q = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
  return (q?.count ?? 0) === 0
}

export interface SeedResult {
  audit: number
  apps: number
}

/**
 * Writes the seed data to the database. Every table is checked independently —
 * only empty tables are filled, which makes calling this again safe.
 */
export function applySeed(db: Database): SeedResult {
  const result: SeedResult = { audit: 0, apps: 0 }
  const now = new Date().toISOString()

  // There is DELIBERATELY no skill seed: a skill is tied to a real `SKILL.md`
  // on disk, so a made-up row would point nowhere. The user connects a GitHub
  // source themselves (the Skills page).

  // The audit seed is written directly (not through `auditWrite`) — these are
  // historical entries, and broadcasting them over WS as "new events" would be
  // wrong; their time fields are past values too.
  if (isEmpty(db, 'audit_log')) {
    const st = db.prepare(
      `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const day = now.slice(0, 10)
    db.transaction(() => {
      for (const a of seedAuditLog) {
        st.run(a.time, a.actor, a.action, a.target, a.level, a.result, `${day}T${a.time}:00.000Z`)
        result.audit++
      }
    })()
  }

  // No app seed — see the note above `seedApps`. `result.apps` stays 0 and is
  // kept in the shape so callers and tests do not have to change.

  return result
}
