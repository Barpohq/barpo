// Orchestrator: LLM oqimi → WS eventlari → DB.
//
// Haqiqiy LLM chaqirilmaydi — @platforma/ai moduli soxta oqim bilan
// almashtiriladi (mock.module import'lardan OLDIN bajarilishi shart, shuning
// uchun u fayl boshida turadi).
//
// `javobOqizi` standart holatda `agentOqimi` ni (tool'lar bilan) ishlatadi,
// `{ toollar: false }` bilan esa `suhbatOqimi` ni. Ikkalasi ham mock qilinadi.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerEvent } from '@platforma/shared'

/** Keyingi chaqiruvda qaytariladigan soxta hodisalar */
let soxtaHodisalar: unknown[] = []
/** Oqim funksiyasi qanday argumentlar bilan chaqirilgani */
let songgiChaqiruv: { tanlov: unknown; xabarlar: unknown; sozlama?: unknown } | null = null

// DIQQAT: mock.module butun modulni almashtiradi, shuning uchun haqiqiy
// eksportlarni saqlab qolamiz va faqat kerakligini ustidan yozamiz. Aks holda
// `modellarniAniqla` kabi eksportlar yo'qoladi va bu mock global bo'lgani
// uchun boshqa test fayllari ham (masalan platform-ai/test/ruxsat.test.ts)
// to'liqsiz obyektlarni olib yiqiladi.
const haqiqiyAi = await import('@platforma/ai')

/**
 * Ruxsat boshqaruvchisi — HAQIQIY reestrdan, ustiga har so'rovni darhol rad
 * etadigan kuzatuvchi qo'shiladi.
 *
 * Nega mock qilinmaydi: bu mock.module global, shuning uchun u
 * platform-ai/test/ruxsat.test.ts ga ham oqib boradi. O'z reestrimizni yozsak,
 * u yerdagi `ruxsatBoshqaruvchisiniYop` / `ruxsatlarniTozala` bilan
 * sinxronlanmay qoladi. Haqiqiy reestr ikkala faylda ham to'g'ri ishlaydi.
 */
// Referensni mockdan OLDIN ushlab olamiz — `haqiqiyAi.ruxsatBoshqaruvchisi`
// orqali chaqirsak, mock qo'llangach namespace yangilanib, funksiya o'zini
// cheksiz chaqiradi.
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
  suhbatOqimi: async function* (tanlov: unknown, xabarlar: unknown, sozlama: unknown) {
    songgiChaqiruv = { tanlov, xabarlar, sozlama }
    for (const h of soxtaHodisalar) yield h
  },
  agentOqimi: async function* (tanlov: unknown, xabarlar: unknown, sozlama: unknown) {
    songgiChaqiruv = { tanlov, xabarlar, sozlama }
    for (const h of soxtaHodisalar) yield h
  },
  ruxsatBoshqaruvchisi: radEtuvchiRuxsat,
}))

const { bazaOch, dbOrnat } = await import('../src/db.ts')
const { javobOqizi, oqimBormi } = await import('../src/orchestrator.ts')
const { sessiyaYarat, xabarlarOqi, xabarYoz } = await import('../src/repo.ts')
const { hub } = await import('../src/ws/hub.ts')

let db: Database
let olingan: ServerEvent[]
let ishlarPapkasi: string

/** Chat kanaliga obuna bo'lgan soxta WS ulanishi */
function soxtaWs() {
  const yigilgan: ServerEvent[] = []
  const ws = {
    data: { id: 'soxta', channels: new Set(['chat', 'audit']) },
    send: (m: string) => yigilgan.push(JSON.parse(m) as ServerEvent),
  }
  return { ws: ws as never, yigilgan }
}

beforeEach(() => {
  // Ish papkalari uy katalogida emas, vaqtinchalik joyda yaratilsin
  ishlarPapkasi = mkdtempSync(join(tmpdir(), 'orch-ishlar-'))
  process.env.PLATFORMA_ISHLAR = ishlarPapkasi

  db = bazaOch(':memory:')
  dbOrnat(db)
  const soxta = soxtaWs()
  olingan = soxta.yigilgan
  hub.ulandi(soxta.ws)
  olingan.length = 0 // `hello` eventini tashlab yuboramiz
  soxtaHodisalar = []
  songgiChaqiruv = null
})

afterEach(() => {
  delete process.env.PLATFORMA_ISHLAR
  rmSync(ishlarPapkasi, { recursive: true, force: true })
  dbOrnat(null)
  hub.tozala()
  db.close()
})

const tanlov = { provider: 'ollama', model: 'qwen3:0.6b' }

function chatEventlari(): ServerEvent[] {
  return olingan.filter((e) => e.type.startsWith('chat.'))
}

describe('javobOqizi — muvaffaqiyatli oqim', () => {
  test('delta eventlari ketma-ket keladi, oxirida done', async () => {
    soxtaHodisalar = [
      { tur: 'delta', matn: 'Sa' },
      { tur: 'delta', matn: 'lom' },
      { tur: 'tugadi', matn: 'Salom', sarflov: { input: 10, output: 5, cost: 0 } },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'xabar-1', tanlov)

    const eventlar = chatEventlari()
    expect(eventlar.map((e) => e.type)).toEqual(['chat.delta', 'chat.delta', 'chat.done'])

    const deltalar = eventlar.filter((e) => e.type === 'chat.delta')
    expect(deltalar.map((e) => (e as { delta: string }).delta).join('')).toBe('Salom')

    const done = eventlar.at(-1) as { usage?: { input: number; output: number } }
    expect(done.usage?.input).toBe(10)
    expect(done.usage?.output).toBe(5)
  })

  test('javob DB ga bir marta, to\'liq holda yoziladi', async () => {
    soxtaHodisalar = [
      { tur: 'delta', matn: 'Bir' },
      { tur: 'delta', matn: ' ikki' },
      { tur: 'tugadi', matn: 'Bir ikki', sarflov: { input: 1, output: 2, cost: 0 } },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'xabar-2', tanlov)

    const xabarlar = xabarlarOqi(s.id, db)
    expect(xabarlar).toHaveLength(1)
    expect(xabarlar[0]?.id).toBe('xabar-2')
    expect(xabarlar[0]?.role).toBe('assistant')
    expect(xabarlar[0]?.text).toBe('Bir ikki')
  })

  test('sessiya tarixi LLM ga uzatiladi', async () => {
    soxtaHodisalar = [{ tur: 'tugadi', matn: 'ok', sarflov: { input: 0, output: 0, cost: 0 } }]

    const s = sessiyaYarat('sinov', db)
    xabarYoz({ sessionId: s.id, role: 'user', text: 'birinchi savol' }, db)
    xabarYoz({ sessionId: s.id, role: 'assistant', text: 'birinchi javob' }, db)
    xabarYoz({ sessionId: s.id, role: 'user', text: 'ikkinchi savol' }, db)

    await javobOqizi(s.id, 'xabar-3', tanlov)

    expect(songgiChaqiruv?.tanlov).toEqual(tanlov)
    expect(songgiChaqiruv?.xabarlar).toEqual([
      { role: 'user', text: 'birinchi savol' },
      { role: 'assistant', text: 'birinchi javob' },
      { role: 'user', text: 'ikkinchi savol' },
    ])
  })

  test('bo\'sh matnli xabarlar tarixdan chiqarib tashlanadi', async () => {
    soxtaHodisalar = [{ tur: 'tugadi', matn: 'ok', sarflov: { input: 0, output: 0, cost: 0 } }]

    const s = sessiyaYarat('sinov', db)
    xabarYoz({ sessionId: s.id, role: 'user', text: 'savol' }, db)
    xabarYoz({ sessionId: s.id, role: 'assistant', text: '   ' }, db)

    await javobOqizi(s.id, 'xabar-4', tanlov)
    expect(songgiChaqiruv?.xabarlar).toEqual([{ role: 'user', text: 'savol' }])
  })
})

describe('javobOqizi — xato holatlari', () => {
  test('xato bo\'lsa chat.error keladi, chat.done kelmaydi', async () => {
    soxtaHodisalar = [{ tur: 'xato', xabar: 'Kalit yaroqsiz' }]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'xabar-5', tanlov)

    const turlari = chatEventlari().map((e) => e.type)
    expect(turlari).toContain('chat.error')
    expect(turlari).not.toContain('chat.done')

    const xatoEvent = chatEventlari().find((e) => e.type === 'chat.error') as { error: string }
    expect(xatoEvent.error).toBe('Kalit yaroqsiz')
  })

  test('yarim kelgan matn xato belgisi bilan saqlanadi', async () => {
    soxtaHodisalar = [
      { tur: 'delta', matn: 'Yarim ' },
      { tur: 'xato', xabar: 'ulanish uzildi' },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'xabar-6', tanlov)

    const xabarlar = xabarlarOqi(s.id, db)
    expect(xabarlar).toHaveLength(1)
    expect(xabarlar[0]?.text).toContain('Yarim')
    expect(xabarlar[0]?.text).toContain('ulanish uzildi')
  })

  test('hech narsa kelmasdan xato — sabab saqlanadi', async () => {
    soxtaHodisalar = [{ tur: 'xato', xabar: 'Model topilmadi' }]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'xabar-7', tanlov)

    const xabarlar = xabarlarOqi(s.id, db)
    expect(xabarlar[0]?.text).toContain('Model topilmadi')
  })

  test('natija obyektida xato qaytadi', async () => {
    soxtaHodisalar = [{ tur: 'xato', xabar: 'nimadir' }]
    const s = sessiyaYarat('sinov', db)
    const natija = await javobOqizi(s.id, 'xabar-8', tanlov)
    expect(natija.xato).toBe('nimadir')
    expect(natija.messageId).toBe('xabar-8')
  })
})

describe('oqim holati', () => {
  test('tugagach oqim ro\'yxatdan chiqadi', async () => {
    soxtaHodisalar = [{ tur: 'tugadi', matn: 'ok', sarflov: { input: 0, output: 0, cost: 0 } }]
    const s = sessiyaYarat('sinov', db)

    expect(oqimBormi(s.id)).toBe(false)
    await javobOqizi(s.id, 'xabar-9', tanlov)
    expect(oqimBormi(s.id)).toBe(false)
  })
})

describe('tool oqimi', () => {
  test('tool boshlanishi va tugashi chat.tool bo\'lib ketadi', async () => {
    soxtaHodisalar = [
      { tur: 'tool_boshlandi', id: 't1', nom: 'read', args: 'a.txt' },
      { tur: 'tool_tugadi', id: 't1', natija: 'salom', xatomi: false },
      { tur: 'delta', matn: 'Faylda: salom' },
      { tur: 'tugadi', matn: 'Faylda: salom', sarflov: { input: 5, output: 3, cost: 0 } },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-tool', tanlov)

    const toolEventlari = olingan.filter((e) => e.type === 'chat.tool') as {
      tool: { id: string; nom: string; holat: string; natija?: string }
    }[]
    expect(toolEventlari).toHaveLength(2)
    expect(toolEventlari[0]?.tool.holat).toBe('ishlamoqda')
    expect(toolEventlari[0]?.tool.nom).toBe('read')
    expect(toolEventlari[1]?.tool.holat).toBe('tugadi')
    expect(toolEventlari[1]?.tool.natija).toBe('salom')
    // Argumentlar ikkinchi eventda ham saqlanadi
    expect(toolEventlari[1]?.tool.nom).toBe('read')
  })

  test('tool kartalari xabar bilan birga saqlanadi', async () => {
    soxtaHodisalar = [
      { tur: 'tool_boshlandi', id: 't1', nom: 'write', args: 'b.txt' },
      { tur: 'tool_tugadi', id: 't1', natija: 'yozildi', xatomi: false },
      { tur: 'tugadi', matn: 'Tayyor', sarflov: { input: 1, output: 1, cost: 0 } },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-saqlash', tanlov)

    const xabarlar = xabarlarOqi(s.id, db)
    expect(xabarlar).toHaveLength(1)
    expect(xabarlar[0]?.toolCards).toHaveLength(1)
    expect(xabarlar[0]?.toolCards?.[0]?.nom).toBe('write')
    expect(xabarlar[0]?.toolCards?.[0]?.holat).toBe('tugadi')
  })

  test('ruxsat berilmagani alohida holat sifatida belgilanadi', async () => {
    soxtaHodisalar = [
      { tur: 'tool_boshlandi', id: 't1', nom: 'bash', args: 'rm -rf x' },
      { tur: 'tool_tugadi', id: 't1', natija: 'Ruxsat berilmadi: `rm`', xatomi: true },
      { tur: 'tugadi', matn: '', sarflov: { input: 0, output: 0, cost: 0 } },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-rad', tanlov)

    const oxirgi = (olingan.filter((e) => e.type === 'chat.tool').at(-1) as { tool: { holat: string } })
      .tool
    expect(oxirgi.holat).toBe('rad etildi')
  })

  test('oddiy tool xatosi "xato" holatini oladi', async () => {
    soxtaHodisalar = [
      { tur: 'tool_boshlandi', id: 't1', nom: 'read', args: 'yoq.txt' },
      { tur: 'tool_tugadi', id: 't1', natija: 'ENOENT: fayl topilmadi', xatomi: true },
      { tur: 'tugadi', matn: '', sarflov: { input: 0, output: 0, cost: 0 } },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-xato', tanlov)

    const oxirgi = (olingan.filter((e) => e.type === 'chat.tool').at(-1) as { tool: { holat: string } })
      .tool
    expect(oxirgi.holat).toBe('xato')
  })

  test('ruxsat so\'rovi chat.permission bo\'lib ketadi', async () => {
    const sorov = {
      id: 'r1',
      sessionId: 's',
      tur: 'buyruq' as const,
      amal: 'bash',
      nishon: 'rm -rf x',
      sabab: 'xavfli',
      naqsh: 'rm',
      vaqt: new Date().toISOString(),
    }
    soxtaHodisalar = [
      { tur: 'ruxsat_kerak', sorov },
      { tur: 'tugadi', matn: 'ok', sarflov: { input: 0, output: 0, cost: 0 } },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-ruxsat', tanlov)

    const ruxsatEvent = olingan.find((e) => e.type === 'chat.permission') as { sorov: { id: string } }
    expect(ruxsatEvent?.sorov.id).toBe('r1')
  })

  test('toollar: false bo\'lsa oddiy suhbat oqimi ishlatiladi', async () => {
    soxtaHodisalar = [{ tur: 'tugadi', matn: 'ok', sarflov: { input: 0, output: 0, cost: 0 } }]
    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-toolsiz', tanlov, { toollar: false })

    // suhbatOqimi sozlamasida ishPapkasi bo'lmaydi
    expect((songgiChaqiruv?.sozlama as { ishPapkasi?: string })?.ishPapkasi).toBeUndefined()
  })

  test('tool bilan ishlaganda ish papkasi beriladi', async () => {
    soxtaHodisalar = [{ tur: 'tugadi', matn: 'ok', sarflov: { input: 0, output: 0, cost: 0 } }]
    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-papka', tanlov)

    const sozlama = songgiChaqiruv?.sozlama as { ishPapkasi?: string; sessionId?: string }
    expect(sozlama?.ishPapkasi).toBeTruthy()
    expect(sozlama?.sessionId).toBe(s.id)
  })
})

describe('audit', () => {
  test('har javob audit logga tushadi', async () => {
    soxtaHodisalar = [{ tur: 'tugadi', matn: 'ok', sarflov: { input: 0, output: 0, cost: 0 } }]
    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'xabar-10', tanlov)

    const yozuvlar = db
      .query<{ actor: string; target: string; result: string }, []>(
        "SELECT actor, target, result FROM audit_log WHERE actor = 'chat'",
      )
      .all()
    expect(yozuvlar).toHaveLength(1)
    expect(yozuvlar[0]?.target).toBe('ollama/qwen3:0.6b')
    expect(yozuvlar[0]?.result).toBe('OK')
  })

  test('xato holati audit logda rad etilgan deb belgilanadi', async () => {
    soxtaHodisalar = [{ tur: 'xato', xabar: 'xato' }]
    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'xabar-11', tanlov)

    const yozuv = db
      .query<{ result: string }, []>("SELECT result FROM audit_log WHERE actor = 'chat'")
      .get()
    expect(yozuv?.result).toBe('rad etildi')
  })
})
