// Qidiruv testlari uchun umumiy yordamchilar.
//
// Asosiy vazifasi: `rg` bor-yo'qligini SINXRON aniqlash. Bu kerak, chunki
// `test.if(...)` shart qiymatini test e'lon qilinayotgan paytda talab
// qiladi — u yerda `await` qilib bo'lmaydi.
//
// `rg` yo'q tizimda (yoki PCRE2siz qurilgan `rg` da) `rg` ga bog'liq
// testlar o'tkazib yuboriladi, Node zaxirasi testlari esa HAR DOIM
// ishlaydi. Shunday qilib topshiriqdagi "`rg` yo'q tizimda ham testlar
// o'tishi kerak" sharti bajariladi.

import { spawnSync } from 'node:child_process'

let keshlangan: boolean | undefined

/**
 * `rg` mavjud va PCRE2 bilan qurilganmi.
 *
 * `qidiruv-asos.ts` dagi `rgMavjudmi()` bilan bir xil shart (`+pcre2`) —
 * aks holda testlar motor tanlamaydigan yo'lni sinab qolardi.
 */
export function rgBormi(): boolean {
  if (keshlangan !== undefined) return keshlangan
  try {
    const n = spawnSync('rg', ['--version'], { encoding: 'utf8', timeout: 5000 })
    keshlangan = n.status === 0 && typeof n.stdout === 'string' && n.stdout.includes('+pcre2')
  } catch {
    keshlangan = false
  }
  return keshlangan
}
