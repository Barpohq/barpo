// Orchestrator loyihaga ulangan sessiya uchun QAYSI papkani beradi.
//
// `loyihalar.test.ts` `sessiyaIshPapkasi` funksiyasini alohida sinaydi; bu
// yerda esa TO'LIQ ZANJIR tekshiriladi:
//   sessiya (project_id bilan) → repo → orchestrator → agentOqimi sozlamasi
//
// Nega alohida fayl: `orchestrator.test.ts` dagi `mock.module` global va
// mavjud testni o'zgartirish taqiqlangan. Shu naqsh takrorlanadi.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Oqim funksiyasi qanday sozlama bilan chaqirilgani */
let songgiSozlama: { ishPapkasi?: string; sessionId?: string } | null = null

// DIQQAT: mock.module butun modulni almashtiradi — haqiqiy eksportlarni
// saqlab, faqat kerakligini ustidan yozamiz (orchestrator.test.ts dagi
// izohga q.).
const haqiqiyAi = await import('@platforma/ai')
const haqiqiyRuxsatBoshqaruvchisi = haqiqiyAi.ruxsatBoshqaruvchisi
const kuzatuvQoshilgan = new WeakSet<object>()

function radEtuvchiRuxsat(sessionId: string) {
  const b = haqiqiyRuxsatBoshqaruvchisi(sessionId)
  if (!kuzatuvQoshilgan.has(b)) {
    kuzatuvQoshilgan.add(b)
    b.kuzat((s) => b.javobBer(s.id, 'rad'))
  }
  return b
}

mock.module('@platforma/ai', () => ({
  ...haqiqiyAi,
  agentOqimi: async function* (_tanlov: unknown, _xabarlar: unknown, sozlama: unknown) {
    songgiSozlama = sozlama as { ishPapkasi?: string; sessionId?: string }
    yield { tur: 'tugadi', matn: 'ok', sarflov: { input: 0, output: 0, cost: 0 } }
  },
  ruxsatBoshqaruvchisi: radEtuvchiRuxsat,
}))

const { bazaOch, dbOrnat } = await import('../src/db.ts')
const { javobOqizi } = await import('../src/orchestrator.ts')
const { loyihaPapkasiniYarat } = await import('../src/ish-papkasi.ts')
const { loyihaYarat, sessiyaYarat } = await import('../src/repo.ts')
const { hub } = await import('../src/ws/hub.ts')

let db: Database
let vaqtinchalik: string

const tanlov = { provider: 'ollama', model: 'qwen3:0.6b' }

beforeEach(() => {
  vaqtinchalik = mkdtempSync(join(tmpdir(), 'loyiha-papka-'))
  process.env.PLATFORMA_ISHLAR = join(vaqtinchalik, 'ishlar')
  process.env.PLATFORMA_LOYIHALAR = join(vaqtinchalik, 'loyihalar')

  db = bazaOch(':memory:')
  dbOrnat(db)
  songgiSozlama = null
})

afterEach(() => {
  delete process.env.PLATFORMA_ISHLAR
  delete process.env.PLATFORMA_LOYIHALAR
  rmSync(vaqtinchalik, { recursive: true, force: true })
  dbOrnat(null)
  hub.tozala()
  db.close()
})

describe('javobOqizi — loyiha papkasi', () => {
  test('loyihasiz sessiya o\'z sessiya papkasida ishlaydi', async () => {
    const s = sessiyaYarat('loyihasiz', db)
    await javobOqizi(s.id, 'x1', tanlov)

    expect(songgiSozlama?.ishPapkasi).toContain(join(vaqtinchalik, 'ishlar'))
    expect(songgiSozlama?.ishPapkasi).toContain(s.id)
  })

  test('loyihali sessiya LOYIHA papkasida ishlaydi', async () => {
    const papka = loyihaPapkasiniYarat('bot')
    const l = loyihaYarat('bot', papka, db)
    const s = sessiyaYarat('ulangan', db, l.id)

    await javobOqizi(s.id, 'x2', tanlov)

    expect(songgiSozlama?.ishPapkasi).toBe(papka)
    // Sessiya id'si papka yo'lida umuman qatnashmaydi
    expect(songgiSozlama?.ishPapkasi).not.toContain(s.id)
    expect(songgiSozlama?.sessionId).toBe(s.id)
  })

  test('bir loyihaning IKKI sessiyasi bitta papkani oladi', async () => {
    const papka = loyihaPapkasiniYarat('umumiy')
    const l = loyihaYarat('umumiy', papka, db)
    const bir = sessiyaYarat('chat 1', db, l.id)
    const ikki = sessiyaYarat('chat 2', db, l.id)

    await javobOqizi(bir.id, 'x3', tanlov)
    const birinchiPapka = songgiSozlama?.ishPapkasi

    await javobOqizi(ikki.id, 'x4', tanlov)
    const ikkinchiPapka = songgiSozlama?.ishPapkasi

    expect(birinchiPapka).toBe(papka)
    expect(ikkinchiPapka).toBe(papka)
  })

  test('ikki xil loyiha ikki xil papkada ishlaydi (izolyatsiya)', async () => {
    const birL = loyihaYarat('bir', loyihaPapkasiniYarat('bir'), db)
    const ikkiL = loyihaYarat('ikki', loyihaPapkasiniYarat('ikki'), db)

    await javobOqizi(sessiyaYarat('a', db, birL.id).id, 'x5', tanlov)
    const birPapka = songgiSozlama?.ishPapkasi

    await javobOqizi(sessiyaYarat('b', db, ikkiL.id).id, 'x6', tanlov)

    expect(birPapka).not.toBe(songgiSozlama?.ishPapkasi)
  })

  test('loyiha papkasi qo\'lda o\'chirilgan bo\'lsa qayta yaratiladi', async () => {
    const papka = loyihaPapkasiniYarat('ochirilgan')
    const l = loyihaYarat('ochirilgan', papka, db)
    const s = sessiyaYarat('chat', db, l.id)

    rmSync(papka, { recursive: true, force: true })
    await javobOqizi(s.id, 'x7', tanlov)

    expect(songgiSozlama?.ishPapkasi).toBe(papka)
    expect(existsSync(papka)).toBe(true)
  })
})
