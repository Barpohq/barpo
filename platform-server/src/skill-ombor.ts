// Skill ombori va loyihaga nusxalash — skilllarning disk qatlami.
//
// IKKI JOY, IKKI VAZIFA:
//
//   OMBOR   ~/.platforma/skills-ombor/<manbaId>/<skillId>/
//           O'rnatilgan skill fayllarining YAGONA nusxasi. Bir skill 10 ta
//           loyihada ishlatilsa ham bu yerda bitta bo'ladi.
//
//   LOYIHA  <ishPapkasi>/.platforma/skills/<nom>/
//           Ombordan NUSXA. Sessiya boshida quriladi.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NEGA NUSXA, SYMLINK EMAS: `muhit.ts` yo'lni tekshirishda             │
// │ `canonicalPath` ishlatadi — symlink OCHIB YUBORILADI va haqiqiy      │
// │ yo'l (ombor) ish papkasidan tashqarida chiqadi. Natijada model har   │
// │ SKILL.md o'qiganda ruxsat modali chiqardi.                           │
// │                                                                      │
// │ Nusxa bilan chegara kodiga umuman tegilmaydi: fayl haqiqatan ham     │
// │ ish papkasi ichida. Yon foyda — agent nusxani buzsa ombor butun      │
// │ qoladi, ya'ni bir loyiha boshqasining skill'ini aynita olmaydi.      │
// └──────────────────────────────────────────────────────────────────────┘
//
// `.platforma/skills/` — BOSHQARILADIGAN papka. Haqiqat manbai — baza
// (`skill_ornatish`). Har sessiya boshida u bazaga moslashtiriladi:
// ortiqchasi o'chiriladi, yetishmagani nusxalanadi. Foydalanuvchi u yerga
// qo'lda qo'ygan narsa keyingi sessiyada yo'qoladi — bu ataylab shunday,
// aks holda diskdagi va bazadagi holat vaqt o'tib bir-biriga mos kelmay
// qolardi.

import { skillFayliniTahlil } from '@platforma/ai'
import type { Skill } from '@platforma/shared'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  blobniOqi,
  MAKS_SKILL_BAYT,
  repoMalumoti,
  skillFayllariniTop,
  tarballniOl,
  type GithubManzil,
} from './github.ts'
import { standartniOmborga } from './standart-skilllar.ts'
import { tarOqi } from './tar.ts'

/** Ombor ildizi — `PLATFORMA_SKILLS` bilan ko'chiriladi (testlar shuni beradi) */
export function omborIldizi(): string {
  const env = process.env.PLATFORMA_SKILLS?.trim()
  if (env) return env
  return join(homedir(), '.platforma', 'skills-ombor')
}

/**
 * Yo'l bo'lagini xavfsiz nomga aylantiradi.
 *
 * `id` lar UUID, ya'ni xavfsiz — lekin tashqaridan kelgan qiymatga
 * ishonmaymiz (`ish-papkasi.ts` dagi bilan bir xil qoida).
 */
function xavfsizNom(x: string): string {
  return x.replace(/[^a-zA-Z0-9_-]/g, '') || 'nomalum'
}

/** Bitta skillning ombordagi papkasi */
export function skillOmborYoli(manbaId: string, skillId: string): string {
  return join(omborIldizi(), xavfsizNom(manbaId), xavfsizNom(skillId))
}

// ---------------------------------------------------------------------------
// Katalog: repo'ni skanerlash
// ---------------------------------------------------------------------------

export interface SkanerNatija {
  ref: string
  sha: string
  skilllar: Omit<Skill, 'id' | 'manbaId' | 'ornatilgan'>[]
  ogohlantirishlar: string[]
}

/**
 * Repo'dagi hamma `SKILL.md` ni topib, frontmatter'ini o'qiydi.
 *
 * Har `SKILL.md` uchun bitta blob so'rovi ketadi. Rate limit (60/soat)
 * hisobga olinib, skanerlanadigan fayl soni cheklanadi — aks holda katta
 * repo bitta urinishda limitni tugatardi.
 */
export const MAKS_SKANER_FAYL = 50

/** Ochilgan tarball chegarasi — zip bomb himoyasi */
const MAKS_TARBALL_OCHILGAN = 200 * 1024 * 1024

export async function manbaniSkanerla(m: GithubManzil): Promise<SkanerNatija> {
  const ogohlantirishlar: string[] = []
  const { ref, sha } = await repoMalumoti(m)
  const { fayllar, kesilgan } = await skillFayllariniTop(m, ref)

  if (kesilgan) {
    ogohlantirishlar.push('Repository too large — the file list is incomplete')
  }

  let royxat = fayllar
  if (royxat.length > MAKS_SKANER_FAYL) {
    ogohlantirishlar.push(
      `Found ${royxat.length} skills, read the first ${MAKS_SKANER_FAYL}`,
    )
    royxat = royxat.slice(0, MAKS_SKANER_FAYL)
  }

  const skilllar: SkanerNatija['skilllar'] = []
  for (const fayl of royxat) {
    let xom: string
    try {
      xom = await blobniOqi(m, fayl.sha)
    } catch {
      // Bitta fayl o'qilmasa qolganini yo'qotmaymiz
      continue
    }

    // Papka nomi — `SKILL.md` ning ota-papkasi. Ildizdagi fayl uchun repo nomi.
    const papka = fayl.yol.includes('/') ? (dirname(fayl.yol).split('/').pop() ?? m.repo) : m.repo

    const tahlil = skillFayliniTahlil(xom, papka)
    if (!tahlil) {
      ogohlantirishlar.push(`${fayl.yol}: no description — skipped`)
      continue
    }

    skilllar.push({
      yol: fayl.yol,
      nom: tahlil.nom,
      tavsif: tahlil.tavsif,
      litsenziya: tahlil.litsenziya,
      allowedTools: tahlil.allowedTools,
      ogohlantirishlar: tahlil.ogohlantirishlar,
    })
  }

  return { ref, sha, skilllar, ogohlantirishlar }
}

// ---------------------------------------------------------------------------
// O'rnatish: tarball → ombor
// ---------------------------------------------------------------------------

/**
 * Skill papkasini repo tarball'idan ombor ga chiqaradi.
 *
 * Tarball BUTUN repo bo'lgani uchun faqat kerakli prefiksdagi fayllar
 * olinadi. GitHub arxivi ichida bitta ildiz papka bor
 * (`skills-abc123/…`) — uni tashlab ketamiz.
 */
export async function skillniOmborga(
  m: GithubManzil,
  ref: string,
  skillYoli: string,
  manbaId: string,
  skillId: string,
): Promise<{ fayllar: number; baytlar: number }> {
  const xom = await tarballniOl(m, ref)
  const yozuvlar = tarOqi(xom, MAKS_TARBALL_OCHILGAN)

  // `document-skills/pdf/SKILL.md` → `document-skills/pdf/`
  const skillPapkasi = skillYoli.includes('/') ? `${dirname(skillYoli)}/` : ''

  const nishon = skillOmborYoli(manbaId, skillId)
  // Qayta o'rnatishda eski holat qolmasin
  rmSync(nishon, { recursive: true, force: true })
  mkdirSync(nishon, { recursive: true })

  let fayllar = 0
  let baytlar = 0

  for (const yozuv of yozuvlar) {
    // Arxiv ildizini olib tashlaymiz: `skills-abc123/x/y` → `x/y`
    const kesik = yozuv.yol.slice(yozuv.yol.indexOf('/') + 1)
    if (!kesik.startsWith(skillPapkasi)) continue

    const ichkiYol = kesik.slice(skillPapkasi.length)
    if (!ichkiYol) continue

    baytlar += yozuv.mazmun.length
    if (baytlar > MAKS_SKILL_BAYT) {
      rmSync(nishon, { recursive: true, force: true })
      throw new Error(`Skill too large (${Math.round(MAKS_SKILL_BAYT / 1024 / 1024)}MB limit)`)
    }

    // `tarOqi` yo'lni allaqachon tozalagan (`..` yo'q), lekin yozishdan
    // oldin yakuniy yo'l nishon ichida ekanini QAYTA tekshiramiz —
    // xavfsizlik tekshiruvi bitta joyga tayanmasin.
    const toliq = join(nishon, ichkiYol)
    if (toliq !== nishon && !toliq.startsWith(`${nishon}/`)) continue

    mkdirSync(dirname(toliq), { recursive: true })
    writeFileSync(toliq, yozuv.mazmun)
    fayllar++
  }

  if (fayllar === 0) {
    rmSync(nishon, { recursive: true, force: true })
    throw new Error(`Folder "${skillPapkasi || '/'}" not found in the archive`)
  }

  return { fayllar, baytlar }
}

/** Ombordagi skill papkasini o'chiradi (o'rnatish bekor qilinganda) */
export function skillniOmbordanOchir(manbaId: string, skillId: string): void {
  rmSync(skillOmborYoli(manbaId, skillId), { recursive: true, force: true })
}

/** Manba o'chirilganda uning butun ombor papkasi ketadi */
export function manbaniOmbordanOchir(manbaId: string): void {
  rmSync(join(omborIldizi(), xavfsizNom(manbaId)), { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Loyihaga sinxronlash
// ---------------------------------------------------------------------------

/** Ish papkasi ichidagi boshqariladigan skill papkasi */
export const ISH_SKILL_PAPKASI = join('.platforma', 'skills')

export interface SinxronNatija {
  nusxalandi: number
  ochirildi: number
}

/**
 * Ish papkasidagi `.platforma/skills/` ni berilgan skilllar ro'yxatiga
 * moslashtiradi.
 *
 * XATO TASHLAMAYDI: nusxalash muvaffaqiyatsiz bo'lsa o'sha skill shunchaki
 * tushmay qoladi. Sessiya skill'siz ham to'liq ishlaydi — buning uchun
 * suhbatni yiqitish noto'g'ri bo'lardi (`loyiha-konteksti.ts` bilan bir xil
 * qoida).
 */
export function loyihagaSinxronla(ishPapkasi: string, skilllar: Skill[]): SinxronNatija {
  const ildiz = join(ishPapkasi, ISH_SKILL_PAPKASI)
  const natija: SinxronNatija = { nusxalandi: 0, ochirildi: 0 }

  // Nom bo'yicha xarita. Bir xil nomli ikki skill bo'lsa BIRINCHISI qoladi
  // (pi ham shunday qiladi) — papka nomi bitta bo'lgani uchun boshqa iloj yo'q.
  const kerakli = new Map<string, Skill>()
  for (const s of skilllar) {
    const nom = xavfsizNom(s.nom)
    if (!kerakli.has(nom)) kerakli.set(nom, s)
  }

  try {
    mkdirSync(ildiz, { recursive: true })
  } catch {
    return natija
  }

  // 1) Ortiqchani o'chirish — bazada yo'q papkalar
  let mavjud: string[] = []
  try {
    mavjud = readdirSync(ildiz)
  } catch {
    mavjud = []
  }
  for (const papka of mavjud) {
    if (kerakli.has(papka)) continue
    try {
      rmSync(join(ildiz, papka), { recursive: true, force: true })
      natija.ochirildi++
    } catch {
      // o'chirib bo'lmasa qoldiramiz — keyingi sessiyada qayta urinamiz
    }
  }

  // 2) Ombordan nusxalash. HAR SAFAR qayta nusxalanadi: ombor yangilangan
  //    bo'lishi (qayta o'rnatish) yoki agent nusxani buzgan bo'lishi mumkin.
  //    Skilllar kichik (bir necha KB) — bu qimmat amal emas.
  for (const [nom, skill] of kerakli) {
    const manba = skillOmborYoli(skill.manbaId, skill.id)
    if (!existsSync(manba)) continue

    const nishon = join(ildiz, nom)
    try {
      rmSync(nishon, { recursive: true, force: true })
      // `dereference` — ombordagi symlink (bo'lsa) nusxada oddiy faylga
      // aylanadi, ya'ni ish papkasidan chiqib ketadigan bog'lanish qolmaydi
      cpSync(manba, nishon, { recursive: true, dereference: true })
      natija.nusxalandi++
    } catch {
      continue
    }
  }

  return natija
}
