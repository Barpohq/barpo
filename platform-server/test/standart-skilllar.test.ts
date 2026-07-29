// Standart skilllar — platforma bilan birga keladigan skilllar.
//
// Ular ODDIY SKILLLAR KABI ishlaydi: katalogdan o'tadi, "Skill do'koni" da
// ko'rinadi, foydalanuvchi o'rnatadi. Yagona farq — manba GitHub emas,
// repo ichidagi `skills/` papkasi.
//
// Testlar shuni majburlaydi: repo GitHub'ga ko'chganda katalog, o'rnatish
// va UI oqimlari o'zgarmasligi kerak.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bazaOch } from '../src/db.ts'
import { manbalarOqi, manbaYarat, skilllarniSinxronla, skilllarOqi } from '../src/repo.ts'
import {
  STANDART_MANBA_URL,
  standartlarniSkanerla,
  standartManbaniTaminla,
  standartniOmborga,
} from '../src/standart-skilllar.ts'

let db: Database

beforeEach(() => {
  db = bazaOch(':memory:')
})

afterEach(() => {
  db.close()
})

/** `standartManbaniTaminla` ni sinov bazasi bilan chaqiradi */
function taminla() {
  return standartManbaniTaminla(
    (m) => manbaYarat(m, db),
    (manbaId, topilgan, sha) => skilllarniSinxronla(manbaId, topilgan, sha, db),
  )
}

describe('standartlarniSkanerla', () => {
  test('repo ichidagi skilllar topiladi', () => {
    const n = standartlarniSkanerla()
    const nomlar = n.skilllar.map((s) => s.nom)
    expect(nomlar).toContain('dashboard-yaratish')
    expect(nomlar).toContain('dashboard-jsx')
  })

  test('tavsif majburiy va bo\'sh emas — promptga shu tushadi', () => {
    for (const s of standartlarniSkanerla().skilllar) {
      expect(s.tavsif.length).toBeGreaterThan(20)
    }
  })

  test('yo\'l GitHub varianti bilan bir xil shaklda', () => {
    // Repo GitHub'ga ko'chganda yo'llar mos tushishi kerak, aks holda
    // katalogdagi yozuvlar (demak o'rnatishlar ham) yo'qolardi.
    for (const s of standartlarniSkanerla().skilllar) {
      expect(s.yol).toMatch(/^[a-z0-9-]+\/SKILL\.md$/)
    }
  })
})

describe('standartManbaniTaminla — katalogga yozish', () => {
  test('manba va skilllar katalogga tushadi', () => {
    const n = taminla()
    expect(n).not.toBeNull()
    expect(n!.soni).toBeGreaterThan(0)

    const manbalar = manbalarOqi(db)
    expect(manbalar).toHaveLength(1)
    expect(manbalar[0]!.tur).toBe('platforma')
    expect(manbalar[0]!.url).toBe(STANDART_MANBA_URL)

    const nomlar = skilllarOqi(db).map((s) => s.nom)
    expect(nomlar).toContain('dashboard-yaratish')
    expect(nomlar).toContain('dashboard-jsx')
  })

  test('takroriy chaqiruv DUBLIKAT yaratmaydi', () => {
    // Har ishga tushishda chaqiriladi — idempotent bo'lishi shart
    taminla()
    const birinchi = skilllarOqi(db).length
    taminla()
    taminla()

    expect(manbalarOqi(db)).toHaveLength(1)
    expect(skilllarOqi(db)).toHaveLength(birinchi)
  })

  test('skilllar o\'rnatilmagan holatda keladi', () => {
    // Foydalanuvchi O'ZI o'rnatishi kerak — majburan yoqilmaydi
    taminla()
    for (const s of skilllarOqi(db)) {
      expect(s.ornatilgan).toEqual([])
    }
  })
})

describe('standartniOmborga — o\'rnatish', () => {
  test('skill papkasi ombor ga nusxalanadi', () => {
    const papka = mkdtempSync(join(tmpdir(), 'ombor-'))
    try {
      const nishon = join(papka, 'skill')
      expect(standartniOmborga('dashboard-jsx/SKILL.md', nishon)).toBe(true)
      expect(existsSync(join(nishon, 'SKILL.md'))).toBe(true)
    } finally {
      rmSync(papka, { recursive: true, force: true })
    }
  })

  test('yo\'q skill uchun false qaytadi, xato TASHLAMAYDI', () => {
    const papka = mkdtempSync(join(tmpdir(), 'ombor-'))
    try {
      expect(standartniOmborga('yoq-skill/SKILL.md', join(papka, 'x'))).toBe(false)
    } finally {
      rmSync(papka, { recursive: true, force: true })
    }
  })
})
