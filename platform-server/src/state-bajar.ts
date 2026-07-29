// Dashboard state'larini hisoblash — jonli ma'lumot qatlami.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ ASOSIY QOIDA: AI YANGI API YOZMAYDI.                                 │
// │                                                                      │
// │ Endpoint bitta va oldindan tayyor:                                   │
// │     GET /api/apps/:id/state/:nom                                     │
// │ AI faqat o'sha endpoint NIMA QAYTARISHINI belgilaydi — state kodini  │
// │ yozadi, marshrutni emas. Frontend esa shu bitta endpointni polling   │
// │ qiladi va yangi qiymatlarni oladi.                                   │
// └──────────────────────────────────────────────────────────────────────┘
//
// HAR STATE MUSTAQIL. CPU 5 soniyada, disk 30 soniyada yangilanishi
// mumkin — ular alohida kod, alohida interval va alohida keshga ega.
// Bitta umumiy obyekt bo'lganda eng tez yangilanadigani butun to'plamni
// qayta hisoblatardi (disk uchun `df` har 5 soniyada bejiz ishlardi).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ ⚠️ ISHONCH DARAJASI — ONGLI VAQTINCHALIK QAROR                       │
// │                                                                      │
// │ State kodi SERVER JARAYONIDA, platformaning to'liq huquqi bilan      │
// │ ishlaydi (`child_process`, `fs`, tarmoq — hammasi ochiq) va interval │
// │ bo'yicha AVTOMATIK takrorlanadi, ruxsat so'ramasdan.                 │
// │                                                                      │
// │ Bu `bash` tool'idan farq qiladi: u har chaqiruvda ruxsat qatlamidan  │
// │ o'tadi (`buyruq-tahlil.ts`, `ruxsat.ts`), bu esa o'tmaydi.           │
// │                                                                      │
// │ KEYINGI BOSQICH: kodni tekshiradigan klassifikator (prompt injection │
// │ himoyasi). Ulanish nuqtasi — shu fayldagi `kodniTekshir()`. Hozircha │
// │ u faqat sintaksis va hajmni ko'radi.                                 │
// └──────────────────────────────────────────────────────────────────────┘

/** Bitta state kodining maksimal hajmi (belgi) */
export const STATE_KOD_CHEGARASI = 64 * 1024

/** Bitta manifestdagi maksimal state soni */
export const STATE_SONI_CHEGARASI = 20

/**
 * Eng qisqa interval (soniya).
 *
 * AI `interval: 1` yozib qo'ysa, `ssh` har soniyada ishga tushib serverni
 * ham, platformani ham ortiqcha yuklardi. 3 soniya — jonli ko'rinish
 * uchun yetarli, lekin suiiste'mol emas.
 */
export const ENG_QISQA_INTERVAL = 3

/** Bitta state hisoblanishining vaqt chegarasi (ms) */
export const STATE_TIMEOUT_MS = 20_000

/** Natija JSON'ining maksimal hajmi (belgi) */
export const NATIJA_CHEGARASI = 256 * 1024

export interface StateNatijasi {
  ok: boolean
  /** Muvaffaqiyatli bo'lsa — kod qaytargan qiymat */
  qiymat?: unknown
  /** Xato bo'lsa — sabab (UI'da ko'rsatiladi, AI ham o'qiydi) */
  xato?: string
  /** Hisoblangan vaqt (ISO) */
  vaqt: string
}

/**
 * State kodini tekshiradi.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ KELAJAKDAGI KLASSIFIKATOR SHU YERGA ULANADI.                       │
 * │                                                                    │
 * │ Reja: kodni LLM'ga berib "bu dashboard uchun ma'lumot yig'ishmi    │
 * │ yoki boshqa narsami?" deb so'rash — prompt injection orqali        │
 * │ kelgan zararli kodni ushlash uchun.                                │
 * │                                                                    │
 * │ Hozircha faqat MEXANIK tekshiruv: hajm va sintaksis. Bu ongli      │
 * │ vaqtinchalik holat (GitHub issue ochilgan).                        │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * XATO TASHLAMAYDI — sabablar ro'yxati qaytadi (bo'sh = yaroqli).
 */
export function kodniTekshir(kod: string): string[] {
  const xatolar: string[] = []

  if (typeof kod !== 'string' || kod.trim().length === 0) {
    xatolar.push('State kodi bo\'sh')
    return xatolar
  }

  if (kod.length > STATE_KOD_CHEGARASI) {
    xatolar.push(
      `State kodi juda uzun: ${kod.length} belgi, chegara ${STATE_KOD_CHEGARASI}`,
    )
  }

  // Sintaksisni ERTA ushlaymiz: aks holda xato birinchi polling paytida,
  // foydalanuvchi sahifani ochganda chiqardi.
  try {
    new Function(kod)
  } catch (xato) {
    xatolar.push(`Sintaksis xatosi: ${xato instanceof Error ? xato.message : String(xato)}`)
  }

  return xatolar
}

/** Intervalni chegaralar ichiga keltiradi */
export function intervalniTogrila(xom: unknown): number {
  if (typeof xom !== 'number' || !Number.isFinite(xom) || xom <= 0) return 0
  return Math.max(ENG_QISQA_INTERVAL, Math.round(xom))
}

/**
 * State kodini bajaradi va natijani qaytaradi.
 *
 * XATO TASHLAMAYDI: kod yiqilsa `{ ok: false, xato }` qaytadi va
 * dashboard eski qiymat bilan ishlashda davom etadi. Bu butun
 * loyihadagi qoida — AI xatosi platformani yiqitmaydi.
 */
export async function stateniBajar(kod: string, appId: string): Promise<StateNatijasi> {
  const vaqt = new Date().toISOString()

  const xatolar = kodniTekshir(kod)
  if (xatolar.length > 0) {
    return { ok: false, xato: xatolar.join('; '), vaqt }
  }

  try {
    // `module.exports = async function () {...}` shaklini qo'llab-quvvatlaymiz.
    // CommonJS ataylab: AI uchun eng tanish shakl va `require` ham shu
    // yerda tabiiy ishlaydi.
    const modul: { exports: unknown } = { exports: {} }
    const fabrika = new Function('module', 'exports', 'require', '__appId', kod)

    fabrika(modul, modul.exports, require, appId)

    const funksiya =
      typeof modul.exports === 'function'
        ? modul.exports
        : typeof (modul.exports as { default?: unknown })?.default === 'function'
          ? (modul.exports as { default: unknown }).default
          : null

    if (typeof funksiya !== 'function') {
      return {
        ok: false,
        xato: 'Kod `module.exports = async function () { ... }` bermadi',
        vaqt,
      }
    }

    // Vaqt chegarasi: osilib qolgan `ssh` butun polling zanjirini
    // to'xtatib qo'ymasin.
    const qiymat = await Promise.race([
      Promise.resolve((funksiya as () => unknown)()),
      new Promise<never>((_, rad) =>
        setTimeout(
          () => rad(new Error(`Vaqt tugadi (${STATE_TIMEOUT_MS / 1000}s)`)),
          STATE_TIMEOUT_MS,
        ),
      ),
    ])

    // Natija JSON'ga aylanishi SHART: u WS orqali ham, REST orqali ham
    // uzatiladi. Aylanmaydigan qiymat (siklik havola, funksiya) keyinroq
    // — uzatish paytida — yiqilardi.
    let json: string
    try {
      json = JSON.stringify(qiymat ?? null)
    } catch {
      return { ok: false, xato: 'Natija JSON\'ga aylanmaydi (siklik havola?)', vaqt }
    }

    if (json.length > NATIJA_CHEGARASI) {
      return {
        ok: false,
        xato: `Natija juda katta: ${json.length} belgi, chegara ${NATIJA_CHEGARASI}`,
        vaqt,
      }
    }

    return { ok: true, qiymat: JSON.parse(json), vaqt }
  } catch (xato) {
    return {
      ok: false,
      xato: xato instanceof Error ? xato.message : String(xato),
      vaqt,
    }
  }
}
