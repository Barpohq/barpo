// Prompt tanlash — tarix `assistant` bilan tugagan holat.
//
// NEGA BU TEST BOR (haqiqiy poyga holati):
//   1) foydalanuvchi xabar yubordi, javob oqmoqda;
//   2) u "To'xtatish" bosdi va darhol yangi xabar yubordi;
//   3) `javobOqizi` eski oqimni abort qildi va YANGI user xabarini yozdi;
//   4) abort qilingan eski oqim `finally` da o'z javobini ENDI saqladi —
//      ya'ni yangi user xabaridan KEYIN.
//
// Natijada tarix `user, user, assistant` bo'lib qoladi. Oldin bu holatda
// `xabarlar.at(-1)?.role === 'user'` tekshiruvi yiqilib, agent
// "Yuboriladigan foydalanuvchi xabari topilmadi" xatosini berardi va
// foydalanuvchining xabari JIMGINA yo'qolardi.

import { describe, expect, test } from 'bun:test'
import { oxirgiUserIndeksi } from '../src/agent.ts'
import type { SuhbatXabari } from '../src/suhbat.ts'

const u = (text: string): SuhbatXabari => ({ role: 'user', text })
const a = (text: string): SuhbatXabari => ({ role: 'assistant', text })

describe('oxirgiUserIndeksi', () => {
  test('oddiy holat — oxirgi element user', () => {
    expect(oxirgiUserIndeksi([u('salom'), a('javob'), u('yana')])).toBe(2)
  })

  test('tarix assistant bilan tugasa ham user topiladi', () => {
    // Aynan poyga holati: bekor qilingan javob user xabaridan keyin saqlandi
    const xabarlar = [
      u('birinchi so\'rov'),
      u('ikkinchi so\'rov'),
      a("⚠︎ Javob to'liq kelmadi: So'rov bekor qilindi"),
    ]
    expect(oxirgiUserIndeksi(xabarlar)).toBe(1)
    expect(xabarlar[oxirgiUserIndeksi(xabarlar)]!.text).toBe("ikkinchi so'rov")
  })

  test('ketma-ket bir necha assistant xabaridan keyin ham topiladi', () => {
    expect(oxirgiUserIndeksi([u('so\'rov'), a('bir'), a('ikki'), a('uch')])).toBe(0)
  })

  test('faqat bitta user xabari', () => {
    expect(oxirgiUserIndeksi([u('yolg\'iz')])).toBe(0)
  })

  test('user xabari umuman yo\'q — -1', () => {
    expect(oxirgiUserIndeksi([a('faqat assistant')])).toBe(-1)
    expect(oxirgiUserIndeksi([])).toBe(-1)
  })

  test('eng OXIRGI user tanlanadi, birinchisi emas', () => {
    const xabarlar = [u('eski'), a('javob'), u('yangi'), a('bekor qilindi')]
    expect(xabarlar[oxirgiUserIndeksi(xabarlar)]!.text).toBe('yangi')
  })
})
