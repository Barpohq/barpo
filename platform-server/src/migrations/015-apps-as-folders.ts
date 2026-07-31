import type { Migration } from './index.ts'

// An app is now a FOLDER on disk, not a JSON blob in this table.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHAT CHANGED AND WHY.                                                │
// │                                                                      │
// │ `apps.manifest` held the whole dashboard — widgets, state code, the  │
// │ compiled view, the settings code. Nothing could read it but the      │
// │ platform: the agent could not `edit` one line of it and the user     │
// │ could not open it at all. Every update therefore meant the model     │
// │ rewriting the entire manifest from memory, and whatever it forgot to │
// │ repeat was silently dropped.                                         │
// │                                                                      │
// │ The folder is now the source of truth (`~/.platforma/apps/<id>/`).   │
// │ This table records only THAT a folder was published, and where.      │
// └──────────────────────────────────────────────────────────────────────┘
//
// EXISTING ROWS ARE DROPPED, DELIBERATELY. The user's decision: no data
// migration. Writing the old blobs out to folders would mean splitting code
// out of JSON strings and guessing file names for states and actions — for
// dashboards that were test data. A clean start is honest; a half-converted
// folder that looks fine until its settings form is opened is not.
//
// The table is REBUILT rather than altered: `manifest` is `NOT NULL` and
// SQLite cannot drop a column in older versions. Rebuilding also lets
// `published_at` replace `updated_at` with a meaning that is actually true —
// the row records a publish, and the folder's own mtime is what changes when
// the content changes.
//
// `outsideTransaction` is NOT needed here: no foreign key references `apps`,
// so no `PRAGMA foreign_keys` dance is required (see `db.ts`).

export const migration: Migration = {
  number: 15,
  name: 'apps-as-folders',
  sql: `
    DROP TABLE apps;

    CREATE TABLE apps (
      id           TEXT PRIMARY KEY,
      -- The folder holding the app. Absolute, so relocating PLATFORM_APPS
      -- does not silently repoint every existing app at a new directory.
      dir          TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('running', 'idle')),
      created_at   TEXT NOT NULL,
      published_at TEXT NOT NULL
    );
  `,
}
