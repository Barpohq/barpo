// Qidiruv motorlari: `grep`, `find`, `ls` uchun ikkita backend.
//
// Har amal uchun ikkita funksiya bor — `...Rg()` va `...Node()` — va bitta
// tanlovchi (`grepQidir`, `findQidir`, `lsRoyxat`) `rg` bor-yo'qligiga qarab
// ularning birini chaqiradi.
//
// IKKALASI BIR XIL NATIJA QAYTARISHI SHART. Bu shunchaki niyat emas, test
// bilan majburlanadi: `qidiruv-bir-xillik.test.ts` bir xil kirish uchun
// ikkala funksiyani ALOHIDA chaqirib, natijalarni (tartibi bilan birga)
// solishtiradi.
//
// Bir xillikni ta'minlash uchun qabul qilingan qarorlar `qidiruv-asos.ts`
// boshidagi izohda batafsil yozilgan. Qisqacha:
//   gitignore — ikkalasida ham O'QILMAYDI (`--no-ignore` + qat'iy ro'yxat)
//   tartib    — ikkalasi ham `yolTartibi`/`moslikTartibi` bilan saralanadi
//   regex     — `rg --pcre2`, PCRE2siz `rg` ishlatilmaydi
//   symlink   — ikkalasida ham kuzatilmaydi
//   ikkilik   — ikkalasida ham NUL bayt evristikasi bilan tashlanadi
//
// `ls` uchun `rg` ishlatilmaydi — u qidiruv dasturi, papka ro'yxati emas.
// `find` uchun `fd` ham ishlatilmaydi: bu tizimda u `fdfind` nomi bilan
// turibdi (Debian), boshqa joyda `fd`, uchinchi joyda umuman yo'q — ya'ni
// yana bir "PC'ga bog'liq farq" manbai. Uning o'rniga `rg --files` ishlatiladi:
// u `rg` ning o'zida bor, glob filtri bir xil `ignore` crate'iga tayanadi
// va `grep` bilan bitta dasturni baham ko'radi.

import {
  baytlarniOqi,
  chegaraniTekshir,
  fayllarniAylan,
  FIND_CHEGARASI,
  globMosKeladimi,
  GREP_CHEGARASI,
  ikkilikmi,
  jarayonniIshgaTushir,
  LS_CHEGARASI,
  moslikTartibi,
  nisbiyYol,
  olchamniOl,
  papkaTashlanadimi,
  qatorniTayyorla,
  rgMavjudmi,
  TASHLANADIGAN_PAPKALAR,
  yolTartibi,
  type GrepMosligi,
  type PapkaElementi,
  type QidiruvNatijasi,
} from './qidiruv-asos.ts'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Chegaradan tashqaridagi yo'l uchun tashlanadigan xato */
export class ChegaraXatosi extends Error {
  constructor(yol: string, sabab: string) {
    super(`Permission denied: ${yol} — ${sabab}`)
    this.name = 'ChegaraXatosi'
  }
}

/** Naqsh noto'g'ri bo'lsa tashlanadigan xato */
export class NaqshXatosi extends Error {
  constructor(naqsh: string, sabab: string) {
    super(`Invalid pattern \`${naqsh}\`: ${sabab}`)
    this.name = 'NaqshXatosi'
  }
}

// ---------------------------------------------------------------------------
// Umumiy sozlamalar
// ---------------------------------------------------------------------------

export interface GrepSozlamalari {
  ishPapkasi: string
  pattern: string
  /** Qidiriladigan papka yoki fayl — standart: ish papkasi */
  path?: string
  /** Fayl nomi filtri (glob) */
  glob?: string
  caseInsensitive?: boolean
  /** Tashlanadigan papkalarni ham qidirish */
  barchasi?: boolean
  chegara?: number
  signal?: AbortSignal
}

export interface FindSozlamalari {
  ishPapkasi: string
  /** Glob naqshi */
  pattern: string
  path?: string
  barchasi?: boolean
  chegara?: number
  signal?: AbortSignal
}

export interface LsSozlamalari {
  ishPapkasi: string
  path?: string
  barchasi?: boolean
  chegara?: number
  signal?: AbortSignal
}

/**
 * Naqshni JS `RegExp` sifatida tekshiradi.
 *
 * `rg` yo'lida ham chaqiriladi — garchi qidiruvni `rg` qilsa ham. Sabab:
 * naqsh xatosi IKKALA backendda BIR XIL vaqtda va bir xil xabar bilan
 * chiqishi kerak. Aks holda `rg` bor PC'da PCRE2 xabari, `rg` yo'q PC'da
 * esa V8 xabari chiqardi — yana farq.
 */
function naqshniTekshir(pattern: string, caseInsensitive: boolean): RegExp {
  if (pattern.length === 0) {
    throw new NaqshXatosi(pattern, 'the pattern is empty')
  }
  try {
    return new RegExp(pattern, caseInsensitive ? 'i' : '')
  } catch (xato) {
    throw new NaqshXatosi(pattern, xato instanceof Error ? xato.message : String(xato))
  }
}

/** Chegarani tekshirib, o'tmasa xato tashlaydi */
async function chegaraYokiXato(ishPapkasi: string, yol: string | undefined): Promise<string> {
  const natija = await chegaraniTekshir(ishPapkasi, yol)
  if (!natija.ok) {
    // Xato xabarida NISBIY yo'l ishlatiladi — absolut yo'l chiqib qolsa
    // fayl tizimi tuzilishi oshkor bo'lardi
    throw new ChegaraXatosi(yol ?? '.', natija.sabab ?? 'outside the allowed boundary')
  }
  return natija.absolut
}

/**
 * Foydalanuvchi so'ragan yo'lning o'zi tashlanadigan papka ichidami.
 *
 * Agar agent aniq `node_modules/paket` ni so'rasa, uni ko'rsatish kerak —
 * "standart holda tashlab yuborish" faqat AYLANIB CHIQISHDA qo'llanadi,
 * aniq so'rovda emas. Ikkala backendda ham shu qoida.
 */
function aniqSoralganmi(ishPapkasi: string, absolut: string): boolean {
  const nisbiy = nisbiyYol(ishPapkasi, absolut)
  if (nisbiy === '.') return false
  return nisbiy.split('/').some((qism) => (TASHLANADIGAN_PAPKALAR as readonly string[]).includes(qism))
}

// ===========================================================================
// grep
// ===========================================================================

/**
 * `rg` backend'i.
 *
 * Bayroqlar bir xillik uchun tanlangan:
 *   --no-ignore  gitignore o'qilmasin (Node zaxirasi ham o'qimaydi)
 *   --hidden     yashirin fayllar ko'rinsin (Node ham ko'rsatadi)
 *   --pcre2      JS `RegExp` ga eng yaqin shevа
 *   --no-config  foydalanuvchi `RIPGREP_CONFIG_PATH` orqali bayroq
 *                qo'shib natijani o'zgartira olmasin — bu jimgina farq
 *                keltirib chiqaradigan eng nozik joy edi
 *   --line-number, --no-heading, --with-filename — `fayl:qator:matn` shakli
 *   -g '!nom'    tashlanadigan papkalar (Node bilan bir xil ro'yxatdan)
 */
export async function grepRg(sozlama: GrepSozlamalari): Promise<QidiruvNatijasi<GrepMosligi>> {
  const chegara = sozlama.chegara ?? GREP_CHEGARASI
  const absolut = await chegaraYokiXato(sozlama.ishPapkasi, sozlama.path)
  naqshniTekshir(sozlama.pattern, sozlama.caseInsensitive ?? false)

  const barchasi = sozlama.barchasi ?? aniqSoralganmi(sozlama.ishPapkasi, absolut)

  const argumentlar = [
    '--no-config',
    '--no-ignore',
    '--hidden',
    '--pcre2',
    '--line-number',
    '--no-heading',
    '--with-filename',
    '--color=never',
    // Symlink kuzatilmaydi — Node zaxirasi ham kuzatmaydi (standart xulq,
    // aniqlik uchun ochiq yozilgan)
    '--no-follow',
  ]

  if (sozlama.caseInsensitive) argumentlar.push('--ignore-case')
  if (sozlama.glob) argumentlar.push('--glob', sozlama.glob)
  if (!barchasi) {
    for (const papka of TASHLANADIGAN_PAPKALAR) argumentlar.push('--glob', `!${papka}`)
  }

  // `--` dan keyin naqsh: `-` bilan boshlanadigan naqsh bayroq deb
  // o'qilmasin. `-e` ham shu vazifani bajaradi, lekin ikkalasi birga
  // ishonchliroq.
  argumentlar.push('-e', sozlama.pattern, '--', '.')

  const natija = await jarayonniIshgaTushir('rg', argumentlar, {
    cwd: absolut,
    signal: sozlama.signal,
  })

  // rg: 0 — topildi, 1 — topilmadi (xato emas), 2 — haqiqiy xato
  if (natija.kod === 1 && natija.stdout.length === 0) {
    return { elementlar: [], kesildi: false, backend: 'rg' }
  }
  if (natija.kod !== 0 && natija.kod !== 1 && !natija.toxtatildi) {
    throw new Error(`rg error (${natija.kod}): ${natija.stderr.trim().slice(0, 300)}`)
  }

  const mosliklar: GrepMosligi[] = []
  for (const qator of natija.stdout.split('\n')) {
    if (!qator) continue
    // Shakl: `./yol/fayl.ts:12:matn` — yo'lda ham `:` bo'lishi mumkin,
    // shuning uchun chapdan ikki marta ajratamiz va o'rtasi raqam
    // ekanini tekshiramiz.
    const ajratilgan = rgQatoriniAjrat(qator)
    if (!ajratilgan) continue

    // `rg` `cwd` ga nisbiy `./x` beradi; biz ish papkasiga nisbiy
    // ko'rinishga o'tkazamiz — Node zaxirasi ham shunday qaytaradi
    const absolutFayl = join(absolut, ajratilgan.yol)
    mosliklar.push({
      yol: nisbiyYol(sozlama.ishPapkasi, absolutFayl),
      qator: ajratilgan.qator,
      matn: qatorniTayyorla(ajratilgan.matn),
    })
  }

  return chegaralaVaSarala(mosliklar, chegara, 'rg')
}

/** `./yol:12:matn` shaklini ajratadi */
function rgQatoriniAjrat(qator: string): { yol: string; qator: number; matn: string } | undefined {
  // Yo'lda `:` bo'lishi mumkin (`a:b.ts:12:matn`), shuning uchun chapdan
  // qidirmaymiz — har `:` dan keyin raqam va yana `:` kelishini sinaymiz.
  let izlash = 0
  while (true) {
    const birinchi = qator.indexOf(':', izlash)
    if (birinchi < 0) return undefined
    const ikkinchi = qator.indexOf(':', birinchi + 1)
    if (ikkinchi < 0) return undefined

    const raqamMatni = qator.slice(birinchi + 1, ikkinchi)
    if (/^\d+$/.test(raqamMatni)) {
      let yol = qator.slice(0, birinchi)
      if (yol.startsWith('./')) yol = yol.slice(2)
      return { yol, qator: Number(raqamMatni), matn: qator.slice(ikkinchi + 1) }
    }
    izlash = birinchi + 1
  }
}

/**
 * Sof Node backend'i.
 *
 * `rg` bilan bir xil bo'lishi uchun ataylab shunday qilingan:
 *   - gitignore o'qilmaydi (yuqoridagi qarorga muvofiq)
 *   - yashirin fayllar qidiriladi
 *   - ikkilik fayllar tashlanadi (NUL bayt evristikasi)
 *   - symlinklar kuzatilmaydi
 *   - natija `moslikTartibi` bilan saralanadi
 */
export async function grepNode(sozlama: GrepSozlamalari): Promise<QidiruvNatijasi<GrepMosligi>> {
  const chegara = sozlama.chegara ?? GREP_CHEGARASI
  const absolut = await chegaraYokiXato(sozlama.ishPapkasi, sozlama.path)
  const naqsh = naqshniTekshir(sozlama.pattern, sozlama.caseInsensitive ?? false)

  const barchasi = sozlama.barchasi ?? aniqSoralganmi(sozlama.ishPapkasi, absolut)
  const mosliklar: GrepMosligi[] = []

  for await (const fayl of fayllarniAylan({
    ishPapkasi: sozlama.ishPapkasi,
    boshlanish: absolut,
    barchasi,
    signal: sozlama.signal,
  })) {
    // Glob filtri — `absolut` ga nisbiy yo'lga qo'llanadi, chunki `rg` ham
    // glob'ni o'zi qidirayotgan papkaga nisbatan qo'llaydi
    if (sozlama.glob) {
      const papkagaNisbiy = nisbiyYol(absolut, fayl.absolut)
      if (!globMosKeladimi(sozlama.glob, papkagaNisbiy)) continue
    }

    const baytlar = await baytlarniOqi(fayl.absolut)
    if (!baytlar) continue
    // Ikkilik fayl — `rg` uni tashlab ketadi, biz ham
    if (ikkilikmi(baytlar)) continue

    // `fatal: false` — noto'g'ri UTF-8 baytlar xato tashlamay `` bo'ladi.
    // `rg` ham shunday qiladi: buzuq kodlangan faylni butunlay tashlab
    // yubormaydi, o'qiy olgan qismini qidiradi.
    const matn = new TextDecoder('utf-8', { fatal: false }).decode(baytlar)
    const qatorlar = matn.split('\n')

    for (let i = 0; i < qatorlar.length; i += 1) {
      // Oxirgi element `\n` dan keyingi bo'sh qism bo'lsa — qator emas
      if (i === qatorlar.length - 1 && qatorlar[i] === '') break

      // `lastIndex` muammosi bo'lmasligi uchun `g` bayrog'i ishlatilmaydi
      if (!naqsh.test(qatorlar[i]!)) continue
      mosliklar.push({
        yol: fayl.nisbiy,
        qator: i + 1,
        matn: qatorniTayyorla(qatorlar[i]!),
      })
    }
  }

  return chegaralaVaSarala(mosliklar, chegara, 'node')
}

/**
 * Saralab, chegaraga kesadi.
 *
 * Tartib SARALASHDAN KEYIN kesiladi — bu muhim: agar avval kesib keyin
 * saralasak, `rg` ning tasodifiy tartibi tufayli ikkala backend BOSHQA
 * 200 talikni tanlab qolardi. Endi ikkalasi ham "eng birinchi 200 ta"ni
 * bir xil tartibda beradi.
 */
function chegaralaVaSarala(
  mosliklar: GrepMosligi[],
  chegara: number,
  backend: 'rg' | 'node',
): QidiruvNatijasi<GrepMosligi> {
  mosliklar.sort(moslikTartibi)
  const kesildi = mosliklar.length > chegara
  return { elementlar: kesildi ? mosliklar.slice(0, chegara) : mosliklar, kesildi, backend }
}

/** `rg` bor bo'lsa undan, aks holda Node zaxirasidan foydalanadi */
export async function grepQidir(sozlama: GrepSozlamalari): Promise<QidiruvNatijasi<GrepMosligi>> {
  return (await rgMavjudmi()) ? grepRg(sozlama) : grepNode(sozlama)
}

// ===========================================================================
// find
// ===========================================================================

/**
 * `rg --files` backend'i.
 *
 * `fd` ATAYLAB ishlatilmaydi: u bu tizimda `fdfind` (Debian), boshqa
 * distributivda `fd`, ko'p PC'da esa umuman yo'q. Uchta holatni ushlash
 * — uchta xulq farqi ehtimoli. `rg --files` esa `rg` ning o'zida bor,
 * `grep` bilan bitta bayroq to'plamiga va bitta glob crate'iga tayanadi.
 */
export async function findRg(sozlama: FindSozlamalari): Promise<QidiruvNatijasi<string>> {
  const chegara = sozlama.chegara ?? FIND_CHEGARASI
  const absolut = await chegaraYokiXato(sozlama.ishPapkasi, sozlama.path)
  const barchasi = sozlama.barchasi ?? aniqSoralganmi(sozlama.ishPapkasi, absolut)

  const argumentlar = ['--no-config', '--no-ignore', '--hidden', '--no-follow', '--files']
  if (sozlama.pattern) argumentlar.push('--glob', sozlama.pattern)
  if (!barchasi) {
    for (const papka of TASHLANADIGAN_PAPKALAR) argumentlar.push('--glob', `!${papka}`)
  }
  argumentlar.push('--', '.')

  const natija = await jarayonniIshgaTushir('rg', argumentlar, {
    cwd: absolut,
    signal: sozlama.signal,
  })

  if (natija.kod !== 0 && natija.kod !== 1 && !natija.toxtatildi) {
    throw new Error(`rg error (${natija.kod}): ${natija.stderr.trim().slice(0, 300)}`)
  }

  const yollar: string[] = []
  for (const qator of natija.stdout.split('\n')) {
    if (!qator) continue
    const toza = qator.startsWith('./') ? qator.slice(2) : qator
    yollar.push(nisbiyYol(sozlama.ishPapkasi, join(absolut, toza)))
  }

  return yollarniChegarala(yollar, chegara, 'rg')
}

/** Sof Node backend'i — `fayllarniAylan` + `globMosKeladimi` */
export async function findNode(sozlama: FindSozlamalari): Promise<QidiruvNatijasi<string>> {
  const chegara = sozlama.chegara ?? FIND_CHEGARASI
  const absolut = await chegaraYokiXato(sozlama.ishPapkasi, sozlama.path)
  const barchasi = sozlama.barchasi ?? aniqSoralganmi(sozlama.ishPapkasi, absolut)

  const yollar: string[] = []
  for await (const fayl of fayllarniAylan({
    ishPapkasi: sozlama.ishPapkasi,
    boshlanish: absolut,
    barchasi,
    signal: sozlama.signal,
  })) {
    if (sozlama.pattern) {
      const papkagaNisbiy = nisbiyYol(absolut, fayl.absolut)
      if (!globMosKeladimi(sozlama.pattern, papkagaNisbiy)) continue
    }
    yollar.push(fayl.nisbiy)
  }

  return yollarniChegarala(yollar, chegara, 'node')
}

function yollarniChegarala(
  yollar: string[],
  chegara: number,
  backend: 'rg' | 'node',
): QidiruvNatijasi<string> {
  yollar.sort(yolTartibi)
  const kesildi = yollar.length > chegara
  return { elementlar: kesildi ? yollar.slice(0, chegara) : yollar, kesildi, backend }
}

export async function findQidir(sozlama: FindSozlamalari): Promise<QidiruvNatijasi<string>> {
  return (await rgMavjudmi()) ? findRg(sozlama) : findNode(sozlama)
}

// ===========================================================================
// ls
// ===========================================================================

/**
 * Papka ro'yxati — faqat Node.
 *
 * Bu yerda ikkinchi backend YO'Q va bo'lishi ham shart emas: `ls` tashqi
 * dasturga tayanmaydi, ya'ni "PC'ga bog'liq farq" manbai umuman paydo
 * bo'lmaydi. Backend maydoni baribir `'node'` bo'lib qaytadi, shunda
 * natija shakli qolgan ikki tool bilan bir xil qoladi.
 */
export async function lsRoyxat(sozlama: LsSozlamalari): Promise<QidiruvNatijasi<PapkaElementi>> {
  const chegara = sozlama.chegara ?? LS_CHEGARASI
  const absolut = await chegaraYokiXato(sozlama.ishPapkasi, sozlama.path)
  const barchasi = sozlama.barchasi ?? aniqSoralganmi(sozlama.ishPapkasi, absolut)

  // `Dirent[]` ochiq yoziladi — `ReturnType<typeof readdir>` overload
  // ichidan Buffer variantini tanlab qolardi
  let xom: Dirent[]
  try {
    xom = await readdir(absolut, { withFileTypes: true })
  } catch (xato) {
    const kod = (xato as NodeJS.ErrnoException).code
    if (kod === 'ENOTDIR') throw new Error(`Not a directory: ${nisbiyYol(sozlama.ishPapkasi, absolut)}`)
    if (kod === 'ENOENT') throw new Error(`Not found: ${nisbiyYol(sozlama.ishPapkasi, absolut)}`)
    throw new Error(`Could not read: ${nisbiyYol(sozlama.ishPapkasi, absolut)}`)
  }

  const elementlar: PapkaElementi[] = []
  for (const element of xom) {
    if (element.isDirectory() && papkaTashlanadimi(element.name, barchasi)) continue

    const tur: PapkaElementi['tur'] = element.isDirectory()
      ? 'papka'
      : element.isSymbolicLink()
        ? 'symlink'
        : 'fayl'

    elementlar.push({
      nom: element.name,
      tur,
      // Papka o'lchami ma'nosiz (fayl tizimi metadata'si), ko'rsatmaymiz
      olcham: tur === 'fayl' ? await olchamniOl(join(absolut, element.name)) : undefined,
    })
  }

  // Papkalar avval, keyin fayllar — har guruh ichida nom bo'yicha.
  // Bu `ls` ning odatiy ko'rinishi va agent uchun o'qishga qulay.
  elementlar.sort((a, b) => {
    const aPapka = a.tur === 'papka' ? 0 : 1
    const bPapka = b.tur === 'papka' ? 0 : 1
    if (aPapka !== bPapka) return aPapka - bPapka
    return yolTartibi(a.nom, b.nom)
  })

  const kesildi = elementlar.length > chegara
  return {
    elementlar: kesildi ? elementlar.slice(0, chegara) : elementlar,
    kesildi,
    backend: 'node',
  }
}
