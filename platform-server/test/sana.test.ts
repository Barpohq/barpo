// Sana guruhlash va qisqa vaqt (platform-ui/src/lib/sana.ts).
//
// NEGA SERVER TESTLARIDA: `hash-yol.test.ts` bilan bir xil sabab — funksiyalar
// sof (DOM'ga tegmaydi), UI paketida esa test yig'masi yo'q.
//
// "Hozir" har testda ANIQ beriladi, shuning uchun natija testni qachon
// ishga tushirishga bog'liq emas.

import { describe, expect, test } from 'bun:test'
import { GURUH_TARTIBI, qisqaVaqt, sanaGuruhi } from '../../platform-ui/src/lib/sana.ts'

/** Barcha testlar uchun bitta "hozir": 2026-07-28, soat 14:00 */
const HOZIR = new Date(2026, 6, 28, 14, 0, 0)

/** Mahalliy vaqt zonasida ISO satr yasaydi — testlar zonaga bog'liq bo'lmasin */
function sana(yil: number, oy: number, kun: number, soat = 12, daqiqa = 0): string {
  return new Date(yil, oy - 1, kun, soat, daqiqa).toISOString()
}

describe('sanaGuruhi', () => {
  test('bugungi suhbat — Bugun', () => {
    expect(sanaGuruhi(sana(2026, 7, 28, 9), HOZIR)).toBe('Today')
  })

  test('bugun ertalab soat 00:30 ham Bugun', () => {
    expect(sanaGuruhi(sana(2026, 7, 28, 0, 30), HOZIR)).toBe('Today')
  })

  test('kechagi suhbat — Kecha', () => {
    expect(sanaGuruhi(sana(2026, 7, 27, 20), HOZIR)).toBe('Yesterday')
  })

  // Bu asosiy sabab: guruhlash KALENDAR kuni bo'yicha, "24 soat ichida" emas.
  // Kecha kechqurun 23:00 dagi suhbat 15 soat o'tgan bo'lsa ham "Kecha".
  test("kecha soat 23:00 — 24 soat o'tmagan bo'lsa ham Kecha", () => {
    expect(sanaGuruhi(sana(2026, 7, 27, 23), HOZIR)).toBe('Yesterday')
  })

  test('uch kun oldin — Shu hafta', () => {
    expect(sanaGuruhi(sana(2026, 7, 25), HOZIR)).toBe('This week')
  })

  test('ikki hafta oldin — Bu oy', () => {
    expect(sanaGuruhi(sana(2026, 7, 14), HOZIR)).toBe('This month')
  })

  test('ikki oy oldin — Eskiroq', () => {
    expect(sanaGuruhi(sana(2026, 5, 20), HOZIR)).toBe('Older')
  })

  test("kelajakdagi sana — Bugun (soat noto'g'ri qo'yilgan holat)", () => {
    expect(sanaGuruhi(sana(2026, 8, 5), HOZIR)).toBe('Today')
  })

  test("buzuq sana ro'yxatni yiqitmaydi", () => {
    expect(sanaGuruhi('sana emas', HOZIR)).toBe('Older')
  })

  test("qaytgan guruh har doim GURUH_TARTIBI ichida bo'ladi", () => {
    const sinovlar = [
      sana(2026, 7, 28),
      sana(2026, 7, 27),
      sana(2026, 7, 24),
      sana(2026, 7, 10),
      sana(2025, 1, 1),
    ]
    for (const s of sinovlar) {
      expect(GURUH_TARTIBI).toContain(sanaGuruhi(s, HOZIR))
    }
  })
})

describe('qisqaVaqt', () => {
  test("bir daqiqadan kam — 'hozir'", () => {
    expect(qisqaVaqt(sana(2026, 7, 28, 14, 0), HOZIR)).toBe('now')
  })

  test("roppa-rosa bir daqiqa — '1 daq'", () => {
    expect(qisqaVaqt(sana(2026, 7, 28, 13, 59), HOZIR)).toBe('1 min')
  })

  test('daqiqalar', () => {
    expect(qisqaVaqt(sana(2026, 7, 28, 13, 25), HOZIR)).toBe('35 min')
  })

  test('soatlar', () => {
    expect(qisqaVaqt(sana(2026, 7, 28, 9, 0), HOZIR)).toBe('5 h')
  })

  test('kunlar', () => {
    expect(qisqaVaqt(sana(2026, 7, 25, 14), HOZIR)).toBe('3 d')
  })

  test("bir haftadan oshgach aniq sana — shu yil bo'lsa yilsiz", () => {
    expect(qisqaVaqt(sana(2026, 7, 12), HOZIR)).toBe('Jul 12')
  })

  test('boshqa yil — yil bilan', () => {
    expect(qisqaVaqt(sana(2025, 11, 3), HOZIR)).toBe('Nov 3, 2025')
  })

  test("buzuq sana — bo'sh satr", () => {
    expect(qisqaVaqt('sana emas', HOZIR)).toBe('')
  })
})
