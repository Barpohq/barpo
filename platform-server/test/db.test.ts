// Migration system tests — every test runs on a clean in-memory database.

import { describe, expect, test } from 'bun:test'
import { openDb, applyMigrations, schemaVersion } from '../src/db.ts'
import { migrations } from '../src/migrations/index.ts'

describe('migrations', () => {
  test('a clean database gets every table created', () => {
    const db = openDb(':memory:')
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((q) => q.name)

    for (const expected of [
      'schema_version',
      'servers',
      'audit_log',
      'apps',
      'chat_sessions',
      'chat_messages',
      'build_sessions',
      'projects',
      'skill_sources',
      'skills',
      'skill_installs',
    ]) {
      expect(tables).toContain(expected)
    }

    db.close()
  })

  test('the schema version equals the highest migration number', () => {
    const db = openDb(':memory:')
    const highest = Math.max(...migrations.map((m) => m.number))
    expect(schemaVersion(db)).toBe(highest)
    db.close()
  })

  test('applying the migrations again changes nothing (idempotent)', () => {
    const db = openDb(':memory:')
    const before = schemaVersion(db)

    applyMigrations(db)
    applyMigrations(db)

    expect(schemaVersion(db)).toBe(before)
    const row = db
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM schema_version')
      .get()
    expect(row?.count).toBe(migrations.length)
    db.close()
  })

  test('audit_log is append-only: UPDATE is blocked', () => {
    const db = openDb(':memory:')
    db.prepare(
      `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
       VALUES ('10:00', 'test', 'trial', 'target', 'read', 'OK', '2026-07-27T10:00:00.000Z')`,
    ).run()

    expect(() => db.exec("UPDATE audit_log SET actor = 'tampered'")).toThrow()
    db.close()
  })

  test('audit_log is append-only: DELETE is blocked', () => {
    const db = openDb(':memory:')
    db.prepare(
      `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
       VALUES ('10:00', 'test', 'trial', 'target', 'read', 'OK', '2026-07-27T10:00:00.000Z')`,
    ).run()

    expect(() => db.exec('DELETE FROM audit_log')).toThrow()
    db.close()
  })

  test('an unknown audit level is rejected by the CHECK constraint', () => {
    const db = openDb(':memory:')
    expect(() =>
      db
        .prepare(
          `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('10:00', 'test', 'trial', 'target', 'bogus-level', 'OK', '2026-07-27T10:00:00.000Z'),
    ).toThrow()
    db.close()
  })
})
