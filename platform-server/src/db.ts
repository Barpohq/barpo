// SQLite ulanishi va migratsiya tizimi.
//
// WAL rejimi yoqilgan: o'qish yozishni bloklamaydi — WS orqali oqim ketayotganda
// REST so'rovlari kutib qolmaydi. Baza fayli `platform-server/data/platform.db`,
// papka runtime'da yaratiladi (git'ga tushmaydi).

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { migratsiyalar } from './migrations/index.ts'

/** Standart baza yo'li — paket ildizidagi data/ papkasi */
export const DEFAULT_DB_YOLI = resolve(import.meta.dir, '..', 'data', 'platform.db')

/**
 * Bazani ochadi, WAL yoqadi va kutilayotgan migratsiyalarni qo'llaydi.
 * `:memory:` yo'li testlar uchun — papka yaratilmaydi.
 */
export function bazaOch(yol: string = DEFAULT_DB_YOLI): Database {
  if (yol !== ':memory:') {
    mkdirSync(dirname(yol), { recursive: true })
  }

  const db = new Database(yol, { create: true })

  // WAL — parallel o'qish uchun. Xotiradagi baza WAL'ni qo'llab-quvvatlamaydi.
  if (yol !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
  }
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')

  migratsiyalarniQolla(db)
  return db
}

/**
 * `schema_version` jadvaliga qarab qo'llanmagan migratsiyalarni ketma-ket
 * bajaradi. Har migratsiya o'z tranzaksiyasida — yarim qo'llangan holat bo'lmaydi.
 */
export function migratsiyalarniQolla(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      raqam      INTEGER PRIMARY KEY,
      nom        TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)

  const qollangan = new Set(
    db
      .query<{ raqam: number }, []>('SELECT raqam FROM schema_version')
      .all()
      .map((q) => q.raqam),
  )

  const yozish = db.prepare('INSERT INTO schema_version (raqam, nom, applied_at) VALUES (?, ?, ?)')

  for (const m of [...migratsiyalar].sort((a, b) => a.raqam - b.raqam)) {
    if (qollangan.has(m.raqam)) continue

    if (m.pragmaTashqarida) {
      // ┌──────────────────────────────────────────────────────────────┐
      // │ TRANZAKSIYASIZ YO'L — faqat jadval qayta quradigan           │
      // │ migratsiyalar uchun.                                          │
      // │                                                               │
      // │ SQLite'da `CHECK` cheklovini o'zgartirishning yagona yo'li —  │
      // │ jadvalni qayta qurish. Bunda `PRAGMA foreign_keys = OFF`      │
      // │ kerak (aks holda `DROP TABLE` bog'langan qatorlarni CASCADE   │
      // │ bilan o'chirib yuboradi), lekin PRAGMA tranzaksiya ichida     │
      // │ JIMGINA E'TIBORSIZ qoldiriladi.                               │
      // │                                                               │
      // │ Shuning uchun bunday migratsiya o'z BEGIN/COMMIT ini SQL      │
      // │ ichida olib yuradi va bu yerda tranzaksiyaga o'ralmaydi.      │
      // │ Xavfsizlik shundaki, `BEGIN`/`COMMIT` baribir bor — atomiklik │
      // │ saqlanadi, faqat PRAGMA'lar undan tashqarida turadi.          │
      // └──────────────────────────────────────────────────────────────┘
      db.exec(m.sql)
      yozish.run(m.raqam, m.nom, new Date().toISOString())
      continue
    }

    const bajar = db.transaction(() => {
      db.exec(m.sql)
      yozish.run(m.raqam, m.nom, new Date().toISOString())
    })
    bajar()
  }
}

/** Hozirgi sxema versiyasi (hech qanday migratsiya qo'llanmagan bo'lsa 0) */
export function sxemaVersiyasi(db: Database): number {
  const qator = db
    .query<{ v: number | null }, []>('SELECT MAX(raqam) AS v FROM schema_version')
    .get()
  return qator?.v ?? 0
}

// ---------------------------------------------------------------------------
// Jarayon davomida yashaydigan yagona ulanish (singleton).
// Testlar o'z bazasini `bazaOch(':memory:')` bilan mustaqil ochadi.
// ---------------------------------------------------------------------------

let _db: Database | null = null

export function db(): Database {
  if (!_db) _db = bazaOch(process.env.DB_YOLI ?? DEFAULT_DB_YOLI)
  return _db
}

/** Testlarda global ulanishni almashtirish uchun */
export function dbOrnat(baza: Database | null): void {
  _db = baza
}
