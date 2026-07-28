// Migratsiya tizimi testlari — har test toza xotira bazasida ishlaydi.

import { describe, expect, test } from 'bun:test'
import { bazaOch, migratsiyalarniQolla, sxemaVersiyasi } from '../src/db.ts'
import { migratsiyalar } from '../src/migrations/index.ts'

describe('migratsiyalar', () => {
  test("toza bazada barcha jadvallar yaratiladi", () => {
    const db = bazaOch(':memory:')
    const jadvallar = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((q) => q.name)

    for (const kutilgan of [
      'schema_version',
      'servers',
      'audit_log',
      'apps',
      'chat_sessions',
      'chat_messages',
      'build_sessions',
      'projects',
      'skill_manbalari',
      'skilllar',
      'skill_ornatish',
    ]) {
      expect(jadvallar).toContain(kutilgan)
    }

    // 006-migratsiya eski mock jadvalini tashlagan bo'lishi kerak
    expect(jadvallar).not.toContain('skills')
    db.close()
  })

  test('sxema versiyasi oxirgi migratsiya raqamiga teng', () => {
    const db = bazaOch(':memory:')
    const oxirgi = Math.max(...migratsiyalar.map((m) => m.raqam))
    expect(sxemaVersiyasi(db)).toBe(oxirgi)
    db.close()
  })

  test('qayta chaqirilganda migratsiya takrorlanmaydi (idempotent)', () => {
    const db = bazaOch(':memory:')
    const oldin = sxemaVersiyasi(db)

    migratsiyalarniQolla(db)
    migratsiyalarniQolla(db)

    expect(sxemaVersiyasi(db)).toBe(oldin)
    const soni = db
      .query<{ soni: number }, []>('SELECT COUNT(*) AS soni FROM schema_version')
      .get()
    expect(soni?.soni).toBe(migratsiyalar.length)
    db.close()
  })

  test('audit_log append-only: UPDATE bloklanadi', () => {
    const db = bazaOch(':memory:')
    db.prepare(
      `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
       VALUES ('10:00', 'test', 'sinov', 'nishon', 'o''qish', 'OK', '2026-07-27T10:00:00.000Z')`,
    ).run()

    expect(() => db.exec("UPDATE audit_log SET actor = 'buzuq'")).toThrow()
    db.close()
  })

  test('audit_log append-only: DELETE bloklanadi', () => {
    const db = bazaOch(':memory:')
    db.prepare(
      `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
       VALUES ('10:00', 'test', 'sinov', 'nishon', 'o''qish', 'OK', '2026-07-27T10:00:00.000Z')`,
    ).run()

    expect(() => db.exec('DELETE FROM audit_log')).toThrow()
    db.close()
  })

  test("noto'g'ri audit darajasi CHECK bilan rad etiladi", () => {
    const db = bazaOch(':memory:')
    expect(() =>
      db
        .prepare(
          `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('10:00', 'test', 'sinov', 'nishon', 'yolgon-daraja', 'OK', '2026-07-27T10:00:00.000Z'),
    ).toThrow()
    db.close()
  })
})
