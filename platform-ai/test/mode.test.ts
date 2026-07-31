// Rejim boshqaruvchisi — fallback mexanizmi.
//
// Auto rejim uch holatda o'chadi: klassifikator nosoz, 3 ketma-ket blok,
// 20 jami blok. O'chgach avtomatik tiklanmaydi.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  TOTAL_BLOCK_LIMIT,
  CONSECUTIVE_BLOCK_LIMIT,
  ModeManager,
  modeManager,
  closeModeManager,
  clearModes,
  type ModeChange,
} from '../src/mode.ts'

afterEach(() => {
  clearModes()
})

describe('boshlang\'ich holat', () => {
  test('standart rejim tasdiq', () => {
    const r = new ModeManager('s1')
    expect(r.rejim).toBe('tasdiq')
    expect(r.sabab).toBeUndefined()
  })

  test('tasdiq rejimida bloklar hisoblanmaydi', () => {
    const r = new ModeManager('s1')
    r.blokBoldi()
    r.blokBoldi()
    r.blokBoldi()
    expect(r.rejim).toBe('tasdiq')
    expect(r.hisoblagichlar.ketmaKet).toBe(0)
  })
})

describe('rejim almashtirish', () => {
  test('auto ga o\'tish kuzatuvchiga xabar beradi', () => {
    const r = new ModeManager('s1')
    const olingan: ModeChange[] = []
    r.kuzat((o) => olingan.push(o))

    r.ornat('auto')
    expect(r.rejim).toBe('auto')
    expect(olingan).toHaveLength(1)
    expect(olingan[0]?.rejim).toBe('auto')
  })

  test('bir xil rejimga qayta o\'rnatish xabar bermaydi', () => {
    const r = new ModeManager('s1')
    r.ornat('auto')
    const olingan: ModeChange[] = []
    r.kuzat((o) => olingan.push(o))
    r.ornat('auto')
    expect(olingan).toHaveLength(0)
  })

  test('auto ga qaytish hisoblagichlarni tozalaydi', () => {
    const r = new ModeManager('s1')
    r.ornat('auto')
    r.blokBoldi()
    r.blokBoldi()
    expect(r.hisoblagichlar.jami).toBe(2)

    r.ornat('tasdiq')
    r.ornat('auto')
    expect(r.hisoblagichlar).toEqual({ ketmaKet: 0, jami: 0 })
  })
})

describe('ketma-ket blok chegarasi', () => {
  test(`${CONSECUTIVE_BLOCK_LIMIT} ketma-ket blok auto ni o'chiradi`, () => {
    const r = new ModeManager('s1')
    r.ornat('auto')

    for (let i = 1; i < CONSECUTIVE_BLOCK_LIMIT; i += 1) {
      expect(r.blokBoldi()).toBe(false)
      expect(r.rejim).toBe('auto')
    }
    expect(r.blokBoldi()).toBe(true)
    expect(r.rejim).toBe('tasdiq')
    expect(r.sabab).toContain('in a row')
  })

  test('ruxsat ketma-ket hisoblagichni nolga qaytaradi', () => {
    const r = new ModeManager('s1')
    r.ornat('auto')

    r.blokBoldi()
    r.blokBoldi()
    r.ruxsatBerildi()
    expect(r.hisoblagichlar.ketmaKet).toBe(0)

    // Endi yana 3 ta kerak
    r.blokBoldi()
    r.blokBoldi()
    expect(r.rejim).toBe('auto')
    r.blokBoldi()
    expect(r.rejim).toBe('tasdiq')
  })

  test('ruxsat jami hisoblagichni tozalamaydi', () => {
    const r = new ModeManager('s1')
    r.ornat('auto')
    r.blokBoldi()
    r.ruxsatBerildi()
    expect(r.hisoblagichlar.jami).toBe(1)
  })
})

describe('jami blok chegarasi', () => {
  test(`${TOTAL_BLOCK_LIMIT} jami blok auto ni o'chiradi`, () => {
    const r = new ModeManager('s1')
    r.ornat('auto')

    // Har blokdan keyin ruxsat — ketma-ket chegara ishlamasin
    for (let i = 0; i < TOTAL_BLOCK_LIMIT - 1; i += 1) {
      r.blokBoldi()
      r.ruxsatBerildi()
    }
    expect(r.rejim).toBe('auto')

    r.blokBoldi()
    expect(r.rejim).toBe('tasdiq')
    expect(r.sabab).toContain('in total')
  })
})

describe('klassifikator nosozligi', () => {
  test('auto darhol o\'chadi', () => {
    const r = new ModeManager('s1')
    r.ornat('auto')
    r.klassifikatorNosoz('model topilmadi')

    expect(r.rejim).toBe('tasdiq')
    expect(r.sabab).toContain('model topilmadi')
  })

  test('tasdiq rejimida ta\'sir qilmaydi', () => {
    const r = new ModeManager('s1')
    r.klassifikatorNosoz('xato')
    expect(r.sabab).toBeUndefined()
  })

  test('o\'chgach avtomatik tiklanmaydi', () => {
    const r = new ModeManager('s1')
    r.ornat('auto')
    r.klassifikatorNosoz('timeout')

    // Vaqt o'tishi yoki muvaffaqiyatli amal rejimni qaytarmaydi
    r.ruxsatBerildi()
    expect(r.rejim).toBe('tasdiq')

    // Faqat qo'lda
    r.ornat('auto')
    expect(r.rejim).toBe('auto')
    expect(r.sabab).toBeUndefined()
  })
})

describe('reestr', () => {
  test('bir sessiya uchun bir boshqaruvchi', () => {
    expect(modeManager('s1')).toBe(modeManager('s1'))
  })

  test('sessiyalar ajratilgan', () => {
    modeManager('s1').ornat('auto')
    expect(modeManager('s2').rejim).toBe('tasdiq')
  })

  test('yopilgach yangi boshqaruvchi', () => {
    const a = modeManager('s1')
    a.ornat('auto')
    closeModeManager('s1')
    expect(modeManager('s1').rejim).toBe('tasdiq')
  })
})
