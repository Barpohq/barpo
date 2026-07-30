// Qidiruv tool'larining umumiy poydevori: naqsh, chegara va ikki backend.
//
// Bu yerda TOOL yo'q — faqat `grep`/`find`/`ls` uchun kerak bo'ladigan
// mushtarak qismlar: glob→regex aylantirish, papka aylanib chiqish,
// ish papkasi chegarasini tekshirish va `rg` ni topish.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ ENG MUHIM SHART: IKKI BACKEND BIR XIL NATIJA BERISHI KERAK.          │
// │                                                                      │
// │ `rg` bor PC'da va yo'q PC'da agent BOSHQACHA ishlasa — bu jimgina    │
// │ buziladigan xato: hech kim sezmaydi, faqat "menda ishlaydi, sende    │
// │ ishlamaydi" bo'lib qoladi. Shuning uchun pastdagi har bir qaror      │
// │ "tezroq" emas, "bir xil" mezoni bilan qabul qilingan.                │
// └──────────────────────────────────────────────────────────────────────┘
//
// Bir xillikni buzishi mumkin bo'lgan uchta joy aniqlandi va uchalasi ham
// ataylab yopildi:
//
//   1) GITIGNORE. `rg` standart holda `.gitignore` ni hurmat qiladi, Node'da
//      esa uni to'liq takrorlash (ichma-ich `.gitignore`, inkor qoidalari
//      `!naqsh`, `**` semantikasi, `.git/info/exclude`, global gitignore)
//      juda katta sirt — u yerda albatta farq paydo bo'ladi.
//      QAROR: gitignore IKKALA backendda ham O'QILMAYDI (`rg --no-ignore`).
//      Uning o'rniga pastdagi `TASHLANADIGAN_PAPKALAR` — qat'iy, qisqa va
//      ikkala tomonda bir xil ro'yxat. Foydalanuvchi `.gitignore` dagi
//      faylni qidirsa topadi; bu bizga kerak, chunki agent ko'pincha
//      aynan `dist/` yoki `.env.example` kabi narsalarni so'raydi.
//
//   2) TARTIB. `rg` parallel aylanadi va natija tartibi HAR ISHGA TUSHISHDA
//      BOSHQACHA (sinovda uch marta uch xil tartib chiqdi). Node'da esa
//      `readdir` tartibi fayl tizimiga bog'liq.
//      QAROR: ikkala backend ham natijani `yolTartibi` bilan yakuniy
//      saralaydi. `rg` ga `--sort path` berilmaydi — u parallellikni
//      o'chiradi va baribir bizning saralashimiz yakuniy so'zni aytadi.
//
//   3) REGEX SHEVASI. `rg` ning Rust engine'i `(?=...)` va `(?<=...)` ni
//      RAD ETADI, JS `RegExp` esa qo'llab-quvvatlaydi. Ya'ni bitta naqsh
//      bir PC'da ishlab, ikkinchisida xato berishi mumkin edi.
//      QAROR: `rg` ga `--pcre2` beriladi (PCRE2 shevasi JS'ga eng yaqin).
//      PCRE2 siz qurilgan `rg` esa umuman ishlatilmaydi — `rgMavjudmi()`
//      buni tekshiradi va bunday holda Node zaxirasiga o'tadi. Shunday
//      qilib "qo'llab-quvvatlanadigan naqsh to'plami" ikkala yo'lda bir xil.

import { spawn } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

// ---------------------------------------------------------------------------
// Standart chegaralar
// ---------------------------------------------------------------------------

/**
 * Standart holda aylanib chiqilmaydigan papkalar.
 *
 * Ataylab QISQA va QAT'IY: bu ro'yxat gitignore o'rnini bosadi, shuning
 * uchun u ikkala backendda ham AYNAN bir xil qo'llanishi shart. Har yangi
 * element qo'shilganda `rg` tomonida `-g '!nom'` ham, Node tomonida
 * `papkaTashlanadimi()` ham o'zgarishi kerak — shu sababli ikkalasi ham
 * shu yagona ro'yxatdan o'qiydi.
 *
 * Foydalanuvchi aniq shu papkani so'rasa (`path: 'node_modules/x'`) yoki
 * `barchasi: true` bersa — ro'yxat chetlab o'tiladi.
 */
export const TASHLANADIGAN_PAPKALAR = [
  '.git',
  // Platformaning o'z hududi: skilllar, xotira va sessiya yuklamalari.
  //
  // NEGA TASHLANADI. Loyihaga ulangan suhbatlar bitta papkani bo'lishadi
  // (`ish-papkasi.ts`), yuklamalar esa `.platforma/sessiyalar/<sid>/` da
  // yashaydi. Tashlanmasa agent `grep` qilganda BOSHQA suhbatlarning
  // biriktirilgan fayllaridan natija chiqardi — shovqin va suhbatlar
  // orasida ma'lumot sizishi.
  //
  // ONGLI YON TA'SIR: skilllar (`.platforma/skills`) va xotira
  // (`.platforma/memory`) ham qidiruvdan chiqadi. Ular promptga baribir
  // to'liq tushadi (`skill-yuklash.ts`, `xotira.ts`), ya'ni agent ularni
  // ko'radi — faqat `grep` bilan izlay olmaydi. Almashtirish ataylab:
  // begona suhbat fayllarining ko'rinmasligi muhimroq.
  //
  // Aniq yo'l berilsa ro'yxat baribir chetlab o'tiladi (yuqoridagi izoh),
  // ya'ni agent `read('.platforma/sessiyalar/…/fayllar/rasm.png')` ni
  // bemalol o'qiydi — biriktirma oqimi shunga tayanadi.
  '.platforma',
  'node_modules',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.venv',
  '__pycache__',
  'target',
  'vendor',
] as const

const TASHLANADIGAN_TOPLAM: ReadonlySet<string> = new Set(TASHLANADIGAN_PAPKALAR)

/** Qator shu uzunlikdan oshsa kesiladi — minified fayl butun natijani bosmasin */
export const QATOR_CHEGARASI = 500

/** `grep` uchun standart mos kelish chegarasi */
export const GREP_CHEGARASI = 200

/** `find` uchun standart fayl chegarasi */
export const FIND_CHEGARASI = 1000

/** `ls` uchun standart element chegarasi */
export const LS_CHEGARASI = 500

/** Tashqi jarayon (`rg`) shu vaqtdan oshsa to'xtatiladi */
export const JARAYON_TIMEOUT_MS = 30_000

/**
 * Ikkilik (binar) fayl deb hisoblash uchun tekshiriladigan bayt soni.
 * `rg` ham shunga o'xshash evristika ishlatadi: boshida NUL bayt bo'lsa
 * fayl ikkilik sanaladi va qidiruvdan chiqariladi.
 */
const IKKILIK_TEKSHIRUV_BAYTI = 8192

// ---------------------------------------------------------------------------
// Natija shakllari
// ---------------------------------------------------------------------------

/** Bitta mos kelgan qator */
export interface GrepMosligi {
  /** Ish papkasiga nisbatan yo'l — absolut yo'l HECH QACHON chiqmaydi */
  yol: string
  qator: number
  matn: string
}

/** Qidiruv natijasi — kesilgani alohida bayroq bilan */
export interface QidiruvNatijasi<T> {
  elementlar: T[]
  /** Chegaraga yetib kesildimi */
  kesildi: boolean
  /** Qaysi backend ishlatildi — testlar shu bilan ikkalasini solishtiradi */
  backend: 'rg' | 'node'
}

/** `ls` uchun bitta element */
export interface PapkaElementi {
  nom: string
  tur: 'fayl' | 'papka' | 'symlink'
  /** Bayt — papka uchun `undefined` */
  olcham?: number
}

// ---------------------------------------------------------------------------
// Yo'l chegarasi
// ---------------------------------------------------------------------------

/**
 * Chegara tekshiruvi natijasi.
 *
 * `muhit.ts` dagi `ChegaralanganMuhit` fayl amallarini o'raydi, lekin biz
 * papkani O'ZIMIZ aylanib chiqamiz (`rg` ham shunday qiladi), shuning uchun
 * chegara shu yerda alohida qo'llanadi. Mantiq `ChegaralanganMuhit` bilan
 * bir xil: matn yo'li ham, `realpath` orqali kanonik yo'l ham tekshiriladi.
 */
export interface ChegaraNatijasi {
  ok: boolean
  /** Tekshiruvdan o'tgan absolut yo'l */
  absolut: string
  /** Symlink ochilgandan keyingi haqiqiy yo'l */
  kanonik: string
  /** Ichkarida bo'lmasa — sabab */
  sabab?: string
}

/** Yo'l `asos` papkasi ichidami — matn darajasida */
export function ichkarimi(asos: string, yol: string): boolean {
  return yol === asos || yol.startsWith(asos + sep)
}

/**
 * Berilgan yo'lni ish papkasi chegarasiga solishtiradi.
 *
 * Ikki bosqich — `ChegaralanganMuhit.yolniTekshir` dagi bilan bir xil:
 *   1) matn yo'li (mavjud bo'lmagan fayl uchun ham ishlaydi),
 *   2) `realpath` — symlink ish papkasi ichida turib /etc ga qarasa ushlanadi.
 *
 * Symlink mavjud bo'lmasa (`realpath` xato bersa) matn yo'li yetarli deb
 * hisoblanadi: bu holda fayl yo'q, ya'ni o'qishga ham hech narsa yo'q.
 */
export async function chegaraniTekshir(
  ishPapkasi: string,
  soralganYol: string | undefined,
): Promise<ChegaraNatijasi> {
  const asos = resolve(ishPapkasi)
  const xom = soralganYol && soralganYol.length > 0 ? soralganYol : '.'
  const absolut = isAbsolute(xom) ? resolve(xom) : resolve(asos, xom)

  // Matn darajasida allaqachon tashqarida bo'lsa — kanonikni kutmaymiz
  if (!ichkarimi(asos, absolut)) {
    return {
      ok: false,
      absolut,
      kanonik: absolut,
      sabab: "ish papkasidan tashqarida",
    }
  }

  // Symlink orqali chiqib ketish
  let kanonik = absolut
  try {
    kanonik = await realpath(absolut)
  } catch {
    // Yo'l mavjud emas — matn tekshiruvi yetarli
    return { ok: true, absolut, kanonik: absolut }
  }

  // Ish papkasining o'zi ham symlink bo'lishi mumkin (masalan macOS'da
  // /tmp → /private/tmp). Shuning uchun asosni ham kanonik ko'rinishda
  // solishtiramiz, aks holda butunlay to'g'ri yo'l "tashqarida" deb
  // qolardi.
  let kanonikAsos = asos
  try {
    kanonikAsos = await realpath(asos)
  } catch {
    // Ish papkasi yo'q — quyidagi tekshiruv baribir xato qaytaradi
  }

  if (!ichkarimi(kanonikAsos, kanonik)) {
    return {
      ok: false,
      absolut,
      kanonik,
      sabab: "symlink ish papkasidan tashqariga olib chiqadi",
    }
  }

  return { ok: true, absolut, kanonik }
}

/**
 * Absolut yo'lni ish papkasiga nisbatan ko'rinishga o'tkazadi.
 *
 * Bu shunchaki chiroy uchun emas, XAVFSIZLIK talabi: natijada ish
 * papkasidan tashqaridagi absolut yo'llar chiqib qolmasligi kerak, aks
 * holda agent (va prompt injection orqali tashqi o'quvchi) foydalanuvchi
 * fayl tizimining tuzilishini bilib oladi.
 */
export function nisbiyYol(ishPapkasi: string, absolut: string): string {
  const n = relative(resolve(ishPapkasi), absolut)
  return n === '' ? '.' : n
}

// ---------------------------------------------------------------------------
// Tartib — ikki backend bir xil ketma-ketlik berishi uchun
// ---------------------------------------------------------------------------

/**
 * Yo'llarni saralash tartibi.
 *
 * IKKI BACKEND BIR XILLIGINING ASOSIY KAFOLATI. `rg` parallel aylanib
 * tasodifiy tartibda chiqaradi, Node esa `readdir` tartibida — ikkalasi ham
 * ishonchsiz. Shuning uchun natija HAR IKKALA yo'lda ham shu funksiya bilan
 * qayta saralanadi.
 *
 * `localeCompare` EMAS, oddiy `<`/`>` ishlatiladi: `localeCompare` tizim
 * lokaliga bog'liq (`LANG=tr_TR` da `i`/`I` boshqacha saralanadi), bu esa
 * yana PC'ga bog'liq farq bo'lardi. Kod nuqtasi bo'yicha solishtirish har
 * joyda bir xil.
 */
export function yolTartibi(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Grep mosliklari uchun tartib: avval yo'l, keyin qator raqami */
export function moslikTartibi(a: GrepMosligi, b: GrepMosligi): number {
  const y = yolTartibi(a.yol, b.yol)
  return y !== 0 ? y : a.qator - b.qator
}

// ---------------------------------------------------------------------------
// Qatorni tozalash
// ---------------------------------------------------------------------------

/**
 * Mos kelgan qatorni natijaga tayyorlaydi.
 *
 * `rg` qatorni `\n` bilan qaytaradi, Node'da esa biz o'zimiz bo'lamiz —
 * ikkalasida ham bir xil bo'lishi uchun oxiridagi `\r`/`\n` olib tashlanadi
 * va uzunlik bir xil chegaraga kesiladi.
 */
export function qatorniTayyorla(xom: string): string {
  const toza = xom.replace(/\r?\n$/, '')
  if (toza.length <= QATOR_CHEGARASI) return toza
  return toza.slice(0, QATOR_CHEGARASI) + '…'
}

// ---------------------------------------------------------------------------
// Glob → RegExp
// ---------------------------------------------------------------------------

/**
 * Glob naqshini regexpga aylantiradi.
 *
 * `rg` ning glob shevasiga (`ignore` crate) ataylab moslashtirilgan, chunki
 * `find` tool'i Node yo'lida shu funksiyaga, `rg`/`fd` yo'lida esa o'sha
 * crate'ga tayanadi — ikkalasi bir xil tushunishi kerak:
 *   `*`   — bitta segment ichida ixtiyoriy belgilar (`/` dan o'tmaydi)
 *   `**`  — ko'p segment (`/` dan o'tadi)
 *   `?`   — bitta belgi (`/` emas)
 *   `[…]` — belgi to'plami
 *   `{a,b}` — variantlar
 *
 * Naqshda `/` bo'lmasa (`*.ts`) u FAQAT fayl nomiga qo'llanadi — bu ham
 * `rg -g` xulqi: `-g '*.ts'` ichma-ich papkalardagi `.ts` fayllarni ham
 * topadi.
 */
export function globniRegexpga(glob: string): RegExp {
  // Nomga qo'llanadimi yoki to'liq yo'lgami
  const nomgaQollanadi = !glob.includes('/')
  let re = ''
  let i = 0

  while (i < glob.length) {
    const c = glob[i]!

    if (c === '*') {
      // `**` — segmentlardan o'tadi
      if (glob[i + 1] === '*') {
        // `**/` shakli: nol yoki ko'p segment (`**/a.ts` → `a.ts` ham mos)
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 3
          continue
        }
        re += '.*'
        i += 2
        continue
      }
      // Bitta `*` — `/` dan o'tmaydi
      re += '[^/]*'
      i += 1
      continue
    }

    if (c === '?') {
      re += '[^/]'
      i += 1
      continue
    }

    // Belgi to'plami — ichidagi `]` va `^` ni asl holicha uzatamiz
    if (c === '[') {
      const yopilish = glob.indexOf(']', i + 1)
      if (yopilish > 0) {
        let ichi = glob.slice(i + 1, yopilish)
        // Glob'da inkor `!`, regexpda `^`
        if (ichi.startsWith('!')) ichi = '^' + ichi.slice(1)
        re += '[' + ichi + ']'
        i = yopilish + 1
        continue
      }
      // Yopilmagan `[` — oddiy belgi
      re += '\\['
      i += 1
      continue
    }

    // Variantlar `{a,b}` → `(?:a|b)`
    if (c === '{') {
      const yopilish = glob.indexOf('}', i + 1)
      if (yopilish > 0) {
        const variantlar = glob
          .slice(i + 1, yopilish)
          .split(',')
          .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        re += '(?:' + variantlar.join('|') + ')'
        i = yopilish + 1
        continue
      }
      re += '\\{'
      i += 1
      continue
    }

    // Qolgan hamma narsa — literal
    re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    i += 1
  }

  return new RegExp('^' + re + '$')
}

/** Glob naqshi yo'lga mos keladimi (`nomgaQollanadi` mantig'i bilan) */
export function globMosKeladimi(glob: string, nisbiy: string): boolean {
  const re = globniRegexpga(glob)
  if (!glob.includes('/')) {
    // Nomga qo'llanadigan naqsh — har segmentning oxirgisiga
    const nom = nisbiy.split('/').pop() ?? nisbiy
    return re.test(nom)
  }
  return re.test(nisbiy)
}

// ---------------------------------------------------------------------------
// Papka aylanib chiqish (Node zaxirasi)
// ---------------------------------------------------------------------------

/** Papka standart holda tashlab yuboriladimi */
export function papkaTashlanadimi(nom: string, barchasi: boolean): boolean {
  if (barchasi) return false
  return TASHLANADIGAN_TOPLAM.has(nom)
}

export interface AylanishSozlamalari {
  /** Chegara — bundan tashqariga hech qachon chiqilmaydi */
  ishPapkasi: string
  /** Aylanish boshlanadigan papka (absolut, chegara ichida) */
  boshlanish: string
  /** Tashlanadigan papkalarni ham ko'rsatish */
  barchasi: boolean
  signal?: AbortSignal
}

/**
 * Papkani rekursiv aylanib, fayllarning ish papkasiga nisbiy yo'lini beradi.
 *
 * Natija SARALANGAN holda qaytadi: har papka ichidagi elementlar
 * `yolTartibi` bilan tartiblanadi, shunda `readdir` ning fayl tizimiga
 * bog'liq tartibi natijaga sizib o'tmaydi.
 *
 * Symlinklar KUZATILMAYDI (`lstat` semantikasi): ish papkasi ichidagi
 * symlink /etc ga qarab tursa, uni ochib aylanmaymiz. Bu ham xavfsizlik
 * (chegaradan chiqmaslik), ham to'g'rilik (cheksiz sikl bo'lmasligi) uchun.
 * `rg` ham standart holda symlinklarni kuzatmaydi — yana bir bir xillik.
 */
export async function* fayllarniAylan(
  sozlama: AylanishSozlamalari,
): AsyncGenerator<{ nisbiy: string; absolut: string }> {
  const navbat: string[] = [sozlama.boshlanish]

  while (navbat.length > 0) {
    sozlama.signal?.throwIfAborted()
    const papka = navbat.shift()!

    // `Dirent[]` ochiq yoziladi: `ReturnType<typeof readdir>` overload'lar
    // ichidan Buffer variantini tanlab, tip xatosi berardi
    let elementlar: Dirent[]
    try {
      elementlar = await readdir(papka, { withFileTypes: true })
    } catch {
      // O'qib bo'lmadi (ruxsat yo'q, yo'qolgan) — jimgina o'tamiz.
      // `rg` ham xuddi shunday qiladi: xatoni stderr'ga yozib, davom etadi.
      continue
    }

    // Tartibni SHU YERDA qat'iylashtiramiz — `readdir` kafolat bermaydi
    const saralangan = [...elementlar].sort((a, b) => yolTartibi(a.name, b.name))

    const ichkiPapkalar: string[] = []
    for (const element of saralangan) {
      const absolut = join(papka, element.name)

      if (element.isDirectory()) {
        if (papkaTashlanadimi(element.name, sozlama.barchasi)) continue
        ichkiPapkalar.push(absolut)
        continue
      }

      // Symlink va maxsus fayllar (soket, FIFO) — fayl sifatida sanalmaydi
      if (!element.isFile()) continue

      yield { nisbiy: nisbiyYol(sozlama.ishPapkasi, absolut), absolut }
    }

    // Chuqurlikni emas, kenglikni birinchi aylanamiz, lekin ichki papkalar
    // navbat boshiga qo'yilmaydi — yakuniy saralash baribir tartibni
    // belgilaydi, shuning uchun bu yerda faqat determinizm muhim.
    navbat.push(...ichkiPapkalar)
  }
}

// ---------------------------------------------------------------------------
// Ikkilik fayl aniqlash
// ---------------------------------------------------------------------------

/**
 * Baytlar orasida NUL bormi — ikkilik fayl belgisi.
 * `rg` ham shu evristikani ishlatadi, shuning uchun Node yo'lida ham
 * ishlatiladi: aks holda `rg` PNG faylni tashlab ketardi, Node esa undan
 * "mos kelgan qator" chiqarardi.
 */
export function ikkilikmi(baytlar: Uint8Array): boolean {
  const chegara = Math.min(baytlar.length, IKKILIK_TEKSHIRUV_BAYTI)
  for (let i = 0; i < chegara; i += 1) {
    if (baytlar[i] === 0) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// `rg` ni topish
// ---------------------------------------------------------------------------

/**
 * `rg` mavjudligi (va PCRE2 bilan qurilganligi) keshi.
 *
 * `undefined` — hali tekshirilmagan. Tekshiruv jarayon ishga tushirishni
 * talab qiladi, shuning uchun bir marta qilinadi.
 */
let rgKeshi: boolean | undefined

/**
 * Test uchun keshni tozalash yoki majburiy qiymat qo'yish.
 *
 * Testlar `rg` yo'q PC'ni taqlid qilishi kerak (topshiriq talabi), aks
 * holda `rg` o'rnatilmagan mashinada testlar boshqacha yo'ldan ketardi.
 */
export function rgKeshiniOrnat(qiymat: boolean | undefined): void {
  rgKeshi = qiymat
}

/**
 * `rg` ishlatsa bo'ladimi.
 *
 * Ikki shart: dastur mavjud BO'LSIN va PCRE2 bilan qurilgan BO'LSIN.
 *
 * PCRE2 talabi ataylab qat'iy. `rg` ning standart Rust engine'i
 * `(?=...)`/`(?<=...)` ni rad etadi, JS `RegExp` esa qabul qiladi — ya'ni
 * PCRE2siz `rg` da bitta naqsh ishlab, Node zaxirasida boshqacha (yoki
 * teskarisi) bo'lardi. Bu aynan biz oldini olmoqchi bo'lgan "PC'ga bog'liq
 * farq". PCRE2 yo'q bo'lsa `rg` umuman ishlatilmaydi.
 */
export async function rgMavjudmi(): Promise<boolean> {
  if (rgKeshi !== undefined) return rgKeshi
  try {
    const natija = await jarayonniIshgaTushir('rg', ['--version'], { timeoutMs: 5000 })
    rgKeshi = natija.kod === 0 && natija.stdout.includes('+pcre2')
  } catch {
    rgKeshi = false
  }
  return rgKeshi
}

// ---------------------------------------------------------------------------
// Jarayon ishga tushirish
// ---------------------------------------------------------------------------

export interface JarayonNatijasi {
  kod: number
  stdout: string
  stderr: string
  /** Timeout yoki abort tufayli to'xtatildimi */
  toxtatildi: boolean
}

export interface JarayonSozlamalari {
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Chiqish shu bayt miqdoridan oshsa jarayon to'xtatiladi */
  maxBayt?: number
}

/**
 * Tashqi dasturni ishga tushiradi.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ SHELL ISHLATILMAYDI. `spawn(dastur, argumentlar)` — argument massivi │
 * │ bilan, `shell: true` YO'Q.                                           │
 * │                                                                      │
 * │ Bu shart, chunki `pattern` foydalanuvchidan (aslida LLM'dan) keladi. │
 * │ Shell orqali uzatilsa `grep` naqshi `x"; rm -rf ~; echo "` bo'lib     │
 * │ buyruq in'ektsiyasiga aylanardi. Argument massivida naqsh operatsion  │
 * │ tizimga XOM BAYT sifatida boradi — u yerda tirnoq, `;`, `$` ning     │
 * │ maxsus ma'nosi yo'q.                                                 │
 * │                                                                      │
 * │ Shuningdek `buyruq-tahlil.ts` tekshiruvi bu yerda ATAYLAB chetlab    │
 * │ o'tiladi: bajarilayotgan buyruq LLM matni emas, BIZNING kodimiz —    │
 * │ dastur nomi qat'iy `'rg'`, argumentlar esa quyidagi funksiyalarda    │
 * │ tuzilgan. Yo'l argumentlari `chegaraniTekshir` dan o'tadi.           │
 * └──────────────────────────────────────────────────────────────────────┘
 */
export function jarayonniIshgaTushir(
  dastur: string,
  argumentlar: string[],
  sozlama: JarayonSozlamalari = {},
): Promise<JarayonNatijasi> {
  return new Promise((bajar, rad) => {
    let bola: ReturnType<typeof spawn>
    try {
      bola = spawn(dastur, argumentlar, {
        cwd: sozlama.cwd,
        // Shell YO'Q — yuqoridagi izohga qarang
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (xato) {
      rad(xato)
      return
    }

    let stdout = ''
    let stderr = ''
    let toxtatildi = false
    let hal = false

    const maxBayt = sozlama.maxBayt ?? 32 * 1024 * 1024

    const oldir = () => {
      toxtatildi = true
      bola.kill('SIGKILL')
    }

    const soat = setTimeout(oldir, sozlama.timeoutMs ?? JARAYON_TIMEOUT_MS)
    const abortTinglovchi = () => oldir()
    sozlama.signal?.addEventListener('abort', abortTinglovchi, { once: true })

    const tozala = () => {
      clearTimeout(soat)
      sozlama.signal?.removeEventListener('abort', abortTinglovchi)
    }

    bola.stdout?.on('data', (bolak: Buffer) => {
      if (stdout.length > maxBayt) {
        // Chiqish juda katta — o'qishni to'xtatamiz, xotira to'lib
        // ketmasin. Bizning chegaralarimiz (200 moslik) baribir undan
        // ancha oldin ishlaydi.
        oldir()
        return
      }
      stdout += bolak.toString('utf8')
    })
    bola.stderr?.on('data', (bolak: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += bolak.toString('utf8')
    })

    bola.on('error', (xato) => {
      if (hal) return
      hal = true
      tozala()
      rad(xato)
    })

    bola.on('close', (kod) => {
      if (hal) return
      hal = true
      tozala()
      bajar({ kod: kod ?? -1, stdout, stderr, toxtatildi })
    })
  })
}

// ---------------------------------------------------------------------------
// Fayl o'qish yordamchilari
// ---------------------------------------------------------------------------

/** Faylni bayt sifatida o'qiydi; xato bo'lsa `undefined` */
export async function baytlarniOqi(yol: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(yol))
  } catch {
    return undefined
  }
}

/** Fayl o'lchamini oladi; xato bo'lsa `undefined` */
export async function olchamniOl(yol: string): Promise<number | undefined> {
  try {
    const m = await stat(yol)
    return m.size
  } catch {
    return undefined
  }
}
