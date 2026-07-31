// The list of migrations — ORDER MATTERS, they are applied sequentially by
// number.
//
// Adding a new migration:
//   1) create a `002-what-it-does.ts` file in this folder,
//   2) `export const migration: Migration = { number: 2, name: '...', sql: `...` }`,
//   3) add it to the `migrations` array below.
// NEVER edit a migration that has already been applied — write a new one,
// otherwise existing databases end up in a different state.

export interface Migration {
  number: number
  name: string
  /** SQL executed in a single transaction (may contain several statements) */
  sql: string
  /**
   * The SQL carries its own `BEGIN`/`COMMIT` and is NOT wrapped in a
   * transaction.
   *
   * Only for migrations that rebuild a table: those require
   * `PRAGMA foreign_keys = OFF`, and a PRAGMA is silently ignored inside a
   * transaction (see `db.ts`).
   */
  outsideTransaction?: boolean
}

import { migration as m001 } from './001-initial.ts'
import { migration as m002 } from './002-chat-model.ts'
import { migration as m003 } from './003-tool-cards.ts'
import { migration as m004 } from './004-agent-messages.ts'
import { migration as m005 } from './005-projects.ts'
import { migration as m006 } from './006-skills.ts'
import { migration as m007 } from './007-servers-real.ts'
// Number 8 is skipped ON PURPOSE — the reason is in `009-tool-calls.ts`.
import { migration as m009 } from './009-tool-calls.ts'
import { migration as m010 } from './010-builtin-source.ts'
import { migration as m011 } from './011-mcp-servers.ts'
import { migration as m012 } from './012-attachments.ts'
import { migration as m013 } from './013-english-rename.ts'
import { migration as m014 } from './014-builtin-source-rename.ts'
import { migration as m015 } from './015-apps-as-folders.ts'

export const migrations: Migration[] = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
  m007,
  m009,
  m010,
  m011,
  m012,
  m013,
  m014,
  m015,
]
