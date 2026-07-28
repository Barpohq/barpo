// Agent tool'lari ishlaydigan papka.
//
// Har sessiya o'z papkasini oladi: bir suhbatda yaratilgan fayllar
// boshqasiga aralashmasin va chegara tekshiruvi aniq bo'lsin.
//
// Joylashuv: ~/.platforma/ishlar/<sessionId>/
// `PLATFORMA_ISHLAR` env bilan boshqa joyga ko'chirish mumkin (testlarda
// vaqtinchalik papka beriladi).

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Barcha sessiya papkalarining ildizi */
export function ishlarIldizi(): string {
  const env = process.env.PLATFORMA_ISHLAR?.trim()
  if (env) return env
  return join(homedir(), '.platforma', 'ishlar')
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
