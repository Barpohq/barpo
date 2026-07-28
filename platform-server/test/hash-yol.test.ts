// URL hash ↔ ilova holati (platform-ui/src/lib/hash-yol.ts).
//
// NEGA SERVER TESTLARIDA: funksiyalar sof (DOM'ga tegmaydi), UI paketida
// esa hozircha test yig'masi yo'q. Mantiq nozik — sahifa yangilanganda
// suhbat tiklanishi shunga bog'liq, shuning uchun qoplanmay qolmasin.

import { describe, expect, test } from 'bun:test'
import { hashQur, hashTahlil, uuidmi } from '../../platform-ui/src/lib/hash-yol.ts'

const UUID = '3f8a1c2e-9b4d-4e7a-8c1f-2d5e6a7b8c9d'

describe('hashTahlil', () => {
  test("bo'sh hash — oddiy rejim, sessiyasiz", () => {
    expect(hashTahlil('')).toEqual({ pro: false, yol: '', sessionId: null })
  })

  test('# belgisi bilan ham, usiz ham bir xil ishlaydi', () => {
    expect(hashTahlil('#pro/servers')).toEqual(hashTahlil('pro/servers'))
  })

  test('oddiy rejimdagi suhbat: #chat/<uuid>', () => {
    expect(hashTahlil(`#chat/${UUID}`)).toEqual({ pro: false, yol: 'chat', sessionId: UUID })
  })

  test('pro rejimdagi suhbat: #pro/chat/<uuid>', () => {
    expect(hashTahlil(`#pro/chat/${UUID}`)).toEqual({ pro: true, yol: 'chat', sessionId: UUID })
  })

  test('sessiyasiz pro sahifa', () => {
    expect(hashTahlil('#pro/servers')).toEqual({ pro: true, yol: 'servers', sessionId: null })
  })

  test('ilova sahifasi buzilmaydi', () => {
    expect(hashTahlil('#pro/app:ai-news-bot')).toEqual({
      pro: true,
      yol: 'app:ai-news-bot',
      sessionId: null,
    })
  })

  // ENG MUHIM HIMOYA: UUID bo'lmagan oxirgi bo'lak sessiya deb olinmasligi
  // kerak — aks holda UI mavjud bo'lmagan suhbatni yuklashga urinardi
  test("UUID bo'lmagan bo'lak sessiya deb olinmaydi", () => {
    expect(hashTahlil('#pro/chat/salom').sessionId).toBeNull()
    expect(hashTahlil('#pro/chat/123').sessionId).toBeNull()
    expect(hashTahlil('#chat/not-a-uuid-at-all').sessionId).toBeNull()
  })

  test('qisqartirilgan yoki buzilgan UUID rad etiladi', () => {
    expect(hashTahlil('#chat/3f8a1c2e-9b4d-4e7a-8c1f').sessionId).toBeNull()
    expect(hashTahlil(`#chat/${UUID}xx`).sessionId).toBeNull()
  })

  test('katta-kichik harf farq qilmaydi', () => {
    expect(hashTahlil(`#chat/${UUID.toUpperCase()}`).sessionId).toBe(UUID.toUpperCase())
  })

  test("ortiqcha slash'lar yiqitmaydi", () => {
    expect(hashTahlil('#//pro//chat//')).toEqual({ pro: true, yol: 'chat', sessionId: null })
  })
})

describe('hashQur', () => {
  test("oddiy rejim, sessiyasiz — bo'sh hash", () => {
    expect(hashQur(false, 'chat', null)).toBe('')
  })

  test('oddiy rejimdagi suhbat', () => {
    expect(hashQur(false, 'chat', UUID)).toBe(`chat/${UUID}`)
  })

  test('pro rejimdagi suhbat', () => {
    expect(hashQur(true, 'chat', UUID)).toBe(`pro/chat/${UUID}`)
  })

  test('sessiya id faqat chat sahifasida yoziladi', () => {
    // Serverlar sahifasida ochiq suhbat id'si ma'nosiz
    expect(hashQur(true, 'servers', UUID)).toBe('pro/servers')
  })

  test('ilova sahifasi', () => {
    expect(hashQur(true, 'app:ai-news-bot', null)).toBe('pro/app:ai-news-bot')
  })
})

describe('hashQur ↔ hashTahlil aylanishi', () => {
  // Ikkalasi bir-birining teskarisi bo'lishi kerak, aks holda URL yozilgach
  // qayta o'qilganda boshqa holat chiqib, suhbat yo'qolardi
  const holatlar: { pro: boolean; yol: string; sessionId: string | null }[] = [
    { pro: false, yol: 'chat', sessionId: null },
    { pro: false, yol: 'chat', sessionId: UUID },
    { pro: true, yol: 'chat', sessionId: UUID },
    { pro: true, yol: 'chat', sessionId: null },
    { pro: true, yol: 'servers', sessionId: null },
    { pro: true, yol: 'app:ai-news-bot', sessionId: null },
  ]

  for (const h of holatlar) {
    test(`${JSON.stringify(h)} — qurib, qayta o'qiganda o'zgarmaydi`, () => {
      const tahlil = hashTahlil(hashQur(h.pro, h.yol, h.sessionId))
      expect(tahlil.pro).toBe(h.pro)
      // Oddiy rejimda sessiyasiz 'chat' yozilmaydi (bo'sh hash) — o'qiganda
      // ham bo'sh chiqadi va App uni standart 'chat' deb oladi
      const chatSozi = h.pro || h.yol !== 'chat' || h.sessionId
      expect(tahlil.yol).toBe(chatSozi ? h.yol : '')
      expect(tahlil.sessionId).toBe(h.sessionId)
    })
  }
})

describe('uuidmi', () => {
  test('haqiqiy UUID qabul qilinadi', () => {
    expect(uuidmi(UUID)).toBe(true)
    expect(uuidmi(crypto.randomUUID())).toBe(true)
  })

  test("bo'sh satr va axlat rad etiladi", () => {
    expect(uuidmi('')).toBe(false)
    expect(uuidmi('chat')).toBe(false)
  })
})
