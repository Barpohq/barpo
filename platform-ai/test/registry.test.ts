// Sessiya reestri — TTL va LRU tozalash.
//
// Bu testlar aynan XOTIRA SIZMASINI tekshiradi: oldin `ruxsat.ts` va
// `rejim.ts` dagi Map hech qachon kichraymasdi, har yangi sessiya unda
// abadiy qolardi.
//
// Vaqt tashqaridan beriladi (`ol(id, hozir)`) — testlar haqiqiy soatni
// kutmaydi va shuning uchun barqaror.

import { describe, expect, test } from 'bun:test'
import { REGISTRY_LIMIT, REGISTRY_TTL_MS, SessionRegistry } from '../src/registry.ts'

/** Yopilganini yozib oladigan soxta boshqaruvchi */
class SoxtaBoshqaruvchi {
  yopilgan = false
  constructor(readonly sessionId: string) {}
  yop(): void {
    this.yopilgan = true
  }
}

function reestrYarat(ttlMs = REGISTRY_TTL_MS, chegara = REGISTRY_LIMIT) {
  return new SessionRegistry<SoxtaBoshqaruvchi>(
    (id) => new SoxtaBoshqaruvchi(id),
    ttlMs,
    chegara,
  )
}

describe('asosiy xulq', () => {
  test('bir xil sessiya uchun bir xil obyekt', () => {
    const r = reestrYarat()
    expect(r.ol('s1')).toBe(r.ol('s1'))
  })

  test('turli sessiyalar ajratilgan', () => {
    const r = reestrYarat()
    expect(r.ol('s1')).not.toBe(r.ol('s2'))
    expect(r.soni).toBe(2)
  })

  test('yop() obyektni yopadi va reestrdan chiqaradi', () => {
    const r = reestrYarat()
    const a = r.ol('s1')
    r.yop('s1')

    expect(a.yopilgan).toBe(true)
    expect(r.soni).toBe(0)
    expect(r.ol('s1')).not.toBe(a) // yangisi yaratiladi
  })

  test("mavjud bo'lmagan sessiyani yopish yiqilmaydi", () => {
    const r = reestrYarat()
    expect(() => r.yop('yoq')).not.toThrow()
  })

  test('tozala() hammasini yopadi', () => {
    const r = reestrYarat()
    const a = r.ol('s1')
    const b = r.ol('s2')
    r.tozala()

    expect(a.yopilgan).toBe(true)
    expect(b.yopilgan).toBe(true)
    expect(r.soni).toBe(0)
  })
})

describe('TTL — faolsizlik bo\'yicha tozalash', () => {
  test('TTL o\'tgan sessiya tozalanadi', () => {
    const r = reestrYarat(1000)
    const a = r.ol('s1', 0)
    expect(r.soni).toBe(1)

    // TTL o'tgach boshqa sessiyaga murojaat — eskisi tozalanadi
    r.ol('s2', 5000)

    expect(a.yopilgan).toBe(true)
    expect(r.soni).toBe(1)
  })

  test('FAOL sessiya tozalanmaydi — har murojaat vaqtni yangilaydi', () => {
    // Eng muhim kafolat: javob oqayotgan sessiya o'chib ketmasligi kerak
    const r = reestrYarat(1000)
    const a = r.ol('s1', 0)

    // Muntazam murojaat qilib turamiz (agent har tool chaqiruvida shunday qiladi)
    for (let t = 500; t <= 10_000; t += 500) {
      expect(r.ol('s1', t)).toBe(a)
    }

    expect(a.yopilgan).toBe(false)
  })

  test('TTL ichida qayta murojaat bir xil obyektni beradi', () => {
    const r = reestrYarat(1000)
    const a = r.ol('s1', 0)
    expect(r.ol('s1', 900)).toBe(a)
    expect(a.yopilgan).toBe(false)
  })

  test('TTL o\'tgan sessiyaga murojaat YANGI obyekt beradi', () => {
    const r = reestrYarat(1000)
    const a = r.ol('s1', 0)
    const b = r.ol('s1', 5000)

    expect(b).not.toBe(a)
    expect(a.yopilgan).toBe(true)
  })

  test('eskirganlarniTozala tozalangan sonni qaytaradi', () => {
    const r = reestrYarat(1000)
    r.ol('s1', 0)
    r.ol('s2', 0)
    r.ol('s3', 0)
    expect(r.soni).toBe(3)

    // TTL o'tgan uchtasi ham tozalanadi
    expect(r.eskirganlarniTozala(5000)).toBe(3)
    expect(r.soni).toBe(0)
  })

  test('ol() ichida ham eskirganlar tozalanadi', () => {
    // `ol()` avval eskirganlarni chiqaradi — alohida taymer kerak emas
    const r = reestrYarat(1000)
    r.ol('s1', 0)
    r.ol('s2', 0)
    expect(r.soni).toBe(2)

    r.ol('s3', 4000) // TTL o'tdi → s1 va s2 shu yerda tozalanadi

    expect(r.soni).toBe(1)
    expect(r.eskirganlarniTozala(4000)).toBe(0) // tozalanadigan qolmadi
  })

  test('bir necha eski sessiya birdan tozalanadi', () => {
    const r = reestrYarat(1000)
    for (let i = 0; i < 50; i += 1) r.ol(`eski-${i}`, 0)
    expect(r.soni).toBe(50)

    r.ol('yangi', 5000)

    expect(r.soni).toBe(1) // faqat yangi qoldi
  })
})

describe('LRU — soni bo\'yicha chegara', () => {
  test('chegaradan oshsa eng eskisi chiqariladi', () => {
    const r = reestrYarat(REGISTRY_TTL_MS, 3)
    const a = r.ol('s1', 0)
    r.ol('s2', 1)
    r.ol('s3', 2)
    r.ol('s4', 3) // chegaradan oshdi

    expect(a.yopilgan).toBe(true)
    expect(r.soni).toBe(3)
  })

  test('yaqinda ishlatilgan sessiya saqlanadi', () => {
    // LRU "eng eski YARATILGAN" emas, "eng uzoq TEGILMAGAN" bo'yicha ishlaydi
    const r = reestrYarat(REGISTRY_TTL_MS, 3)
    const a = r.ol('s1', 0)
    r.ol('s2', 1)
    r.ol('s3', 2)

    r.ol('s1', 3) // s1 ga qayta murojaat — endi u eng yangi
    r.ol('s4', 4) // chegaradan oshdi → s2 chiqishi kerak, s1 emas

    expect(a.yopilgan).toBe(false)
    expect(r.ol('s1', 5)).toBe(a)
  })

  test('chegara qat\'iy ushlab turadi (ko\'p sessiya anomaliyasi)', () => {
    const r = reestrYarat(REGISTRY_TTL_MS, 10)
    // Skript 1000 ta sessiya ochdi — TTL ulgurmaydi, LRU ushlaydi
    for (let i = 0; i < 1000; i += 1) r.ol(`s${i}`, i)

    expect(r.soni).toBe(10)
  })
})

describe('mustahkamlik', () => {
  test('yop() xatosi tozalashni to\'xtatmaydi', () => {
    const r = new SessionRegistry<{ yop(): void }>(
      () => ({
        yop() {
          throw new Error('yopishda xato')
        },
      }),
      1000,
      100,
    )
    r.ol('s1', 0)
    r.ol('s2', 0)

    expect(() => r.tozala()).not.toThrow()
    expect(r.soni).toBe(0)
  })

  test('standart qiymatlar oqilona', () => {
    // TTL juda qisqa bo'lsa faol suhbat uziladi, juda uzun bo'lsa sizma qoladi
    expect(REGISTRY_TTL_MS).toBeGreaterThanOrEqual(5 * 60 * 1000)
    expect(REGISTRY_LIMIT).toBeGreaterThan(0)
  })
})
