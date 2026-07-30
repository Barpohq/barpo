// Ilova amallari va sozlamalarini bajarish — boshqaruv qatlamining yuragi.
//
// `state-bajar.ts` bilan bir xil naqsh (`new Function`, CommonJS, timeout,
// xato TASHLAMAYDI), lekin uch muhim farq bilan:
//
//   1) QULF. State — o'qish, uni parallel chaqirish zararsiz. Amal esa holat
//      O'ZGARTIRADI: ikki "restart" bir vaqtda ketsa ular bir-birini bosardi
//      va natija tasodifga bog'liq bo'lardi.
//
//   2) AUDIT. `audit.ts` qoidasi: holat o'zgartiradigan har amal auditga
//      yozilishi SHART. State o'qish yozilmaydi (u interval bo'yicha
//      minglab marta ishlaydi), amal esa har bosishda yoziladi.
//
//   3) UZUNROQ TIMEOUT. `docker restart` + healthcheck 20 soniyaga
//      sig'maydi.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ ⚠️ ISHONCH DARAJASI — `states` BILAN BIR XIL, ONGLI QAROR.           │
// │                                                                      │
// │ Kod platformaning to'liq huquqi bilan ishlaydi va ruxsat qatlamidan  │
// │ O'TMAYDI (`bash` tool'idan farqli). Yumshatuvchi omillar:            │
// │   - foydalanuvchi BOSGANDA ishlaydi, avtomatik takrorlanmaydi        │
// │   - auditga tushadi (kim, qachon, qanday natija)                     │
// │   - `tasdiq: true` bo'lsa UI ogohlantiradi                           │
// │                                                                      │
// │ KEYINGI BOSQICH: prompt injection klassifikatori — ulanish nuqtasi   │
// │ shu fayldagi `amalKodiniTekshir()`.                                  │
// └──────────────────────────────────────────────────────────────────────┘
//
// FOYDALANUVCHI KIRISHI — YANGI XAVF. `states` da kirish YO'Q edi, bu yerda
// BOR (token, konteyner nomi). Shuning uchun AI'ga `exec` berilmaydi: u
// `ssh` obyektini oladi (`ilova-ssh.ts`), u esa argv massivini majburlaydi va
// sirni stdin orqali uzatadi.

import type { AppAmali, AppSozlamalari } from '@platforma/shared'
import { ilovaSshYarat, type IlovaSshApi } from './ilova-ssh.ts'
import { serverNomBoyicha } from './repo.ts'
import { kodniTekshir } from './state-bajar.ts'

/**
 * Amal bajarilishining vaqt chegarasi (ms).
 *
 * `STATE_TIMEOUT_MS` (20s) dan uzun: restart + healthcheck ketma-ket
 * ketganda 20 soniya yetmaydi va amal muvaffaqiyatli bo'lsa ham "vaqt
 * tugadi" deb ko'rinardi.
 */
export const AMAL_TIMEOUT_MS = 90_000

/** Natija matnining maksimal uzunligi — UI toast'ga sig'sin */
export const XABAR_CHEGARASI = 2000

export interface AmalNatijasi {
  ok: boolean
  /** Foydalanuvchiga ko'rsatiladigan xabar (toast) */
  xabar?: string
  /** Xato bo'lsa — sabab. Sirlar tozalangan. */
  xato?: string
  /** Bajarilgan vaqt (ISO) */
  vaqt: string
}

/**
 * Amal kodini tekshiradi.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ KELAJAKDAGI KLASSIFIKATOR SHU YERGA ULANADI.                       │
 * │                                                                    │
 * │ `state-bajar.ts` dagi `kodniTekshir()` bilan bir xil reja: kodni    │
 * │ LLM'ga berib "bu ilovani boshqarishmi yoki boshqa narsami?" deb     │
 * │ so'rash. Hozircha faqat mexanik tekshiruv (hajm, sintaksis).        │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function amalKodiniTekshir(kod: string): string[] {
  return kodniTekshir(kod)
}

// ---------------------------------------------------------------------------
// Sirlarni tozalash
// ---------------------------------------------------------------------------

/**
 * Matndan sir qiymatlarni olib tashlaydi.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ NEGA KERAK. Sir platformada saqlanmaydi, lekin YOZISH paytida u     │
 * │ jarayon xotirasidan o'tadi. Agar server buyrug'i xato qaytarsa,     │
 * │ xato matnida token bo'lishi mumkin: masalan bot ishga tushmay       │
 * │ `Invalid token: 789...` deb yozadi. O'sha matn keyin auditga,       │
 * │ WS'ga va brauzerga borardi.                                        │
 * │                                                                    │
 * │ Ya'ni sir platformada SAQLANMAYDI, lekin OQIB KETISHI mumkin —      │
 * │ bu funksiya o'sha yo'lni yopadi.                                   │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Qisqa qiymatlar (< 8 belgi) TOZALANMAYDI: `1`, `true`, `bot` kabi
 * qiymatlar matnda tabiiy uchraydi va ularni maskalash xabarni o'qishga
 * yaroqsiz qilardi.
 */
export function sirlarniTozala(matn: string, sirlar: string[]): string {
  let natija = matn
  for (const sir of sirlar) {
    if (typeof sir !== 'string' || sir.length < 8) continue
    // `split`/`join` — regex qochirish muammosini butunlay chetlab o'tadi
    natija = natija.split(sir).join('•••')
  }
  return natija
}

/** Xatoni matnga aylantiradi va sirlarni tozalaydi */
function xatoniTozala(xato: unknown, sirlar: string[]): string {
  const xom = xato instanceof Error ? xato.message : String(xato)
  return sirlarniTozala(xom, sirlar).slice(0, XABAR_CHEGARASI)
}

// ---------------------------------------------------------------------------
// Qulf — bitta amal bir vaqtda ikki marta ishlamaydi
// ---------------------------------------------------------------------------

/**
 * Bajarilib turgan amallar: `appId:nom` → Promise.
 *
 * NEGA APP+NOM BO'YICHA, ILOVA BO'YICHA EMAS. Bitta ilovada "restart" va
 * "loglarni ko'rsatish" bir vaqtda ketishi mumkin va ular bir-biriga
 * xalal bermaydi. Bir xil amalni ikki marta bosish esa muammo.
 */
const bajarilayotganlar = new Map<string, Promise<AmalNatijasi>>()

/** Amal shu daqiqada bajarilib turibdimi */
export function amalBandmi(appId: string, nom: string): boolean {
  return bajarilayotganlar.has(`${appId}:${nom}`)
}

/** Testlar uchun: qulflarni tozalash */
export function qulflarniTozala(): void {
  bajarilayotganlar.clear()
}

// ---------------------------------------------------------------------------
// Kod bajarish
// ---------------------------------------------------------------------------

/** Kodga beriladigan kontekst */
export interface AmalKonteksti {
  appId: string
  /** Sirsiz sozlama qiymatlari — sirlar bu yerda YO'Q (ular serverda) */
  sozlama: Record<string, string>
}

/**
 * Kodga beriladigan `ssh` fabrikasi.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ NEGA FABRIKA, TAYYOR OBYEKT EMAS.                                  │
 * │                                                                    │
 * │ Manifestda "bu ilova qaysi serverda" degan maydon YO'Q — `service`  │
 * │ erkin matn (`"helsinki-1 · docker · uptime 31 kun"`) va uni tahlil  │
 * │ qilish mo'rt bo'lardi. Ilova bir necha serverda ham bo'lishi mumkin.│
 * │                                                                    │
 * │ Shuning uchun serverni KOD tanlaydi: `ssh('helsinki-1')`. Lekin nom │
 * │ BAZADAN tekshiriladi — kod ixtiyoriy host yozib, boshqariladigan    │
 * │ config'dagi begona serverga buyruq yubora olmaydi.                  │
 * └────────────────────────────────────────────────────────────────────┘
 */
export type SshFabrikasi = (serverNomi: string) => IlovaSshApi

/**
 * Standart fabrika — nomni bazadan tekshiradi.
 *
 * Nom topilmasa XATO tashlanadi: `undefined` qaytarsak kod
 * `ssh(...).buyruq` da tushunarsiz "undefined is not a function" olardi.
 */
function sshFabrikasiniYarat(): SshFabrikasi {
  return (serverNomi: string) => {
    if (typeof serverNomi !== 'string' || serverNomi.trim().length === 0) {
      throw new TypeError("ssh() expects a server name — for example ssh('helsinki-1')")
    }

    const server = serverNomBoyicha(serverNomi.trim())
    if (!server) {
      throw new Error(
        `Server not found: "${serverNomi}". Use a name from the list of servers ` +
          'connected to the platform.',
      )
    }

    return ilovaSshYarat(server.name)
  }
}

/**
 * Testlar uchun almashtiriladigan fabrika (`bajaruvchiOrnat` naqshi).
 *
 * `null` — standartga qaytarish.
 */
let sshFabrikasi: SshFabrikasi | null = null

export function sshFabrikasiniOrnat(f: SshFabrikasi | null): void {
  sshFabrikasi = f
}

/**
 * Kodni bajaradi — `state-bajar.ts` dagi `stateniBajar` bilan bir xil shakl.
 *
 * XATO TASHLAMAYDI: natija `{ ok: false, xato }` bo'lib qaytadi.
 */
async function kodniBajar(
  kod: string,
  kontekst: AmalKonteksti,
  sirlar: string[],
  qoshimcha: Record<string, unknown> = {},
): Promise<{ ok: boolean; qiymat?: unknown; xato?: string }> {
  const xatolar = amalKodiniTekshir(kod)
  if (xatolar.length > 0) return { ok: false, xato: xatolar.join('; ') }

  try {
    const modul: { exports: unknown } = { exports: {} }
    const fabrika = new Function('module', 'exports', 'require', '__appId', kod)
    fabrika(modul, modul.exports, require, kontekst.appId)

    const funksiya =
      typeof modul.exports === 'function'
        ? modul.exports
        : typeof (modul.exports as { default?: unknown })?.default === 'function'
          ? (modul.exports as { default: unknown }).default
          : null

    if (typeof funksiya !== 'function') {
      return { ok: false, xato: 'The code did not return `module.exports = async function () { ... }`' }
    }

    const arg = {
      appId: kontekst.appId,
      sozlama: kontekst.sozlama,
      ssh: sshFabrikasi ?? sshFabrikasiniYarat(),
      ...qoshimcha,
    }

    const qiymat = await Promise.race([
      Promise.resolve((funksiya as (a: unknown) => unknown)(arg)),
      new Promise<never>((_, rad) =>
        setTimeout(
          () => rad(new Error(`Timed out (${AMAL_TIMEOUT_MS / 1000}s)`)),
          AMAL_TIMEOUT_MS,
        ),
      ),
    ])

    return { ok: true, qiymat }
  } catch (xato) {
    return { ok: false, xato: xatoniTozala(xato, sirlar) }
  }
}

/**
 * Kod qaytargan qiymatdan foydalanuvchiga ko'rsatiladigan xabarni ajratadi.
 *
 * AI turli shaklda qaytarishi mumkin (`{ xabar }`, satr, hech narsa) —
 * hammasini qabul qilamiz, chunki rad etish amal ALLAQACHON bajarilgandan
 * keyin bo'lardi va foydalanuvchi "xato" ko'rib qayta bosardi.
 */
function xabarniAjrat(qiymat: unknown, sirlar: string[]): string | undefined {
  let xom: string | undefined

  if (typeof qiymat === 'string') xom = qiymat
  else if (qiymat && typeof qiymat === 'object') {
    const o = qiymat as Record<string, unknown>
    if (typeof o.xabar === 'string') xom = o.xabar
    else if (typeof o.message === 'string') xom = o.message
  }

  if (!xom) return undefined
  return sirlarniTozala(xom, sirlar).slice(0, XABAR_CHEGARASI) || undefined
}

/**
 * Amalni bajaradi.
 *
 * QULF: bir xil amal bajarilib turgan bo'lsa YANGI chaqiruv boshlanmaydi —
 * mavjud natija kutiladi. Ya'ni tugmani ikki marta bosish bitta bajarilishga
 * aylanadi (ikki restart o'rniga).
 *
 * XATO TASHLAMAYDI.
 */
export function amalniBajar(
  amal: AppAmali,
  kontekst: AmalKonteksti,
): Promise<AmalNatijasi> {
  const kalit = `${kontekst.appId}:${amal.nom}`

  const mavjud = bajarilayotganlar.get(kalit)
  if (mavjud) return mavjud

  const ish = (async (): Promise<AmalNatijasi> => {
    const vaqt = new Date().toISOString()
    // Sozlama qiymatlari sir bo'lmasa ham tozalash ro'yxatiga kiradi:
    // ularning ba'zisi (webhook maxfiy so'zi) amalda sirga yaqin.
    const sirlar = Object.values(kontekst.sozlama)

    const natija = await kodniBajar(amal.kod, kontekst, sirlar)

    if (!natija.ok) {
      return { ok: false, xato: natija.xato ?? 'Unknown error', vaqt }
    }

    return {
      ok: true,
      ...(xabarniAjrat(natija.qiymat, sirlar) !== undefined
        ? { xabar: xabarniAjrat(natija.qiymat, sirlar) }
        : {}),
      vaqt,
    }
  })().finally(() => {
    bajarilayotganlar.delete(kalit)
  })

  bajarilayotganlar.set(kalit, ish)
  return ish
}

// ---------------------------------------------------------------------------
// Sozlamalar — yozish va o'qish
// ---------------------------------------------------------------------------

export interface SozlamaYozishNatijasi {
  ok: boolean
  xabar?: string
  xato?: string
  vaqt: string
}

/**
 * Sozlama qiymatlarini SERVERGA yozadi.
 *
 * Qiymatlar kodga `qiymatlar` sifatida beriladi — kod ularni `ssh.envYoz()`
 * bilan serverdagi konfiguratsiyaga yozadi va ilovani restart qiladi.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ SIRLAR SHU FUNKSIYADAN O'TADI, LEKIN SAQLANMAYDI.                  │
 * │                                                                    │
 * │ Ular jarayon xotirasida faqat yozish davomida turadi va natijada    │
 * │ tozalanadi (`sirlarniTozala`). Bazaga, logga, WS'ga tushmaydi.      │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function sozlamalarniYoz(
  sozlamalar: AppSozlamalari,
  qiymatlar: Record<string, string>,
  kontekst: AmalKonteksti,
): Promise<SozlamaYozishNatijasi> {
  const vaqt = new Date().toISOString()

  // Sir maydonlarning qiymatlari — tozalash ro'yxati
  const sirKalitlari = new Set(
    sozlamalar.maydonlar.filter((m) => m.turi === 'sir').map((m) => m.kalit),
  )
  const sirlar = Object.entries(qiymatlar)
    .filter(([k]) => sirKalitlari.has(k))
    .map(([, v]) => v)

  const natija = await kodniBajar(sozlamalar.yoz, kontekst, sirlar, { qiymatlar })

  if (!natija.ok) {
    return { ok: false, xato: natija.xato ?? 'Unknown error', vaqt }
  }

  return {
    ok: true,
    ...(xabarniAjrat(natija.qiymat, sirlar) !== undefined
      ? { xabar: xabarniAjrat(natija.qiymat, sirlar) }
      : {}),
    vaqt,
  }
}

export interface SozlamaOqishNatijasi {
  ok: boolean
  /** Sirsiz joriy qiymatlar */
  qiymatlar: Record<string, string>
  xato?: string
  /**
   * Serverda QIYMATI BOR sir kalitlar.
   *
   * UI shu ro'yxatdan "✓ o'rnatilgan" belgisini quradi. Qiymatning O'ZI
   * qaytarilmaydi — faqat borligi.
   *
   * `tashlangan` (AI xatosi) dan ATAYLAB ajratilgan: ikkisi bir maydonda
   * bo'lganda "sir qaytarildi" va "sir mavjud" holatlari aralashib ketardi.
   */
  ornatilgan?: string[]
  /**
   * `oqi` kodi qaytarib qo'ygan sir kalitlar — AI xatosi belgisi.
   *
   * Ular baribir tashlanadi; bu ro'yxat diagnostika uchun.
   */
  tashlangan?: string[]
}

/**
 * Joriy qiymatlarni SERVERDAN o'qiydi.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ SIR QAYTARILSA — TASHLANADI.                                       │
 * │                                                                    │
 * │ Bu qatlamning asosiy qoidasi: token server → platforma → brauzer   │
 * │ yo'lini bosmaydi. AI `oqi` kodida tokenni ham qaytarib qo'yishi     │
 * │ mumkin (u shunday qilish TABIIY deb o'ylaydi), shuning uchun        │
 * │ filtr shu yerda — kodga ishonib qolmaymiz.                         │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function sozlamalarniOqi(
  sozlamalar: AppSozlamalari,
  kontekst: AmalKonteksti,
): Promise<SozlamaOqishNatijasi> {
  if (!sozlamalar.oqi) return { ok: true, qiymatlar: {} }

  const natija = await kodniBajar(sozlamalar.oqi, kontekst, [])
  if (!natija.ok) {
    return { ok: false, qiymatlar: {}, xato: natija.xato ?? 'Unknown error' }
  }

  if (!natija.qiymat || typeof natija.qiymat !== 'object' || Array.isArray(natija.qiymat)) {
    return { ok: false, qiymatlar: {}, xato: 'The `oqi` code did not return an object' }
  }

  const sirKalitlari = new Set(
    sozlamalar.maydonlar.filter((m) => m.turi === 'sir').map((m) => m.kalit),
  )
  const malumKalitlar = new Set(sozlamalar.maydonlar.map((m) => m.kalit))

  const qiymatlar: Record<string, string> = {}
  const tashlangan: string[] = []
  const ornatilgan: string[] = []

  for (const [kalit, qiymat] of Object.entries(natija.qiymat as Record<string, unknown>)) {
    if (sirKalitlari.has(kalit)) {
      // ┌──────────────────────────────────────────────────────────────┐
      // │ SIR UCHUN IKKI XIL JAVOB QABUL QILINADI.                     │
      // │                                                              │
      // │   `true` / `false`  — TAVSIYA ETILGAN yo'l: kod sirning       │
      // │                       BORLIGINI aytadi, qiymatini emas.       │
      // │   satr             — kod sirni qaytarib qo'ygan (AI xatosi).  │
      // │                       Qiymat TASHLANADI, lekin bo'sh emasligi │
      // │                       "o'rnatilgan" degan ma'noni beradi.     │
      // │                                                              │
      // │ Ikkinchisi kerak, chunki AI tokenni qaytarish TABIIY deb      │
      // │ o'ylaydi. Uni jimgina "o'rnatilmagan" ga aylantirsak,         │
      // │ foydalanuvchi mavjud tokenni "yo'q" deb ko'rardi.             │
      // │                                                              │
      // │ BO'SH QIYMAT ("", null, undefined) — HAR IKKI HOLATDA         │
      // │ "o'rnatilmagan": `{ token: q.TOKEN }` da kalit `.env` da yo'q  │
      // │ bo'lsa qiymat `undefined` bo'ladi, lekin KALIT obyektda       │
      // │ turadi.                                                      │
      // └──────────────────────────────────────────────────────────────┘
      if (typeof qiymat === 'boolean') {
        if (qiymat) ornatilgan.push(kalit)
      } else if (qiymat !== undefined && qiymat !== null && String(qiymat).length > 0) {
        // Haqiqiy qiymat qaytarildi — bu AI xatosi, qayd qilamiz
        tashlangan.push(kalit)
        ornatilgan.push(kalit)
      }
      continue
    }
    // Sxemada e'lon qilinmagan kalit ham tashlanadi: forma uni ko'rsatmaydi,
    // ya'ni uzatish faqat ortiqcha ma'lumot oqishi bo'lardi.
    if (!malumKalitlar.has(kalit)) continue

    if (typeof qiymat === 'string') qiymatlar[kalit] = qiymat
    else if (typeof qiymat === 'number' || typeof qiymat === 'boolean') {
      qiymatlar[kalit] = String(qiymat)
    }
  }

  return {
    ok: true,
    qiymatlar,
    ...(ornatilgan.length > 0 ? { ornatilgan } : {}),
    ...(tashlangan.length > 0 ? { tashlangan } : {}),
  }
}
