// Suhbatlar ro'yxati, qayta nomlash va o'chirish.
//
// UI'dagi "oxirgi 5 chat" sidebar ro'yxati va "Suhbatlar" sahifasi shu
// marshrutlarga tayanadi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { ChatSession } from '@platforma/shared'
import { app } from '../src/app.ts'
import { bazaOch, dbOrnat } from '../src/db.ts'
import {
  sessiyaOchir,
  sessiyaOqi,
  sessiyaSarlavhaOzgart,
  sessiyaYarat,
  sessiyalarOqi,
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

describe('sessiyalarOqi — xabarlar soni', () => {
  test("xabarsiz sessiya ro'yxatda 0 bilan turadi", () => {
    sessiyaYarat('bo\'sh suhbat', db)

    const royxat = sessiyalarOqi(db)
    expect(royxat).toHaveLength(1)
    expect(royxat[0]?.xabarlarSoni).toBe(0)
  })

  test('xabarlar sanaladi', () => {
    const s = sessiyaYarat('to\'la suhbat', db)
    xabarYoz({ sessionId: s.id, role: 'user', text: 'salom' }, db)
    xabarYoz({ sessionId: s.id, role: 'assistant', text: 'salom!' }, db)

    expect(sessiyalarOqi(db)[0]?.xabarlarSoni).toBe(2)
  })

  test("boshqa sessiyaning xabarlari aralashmaydi", () => {
    const a = sessiyaYarat('a', db)
    const b = sessiyaYarat('b', db)
    xabarYoz({ sessionId: a.id, role: 'user', text: 'faqat a da' }, db)

    const royxat = sessiyalarOqi(db)
    expect(royxat.find((s) => s.id === a.id)?.xabarlarSoni).toBe(1)
    expect(royxat.find((s) => s.id === b.id)?.xabarlarSoni).toBe(0)
  })

  test("oxirgi faollik bo'yicha saralanadi — yangisi birinchi", async () => {
    const eski = sessiyaYarat('eski', db)
    // `updated_at` ISO satr bo'yicha taqqoslanadi — bir xil millisekundda
    // yaratilsa tartib aniqlanmay qolardi
    await Bun.sleep(2)
    const yangi = sessiyaYarat('yangi', db)

    const royxat = sessiyalarOqi(db)
    expect(royxat[0]?.id).toBe(yangi.id)
    expect(royxat[1]?.id).toBe(eski.id)
  })

  test('xabar yozilgach suhbat tepaga chiqadi', async () => {
    const birinchi = sessiyaYarat('birinchi', db)
    await Bun.sleep(2)
    sessiyaYarat('ikkinchi', db)
    await Bun.sleep(2)

    xabarYoz({ sessionId: birinchi.id, role: 'user', text: 'jonlantirdik' }, db)
    expect(sessiyalarOqi(db)[0]?.id).toBe(birinchi.id)
  })
})

describe('sessiyaSarlavhaOzgart', () => {
  test('nomni almashtiradi', () => {
    const s = sessiyaYarat('eski nom', db)

    expect(sessiyaSarlavhaOzgart(s.id, 'yangi nom', db)).toBe(true)
    expect(sessiyaOqi(s.id, db)?.title).toBe('yangi nom')
  })

  test("yo'q sessiya uchun false", () => {
    expect(sessiyaSarlavhaOzgart('yoq-bunday', 'nom', db)).toBe(false)
  })

  test("updated_at ga tegmaydi — tahrir suhbatni tepaga ko'tarmasin", async () => {
    const s = sessiyaYarat('birinchi', db)
    await Bun.sleep(2)
    const keyingi = sessiyaYarat('ikkinchi', db)

    sessiyaSarlavhaOzgart(s.id, 'qayta nomlandi', db)

    // Tartib o'zgarmasligi kerak: ikkinchisi hali ham tepada
    expect(sessiyalarOqi(db)[0]?.id).toBe(keyingi.id)
  })
})

describe('sessiyaOchir', () => {
  test("sessiya va uning xabarlari birga o'chadi (CASCADE)", () => {
    const s = sessiyaYarat('o\'chadigan', db)
    xabarYoz({ sessionId: s.id, role: 'user', text: 'salom' }, db)

    expect(sessiyaOchir(s.id, db)).toBe(true)
    expect(sessiyaOqi(s.id, db)).toBeNull()
    expect(xabarlarOqi(s.id, db)).toHaveLength(0)
  })

  test("boshqa sessiyaga tegmaydi", () => {
    const a = sessiyaYarat('a', db)
    const b = sessiyaYarat('b', db)
    xabarYoz({ sessionId: b.id, role: 'user', text: 'qolishi kerak' }, db)

    sessiyaOchir(a.id, db)

    expect(sessiyaOqi(b.id, db)).not.toBeNull()
    expect(xabarlarOqi(b.id, db)).toHaveLength(1)
  })

  test("yo'q sessiya uchun false", () => {
    expect(sessiyaOchir('yoq-bunday', db)).toBe(false)
  })
})

describe('PATCH /api/chat/sessions/:id', () => {
  async function nomOzgart(id: string, tana: unknown) {
    const javob = await app.request(`/api/chat/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tana),
    })
    return { status: javob.status, body: (await javob.json()) as Record<string, unknown> }
  }

  test('nomni o\'zgartiradi va yangilangan sessiyani qaytaradi', async () => {
    const s = sessiyaYarat('eski', db)

    const { status, body } = await nomOzgart(s.id, { title: 'yangi nom' })
    expect(status).toBe(200)
    expect((body.session as ChatSession).title).toBe('yangi nom')
  })

  test("nom atrofidagi bo'shliqlar kesiladi", async () => {
    const s = sessiyaYarat('eski', db)
    await nomOzgart(s.id, { title: '  tozalangan  ' })
    expect(sessiyaOqi(s.id, db)?.title).toBe('tozalangan')
  })

  test("bo'sh nom — 400", async () => {
    const s = sessiyaYarat('eski', db)
    const { status } = await nomOzgart(s.id, { title: '   ' })
    expect(status).toBe(400)
    // Eski nom joyida qoladi
    expect(sessiyaOqi(s.id, db)?.title).toBe('eski')
  })

  test('title yo\'q — 400', async () => {
    const s = sessiyaYarat('eski', db)
    const { status } = await nomOzgart(s.id, {})
    expect(status).toBe(400)
  })

  test("juda uzun nom — 400", async () => {
    const s = sessiyaYarat('eski', db)
    const { status } = await nomOzgart(s.id, { title: 'a'.repeat(201) })
    expect(status).toBe(400)
  })

  test("yo'q sessiya — 404", async () => {
    const { status } = await nomOzgart('00000000-0000-4000-8000-000000000000', {
      title: 'nom',
    })
    expect(status).toBe(404)
  })

  test("JSON bo'lmagan tana — 400", async () => {
    const s = sessiyaYarat('eski', db)
    const javob = await app.request(`/api/chat/sessions/${s.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: 'bu json emas',
    })
    expect(javob.status).toBe(400)
  })
})

describe('DELETE /api/chat/sessions/:id', () => {
  test("sessiyani o'chiradi", async () => {
    const s = sessiyaYarat('o\'chadigan', db)
    xabarYoz({ sessionId: s.id, role: 'user', text: 'salom' }, db)

    const javob = await app.request(`/api/chat/sessions/${s.id}`, { method: 'DELETE' })
    expect(javob.status).toBe(200)
    expect(await javob.json()).toEqual({ ochirildi: true, oqimToxtatildi: false })
    expect(sessiyaOqi(s.id, db)).toBeNull()
  })

  test("o'chirilgach ro'yxatdan chiqadi", async () => {
    const s = sessiyaYarat('o\'chadigan', db)
    await app.request(`/api/chat/sessions/${s.id}`, { method: 'DELETE' })

    const javob = await app.request('/api/chat/sessions')
    const { sessions } = (await javob.json()) as { sessions: ChatSession[] }
    expect(sessions.find((x) => x.id === s.id)).toBeUndefined()
  })

  test("yo'q sessiya — 404", async () => {
    const javob = await app.request('/api/chat/sessions/00000000-0000-4000-8000-000000000000', {
      method: 'DELETE',
    })
    expect(javob.status).toBe(404)
  })

  test("ikki marta o'chirilsa ikkinchisi 404", async () => {
    const s = sessiyaYarat('o\'chadigan', db)
    await app.request(`/api/chat/sessions/${s.id}`, { method: 'DELETE' })

    const ikkinchi = await app.request(`/api/chat/sessions/${s.id}`, { method: 'DELETE' })
    expect(ikkinchi.status).toBe(404)
  })
})

describe('GET /api/chat/sessions — ro\'yxat shakli', () => {
  test('xabarlar soni qaytadi — UI bo\'sh suhbatni ajratadi', async () => {
    const s = sessiyaYarat('sinov', db)
    xabarYoz({ sessionId: s.id, role: 'user', text: 'salom' }, db)

    const javob = await app.request('/api/chat/sessions')
    const { sessions } = (await javob.json()) as { sessions: ChatSession[] }
    expect(sessions.find((x) => x.id === s.id)?.xabarlarSoni).toBe(1)
  })

  test("sessiya yo'q bo'lsa bo'sh massiv — UI shartsiz map qiladi", async () => {
    const javob = await app.request('/api/chat/sessions')
    expect(await javob.json()).toEqual({ sessions: [] })
  })
})
