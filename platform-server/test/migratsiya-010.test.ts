// 010-migratsiya: skill manbasiga `platforma` turi qo'shiladi.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ ENG XAVFLI JOY. Migratsiya jadvalni QAYTA QURADI (SQLite'da `CHECK`  │
// │ ni o'zgartirishning boshqa yo'li yo'q). `skilllar.manba_id` esa unga │
// │ `ON DELETE CASCADE` bilan bog'langan — ya'ni `DROP TABLE` paytida    │
// │ foreign key yoqilgan bo'lsa, foydalanuvchining BUTUN skill katalogi  │
// │ va o'rnatishlari jimgina o'chib ketardi.                             │
// │                                                                      │
// │ Bu testlar aynan shuni majburlaydi: mavjud ma'lumot SAQLANISHI kerak.│
// └──────────────────────────────────────────────────────────────────────┘

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { migratsiyalar } from '../src/migrations/index.ts'
import { migratsiyalarniQolla } from '../src/db.ts'

/** 010 dan OLDINGI holatdagi bazani quradi */
function eskiBaza(): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')

  // 010 dan oldingi migratsiyalarni qo'llaymiz
  db.exec(`
    CREATE TABLE schema_version (
      raqam INTEGER PRIMARY KEY, nom TEXT NOT NULL, applied_at TEXT NOT NULL
    )
  `)
  const yozish = db.prepare('INSERT INTO schema_version VALUES (?, ?, ?)')
  for (const m of migratsiyalar.filter((x) => x.raqam < 10).sort((a, b) => a.raqam - b.raqam)) {
    db.exec(m.sql)
    yozish.run(m.raqam, m.nom, '2026-01-01T00:00:00.000Z')
  }
  return db
}

/** Manba + skill + o'rnatish yozuvlarini qo'shadi */
function malumotQosh(db: Database) {
  db.prepare(
    `INSERT INTO skill_manbalari (id, tur, url, owner, repo, ref, commit_sha, oxirgi_sinxron, created_at)
     VALUES ('m1', 'github', 'https://github.com/a/b', 'a', 'b', 'main', 'sha1', '2026-01-01', '2026-01-01')`,
  ).run()
  db.prepare(
    `INSERT INTO skilllar (id, manba_id, yol, nom, tavsif, litsenziya, allowed_tools, ogohlantirishlar)
     VALUES ('s1', 'm1', 'x/SKILL.md', 'x-skill', 'tavsif', NULL, NULL, '[]')`,
  ).run()
  db.prepare(
    `INSERT INTO skill_ornatish (skill_id, qamrov, project_id, created_at)
     VALUES ('s1', 'global', NULL, '2026-01-01T00:00:00.000Z')`,
  ).run()
}

describe('010-standart-manba migratsiyasi', () => {
  test("mavjud manba, skill va O'RNATISHLAR saqlanadi", () => {
    const db = eskiBaza()
    try {
      malumotQosh(db)
      migratsiyalarniQolla(db)

      // Uchala jadval ham buzilmasligi SHART — CASCADE tuzog'i shu yerda
      expect(db.query('SELECT * FROM skill_manbalari').all()).toHaveLength(1)
      expect(db.query('SELECT * FROM skilllar').all()).toHaveLength(1)
      expect(db.query('SELECT * FROM skill_ornatish').all()).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  test('manba maydonlari o\'zgarmaydi', () => {
    const db = eskiBaza()
    try {
      malumotQosh(db)
      migratsiyalarniQolla(db)

      const m = db.query<Record<string, unknown>, []>('SELECT * FROM skill_manbalari').get()!
      expect(m.id).toBe('m1')
      expect(m.tur).toBe('github')
      expect(m.owner).toBe('a')
      expect(m.commit_sha).toBe('sha1')
    } finally {
      db.close()
    }
  })

  test("'platforma' turi endi QABUL QILINADI", () => {
    const db = eskiBaza()
    try {
      migratsiyalarniQolla(db)
      expect(() =>
        db
          .prepare(
            `INSERT INTO skill_manbalari (id, tur, url, owner, repo, ref, created_at)
             VALUES ('m2', 'platforma', 'platforma://standart', 'platforma', 'std', '', '2026')`,
          )
          .run(),
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  test('notanish tur HALI HAM rad etiladi', () => {
    const db = eskiBaza()
    try {
      migratsiyalarniQolla(db)
      // CHECK cheklovi yo'qolib ketmasligi kerak — faqat kengaygan
      expect(() =>
        db
          .prepare(
            `INSERT INTO skill_manbalari (id, tur, url, owner, repo, ref, created_at)
             VALUES ('m3', 'gitlab', 'x', 'a', 'b', '', '2026')`,
          )
          .run(),
      ).toThrow()
    } finally {
      db.close()
    }
  })

  test('takrorlanish indeksi qayta yaratilgan', () => {
    const db = eskiBaza()
    try {
      migratsiyalarniQolla(db)
      db.prepare(
        `INSERT INTO skill_manbalari (id, tur, url, owner, repo, ref, created_at)
         VALUES ('m4', 'github', 'x', 'a', 'b', 'main', '2026')`,
      ).run()
      // Bir xil owner+repo+ref ikkinchi marta tushmasligi kerak
      expect(() =>
        db
          .prepare(
            `INSERT INTO skill_manbalari (id, tur, url, owner, repo, ref, created_at)
             VALUES ('m5', 'github', 'x', 'a', 'b', 'main', '2026')`,
          )
          .run(),
      ).toThrow()
    } finally {
      db.close()
    }
  })

  test('foreign key CASCADE migratsiyadan keyin ham ishlaydi', () => {
    const db = eskiBaza()
    try {
      malumotQosh(db)
      migratsiyalarniQolla(db)

      // Manba o'chirilsa skill ham ketishi kerak — bog'liqlik tiklangan
      db.exec('PRAGMA foreign_keys = ON')
      db.prepare("DELETE FROM skill_manbalari WHERE id = 'm1'").run()
      expect(db.query('SELECT * FROM skilllar').all()).toHaveLength(0)
    } finally {
      db.close()
    }
  })
})
