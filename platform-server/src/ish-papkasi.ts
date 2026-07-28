// Agent tool'lari ishlaydigan papka.
//
// Ikki xil papka bor:
//
//   1) SESSIYA papkasi — ~/.platforma/ishlar/<sessionId>/
//      Loyihaga ulanmagan suhbat shu yerda ishlaydi: bir suhbatda yaratilgan
//      fayllar boshqasiga aralashmasin.
//
//   2) LOYIHA papkasi — ~/.platforma/loyihalar/<slug>/
//      Loyihaga ulangan suhbat shu yerda ishlaydi. Bir loyihaning HAMMA
//      chatlari bitta papkada — foydalanuvchi bir kod bazasi ustida bir necha
//      suhbat ocha olsin.
//
// Ildizlarni `PLATFORMA_ISHLAR` va `PLATFORMA_LOYIHALAR` env'lari bilan
// ko'chirish mumkin (testlarda vaqtinchalik papka beriladi).

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Barcha sessiya papkalarining ildizi */
export function ishlarIldizi(): string {
  const env = process.env.PLATFORMA_ISHLAR?.trim()
  if (env) return env
  return join(homedir(), '.platforma', 'ishlar')
}

/** Barcha loyiha papkalarining ildizi */
export function loyihalarIldizi(): string {
  const env = process.env.PLATFORMA_LOYIHALAR?.trim()
  if (env) return env
  return join(homedir(), '.platforma', 'loyihalar')
}

/**
 * Sessiya uchun ish papkasini qaytaradi, yo'q bo'lsa yaratadi.
 *
 * `sessionId` UUID bo'lgani uchun yo'l ichida xavfli belgi bo'lmaydi, lekin
 * tashqaridan kelgan qiymatga ishonmaymiz — faqat xavfsiz belgilar qoldiriladi.
 */
export function ishPapkasi(sessionId: string): string {
  const xavfsizId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '') || 'nomalum'
  const yol = join(ishlarIldizi(), xavfsizId)
  mkdirSync(yol, { recursive: true })
  return yol
}

/**
 * Loyiha nomini papka nomiga (slug) aylantiradi.
 *
 * FAQAT `[a-zA-Z0-9_-]` qoldiriladi, qolgani `-` ga aylanadi. `..`, `/`,
 * NUL va boshqa yo'l hiylalari uchun alohida tekshiruv KERAK EMAS: ular
 * xavfsiz belgilar to'plamiga umuman kirmaydi, ya'ni filtr "ruxsat
 * etilganlar" (allowlist) prinsipida ishlaydi — qora ro'yxatdagidek
 * "yana qaysi belgi xavfli edi" degan savol tug'ilmaydi.
 *
 * Bo'sh natija (nom butunlay emoji yoki kirill bo'lsa) `null` qaytadi —
 * chaqiruvchi xato beradi va "nomalum" kabi zaxira nom QO'YMAYDI: aks holda
 * ikkita boshqa nomli loyiha bitta papkani bo'lishardi.
 */
export function loyihaSlugi(nom: string): string | null {
  const slug = nom
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    // Chetdagi chiziqchalar papka nomini xunuk qiladi
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    // Kesishdan keyin oxirida chiziqcha qolishi mumkin
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : null
}

/**
 * Loyiha papkasini yaratadi va to'liq yo'lini qaytaradi.
 *
 * Slug allaqachon xavfsiz belgilardan iborat, shuning uchun `join` ildizdan
 * chiqib keta olmaydi.
 */
export function loyihaPapkasiniYarat(slug: string): string {
  const yol = join(loyihalarIldizi(), slug)
  mkdirSync(yol, { recursive: true })
  return yol
}

/**
 * Sessiya uchun HAQIQIY ish papkasi.
 *
 * Loyihaga ulangan bo'lsa loyiha papkasi, aks holda sessiyaning o'z papkasi.
 * `loyihaPapkasi` chaqiruvchidan keladi (repo'dan o'qilgan) — bu modul
 * bazani bilmaydi.
 *
 * Papka har ikki holatda ham yaratiladi: loyiha yozuvi bazada bor, lekin
 * papkasi qo'lda o'chirilgan bo'lishi mumkin. Papkasiz `ChegaralanganMuhit`
 * ning chegara tekshiruvi ishonchsiz bo'lardi — `canonicalPath` mavjud
 * bo'lmagan papka uchun hech narsa qaytarmaydi.
 */
export function sessiyaIshPapkasi(sessionId: string, loyihaPapkasi?: string | null): string {
  if (loyihaPapkasi) {
    mkdirSync(loyihaPapkasi, { recursive: true })
    return loyihaPapkasi
  }
  return ishPapkasi(sessionId)
}
