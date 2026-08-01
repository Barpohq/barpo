// SQLite connection and the migration system.
//
// WAL mode is enabled: reads do not block writes — while a stream is running
// over WS, REST requests do not have to wait. The database file lives at
// `barpo-server/data/platform.db`; the folder is created at runtime (it is
// not committed to git).

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { migrations } from './migrations/index.ts'

/** Default database path — the data/ folder at the package root */
export const DEFAULT_DB_PATH = resolve(import.meta.dir, '..', 'data', 'platform.db')

/**
 * Opens the database, enables WAL and applies pending migrations.
 * The `:memory:` path is for tests — no folder is created.
 */
export function openDb(path: string = DEFAULT_DB_PATH): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  const db = new Database(path, { create: true })

  // WAL — for parallel reads. An in-memory database does not support WAL.
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
  }
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')

  applyMigrations(db)
  return db
}

/**
 * Runs the migrations that have not been applied yet, in order, based on the
 * `schema_version` table. Each migration runs in its own transaction — there
 * is no half-applied state.
 */
export function applyMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      number     INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)

  // Databases created before migration 013 have the old column names
  // (`raqam`/`nom`). Rename them here, BEFORE the first read: the runner
  // itself queries these columns, so 013 cannot do it without breaking the
  // statement that is currently executing.
  renameSchemaVersionColumns(db)

  const applied = new Set(
    db
      .query<{ number: number }, []>('SELECT number FROM schema_version')
      .all()
      .map((row) => row.number),
  )

  const write = db.prepare('INSERT INTO schema_version (number, name, applied_at) VALUES (?, ?, ?)')

  for (const m of [...migrations].sort((a, b) => a.number - b.number)) {
    if (applied.has(m.number)) continue

    if (m.outsideTransaction) {
      // ┌──────────────────────────────────────────────────────────────┐
      // │ TRANSACTION-FREE PATH — only for migrations that rebuild a   │
      // │ table.                                                        │
      // │                                                               │
      // │ In SQLite the only way to change a `CHECK` constraint is to   │
      // │ rebuild the table. That needs `PRAGMA foreign_keys = OFF`     │
      // │ (otherwise `DROP TABLE` CASCADEs the linked rows away), but a │
      // │ PRAGMA is SILENTLY IGNORED inside a transaction.              │
      // │                                                               │
      // │ So such a migration carries its own BEGIN/COMMIT inside the   │
      // │ SQL and is not wrapped in a transaction here. This is safe    │
      // │ because `BEGIN`/`COMMIT` are still present — atomicity holds, │
      // │ only the PRAGMAs sit outside of it.                           │
      // └──────────────────────────────────────────────────────────────┘
      db.exec(m.sql)
      write.run(m.number, m.name, new Date().toISOString())
      continue
    }

    const run = db.transaction(() => {
      db.exec(m.sql)
      write.run(m.number, m.name, new Date().toISOString())
    })
    run()
  }
}

/**
 * Renames the legacy `schema_version` columns (`raqam`/`nom`) to
 * `number`/`name`.
 *
 * This lives here rather than in migration 013 on purpose: the migration
 * runner reads `schema_version` to decide what to run, so renaming those
 * columns from inside a migration would break the very query that drives the
 * loop. A fresh database is created with the new names above and this is a
 * no-op for it.
 */
function renameSchemaVersionColumns(db: Database): void {
  const columns = db
    .query<{ name: string }, []>('PRAGMA table_info(schema_version)')
    .all()
    .map((c) => c.name)

  if (columns.includes('raqam')) {
    db.exec('ALTER TABLE schema_version RENAME COLUMN raqam TO number')
  }
  if (columns.includes('nom')) {
    db.exec('ALTER TABLE schema_version RENAME COLUMN nom TO name')
  }
}

/** Current schema version (0 when no migration has been applied) */
export function schemaVersion(db: Database): number {
  const row = db
    .query<{ v: number | null }, []>('SELECT MAX(number) AS v FROM schema_version')
    .get()
  return row?.v ?? 0
}

// ---------------------------------------------------------------------------
// A single connection that lives for the whole process (singleton).
// Tests open their own database independently with `openDb(':memory:')`.
// ---------------------------------------------------------------------------

let _db: Database | null = null

export function db(): Database {
  if (!_db) _db = openDb(process.env.DB_PATH ?? DEFAULT_DB_PATH)
  return _db
}

/** For swapping the global connection in tests */
export function setDb(database: Database | null): void {
  _db = database
}
