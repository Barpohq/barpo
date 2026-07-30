// Chat oqimi: validatsiya, sessiya provider qulfi va migratsiya 002.
//
// LLM'ning o'zi chaqirilmaydi — tarmoqqa chiqmaydigan testlar. Haqiqiy oqim
// orchestrator.test.ts da soxta LLM bilan sinaladi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { ChatSession } from '@platforma/shared'
import { keshniOrnat, keshniTozala } from '@platforma/ai'
import { app } from '../src/app.ts'
import { bazaOch, dbOrnat } from '../src/db.ts'
import {
  biriktirmaYoz,
  sessiyaModelniOzgart,
  sessiyaModelQulfla,
  sessiyaOqi,
  sessiyaYarat,
  xabarlarOqi,
  xabarYoz,
} from '../src/repo.ts'
import { hub } from '../src/ws/hub.ts'

let db: Database

beforeEach(() => {
  db = bazaOch(':memory:')
  dbOrnat(db)
})

afterEach(() => {
  dbOrnat(null)
  hub.tozala()
  db.close()
})

async function yubor(tana: unknown): Promise<{ status: number; body: Record<string, string> }> {
  const javob = await app.request('/api/chat/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tana),
  })
  return { status: javob.status, body: (await javob.json()) as Record<string, string> }
}

describe('migratsiya 002 — sessiya modeli', () => {
  test('chat_sessions da provider va model ustunlari bor', () => {
    const ustunlar = db
      .query<{ name: string }, []>('PRAGMA table_info(chat_sessions)')
      .all()
      .map((u) => u.name)
    expect(ustunlar).toContain('provider')
    expect(ustunlar).toContain('model')
  })

  test('yangi sessiyada provider va model bo\'sh', () => {
    const s = sessiyaYarat('sinov', db)
    expect(s.provider).toBeUndefined()
    expect(s.model).toBeUndefined()
  })

  test('sessiyaModelQulfla faqat birinchi marta yozadi', () => {
    const s = sessiyaYarat('sinov', db)

    expect(sessiyaModelQulfla(s.id, 'ollama', 'qwen3:8b', db)).toBe(true)
    expect(sessiyaOqi(s.id, db)?.provider).toBe('ollama')

    // Ikkinchi urinish o'zgartirmaydi — poyga holatiga qarshi himoya
    expect(sessiyaModelQulfla(s.id, 'anthropic', 'claude-haiku-4-5', db)).toBe(false)
    expect(sessiyaOqi(s.id, db)?.provider).toBe('ollama')
  })

  test('sessiyaModelniOzgart providerni saqlab modelni almashtiradi', () => {
    const s = sessiyaYarat('sinov', db)
    sessiyaModelQulfla(s.id, 'ollama', 'qwen3:0.6b', db)
    sessiyaModelniOzgart(s.id, 'qwen3:8b', db)

    const yangilangan = sessiyaOqi(s.id, db)
    expect(yangilangan?.provider).toBe('ollama')
    expect(yangilangan?.model).toBe('qwen3:8b')
  })
})

describe('POST /api/chat/send — validatsiya', () => {
  test('JSON bo\'lmagan tana 400', async () => {
    const javob = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'bu json emas',
    })
    expect(javob.status).toBe(400)
  })

  test('sessionId yo\'q — 400', async () => {
    const { status, body } = await yubor({ text: 'salom' })
    expect(status).toBe(400)
    expect(body.error).toContain('sessionId')
  })

  test('bo\'sh matn — 400', async () => {
    const s = sessiyaYarat('sinov', db)
    const { status, body } = await yubor({ sessionId: s.id, text: '   ' })
    expect(status).toBe(400)
    expect(body.error).toContain("bo'sh")
  })

  test('mavjud bo\'lmagan sessiya — 404', async () => {
    const { status } = await yubor({
      sessionId: 'yoq-bunday',
      text: 'salom',
      model: { provider: 'ollama', model: 'x' },
    })
    expect(status).toBe(404)
  })

  test('birinchi xabarda model tanlanmagan — 400', async () => {
    const s = sessiyaYarat('sinov', db)
    const { status, body } = await yubor({ sessionId: s.id, text: 'salom' })
    expect(status).toBe(400)
    expect(body.error).toContain('Model')
  })
})

describe('POST /api/chat/send — provider qulfi', () => {
  test('qulflangan sessiyada boshqa provider 409 beradi', async () => {
    const s = sessiyaYarat('sinov', db)
    sessiyaModelQulfla(s.id, 'ollama', 'qwen3:0.6b', db)

    const { status, body } = await yubor({
      sessionId: s.id,
      text: 'salom',
      model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    })
    expect(status).toBe(409)
    expect(body.error).toContain("o'zgartirib bo'lmaydi")
    expect(body.detail).toContain('ollama')
  })
})

describe('migratsiya 003 — tool kartalari', () => {
  test('chat_messages da tool_cards ustuni bor', () => {
    const ustunlar = db
      .query<{ name: string }, []>('PRAGMA table_info(chat_messages)')
      .all()
      .map((u) => u.name)
    expect(ustunlar).toContain('tool_cards')
    // Eski ustun ham joyida
    expect(ustunlar).toContain('tool_card')
  })

  test('tool kartalari yozilib qayta o\'qiladi', () => {
    const s = sessiyaYarat('sinov', db)
    xabarYoz(
      {
        sessionId: s.id,
        role: 'assistant',
        text: 'tayyor',
        toolCards: [
          { id: 't1', nom: 'read', args: 'a.txt', holat: 'tugadi', natija: 'salom' },
          { id: 't2', nom: 'bash', args: 'ls', holat: 'xato', natija: 'xato' },
        ],
      },
      db,
    )

    const xabarlar = xabarlarOqi(s.id, db)
    expect(xabarlar[0]?.toolCards).toHaveLength(2)
    expect(xabarlar[0]?.toolCards?.[0]?.nom).toBe('read')
    expect(xabarlar[0]?.toolCards?.[1]?.holat).toBe('xato')
  })

  test('tool kartasiz xabar undefined qaytaradi', () => {
    const s = sessiyaYarat('sinov', db)
    xabarYoz({ sessionId: s.id, role: 'user', text: 'salom' }, db)
    expect(xabarlarOqi(s.id, db)[0]?.toolCards).toBeUndefined()
  })
})

describe('POST /api/chat/permission', () => {
  test('noto\'g\'ri javob qiymati 400', async () => {
    const javob = await app.request('/api/chat/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', sorovId: 'r', javob: 'nimadir' }),
    })
    expect(javob.status).toBe(400)
  })

  test('sessionId yo\'q — 400', async () => {
    const javob = await app.request('/api/chat/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sorovId: 'r', javob: 'ruxsat' }),
    })
    expect(javob.status).toBe(400)
  })

  test('mavjud bo\'lmagan so\'rov 404', async () => {
    const javob = await app.request('/api/chat/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', sorovId: 'yoq-bunday', javob: 'ruxsat' }),
    })
    expect(javob.status).toBe(404)
  })
})

describe('GET /api/chat/running', () => {
  // Oqim ketayotgan holat orchestrator.test.ts da sinaladi — u yerda LLM
  // moduli soxtalashtirilgan. Bu yerda shakl va bo'sh holat tekshiriladi.

  test("hech narsa ishlamayotganda bo'sh ro'yxat qaytadi", async () => {
    const javob = await app.request('/api/chat/running')
    expect(javob.status).toBe(200)
    expect(await javob.json()).toEqual({ running: [] })
  })

  test("`running` maydoni har doim massiv — UI shartsiz map qiladi", async () => {
    const javob = await app.request('/api/chat/running')
    const tana = (await javob.json()) as { running: unknown }
    expect(Array.isArray(tana.running)).toBe(true)
  })
})

describe('GET /api/chat/sessions — model maydonlari', () => {
  test('qulflangan sessiya provider va modelni qaytaradi', async () => {
    const s = sessiyaYarat('sinov', db)
    sessiyaModelQulfla(s.id, 'openrouter', 'anthropic/claude-haiku-4.5', db)

    const javob = await app.request('/api/chat/sessions')
    const { sessions } = (await javob.json()) as { sessions: ChatSession[] }
    const topilgan = sessions.find((x) => x.id === s.id)

    expect(topilgan?.provider).toBe('openrouter')
    expect(topilgan?.model).toBe('anthropic/claude-haiku-4.5')
  })
})

// URL'dan suhbatni tiklash uchun: sahifa `#chat/<uuid>` bilan ochilganda UI
// shu marshrutdan sessiyaning modelini va loyihasini oladi.
describe('GET /api/chat/sessions/:id — URL dan tiklash', () => {
  test('mavjud sessiyani qaytaradi', async () => {
    const s = sessiyaYarat('tiklanadigan', db)

    const javob = await app.request(`/api/chat/sessions/${s.id}`)
    expect(javob.status).toBe(200)

    const { session } = (await javob.json()) as { session: ChatSession }
    expect(session.id).toBe(s.id)
    expect(session.title).toBe('tiklanadigan')
  })

  test('modelni qaytaradi — UI shu bilan provayderni tiklaydi', async () => {
    const s = sessiyaYarat('modelli', db)
    sessiyaModelQulfla(s.id, 'openai-codex', 'gpt-5.6-luna', db)

    const javob = await app.request(`/api/chat/sessions/${s.id}`)
    const { session } = (await javob.json()) as { session: ChatSession }

    expect(session.provider).toBe('openai-codex')
    expect(session.model).toBe('gpt-5.6-luna')
  })

  test("yo'q sessiya uchun 404 — UI buni bo'sh chatga tushish signali deb biladi", async () => {
    const javob = await app.request('/api/chat/sessions/00000000-0000-4000-8000-000000000000')
    expect(javob.status).toBe(404)
  })

  test("id o'rniga axlat kelsa ham 500 emas, 404", async () => {
    const javob = await app.request('/api/chat/sessions/uuid-emas')
    expect(javob.status).toBe(404)
  })
})

// Biriktirmalar `/chat/send` da ID bo'yicha bog'lanadi. Vision qorovuli ham
// shu yerda — bu yagona nuqta, chunki model AYNAN bu yerda qulflanadi.
describe('POST /api/chat/send — biriktirmalar', () => {
  /** Bog'lanmagan biriktirma yozuvi (fayl tizimiga tegilmaydi) */
  function biriktirma(sessionId: string, tur: 'rasm' | 'fayl' = 'fayl') {
    return biriktirmaYoz(
      {
        sessionId,
        tur,
        nom: 'a.png',
        aslNom: 'a.png',
        yol: 'fayllar/a.png',
        mime: tur === 'rasm' ? 'image/png' : 'application/octet-stream',
        hajm: 100,
      },
      db,
    )
  }

  test('biriktirma xabarga bog\'lanadi', async () => {
    const s = sessiyaYarat('sinov', db)
    const b = biriktirma(s.id)

    const { status } = await yubor({
      sessionId: s.id,
      text: 'buni tekshir',
      model: { provider: 'ollama', model: 'x' },
      biriktirmalar: [b.id],
    })

    expect(status).toBe(202)
    const xabarlar = xabarlarOqi(s.id, db)
    expect(xabarlar[0]?.biriktirmalar).toHaveLength(1)
  })

  // Foydalanuvchi rasm tashlab hech narsa yozmasligi tabiiy holat
  test('biriktirma bo\'lsa bo\'sh matn ham o\'tadi', async () => {
    const s = sessiyaYarat('sinov', db)
    const b = biriktirma(s.id)

    const { status } = await yubor({
      sessionId: s.id,
      text: '',
      model: { provider: 'ollama', model: 'x' },
      biriktirmalar: [b.id],
    })

    expect(status).toBe(202)
  })

  test('biriktirmasiz bo\'sh matn baribir 400', async () => {
    const s = sessiyaYarat('sinov', db)

    const { status } = await yubor({
      sessionId: s.id,
      text: '  ',
      model: { provider: 'ollama', model: 'x' },
    })

    expect(status).toBe(400)
  })

  // XAVFSIZLIK: mijoz ixtiyoriy id yuborishi mumkin
  test('boshqa sessiyaning biriktirma id\'si — 404', async () => {
    const bir = sessiyaYarat('bir', db)
    const ikki = sessiyaYarat('ikki', db)
    const begona = biriktirma(ikki.id)

    const { status, body } = await yubor({
      sessionId: bir.id,
      text: 'salom',
      model: { provider: 'ollama', model: 'x' },
      biriktirmalar: [begona.id],
    })

    expect(status).toBe(404)
    expect(body.error).toContain('Biriktirma')
    // Xabar YOZILMASLIGI kerak — bazada yetim user xabari qolmasin
    expect(xabarlarOqi(bir.id, db)).toHaveLength(0)
  })

  test('yo\'q biriktirma id\'si — 404', async () => {
    const s = sessiyaYarat('sinov', db)

    const { status } = await yubor({
      sessionId: s.id,
      text: 'salom',
      model: { provider: 'ollama', model: 'x' },
      biriktirmalar: ['yo-q-id'],
    })

    expect(status).toBe(404)
  })

  test('biriktirmalar massiv bo\'lmasa — 400', async () => {
    const s = sessiyaYarat('sinov', db)

    const { status } = await yubor({
      sessionId: s.id,
      text: 'salom',
      model: { provider: 'ollama', model: 'x' },
      biriktirmalar: 'massiv emas',
    })

    expect(status).toBe(400)
  })

  test('bo\'sh biriktirmalar massivi muammosiz o\'tadi', async () => {
    const s = sessiyaYarat('sinov', db)

    const { status } = await yubor({
      sessionId: s.id,
      text: 'salom',
      model: { provider: 'ollama', model: 'x' },
      biriktirmalar: [],
    })

    expect(status).toBe(202)
  })
})

// Vision qorovuli model KESHIGA tayanadi. Kesh bo'sh bo'lsa qorovul
// o'tkazib yuboradi (noaniqlikda taqiqlamaymiz) — shuning uchun testlar
// keshni o'zi to'ldiradi.
describe('POST /api/chat/send — vision qorovuli', () => {
  function biriktirma(sessionId: string, tur: 'rasm' | 'fayl') {
    return biriktirmaYoz(
      {
        sessionId,
        tur,
        nom: 'a',
        aslNom: 'a',
        yol: 'fayllar/a',
        mime: tur === 'rasm' ? 'image/png' : 'application/octet-stream',
        hajm: 10,
      },
      db,
    )
  }

  /** Kesh: bitta provider, ikki model — biri vision'li, biri emas */
  function keshniToldir() {
    keshniOrnat({
      models: [
        { provider: 'ollama', providerName: 'Ollama', id: 'ko-radigan', name: 'Ko\'radigan', contextWindow: 8000, reasoning: false, vision: true, cost: { input: 0, output: 0 }, manba: 'test', manbaTuri: 'mahalliy' },
        { provider: 'ollama', providerName: 'Ollama', id: 'ko-rmaydigan', name: 'Ko\'rmaydigan', contextWindow: 8000, reasoning: false, vision: false, cost: { input: 0, output: 0 }, manba: 'test', manbaTuri: 'mahalliy' },
      ],
      providers: [],
      ogohlantirishlar: [],
      vaqt: new Date().toISOString(),
    })
  }

  afterEach(() => {
    keshniTozala()
  })

  test('vision\'siz modelga rasm — 400, xabar YOZILMAYDI', async () => {
    keshniToldir()
    const s = sessiyaYarat('sinov', db)
    const b = biriktirma(s.id, 'rasm')

    const { status, body } = await yubor({
      sessionId: s.id,
      text: 'bu nima?',
      model: { provider: 'ollama', model: 'ko-rmaydigan' },
      biriktirmalar: [b.id],
    })

    expect(status).toBe(400)
    expect(body.error).toContain('rasm')
    expect(body.detail).toContain("Ko'rmaydigan")
    // Rad etilgan xabar bazada qolmasligi kerak
    expect(xabarlarOqi(s.id, db)).toHaveLength(0)
  })

  test('vision\'siz modelga FAYL — o\'tadi', async () => {
    keshniToldir()
    const s = sessiyaYarat('sinov', db)
    const b = biriktirma(s.id, 'fayl')

    const { status } = await yubor({
      sessionId: s.id,
      text: 'tekshir',
      model: { provider: 'ollama', model: 'ko-rmaydigan' },
      biriktirmalar: [b.id],
    })

    expect(status).toBe(202)
  })

  test('vision\'li modelga rasm — o\'tadi', async () => {
    keshniToldir()
    const s = sessiyaYarat('sinov', db)
    const b = biriktirma(s.id, 'rasm')

    const { status } = await yubor({
      sessionId: s.id,
      text: 'bu nima?',
      model: { provider: 'ollama', model: 'ko-radigan' },
      biriktirmalar: [b.id],
    })

    expect(status).toBe(202)
  })

  // Noaniqlikda taqiqlamaymiz: kesh bo'sh bo'lsa provider o'z xatosini beradi
  test('kesh bo\'sh — qorovul o\'tkazib yuboradi', async () => {
    const s = sessiyaYarat('sinov', db)
    const b = biriktirma(s.id, 'rasm')

    const { status } = await yubor({
      sessionId: s.id,
      text: 'bu nima?',
      model: { provider: 'ollama', model: 'nomalum' },
      biriktirmalar: [b.id],
    })

    expect(status).toBe(202)
  })
})
