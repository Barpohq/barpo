// The two migrations that REBUILD tables — 010 and 013.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THE MOST DANGEROUS PLACE IN THE SCHEMA. Both migrations recreate     │
// │ tables (in SQLite there is no other way to change a `CHECK`), and    │
// │ children such as `skills.source_id` hang off those tables with       │
// │ `ON DELETE CASCADE` — so if foreign keys were left on during the     │
// │ `DROP TABLE`, a user's ENTIRE skill catalogue and all their installs │
// │ would quietly disappear.                                             │
// │                                                                      │
// │ These tests force exactly that: existing data MUST SURVIVE.          │
// └──────────────────────────────────────────────────────────────────────┘

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { migrations } from '../src/migrations/index.ts'
import { applyMigrations } from '../src/db.ts'

/**
 * Builds a database in the state it was in BEFORE migration `upTo`.
 *
 * The `schema_version` table is created with its legacy column names
 * (`raqam`/`nom`) on purpose: that is the shape a real pre-013 database has,
 * and `applyMigrations` is expected to rename them before it reads the table.
 */
function databaseBefore(upTo: number): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')

  db.exec(`
    CREATE TABLE schema_version (
      raqam INTEGER PRIMARY KEY, nom TEXT NOT NULL, applied_at TEXT NOT NULL
    )
  `)
  const write = db.prepare('INSERT INTO schema_version VALUES (?, ?, ?)')
  for (const m of migrations
    .filter((x) => x.number < upTo)
    .sort((a, b) => a.number - b.number)) {
    db.exec(m.sql)
    write.run(m.number, m.name, '2026-01-01T00:00:00.000Z')
  }
  return db
}

// ===========================================================================
// 010 — the builtin skill source
// ===========================================================================

/** Adds a source, a skill and an install row (pre-010 column names) */
function addSkillData(db: Database) {
  db.prepare(
    `INSERT INTO skill_manbalari (id, tur, url, owner, repo, ref, commit_sha, oxirgi_sinxron, created_at)
     VALUES ('m1', 'github', 'https://github.com/a/b', 'a', 'b', 'main', 'sha1', '2026-01-01', '2026-01-01')`,
  ).run()
  db.prepare(
    `INSERT INTO skilllar (id, manba_id, yol, nom, tavsif, litsenziya, allowed_tools, ogohlantirishlar)
     VALUES ('s1', 'm1', 'x/SKILL.md', 'x-skill', 'description', NULL, NULL, '[]')`,
  ).run()
  db.prepare(
    `INSERT INTO skill_ornatish (skill_id, qamrov, project_id, created_at)
     VALUES ('s1', 'global', NULL, '2026-01-01T00:00:00.000Z')`,
  ).run()
}

describe('migration 010 — the builtin skill source', () => {
  test('the existing source, skill and INSTALLS all survive', () => {
    const db = databaseBefore(10)
    try {
      addSkillData(db)
      applyMigrations(db)

      // None of the three tables may be damaged — this is where the CASCADE
      // trap lies. (013 renames them along the way.)
      expect(db.query('SELECT * FROM skill_sources').all()).toHaveLength(1)
      expect(db.query('SELECT * FROM skills').all()).toHaveLength(1)
      expect(db.query('SELECT * FROM skill_installs').all()).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  test('the fields of the source are carried across unchanged', () => {
    const db = databaseBefore(10)
    try {
      addSkillData(db)
      applyMigrations(db)

      const m = db.query<Record<string, unknown>, []>('SELECT * FROM skill_sources').get()!
      expect(m.id).toBe('m1')
      expect(m.kind).toBe('github')
      expect(m.owner).toBe('a')
      expect(m.commit_sha).toBe('sha1')
    } finally {
      db.close()
    }
  })

  test('an unknown source kind is STILL rejected', () => {
    const db = databaseBefore(10)
    try {
      applyMigrations(db)
      // The CHECK constraint must not have been lost — only widened
      expect(() =>
        db
          .prepare(
            `INSERT INTO skill_sources (id, kind, url, owner, repo, ref, created_at)
             VALUES ('m3', 'gitlab', 'x', 'a', 'b', '', '2026')`,
          )
          .run(),
      ).toThrow()
    } finally {
      db.close()
    }
  })

  test('the uniqueness index is recreated', () => {
    const db = databaseBefore(10)
    try {
      applyMigrations(db)
      db.prepare(
        `INSERT INTO skill_sources (id, kind, url, owner, repo, ref, created_at)
         VALUES ('m4', 'github', 'x', 'a', 'b', 'main', '2026')`,
      ).run()
      // The same owner+repo+ref must not be accepted a second time
      expect(() =>
        db
          .prepare(
            `INSERT INTO skill_sources (id, kind, url, owner, repo, ref, created_at)
             VALUES ('m5', 'github', 'x', 'a', 'b', 'main', '2026')`,
          )
          .run(),
      ).toThrow()
    } finally {
      db.close()
    }
  })

  test('foreign key CASCADE still works after the migration', () => {
    const db = databaseBefore(10)
    try {
      addSkillData(db)
      applyMigrations(db)

      // Deleting the source must take the skill with it — the link is intact
      db.exec('PRAGMA foreign_keys = ON')
      db.prepare("DELETE FROM skill_sources WHERE id = 'm1'").run()
      expect(db.query('SELECT * FROM skills').all()).toHaveLength(0)
    } finally {
      db.close()
    }
  })
})

// ===========================================================================
// 013 — the Uzbek → English rename
// ===========================================================================

/**
 * Fills a pre-013 database with rows in every Uzbek shape the rename has to
 * translate: table and column names, CHECK-constrained values, plain stored
 * values and the flat JSON blobs.
 */
function addUzbekData(db: Database) {
  // --- skills: a builtin source ('platforma') and a project-scoped install
  db.prepare(
    `INSERT INTO projects (id, name, papka, created_at)
     VALUES ('p1', 'loyiha', '/tmp/p1', '2026-01-01T00:00:00.000Z')`,
  ).run()
  db.prepare(
    `INSERT INTO skill_manbalari (id, tur, url, owner, repo, ref, created_at)
     VALUES ('m1', 'platforma', 'platforma://standart', 'platforma', 'std', '', '2026-01-01')`,
  ).run()
  db.prepare(
    `INSERT INTO skilllar (id, manba_id, yol, nom, tavsif, litsenziya, allowed_tools, ogohlantirishlar)
     VALUES ('s1', 'm1', 'x/SKILL.md', 'x-skill', 'tavsif', 'ichki', NULL, '[]')`,
  ).run()
  db.prepare(
    `INSERT INTO skill_ornatish (id, skill_id, qamrov, project_id, created_at)
     VALUES ('i1', 's1', 'loyiha', 'p1', '2026-01-01T00:00:00.000Z')`,
  ).run()

  // --- mcp: both catalogue kinds that get renamed ('qolda', 'standart')
  db.prepare(
    `INSERT INTO mcp_manbalari (id, tur, manba_nomi, ref, created_at)
     VALUES ('mm1', 'qolda', 'qolda-qoshilgan', '', '2026-01-01')`,
  ).run()
  db.prepare(
    `INSERT INTO mcp_manbalari (id, tur, manba_nomi, ref, created_at)
     VALUES ('mm2', 'standart', 'standart-papka', '', '2026-01-01')`,
  ).run()
  db.prepare(
    `INSERT INTO mcp_serverlar (id, manba_id, nom, tavsif, transport, buyruq, argumentlar, sozlamalar)
     VALUES ('ms1', 'mm1', 'server-nomi', 'tavsif', 'stdio', 'npx', '["-y"]', ?)`,
  ).run(
    JSON.stringify([
      { nom: 'TOKEN', izoh: 'API kaliti', majburiy: true, maxfiy: true, standart: '' },
    ]),
  )
  db.prepare(
    `INSERT INTO mcp_ornatish (id, server_id, qamrov, project_id, sozlama_qiymatlari, created_at)
     VALUES ('mi1', 'ms1', 'loyiha', 'p1', '{}', '2026-01-01T00:00:00.000Z')`,
  ).run()

  // --- audit: every level and result value that gets rewritten
  const audit = db.prepare(
    `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  audit.run('10:00', 'a', 'read action', 't', "o'qish", 'OK', '2026-01-01T10:00:00.000Z')
  audit.run('10:01', 'b', 'write action', 't', "o'zgartirish", 'tasdiqlandi', '2026-01-01T10:01:00.000Z')
  audit.run('10:02', 'c', 'dangerous action', 't', 'xavfli', 'rad etildi', '2026-01-01T10:02:00.000Z')
  audit.run('10:03', 'd', 'pending action', 't', "o'zgartirish", 'kutmoqda', '2026-01-01T10:03:00.000Z')

  // --- tool calls: statuses plus the three flat JSON blobs
  db.prepare(
    `INSERT INTO chat_sessions (id, title, created_at, updated_at)
     VALUES ('sess1', 'suhbat', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run()
  const toolCall = db.prepare(
    `INSERT INTO tool_chaqiruvlar
       (id, session_id, message_id, nom, args, holat, natija, tafsilot, ruxsat, klassifikator,
        created_at, updated_at)
     VALUES (?, 'sess1', 'msg1', ?, '{}', ?, NULL, ?, ?, ?, '2026-01-01', '2026-01-01')`,
  )
  toolCall.run(
    't1',
    'bash',
    'tugadi',
    JSON.stringify({ diff: '+a', qisqartirilgan: true }),
    JSON.stringify({
      sorovId: 'r1',
      manba: 'foydalanuvchi',
      berildi: true,
      naqsh: 'git *',
      vaqt: '2026-01-01',
    }),
    JSON.stringify({ qaror: 'ruxsat', izoh: 'xavfsiz buyruq' }),
  )
  toolCall.run(
    't2',
    'write',
    'ishlamoqda',
    null,
    JSON.stringify({ sorovId: 'r2', manba: 'auto-blok', berildi: false, vaqt: '2026-01-01' }),
    JSON.stringify({ qaror: 'blok', izoh: 'xavfli' }),
  )
  toolCall.run('t3', 'read', 'xato', null, null, null)
  toolCall.run('t4', 'rm', 'rad etildi', null, null, null)

  // --- attachments: both kinds
  const attachment = db.prepare(
    `INSERT INTO chat_biriktirmalar
       (id, session_id, message_id, tur, nom, asl_nom, yol, mime, hajm, created_at)
     VALUES (?, 'sess1', 'msg1', ?, ?, ?, ?, ?, 10, '2026-01-01')`,
  )
  attachment.run('a1', 'rasm', 'x.png', 'asl.png', '.barpo/sessiyalar/sess1/fayllar/x.png', 'image/png')
  attachment.run('a2', 'fayl', 'y.txt', 'asl.txt', '.barpo/sessiyalar/sess1/fayllar/y.txt', 'text/plain')
}

describe('migration 013 — the Uzbek → English rename', () => {
  test('the tables and columns arrive under their English names', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((t) => t.name)

      for (const expected of [
        'skill_sources',
        'skills',
        'skill_installs',
        'mcp_sources',
        'mcp_servers',
        'mcp_installs',
        'tool_calls',
        'chat_attachments',
      ]) {
        expect(tables).toContain(expected)
      }
      for (const gone of [
        'skill_manbalari',
        'skilllar',
        'skill_ornatish',
        'mcp_manbalari',
        'mcp_serverlar',
        'mcp_ornatish',
        'tool_chaqiruvlar',
        'chat_biriktirmalar',
      ]) {
        expect(tables).not.toContain(gone)
      }

      const projectColumns = db
        .query<{ name: string }, []>('PRAGMA table_info(projects)')
        .all()
        .map((c) => c.name)
      expect(projectColumns).toContain('folder')
      expect(projectColumns).not.toContain('papka')
    } finally {
      db.close()
    }
  })

  test('every row survives the rebuild — nothing is lost to CASCADE', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      expect(db.query('SELECT * FROM skill_sources').all()).toHaveLength(1)
      expect(db.query('SELECT * FROM skills').all()).toHaveLength(1)
      expect(db.query('SELECT * FROM skill_installs').all()).toHaveLength(1)
      expect(db.query('SELECT * FROM mcp_sources').all()).toHaveLength(2)
      expect(db.query('SELECT * FROM mcp_servers').all()).toHaveLength(1)
      expect(db.query('SELECT * FROM mcp_installs').all()).toHaveLength(1)
      expect(db.query('SELECT * FROM tool_calls').all()).toHaveLength(4)
      expect(db.query('SELECT * FROM chat_attachments').all()).toHaveLength(2)
      expect(db.query('SELECT * FROM audit_log').all()).toHaveLength(4)
    } finally {
      db.close()
    }
  })

  // -------------------------------------------------------------------------
  // Stored value translation
  // -------------------------------------------------------------------------

  test("the skill source kind 'platforma' becomes 'builtin'", () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      const row = db.query<{ kind: string }, []>('SELECT kind FROM skill_sources').get()!
      expect(row.kind).toBe('builtin')
    } finally {
      db.close()
    }
  })

  test("the install scope 'loyiha' becomes 'project'", () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      expect(db.query<{ scope: string }, []>('SELECT scope FROM skill_installs').get()?.scope).toBe(
        'project',
      )
      expect(db.query<{ scope: string }, []>('SELECT scope FROM mcp_installs').get()?.scope).toBe(
        'project',
      )
    } finally {
      db.close()
    }
  })

  test("the mcp source kinds 'qolda' and 'standart' become 'manual' and 'builtin'", () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      const kinds = db
        .query<{ id: string; kind: string }, []>('SELECT id, kind FROM mcp_sources ORDER BY id')
        .all()
      expect(kinds.find((k) => k.id === 'mm1')?.kind).toBe('manual')
      expect(kinds.find((k) => k.id === 'mm2')?.kind).toBe('builtin')
    } finally {
      db.close()
    }
  })

  test('the audit levels and results are translated', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      const rows = db
        .query<{ actor: string; level: string; result: string }, []>(
          'SELECT actor, level, result FROM audit_log ORDER BY id',
        )
        .all()

      expect(rows.map((r) => r.level)).toEqual(['read', 'write', 'dangerous', 'write'])
      expect(rows.map((r) => r.result)).toEqual(['OK', 'approved', 'denied', 'pending'])
    } finally {
      db.close()
    }
  })

  test('the tool call statuses are translated', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      const rows = db
        .query<{ id: string; status: string }, []>('SELECT id, status FROM tool_calls ORDER BY id')
        .all()
      expect(rows.map((r) => r.status)).toEqual(['done', 'running', 'error', 'denied'])
    } finally {
      db.close()
    }
  })

  test('the attachment kinds are translated', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      const rows = db
        .query<{ id: string; kind: string }, []>('SELECT id, kind FROM chat_attachments ORDER BY id')
        .all()
      expect(rows.map((r) => r.kind)).toEqual(['image', 'file'])
    } finally {
      db.close()
    }
  })

  // -------------------------------------------------------------------------
  // The new CHECK constraints
  // -------------------------------------------------------------------------

  test('the new CHECK constraints reject the old Uzbek values', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      // Every one of these was legal BEFORE the migration — afterwards the
      // constraint only accepts the English value, so no code path can quietly
      // reintroduce an Uzbek one.
      expect(() =>
        db
          .prepare(
            `INSERT INTO skill_sources (id, kind, url, owner, repo, ref, created_at)
             VALUES ('m9', 'platforma', 'x', 'a', 'b', '', '2026')`,
          )
          .run(),
      ).toThrow()

      expect(() =>
        db
          .prepare(
            `INSERT INTO skill_installs (id, skill_id, scope, project_id, created_at)
             VALUES ('i9', 's1', 'loyiha', 'p1', '2026')`,
          )
          .run(),
      ).toThrow()

      expect(() =>
        db
          .prepare(
            `INSERT INTO mcp_sources (id, kind, source_name, ref, created_at)
             VALUES ('mm9', 'qolda', 'x', '', '2026')`,
          )
          .run(),
      ).toThrow()

      expect(() =>
        db
          .prepare(
            `INSERT INTO mcp_installs (id, server_id, scope, project_id, created_at)
             VALUES ('mi9', 'ms1', 'loyiha', 'p1', '2026')`,
          )
          .run(),
      ).toThrow()

      expect(() =>
        db
          .prepare(
            `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
             VALUES ('10:00', 'x', 'y', 't', 'xavfli', 'OK', '2026')`,
          )
          .run(),
      ).toThrow()

      expect(() =>
        db
          .prepare(
            `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
             VALUES ('10:00', 'x', 'y', 't', 'read', 'rad etildi', '2026')`,
          )
          .run(),
      ).toThrow()
    } finally {
      db.close()
    }
  })

  test('the new English values are accepted', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      expect(() =>
        db
          .prepare(
            `INSERT INTO skill_sources (id, kind, url, owner, repo, ref, created_at)
             VALUES ('m8', 'builtin', 'x', 'a', 'c', '', '2026')`,
          )
          .run(),
      ).not.toThrow()

      expect(() =>
        db
          .prepare(
            `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
             VALUES ('10:00', 'x', 'y', 't', 'dangerous', 'denied', '2026')`,
          )
          .run(),
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  // -------------------------------------------------------------------------
  // The append-only audit triggers
  // -------------------------------------------------------------------------

  test('the append-only triggers are recreated under their English names', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      const triggers = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        .all()
        .map((t) => t.name)

      expect(triggers).toContain('audit_log_no_update')
      expect(triggers).toContain('audit_log_no_delete')
      expect(triggers).not.toContain('audit_log_ozgartirish_taqiq')
      expect(triggers).not.toContain('audit_log_ochirish_taqiq')
    } finally {
      db.close()
    }
  })

  test('the recreated triggers still block UPDATE and DELETE', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      // The whole point of the audit log is that it cannot be rewritten after
      // the fact — a rebuild that silently dropped the triggers would destroy
      // that guarantee while leaving every row intact and every test green.
      expect(() => db.exec("UPDATE audit_log SET actor = 'tampered'")).toThrow()
      expect(() => db.exec('DELETE FROM audit_log')).toThrow()
      expect(db.query('SELECT * FROM audit_log').all()).toHaveLength(4)
    } finally {
      db.close()
    }
  })

  // -------------------------------------------------------------------------
  // Foreign keys after the rebuild
  // -------------------------------------------------------------------------

  test('no foreign key is left dangling after the rebuild', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      // Foreign keys are turned OFF for the whole rebuild block, so a child
      // row could end up pointing at a parent that no longer exists without
      // SQLite ever complaining. This check is what catches that.
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      db.close()
    }
  })

  test('CASCADE from parent to child still works after the rebuild', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)
      db.exec('PRAGMA foreign_keys = ON')

      // skill_sources → skills → skill_installs
      db.prepare("DELETE FROM skill_sources WHERE id = 'm1'").run()
      expect(db.query('SELECT * FROM skills').all()).toHaveLength(0)
      expect(db.query('SELECT * FROM skill_installs').all()).toHaveLength(0)

      // mcp_sources → mcp_servers → mcp_installs
      db.prepare("DELETE FROM mcp_sources WHERE id = 'mm1'").run()
      expect(db.query('SELECT * FROM mcp_servers').all()).toHaveLength(0)
      expect(db.query('SELECT * FROM mcp_installs').all()).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  // -------------------------------------------------------------------------
  // The flat JSON blobs
  // -------------------------------------------------------------------------

  test('mcp_servers.settings has its field keys rewritten', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      const row = db.query<{ settings: string }, []>('SELECT settings FROM mcp_servers').get()!
      const fields = JSON.parse(row.settings) as Record<string, unknown>[]

      expect(fields[0]).toEqual({
        name: 'TOKEN',
        hint: 'API kaliti',
        required: true,
        secret: true,
        default: '',
      })
      // If any Uzbek key survived, the settings form would render an empty
      // field and the user would silently lose their configuration.
      expect(row.settings).not.toContain('"nom"')
      expect(row.settings).not.toContain('"majburiy"')
      expect(row.settings).not.toContain('"maxfiy"')
    } finally {
      db.close()
    }
  })

  test('tool_calls.detail has qisqartirilgan renamed to truncated', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      const row = db
        .query<{ detail: string }, [string]>('SELECT detail FROM tool_calls WHERE id = ?')
        .get('t1')!
      expect(JSON.parse(row.detail)).toEqual({ diff: '+a', truncated: true })
    } finally {
      db.close()
    }
  })

  test('tool_calls.permission has its keys and origin values rewritten', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      const read = db.query<{ permission: string }, [string]>(
        'SELECT permission FROM tool_calls WHERE id = ?',
      )

      // This blob is the audit trail answering "why was this command run?" —
      // losing its shape is worse than losing the row itself.
      expect(JSON.parse(read.get('t1')!.permission)).toEqual({
        requestId: 'r1',
        origin: 'user',
        granted: true,
        pattern: 'git *',
        time: '2026-01-01',
      })
      expect(JSON.parse(read.get('t2')!.permission)).toEqual({
        requestId: 'r2',
        origin: 'auto-block',
        granted: false,
        time: '2026-01-01',
      })
    } finally {
      db.close()
    }
  })

  test('tool_calls.classifier has its keys and verdict values rewritten', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      const read = db.query<{ classifier: string }, [string]>(
        'SELECT classifier FROM tool_calls WHERE id = ?',
      )
      expect(JSON.parse(read.get('t1')!.classifier)).toEqual({
        verdict: 'allow',
        note: 'xavfsiz buyruq',
      })
      expect(JSON.parse(read.get('t2')!.classifier)).toEqual({
        verdict: 'block',
        note: 'xavfli',
      })
    } finally {
      db.close()
    }
  })

  // -------------------------------------------------------------------------
  // Indexes and the runner's own bootstrap path
  // -------------------------------------------------------------------------

  test('the indexes are recreated under their English names', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      const indexes = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((i) => i.name)

      for (const expected of [
        'idx_skill_source_repo',
        'idx_skill_path',
        'idx_skill_install_unique',
        'idx_skill_install_project',
        'idx_mcp_source_name',
        'idx_mcp_server_name',
        'idx_mcp_install_unique',
        'idx_mcp_install_project',
        'idx_tool_calls_message',
        'idx_tool_calls_session',
        'idx_chat_attachments_message',
        'idx_chat_attachments_session',
      ]) {
        expect(indexes).toContain(expected)
      }
      // Indexes do not follow an `ALTER TABLE ... RENAME TO`, so the old names
      // would linger if they had not been dropped explicitly.
      expect(indexes).not.toContain('tool_chaqiruvlar_message')
      expect(indexes).not.toContain('chat_biriktirmalar_session')
    } finally {
      db.close()
    }
  })

  test('the legacy schema_version columns are renamed by the runner', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)

      const columns = db
        .query<{ name: string }, []>('PRAGMA table_info(schema_version)')
        .all()
        .map((c) => c.name)
      expect(columns).toContain('number')
      expect(columns).toContain('name')
      expect(columns).not.toContain('raqam')
      expect(columns).not.toContain('nom')
    } finally {
      db.close()
    }
  })

  test('applying 013 to an already-migrated database is a no-op', () => {
    const db = databaseBefore(13)
    try {
      addUzbekData(db)
      applyMigrations(db)
      const before = db.query('SELECT * FROM audit_log').all().length

      applyMigrations(db)

      expect(db.query('SELECT * FROM audit_log').all()).toHaveLength(before)
      expect(db.query('SELECT * FROM skill_sources').all()).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})

describe('migration 018 — the working title "platforma" becomes "barpo"', () => {
  test('the builtin skill and mcp source identifiers are renamed', () => {
    const db = databaseBefore(18)
    try {
      db.run(
        `INSERT INTO skill_sources (id, kind, url, owner, repo, ref, created_at)
         VALUES ('s1', 'builtin', 'platforma://builtin', 'platforma', 'builtin-skills', '', '2026-01-01')`,
      )
      db.run(
        `INSERT INTO mcp_sources (id, kind, source_name, ref, created_at)
         VALUES ('m1', 'builtin', 'platforma-builtin', '', '2026-01-01')`,
      )

      applyMigrations(db)

      const skill = db
        .query<{ owner: string; url: string }, []>('SELECT owner, url FROM skill_sources')
        .get()!
      expect(skill.owner).toBe('barpo')
      expect(skill.url).toBe('barpo://builtin')

      const mcp = db
        .query<{ source_name: string }, []>('SELECT source_name FROM mcp_sources')
        .get()!
      expect(mcp.source_name).toBe('barpo-builtin')
    } finally {
      db.close()
    }
  })

  test("a user's own github source with the same owner is not touched", () => {
    const db = databaseBefore(18)
    try {
      db.run(
        `INSERT INTO skill_sources (id, kind, url, owner, repo, ref, created_at)
         VALUES ('s2', 'github', 'https://github.com/platforma/x', 'platforma', 'x', '', '2026-01-01')`,
      )

      applyMigrations(db)

      const row = db
        .query<{ owner: string; url: string }, []>('SELECT owner, url FROM skill_sources')
        .get()!
      expect(row.owner).toBe('platforma')
      expect(row.url).toBe('https://github.com/platforma/x')
    } finally {
      db.close()
    }
  })
})
