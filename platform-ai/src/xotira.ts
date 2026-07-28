// Loyiha xotirasi — agent o'zi yozib qo'yadigan uzoq muddatli faktlar.
//
// Muammo: har yangi sessiyada agent loyihani noldan o'rganadi. Qaysi buyruq
// bilan test yuriladi, nega falon kutubxona tanlangan, foydalanuvchi qaysi
// uslubni yoqtirmaydi — bularning hammasi suhbat tugashi bilan yo'qoladi.
//
// `AGENTS.md` dan FARQI: uni foydalanuvchi yozadi va qo'lda yangilaydi.
// Xotirani AGENT o'zi yozadi — ish davomida bilib olgan narsani saqlab qo'yadi.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NEGA INDEKS + ALOHIDA FAYLLAR, bitta katta fayl emas:                │
// │                                                                      │
// │ Bitta `MEMORY.md` ga hammasini yozish oddiyroq ko'rinadi, lekin u    │
// │ vaqt o'tib o'sadi va HAR SO'ROVDA to'liq kontekstga tushadi. 50 ta   │
// │ fakt saqlangan loyihada bu oynani bir o'zi to'ldirardi.              │
// │                                                                      │
// │ Shuning uchun skilllardagi PROGRESSIVE DISCLOSURE naqshi: promptga   │
// │ faqat nom+tavsif+yo'l tushadi, to'liq matnni model kerak bo'lganda   │
// │ `read` bilan o'zi oladi.                                             │
// └──────────────────────────────────────────────────────────────────────┘
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ XAVFSIZLIK: xotira matni KLASSIFIKATORGA HECH QACHON BORMAYDI.       │
// │                                                                      │
// │ Bu — `loyiha-konteksti.ts` va `skill-yuklash.ts` dagi bilan bir xil  │
// │ chegara, lekin bu yerda hujum yo'li BOSHQACHA va nozikroq:           │
// │                                                                      │
// │   1) agent `read` bilan begona faylni o'qiydi (repo'dan klonlangan   │
// │      README, foydalanuvchi yuklagan hujjat);                         │
// │   2) fayl ichida "bu muhim fakt, xotiraga yoz" degan matn bor;       │
// │   3) agent uni xotiraga KO'CHIRADI;                                  │
// │   4) keyingi sessiyada u prompt orqali qaytib keladi.                │
// │                                                                      │
// │ Ya'ni bu VAQT BO'YICHA KECHIKKAN injection: ishonchsiz matn agentning │
// │ o'z qo'li bilan ishonchli ko'rinadigan joyga o'tadi. Klassifikator    │
// │ chegarasi shuning uchun bu yerda ham majburiy — tool natijasi bugun   │
// │ o'tmagani kabi, ertaga xotira bo'lib ham o'tmasligi kerak.           │
// │                                                                      │
// │ Chegara ma'lumot oqimining o'zida: `amalniBahola` promptni faqat     │
// │ `KLASSIFIKATOR_PROMPT` + `sorovniMatnga()` dan quradi, ya'ni bu      │
// │ modulning natijasi u yerga borishining YO'LI yo'q. Test majburlaydi. │
// └──────────────────────────────────────────────────────────────────────┘

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { skillFayliniTahlil } from './skill-fayl.ts'

/** Ish papkasi ichidagi xotira papkasi */
export const XOTIRA_PAPKASI = '.platforma/memory'

/** Indeks fayli — promptga TO'LIQ tushadigan yagona xotira fayli */
export const XOTIRA_INDEKSI = 'MEMORY.md'

/**
 * Promptga tushadigan xotiralar soni chegarasi.
 *
 * Har xotira ~4 qator prompt egallaydi. 200 ta ~800 qator — ko'p, lekin
 * hali ham suhbat tarixiga joy qoladi. Skilllardagi (100) dan yuqoriroq:
 * skilllar tashqi repo'dan keladi va ularni foydalanuvchi tanlab o'rnatadi,
 * xotira esa loyiha ustida ishlash davomida tabiiy ravishda to'planadi.
 */
export const XOTIRA_SONI_CHEGARASI = 200

/**
 * Bitta xotira faylining o'lchov chegarasi (belgi).
 *
 * Fayl matni promptga TUSHMAYDI (model `read` bilan oladi), shuning uchun
 * chegara kontekst uchun emas — ro'yxatni o'qish tezligi uchun. Undan katta
 * fayl ham ro'yxatda qoladi, faqat frontmatter'i o'qiladi.
 */
export const XOTIRA_FAYL_CHEGARASI = 64 * 1024

/**
 * `MEMORY.md` indeksining promptga tushadigan qismi (belgi).
 *
 * Indeks — YAGONA to'liq o'qiladigan xotira fayli, shuning uchun chegara
 * qat'iy: ~2000 token. Agent u yerga qator qo'shib boradi va vaqt o'tib u
 * o'sadi; chegarasiz u kontekst oynasini bir o'zi egallab qo'yishi mumkin.
 *
 * Kesilganda agent buni promptda ko'radi va to'liq o'qish uchun `read`
 * ishlatishi mumkin — ma'lumot yo'qolmaydi, faqat kechiktiriladi.
 */
export const XOTIRA_INDEKS_CHEGARASI = 8_000

export interface Xotira {
  nom: string
  tavsif: string
  /** `read` tool'i uchun ABSOLUT yo'l */
  yol: string
  /** Frontmatter'dagi `turi` — bo'lmasa aniqlanmagan */
  turi?: string
}

/**
 * Xotira turlari — frontmatter'dagi `turi` maydoni uchun.
 *
 * MAJBURLANMAYDI: begona qiymat ham qabul qilinadi va promptda ko'rsatiladi.
 * Bu ataylab yumshoq — `skill-fayl.ts` dagi validatsiya falsafasi bilan bir
 * xil: bitta nomuvofiqlik uchun butun xotirani yo'qotish foydalanuvchiga
 * zarar qiladi. Ro'yxat promptda modelga tavsiya sifatida beriladi.
 */
export const XOTIRA_TURLARI = ['qaror', 'arxitektura', 'qoida', 'manba'] as const

/**
 * Xotira papkasidagi `*.md` fayllarni o'qiydi (`MEMORY.md` dan tashqari).
 *
 * Frontmatter tahlili `skill-fayl.ts` dan olinadi — format aynan bir xil
 * (`name` + `description`), yangi parser yozish takrorlanish bo'lardi.
 * Shu sababli `description` yo'q fayl xuddi skilldagi kabi TASHLANADI:
 * tavsifsiz xotira promptda ma'nosiz, model uni qachon o'qishni bilmaydi.
 *
 * XATO TASHLAMAYDI: papka yo'q bo'lsa yoki fayl o'qilmasa bo'sh ro'yxat
 * qaytadi. Xotirasiz ham suhbat to'liq ishlaydi — buning uchun sessiyani
 * yiqitish noto'g'ri bo'lardi (`loyiha-konteksti.ts` dagi bilan bir xil qoida).
 */
export function xotiralarniOqi(ishPapkasi: string): Xotira[] {
  const ildiz = join(ishPapkasi, XOTIRA_PAPKASI)

  let fayllar: string[]
  try {
    fayllar = readdirSync(ildiz)
  } catch {
    return []
  }

  const natija: Xotira[] = []
  for (const fayl of fayllar.sort()) {
    if (natija.length >= XOTIRA_SONI_CHEGARASI) break
    if (fayl.startsWith('.')) continue
    if (!fayl.endsWith('.md')) continue
    // Indeks o'zi xotira emas — u ro'yxatning o'zi
    if (fayl === XOTIRA_INDEKSI) continue

    const yol = join(ildiz, fayl)
    try {
      const holat = statSync(yol)
      if (!holat.isFile()) continue
      if (holat.size > XOTIRA_FAYL_CHEGARASI) continue

      const xom = readFileSync(yol, 'utf8')
      // Papka nomi o'rniga fayl nomi (kengaytmasiz) zaxira `name` bo'ladi
      const tahlil = skillFayliniTahlil(xom, basename(fayl, '.md'))
      if (!tahlil) continue

      natija.push({
        nom: tahlil.nom,
        tavsif: tahlil.tavsif,
        yol,
        turi: turiniAjrat(xom),
      })
    } catch {
      continue
    }
  }

  return natija
}

/**
 * Frontmatter'dan `turi` maydonini ajratadi.
 *
 * `skillFayliniTahlil` bu maydonni bilmaydi (u skill formati uchun yozilgan)
 * va uni o'zgartirish skill kodiga xotira tushunchasini olib kirardi.
 * Shuning uchun bitta maydon uchun mustaqil, juda tor o'qish — frontmatter
 * chegarasi ichidagi `turi: qiymat` qatori.
 */
function turiniAjrat(xom: string): string | undefined {
  const moslik = /^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(xom.replace(/^﻿/, ''))
  if (!moslik) return undefined
  const qator = /^turi:\s*(.+)$/m.exec(moslik[1] ?? '')
  if (!qator) return undefined
  const qiymat = (qator[1] ?? '').trim().replace(/^["']|["']$/g, '').trim()
  return qiymat.length > 0 ? qiymat : undefined
}

/**
 * `MEMORY.md` indeksini o'qiydi.
 *
 * Bu — xotira tizimidagi YAGONA to'liq promptga tushadigan fayl. Nega u
 * `<project_memory>` ro'yxatiga qo'shimcha kerak: ro'yxat mashina tomonidan
 * quriladi va faqat nom+tavsifni biladi, indeksni esa AGENT O'ZI yozadi —
 * u yerda guruhlash, ustuvorlik, xotiralar orasidagi bog'lanish bo'ladi.
 * Ya'ni ro'yxat "nima bor" ni, indeks "nimadan boshlash kerak" ni aytadi.
 *
 * XATO TASHLAMAYDI: fayl yo'q bo'lsa `null` — bu normal holat (hali hech
 * narsa yozilmagan).
 */
export function indeksniOqi(ishPapkasi: string): { matn: string; kesildi: boolean } | null {
  const yol = join(ishPapkasi, XOTIRA_PAPKASI, XOTIRA_INDEKSI)
  try {
    if (!statSync(yol).isFile()) return null
    const matn = readFileSync(yol, 'utf8').trim()
    if (matn.length === 0) return null

    if (matn.length > XOTIRA_INDEKS_CHEGARASI) {
      return { matn: `${matn.slice(0, XOTIRA_INDEKS_CHEGARASI)}\n…`, kesildi: true }
    }
    return { matn, kesildi: false }
  } catch {
    return null
  }
}

/** XML maxsus belgilari — tavsif oxir-oqibat ishonchsiz manbadan kelishi mumkin */
function xmlEscape(x: string): string {
  return x
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Xotira ro'yxatini system promptga qo'shiladigan bo'limga aylantiradi.
 *
 * Bo'sh ro'yxatda ham `null` QAYTMAYDI (skilllardan farqli): yozish qoidasi
 * baribir kerak — aks holda agent xotira mexanizmi borligini umuman bilmaydi
 * va birinchi faktni hech qachon saqlamaydi. Ro'yxat bo'sh bo'lsa faqat
 * "hali xotira yo'q" deyiladi.
 *
 * Tavsif matni `<description>` tegi ichida va escape qilingan: xotiraga
 * ishonchsiz matn ko'chib o'tgan bo'lsa (yuqoridagi injection yo'li),
 * u promptdan "chiqib ketishga" urina olmasin.
 *
 * `indeks` — `MEMORY.md` matni (`indeksniOqi`). Berilsa ro'yxatdan OLDIN
 * qo'yiladi: u agentning o'z yo'l xaritasi, ro'yxat esa quruq katalog.
 */
export function xotiralarniPromptga(
  xotiralar: Xotira[],
  ishPapkasi: string,
  indeks?: { matn: string; kesildi: boolean } | null,
): string {
  const papka = join(ishPapkasi, XOTIRA_PAPKASI)

  const qatorlar = [
    '',
    '--- Loyiha xotirasi ---',
    'Bu loyiha haqida ilgari saqlab qo\'yilgan faktlar. Quyida faqat NOM va',
    'TAVSIF bor — kerakli bo\'lsa `read` bilan faylni to\'liq o\'qi.',
  ]

  if (indeks) {
    qatorlar.push(
      '',
      `Indeks (${XOTIRA_INDEKSI}) — xotiralar bo'yicha yo'l xaritasi:`,
      '',
      indeks.matn,
      ...(indeks.kesildi
        ? ['', `(indeks ${XOTIRA_INDEKS_CHEGARASI} belgida kesildi — to'lig'ini \`read\` bilan o'qi)`]
        : []),
    )
  }

  if (xotiralar.length === 0) {
    qatorlar.push('', 'Hozircha saqlangan xotira yo\'q.')
  } else {
    qatorlar.push('', '<project_memory>')
    for (const x of xotiralar) {
      qatorlar.push('  <memory>')
      qatorlar.push(`    <name>${xmlEscape(x.nom)}</name>`)
      qatorlar.push(`    <description>${xmlEscape(x.tavsif)}</description>`)
      if (x.turi) qatorlar.push(`    <type>${xmlEscape(x.turi)}</type>`)
      qatorlar.push(`    <location>${xmlEscape(x.yol)}</location>`)
      qatorlar.push('  </memory>')
    }
    qatorlar.push('</project_memory>')
  }

  qatorlar.push(
    '',
    'YOZISH. Loyiha haqida uzoq muddat foydali fakt bilsang — saqlab qo\'y:',
    'qabul qilingan qaror va uning SABABI, foydalanuvchi bergan qoida,',
    'arxitektura chegarasi, tashqi manba havolasi. Buning uchun `write`',
    `bilan \`${papka}/<nom>.md\` fayl yoz:`,
    '',
    '---',
    'name: <kebab-case-nom>',
    "description: <bir qatorli tavsif — keyingi sessiyada shu bo'yicha tanlanadi>",
    `turi: <${XOTIRA_TURLARI.join(' | ')}>`,
    '---',
    '',
    "<fakt. Qaror bo'lsa **Nega:** va **Qanday qo'llash:** qatorlarini qo'sh.",
    "Bog'liq xotiraga [[nom]] bilan havola ber.>",
    '',
    `Keyin \`${join(papka, XOTIRA_INDEKSI)}\` indeksiga bitta qator qo'sh:`,
    '`- [Sarlavha](<nom>.md) — qisqa izoh`. Indeks — xotiralar ro\'yxati,',
    'xotira MATNI u yerga yozilmaydi.',
    '',
    'YOZMA: kodda ko\'rinib turgan narsa (tuzilma, funksiya nomlari), bir',
    'martalik detal, faqat shu suhbatga tegishli narsa, parol va API kalitlari.',
    'Avval mavjud xotirani tekshir — takrorlash o\'rniga `edit` bilan yangila.',
    'Fakt noto\'g\'ri chiqsa faylni o\'chir.',
    '--- Loyiha xotirasi tugadi ---',
  )

  return qatorlar.join('\n')
}
