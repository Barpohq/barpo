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

import { existsSync, mkdirSync } from 'node:fs'
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

// ---------------------------------------------------------------------------
// Biriktirmalar (chatga yuklangan fayl va rasmlar)
// ---------------------------------------------------------------------------
//
// Yuklamalar ish papkasi ICHIDA yashaydi — bu shart, chunki agent ularni
// mavjud `read`/`grep`/`bash` tool'lari bilan o'qiydi va `ChegaralanganMuhit`
// faqat ish papkasi ichini ruxsatsiz o'tkazadi (`muhit.ts`).
//
// Sessiya bo'yicha bo'linadi, chunki LOYIHAGA ULANGAN suhbatlarda ish
// papkasi umumiy (`sessiyaIshPapkasi` ga q.) — bo'linmasa bir loyihaning
// hamma suhbatlarining fayllari bitta papkada aralashardi.
//
// `sessiyalar/<sid>/fayllar/` — tur bo'yicha ichki papka ATAYLAB: kelajakda
// sessiyaga oid boshqa narsalar (masalan eksportlar, snapshot'lar) o'z
// papkasini oladi va yuklamalar bilan aralashmaydi.

/** Sessiyaga oid ma'lumotlar ildizi — ish papkasiga nisbatan */
export const SESSIYA_PAPKASI = '.platforma/sessiyalar'

/** Sessiya ichida yuklangan fayllar papkasi */
export const FAYLLAR_PAPKASI = 'fayllar'

/**
 * Sessiyaning yuklama papkasini yaratadi.
 *
 * `nisbiy` — ish papkasiga nisbatan yo'l. Bazaga AYNAN SHU saqlanadi va
 * agentga ham shu ko'rinishda beriladi: loyiha papkasi ko'chirilsa yozuvlar
 * buzilmaydi va mijoz absolut yo'lni hech qachon ko'rmaydi.
 */
export function sessiyaFayllarPapkasi(
  ishPapkasiYoli: string,
  sessionId: string,
): { toliq: string; nisbiy: string } {
  const xavfsizId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '') || 'nomalum'
  const nisbiy = join(SESSIYA_PAPKASI, xavfsizId, FAYLLAR_PAPKASI)
  const toliq = join(ishPapkasiYoli, nisbiy)
  mkdirSync(toliq, { recursive: true })
  return { toliq, nisbiy }
}

/** Fayl nomi tanasining eng katta uzunligi */
const NOM_MAX = 80

/** Kengaytmaning eng katta uzunligi — `.jpeg`, `.tar.gz` ning oxirgi bo'lagi sig'adi */
const KENGAYTMA_MAX = 12

/**
 * Foydalanuvchi bergan fayl nomini diskka yozish uchun xavfsiz nomga
 * aylantiradi. Yaramasa (nom butunlay tashlanadigan belgilardan iborat)
 * `null` qaytadi — chaqiruvchi o'zi zaxira nom beradi.
 *
 * `loyihaSlugi()` QAYTA ISHLATILMAYDI, garchi prinsip bir xil bo'lsa ham:
 * u nuqtani ham `-` ga aylantiradi va `hisobot.pdf` → `hisobot-pdf` bo'lardi.
 * Kengaytma esa MUHIM — agent fayl turini shundan biladi va `read` tool'i
 * rasmni aniqlashda ham unga qaraydi.
 *
 * FILTR "RUXSAT ETILGANLAR" PRINSIPIDA (`loyihaSlugi` izohiga q.): faqat
 * `[a-zA-Z0-9_-]` qoldiriladi. Shu sababli `../`, `..\`, NUL, bo'sh joy,
 * `;`, `|`, `$`, kirill/emoji va boshqa yo'l yoki shell hiylalari uchun
 * ALOHIDA tekshiruv kerak emas — ular to'plamga umuman kirmaydi. Ya'ni
 * `"; rm -rf ~; #.png` → `rm-rf.png` bo'lib, metabelgisiz qoladi.
 */
export function yuklamaNomi(xomNom: string | undefined | null): string | null {
  // Tip `undefined` ni ham qabul qiladi, chunki `File.name` HAR DOIM satr
  // emas: rasm clipboard'dan paste qilinganda (Windows'da odatiy holat)
  // brauzer nomsiz `File` yuboradi va Bun uni `undefined` qilib beradi.
  // Chaqiruvchi u holda zaxira nom qo'yadi.
  if (typeof xomNom !== 'string') return null

  // Faqat oxirgi yo'l bo'lagi. `/` va `\` ikkalasi ham: nom Windows
  // mijozidan kelishi mumkin va u `C:\Users\...\x.png` yuboradi.
  const asos = xomNom.split(/[/\\]/).pop() ?? ''

  // `lastIndexOf('.') > 0` — ataylab `> 0`, `>= 0` emas: `.env` kabi nomda
  // nuqta boshida turadi va u kengaytma emas, tananing bir qismi.
  const nuqta = asos.lastIndexOf('.')
  const xomTana = nuqta > 0 ? asos.slice(0, nuqta) : asos
  const xomKengaytma = nuqta > 0 ? asos.slice(nuqta + 1) : ''

  const tana = xomTana
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NOM_MAX)
    // Kesishdan keyin oxirida chiziqcha qolishi mumkin
    .replace(/-+$/g, '')
  if (!tana) return null

  const kengaytma = xomKengaytma
    .replace(/[^a-zA-Z0-9]+/g, '')
    .slice(0, KENGAYTMA_MAX)
    .toLowerCase()

  return kengaytma ? `${tana}.${kengaytma}` : tana
}

/**
 * Nom band bo'lsa `-2`, `-3` … qo'shib bo'sh nom topadi.
 *
 * UUID prefiksi ATAYLAB QO'YILMAYDI: nomni ham agent (promptdagi yo'lda),
 * ham foydalanuvchi (chipda) o'qiydi — `a3f9c1-hisobot.pdf` ikkalasiga ham
 * tanilmaydi.
 *
 * `existsSync` da poyga bor (ikki fayl bir vaqtda yuklansa) — chaqiruvchi
 * shu sababli `flag: 'wx'` bilan yozadi va `EEXIST` da qayta so'raydi.
 */
export function bandsizNom(papka: string, nom: string): string {
  if (!existsSync(join(papka, nom))) return nom

  const nuqta = nom.lastIndexOf('.')
  const tana = nuqta > 0 ? nom.slice(0, nuqta) : nom
  const kengaytma = nuqta > 0 ? nom.slice(nuqta) : ''

  // Chegara: 999 dan keyin to'xtaymiz va vaqt qo'shamiz. Cheksiz halqa
  // bo'lmasin — papka ming xil nusxa bilan to'lgan bo'lsa muammo boshqa joyda.
  for (let i = 2; i <= 999; i += 1) {
    const nomzod = `${tana}-${i}${kengaytma}`
    if (!existsSync(join(papka, nomzod))) return nomzod
  }
  return `${tana}-${Date.now()}${kengaytma}`
}
