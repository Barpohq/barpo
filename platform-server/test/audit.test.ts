// auditYoz / auditOqi testlari — yozish, o'qish, filtrlash va WS tarqatish.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { auditOqi, auditSoni, auditYoz } from '../src/audit.ts'
import { bazaOch, dbOrnat } from '../src/db.ts'
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

describe('auditYoz', () => {
  test('yozuv bazaga tushadi va qaytib o\'qiladi', () => {
    auditYoz('firdavs', 'Sinov amali', 'frankfurt-1', "o'zgartirish", 'OK')

    const yozuvlar = auditOqi()
    expect(yozuvlar).toHaveLength(1)
    expect(yozuvlar[0]?.actor).toBe('firdavs')
    expect(yozuvlar[0]?.action).toBe('Sinov amali')
    expect(yozuvlar[0]?.level).toBe("o'zgartirish")
    expect(yozuvlar[0]?.result).toBe('OK')
    expect(yozuvlar[0]?.time).toMatch(/^\d{2}:\d{2}$/)
  })

  test('natija ko\'rsatilmasa OK bo\'ladi', () => {
    const yozuv = auditYoz('daemon', 'Health tekshiruvi', 'nyc-1', "o'qish")
    expect(yozuv.result).toBe('OK')
  })

  test('eng yangi yozuv birinchi qaytadi', () => {
    auditYoz('a', 'birinchi', 't', "o'qish")
    auditYoz('b', 'ikkinchi', 't', "o'qish")
    auditYoz('c', 'uchinchi', 't', "o'qish")

    const yozuvlar = auditOqi()
    expect(yozuvlar.map((y) => y.action)).toEqual(['uchinchi', 'ikkinchi', 'birinchi'])
  })

  test('level bo\'yicha filtrlanadi', () => {
    auditYoz('a', 'oqish amali', 't', "o'qish")
    auditYoz('b', 'xavfli amal', 't', 'xavfli', 'rad etildi')
    auditYoz('c', 'yana oqish', 't', "o'qish")

    const xavflilar = auditOqi({ level: 'xavfli' })
    expect(xavflilar).toHaveLength(1)
    expect(xavflilar[0]?.action).toBe('xavfli amal')
  })

  test('actor bo\'yicha filtrlanadi', () => {
    auditYoz('ai-news-bot', 'post', 't', "o'zgartirish")
    auditYoz('firdavs', 'tasdiq', 't', "o'zgartirish")
    auditYoz('ai-news-bot', 'yana post', 't', "o'zgartirish")

    expect(auditOqi({ actor: 'ai-news-bot' })).toHaveLength(2)
    expect(auditSoni({ actor: 'firdavs' })).toBe(1)
  })

  test('limit va offset paginatsiya beradi', () => {
    for (let i = 0; i < 10; i++) auditYoz('bot', `amal-${i}`, 't', "o'qish")

    const birinchiSahifa = auditOqi({ limit: 4 })
    expect(birinchiSahifa).toHaveLength(4)
    expect(birinchiSahifa[0]?.action).toBe('amal-9')

    const ikkinchiSahifa = auditOqi({ limit: 4, offset: 4 })
    expect(ikkinchiSahifa).toHaveLength(4)
    expect(ikkinchiSahifa[0]?.action).toBe('amal-5')

    expect(auditSoni()).toBe(10)
  })

  test('yozuv WS hub orqali tarqatiladi', () => {
    const kelgan: unknown[] = []
    // hub'ga soxta ulanish qo'shamiz: send() ni ushlab qolamiz
    const soxta = {
      data: { id: 'test', channels: new Set(['audit']) },
      send: (m: string) => kelgan.push(JSON.parse(m)),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hub.ulandi(soxta as any)
    kelgan.length = 0 // hello eventini tashlab yuboramiz

    auditYoz('firdavs', 'WS sinovi', 'nishon', 'xavfli', 'rad etildi')

    expect(kelgan).toHaveLength(1)
    expect(kelgan[0]).toMatchObject({
      type: 'audit.entry',
      entry: { actor: 'firdavs', action: 'WS sinovi', level: 'xavfli', result: 'rad etildi' },
    })
  })
})
