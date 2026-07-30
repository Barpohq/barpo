// Ilova manifestini tekshirish — dinamik dashboardning BIRINCHI himoya qavati.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NIMA UCHUN KERAK. Manifestni AI yozadi va u bazaga JSON bo'lib       │
// │ tushadi (`apps.manifest`). O'qishda esa `JSON.parse(...)` natijasi   │
// │ to'g'ridan-to'g'ri `as AppManifest` deb KASTLANARDI — ya'ni tip      │
// │ tekshiruvi faqat kompilyatsiya paytida bor, ishlash paytida YO'Q.    │
// │                                                                      │
// │ Oqibati: `widgets` o'rniga `null` kelsa yoki `rows` massiv bo'lmasa, │
// │ xato UI'da — `AppView` render paytida — chiqardi va butun sahifani   │
// │ yiqitardi. Foydalanuvchi talabi esa aniq: AI xato qilsa FAQAT        │
// │ dashboard ishlamasin, platforma butun qolsin.                        │
// │                                                                      │
// │ Shu sabab tekshiruv CHEGARADA turadi: yozishda (`appPublish`) va     │
// │ o'qishda (`repo.ts`). Ikkalasi ham shu modulni ishlatadi.            │
// └──────────────────────────────────────────────────────────────────────┘
//
// FALSAFA — `skill-fayl.ts` dagi bilan bir xil: XATO TASHLAMAYDI.
// Natija `{ ok, xatolar }` bo'lib qaytadi, chaqiruvchi o'zi qaror qiladi.
// `appPublish` xatolarni AI'ga qaytaradi (u tuzatadi), `repo.ts` esa buzuq
// yozuvni tashlab yuboradi (foydalanuvchi yiqilgan sahifa emas, ro'yxatda
// kamaygan ilova ko'radi).
//
// TOZALASH (`tozala`) ALOHIDA MUHIM: qisman buzuq manifest butunlay rad
// etilmaydi — buzuq VIDJET tashlanadi, qolgani ko'rsatiladi. 8 ta vidjetdan
// bittasi xato bo'lgani uchun 7 tasini yo'qotish foydalanuvchiga zarar.

import type {
  AppAmali,
  AppManifest,
  AppSozlamalari,
  AppState,
  AppView,
  AuditLevel,
  SozlamaMaydoni,
  SozlamaTuri,
  StatItem,
  Widget,
} from './types.ts'

/**
 * `data` snapshotining maksimal hajmi (JSON belgilarida).
 *
 * NEGA CHEGARA KERAK: snapshot manifest ichida bazaga yoziladi va HAR
 * ochilishda to'liq brauzerga uzatiladi. AI "bugungi hamma loglarni"
 * qo'yib yuborsa, bitta ilova bazani ham, sahifani ham cho'ktirardi.
 *
 * 256 KB — ~5000 qatorli jadval sig'adi, lekin log arxivi sig'maydi.
 * Bu ataylab: dashboard XULOSA ko'rsatadi, arxiv emas.
 */
export const DATA_CHEGARASI = 256 * 1024

/**
 * Ko'rinish kodining maksimal hajmi (belgi).
 *
 * 128 KB — qo'lda yozilgan har qanday dashboard komponentidan ancha katta.
 * Chegara mantiqiy emas, RESURS himoyasi: kompilyatsiya serverda boradi.
 */
export const KOD_CHEGARASI = 128 * 1024

/** Bitta manifestdagi maksimal vidjet soni */
export const VIDJET_CHEGARASI = 50

/** Jadval/ro'yxat vidjetidagi maksimal qator */
export const QATOR_CHEGARASI = 1000

/** `id` faqat shu shaklda — u URL yo'liga va fayl nomiga tushadi */
export const ID_NAQSHI = /^[a-z0-9][a-z0-9-]{0,63}$/

const VIDJET_TURLARI = ['stats', 'bars', 'table', 'logs', 'note', 'deploy', 'git'] as const

export interface TekshiruvNatijasi<T> {
  ok: boolean
  /** `ok` bo'lsa tozalangan qiymat, aks holda `null` */
  qiymat: T | null
  /** Rad etish sabablari — AI'ga shu matn qaytadi */
  xatolar: string[]
  /** Tuzatilgan/tashlangan joylar. Rad etmaydi. */
  ogohlantirishlar: string[]
}

function satrmi(q: unknown): q is string {
  return typeof q === 'string'
}

/** Obyekt (massiv va `null` emas) */
function obyektmi(q: unknown): q is Record<string, unknown> {
  return typeof q === 'object' && q !== null && !Array.isArray(q)
}

/**
 * Matnni xavfsiz satrga keltiradi.
 *
 * AI raqam yoki `null` yuborishi mumkin — bu buzilish emas, shunchaki
 * beparvolik. Uni rad etgandan ko'ra keltirgan ma'qul.
 */
function matnga(q: unknown): string {
  if (satrmi(q)) return q
  if (typeof q === 'number' || typeof q === 'boolean') return String(q)
  return ''
}

function statniTozala(q: unknown): StatItem | null {
  if (!obyektmi(q)) return null
  const label = matnga(q.label)
  if (!label) return null
  return {
    label,
    value: matnga(q.value),
    ...(satrmi(q.hint) ? { hint: q.hint } : {}),
    ...(satrmi(q.accent) ? { accent: q.accent } : {}),
  }
}

/**
 * Bitta vidjetni tekshiradi va tozalaydi. Yaroqsiz bo'lsa `null`.
 *
 * Har tur alohida ko'riladi, chunki `Widget` — diskriminatsiyalangan union
 * va har variantning majburiy maydonlari boshqacha. Umumiy "hamma maydon
 * bor" tekshiruvi bu yerda ishlamaydi.
 */
export function vidjetniTozala(xom: unknown, ogohlantirishlar: string[]): Widget | null {
  if (!obyektmi(xom)) {
    ogohlantirishlar.push('Widget is not an object — dropped')
    return null
  }

  const tur = xom.type
  if (!satrmi(tur) || !(VIDJET_TURLARI as readonly string[]).includes(tur)) {
    ogohlantirishlar.push(`Unknown widget type: ${JSON.stringify(tur)} — dropped`)
    return null
  }

  switch (tur) {
    case 'stats': {
      if (!Array.isArray(xom.items)) {
        ogohlantirishlar.push("`items` in the 'stats' widget is not an array — dropped")
        return null
      }
      const items = xom.items.slice(0, QATOR_CHEGARASI).map(statniTozala).filter((s): s is StatItem => s !== null)
      if (items.length === 0) {
        ogohlantirishlar.push("the 'stats' widget has no valid items — dropped")
        return null
      }
      return { type: 'stats', items }
    }

    case 'bars': {
      if (!Array.isArray(xom.items)) {
        ogohlantirishlar.push("`items` in the 'bars' widget is not an array — dropped")
        return null
      }
      const items = xom.items
        .slice(0, QATOR_CHEGARASI)
        .map((i: unknown) => {
          if (!obyektmi(i)) return null
          const label = matnga(i.label)
          // `value` RAQAM bo'lishi shart: `AppView` uni kenglik hisobida
          // ishlatadi (`value / max * 100`). Satr kelsa NaN chiqib, chiziq
          // umuman ko'rinmasdi — jim buzilish.
          const value = typeof i.value === 'number' && Number.isFinite(i.value) ? i.value : null
          if (!label || value === null) return null
          return { label, value, ...(satrmi(i.note) ? { note: i.note } : {}) }
        })
        .filter((i): i is { label: string; value: number; note?: string } => i !== null)
      if (items.length === 0) {
        ogohlantirishlar.push("the 'bars' widget has no valid items — dropped")
        return null
      }
      return {
        type: 'bars',
        title: matnga(xom.title),
        items,
        ...(satrmi(xom.suffix) ? { suffix: xom.suffix } : {}),
      }
    }

    case 'table': {
      if (!Array.isArray(xom.columns) || !Array.isArray(xom.rows)) {
        ogohlantirishlar.push("`columns`/`rows` in the 'table' widget is not an array — dropped")
        return null
      }
      const columns = xom.columns.map(matnga)
      if (columns.length === 0) {
        ogohlantirishlar.push("the 'table' widget has no columns — dropped")
        return null
      }
      // Qatorlar ustunlar soniga MAJBURAN moslashtiriladi: kam bo'lsa bo'sh
      // katak qo'shiladi, ko'p bo'lsa kesiladi. Aks holda jadval
      // "sinadi" — HTML tuzilishi buziladi.
      const rows = xom.rows.slice(0, QATOR_CHEGARASI).map((r: unknown) => {
        const xomQator = Array.isArray(r) ? r : [r]
        return columns.map((_, i) => matnga(xomQator[i]))
      })
      return { type: 'table', title: matnga(xom.title), columns, rows }
    }

    case 'logs': {
      if (!Array.isArray(xom.lines)) {
        ogohlantirishlar.push("`lines` in the 'logs' widget is not an array — dropped")
        return null
      }
      return {
        type: 'logs',
        title: matnga(xom.title),
        lines: xom.lines.slice(0, QATOR_CHEGARASI).map(matnga),
      }
    }

    case 'note': {
      const text = matnga(xom.text)
      if (!text) {
        ogohlantirishlar.push("the 'note' widget has no text — dropped")
        return null
      }
      return { type: 'note', text }
    }

    case 'deploy': {
      const url = matnga(xom.url)
      if (!url) {
        ogohlantirishlar.push("the 'deploy' widget has no `url` — dropped")
        return null
      }
      // `AppView` buni `<a href>` ga qo'yadi. `javascript:` sxemasi shu
      // yerda kesiladi — aks holda manifest orqali XSS bo'lardi.
      if (!/^https?:\/\//i.test(url)) {
        ogohlantirishlar.push("`url` in the 'deploy' widget is not http(s) — dropped")
        return null
      }
      return {
        type: 'deploy',
        url,
        kind: xom.kind === 'domen' ? 'domen' : 'port',
        server: matnga(xom.server),
        ...(satrmi(xom.ssl) ? { ssl: xom.ssl } : {}),
        ...(satrmi(xom.extra) ? { extra: xom.extra } : {}),
      }
    }

    case 'git': {
      if (!Array.isArray(xom.commits)) {
        ogohlantirishlar.push("`commits` in the 'git' widget is not an array — dropped")
        return null
      }
      const commits = xom.commits
        .slice(0, QATOR_CHEGARASI)
        .map((c: unknown) => {
          if (!obyektmi(c)) return null
          const hash = matnga(c.hash)
          if (!hash) return null
          return { hash, msg: matnga(c.msg), time: matnga(c.time) }
        })
        .filter((c): c is { hash: string; msg: string; time: string } => c !== null)
      return { type: 'git', repo: matnga(xom.repo), branch: matnga(xom.branch), commits }
    }
  }

  return null
}

/**
 * `data` snapshotini tekshiradi.
 *
 * MAZMUN tekshirilmaydi — shaklni AI belgilaydi va u har ilovada boshqacha.
 * Faqat ikki narsa muhim: (1) u obyekt bo'lsin, (2) JSON'ga aylansin va
 * hajmi chegaradan oshmasin.
 *
 * JSON'ga aylanishi ALOHIDA tekshiriladi, chunki `postMessage` va bazaga
 * yozish ikkalasi ham serializatsiyaga tayanadi. Aylanmaydigan qiymat
 * (siklik havola, `BigInt`) keyinroq — allaqachon saqlangandan keyin —
 * yiqilardi.
 */
export function dataniTekshir(xom: unknown, xatolar: string[]): Record<string, unknown> | null {
  if (xom === undefined || xom === null) return null
  if (!obyektmi(xom)) {
    xatolar.push('`data` must be an object (not an array or a scalar)')
    return null
  }

  let json: string
  try {
    json = JSON.stringify(xom)
  } catch {
    xatolar.push('`data` is not JSON-serialisable — is there a circular reference or a BigInt?')
    return null
  }

  if (json.length > DATA_CHEGARASI) {
    xatolar.push(
      `\`data\` is too large: ${json.length} characters, limit ${DATA_CHEGARASI}. ` +
        'A dashboard should show a summary, not a full archive.',
    )
    return null
  }

  return xom
}

/**
 * State nomi — URL yo'liga tushadi, shuning uchun qat'iy chegaralangan.
 *
 * `GET /api/apps/:id/state/:nom` — bu naqsh yo'l chiqishini (`../`) va
 * kodlash muammolarini butunlay yopadi.
 */
export const STATE_NOMI_NAQSHI = /^[a-z][a-z0-9_]{0,31}$/

/** Bitta manifestdagi maksimal state soni */
export const STATE_SONI_CHEGARASI = 20

/** Bitta state kodining maksimal hajmi (belgi) */
export const STATE_KOD_CHEGARASI = 64 * 1024

/**
 * `states` ro'yxatini tekshiradi va tozalaydi.
 *
 * Yaroqsiz state RAD ETILADI (butun manifest emas) — chunki bitta buzuq
 * state uchun butun dashboardni yo'qotish foydalanuvchiga zarar qiladi.
 * Faqat KRITIK xatolar (nom takrorlanishi) manifestni rad etadi, chunki
 * u holda qaysi kod ishlashi noaniq bo'lardi.
 */
export function statelarniTekshir(
  xom: unknown,
  xatolar: string[],
  ogohlantirishlar: string[],
): AppState[] | null {
  if (xom === undefined || xom === null) return null
  if (!Array.isArray(xom)) {
    ogohlantirishlar.push('`states` is not an array — ignored')
    return null
  }

  if (xom.length > STATE_SONI_CHEGARASI) {
    ogohlantirishlar.push(
      `${xom.length} states were given, the first ${STATE_SONI_CHEGARASI} were kept`,
    )
  }

  const natija: AppState[] = []
  const korilganNomlar = new Set<string>()

  for (const el of xom.slice(0, STATE_SONI_CHEGARASI)) {
    if (!obyektmi(el)) {
      ogohlantirishlar.push('State is not an object — dropped')
      continue
    }

    const nom = matnga(el.nom).trim()
    if (!STATE_NOMI_NAQSHI.test(nom)) {
      ogohlantirishlar.push(
        `Invalid state name: ${JSON.stringify(el.nom)} — it must start with a lowercase ` +
          'letter and contain only `a-z0-9_` (it becomes part of a URL path)',
      )
      continue
    }

    // Nom TAKRORLANSA manifest rad etiladi: `data[nom]` bitta joy, ya'ni
    // qaysi kod natijasi qolishi tasodifga bog'liq bo'lardi.
    if (korilganNomlar.has(nom)) {
      xatolar.push(`Duplicate state name: "${nom}"`)
      continue
    }
    korilganNomlar.add(nom)

    const kod = el.kod
    if (!satrmi(kod) || kod.trim().length === 0) {
      ogohlantirishlar.push(`State "${nom}": the code is empty — dropped`)
      continue
    }
    if (kod.length > STATE_KOD_CHEGARASI) {
      ogohlantirishlar.push(
        `State "${nom}": the code is too long (${kod.length} characters) — dropped`,
      )
      continue
    }

    const interval =
      typeof el.interval === 'number' && Number.isFinite(el.interval) && el.interval > 0
        ? Math.round(el.interval)
        : 0

    natija.push({ nom, kod, ...(interval > 0 ? { interval } : {}) })
  }

  return natija.length > 0 ? natija : null
}

/** Ko'rinish kodini tekshiradi (kompilyatsiyadan OLDIN — bu faqat shakl) */
export function viewniTekshir(xom: unknown, xatolar: string[]): AppView | null {
  if (xom === undefined || xom === null) return null
  if (!obyektmi(xom)) {
    xatolar.push('`view` must be an object')
    return null
  }

  const kod = xom.kod
  if (!satrmi(kod) || kod.trim().length === 0) {
    xatolar.push('`view.kod` must be a non-empty string')
    return null
  }
  if (kod.length > KOD_CHEGARASI) {
    xatolar.push(`\`view.kod\` is too long: ${kod.length} characters, limit ${KOD_CHEGARASI}`)
    return null
  }

  return { kod, xash: satrmi(xom.xash) ? xom.xash : '' }
}

// ---------------------------------------------------------------------------
// Boshqaruv qatlami — sozlamalar va amallar
// ---------------------------------------------------------------------------

/**
 * Sozlama kaliti — serverdagi konfiguratsiyaga yoziladi.
 *
 * `STATE_NOMI_NAQSHI` bilan bir xil shakl, lekin uzunroq (64): `.env`
 * kalitlari uzun bo'lishi mumkin (`TELEGRAM_WEBHOOK_SECRET`).
 *
 * Naqsh qat'iy, chunki kalit `.env` fayliga KALIT bo'lib tushadi: `=`, bo'shliq
 * yoki yangi qator kalitda bo'lsa fayl strukturasi buzilardi.
 */
export const SOZLAMA_KALITI_NAQSHI = /^[a-z][a-z0-9_]{0,63}$/

/** Amal nomi — URL yo'liga tushadi (`STATE_NOMI_NAQSHI` bilan bir xil sabab) */
export const AMAL_NOMI_NAQSHI = /^[a-z][a-z0-9_]{0,31}$/

/** Bitta manifestdagi maksimal sozlama maydoni */
export const SOZLAMA_SONI_CHEGARASI = 30

/** Bitta manifestdagi maksimal amal */
export const AMAL_SONI_CHEGARASI = 20

/** `tanlov` turidagi maydondagi maksimal variant */
export const VARIANT_CHEGARASI = 50

const SOZLAMA_TURLARI = ['matn', 'sir', 'raqam', 'tanlov', 'kalit', 'kopMatn'] as const

const AUDIT_DARAJALARI = ["o'qish", "o'zgartirish", 'xavfli'] as const

/**
 * Naqsh satrini tekshiradi — u `RegExp` ga aylanishi SHART.
 *
 * Yaroqsiz naqsh TASHLANADI (maydon qoladi): validatsiyasiz maydon
 * ishlaydi, lekin `new RegExp` xatosi butun formani yiqitardi.
 *
 * ReDoS xavfini ham chegaralaymiz — juda uzun naqsh qabul qilinmaydi.
 */
function naqshniTekshir(xom: unknown, ogohlantirishlar: string[], kalit: string): string | null {
  if (xom === undefined || xom === null) return null
  if (!satrmi(xom) || xom.trim().length === 0) return null

  if (xom.length > 500) {
    ogohlantirishlar.push(`Setting "${kalit}": \`naqsh\` is too long — dropped`)
    return null
  }

  try {
    new RegExp(xom)
  } catch {
    ogohlantirishlar.push(`Setting "${kalit}": \`naqsh\` is not a valid regex — dropped`)
    return null
  }

  return xom
}

/**
 * Sozlama maydonlarini tekshiradi va tozalaydi.
 *
 * Yaroqsiz maydon TASHLANADI (butun forma emas) — `statelarniTekshir` bilan
 * bir xil qaror. Lekin kalit TAKRORLANSA forma rad etiladi: qaysi qiymat
 * yozilishi tasodifga bog'liq bo'lardi.
 */
export function sozlamaMaydonlariniTekshir(
  xom: unknown,
  xatolar: string[],
  ogohlantirishlar: string[],
): SozlamaMaydoni[] | null {
  if (!Array.isArray(xom)) {
    xatolar.push('`sozlamalar.maydonlar` must be an array')
    return null
  }

  if (xom.length > SOZLAMA_SONI_CHEGARASI) {
    ogohlantirishlar.push(
      `${xom.length} settings were given, the first ${SOZLAMA_SONI_CHEGARASI} were kept`,
    )
  }

  const natija: SozlamaMaydoni[] = []
  const korilganKalitlar = new Set<string>()

  for (const el of xom.slice(0, SOZLAMA_SONI_CHEGARASI)) {
    if (!obyektmi(el)) {
      ogohlantirishlar.push('Setting field is not an object — dropped')
      continue
    }

    const kalit = matnga(el.kalit).trim()
    if (!SOZLAMA_KALITI_NAQSHI.test(kalit)) {
      ogohlantirishlar.push(
        `Invalid setting key: ${JSON.stringify(el.kalit)} — it must start with a ` +
          'lowercase letter and contain only `a-z0-9_` (it becomes a configuration key)',
      )
      continue
    }

    if (korilganKalitlar.has(kalit)) {
      xatolar.push(`Duplicate setting key: "${kalit}"`)
      continue
    }
    korilganKalitlar.add(kalit)

    const turi = SOZLAMA_TURLARI.includes(el.turi as (typeof SOZLAMA_TURLARI)[number])
      ? (el.turi as SozlamaTuri)
      : 'matn'
    if (el.turi !== undefined && turi !== el.turi) {
      ogohlantirishlar.push(
        `Setting "${kalit}": type ${JSON.stringify(el.turi)} was not recognised — treated as \`matn\``,
      )
    }

    // Yorliq bo'lmasa kalitning o'zi ishlatiladi: forma yorliqsiz maydon
    // bilan ham ishlaydi, rad etish ortiqcha qattiqlik bo'lardi.
    const yorliq = matnga(el.yorliq).trim() || kalit

    // `tanlov` variantsiz ma'nosiz — bo'sh select foydalanuvchini qamalda
    // qoldirardi, shuning uchun oddiy matnga tushiriladi.
    let variantlar: string[] | undefined
    if (turi === 'tanlov') {
      const xomVariantlar = Array.isArray(el.variantlar)
        ? el.variantlar.map((v) => matnga(v)).filter((v) => v.length > 0)
        : []
      if (xomVariantlar.length === 0) {
        ogohlantirishlar.push(
          `Setting "${kalit}": no options given for \`tanlov\` — treated as \`matn\``,
        )
      } else {
        variantlar = xomVariantlar.slice(0, VARIANT_CHEGARASI)
      }
    }

    const naqsh = naqshniTekshir(el.naqsh, ogohlantirishlar, kalit)

    // `sir` uchun `standart` ATAYLAB tashlanadi: standart qiymat manifestda
    // ochiq turadi va bazaga yoziladi — sir uchun bu qarama-qarshilik.
    const standart = satrmi(el.standart) && turi !== 'sir' ? el.standart : undefined
    if (satrmi(el.standart) && turi === 'sir') {
      ogohlantirishlar.push(
        `Setting "${kalit}": a \`sir\` field cannot have a \`standart\` — dropped`,
      )
    }

    natija.push({
      kalit,
      turi: variantlar === undefined && turi === 'tanlov' ? 'matn' : turi,
      yorliq,
      ...(matnga(el.izoh).trim() ? { izoh: matnga(el.izoh).trim() } : {}),
      ...(el.majburiy === true ? { majburiy: true } : {}),
      ...(standart !== undefined ? { standart } : {}),
      ...(variantlar ? { variantlar } : {}),
      ...(naqsh ? { naqsh } : {}),
      ...(naqsh && matnga(el.naqshIzohi).trim()
        ? { naqshIzohi: matnga(el.naqshIzohi).trim() }
        : {}),
    })
  }

  return natija.length > 0 ? natija : null
}

/**
 * `sozlamalar` blokini tekshiradi.
 *
 * RAD ETADI (butun manifestni): `yoz` kodi yo'q yoki bo'sh. Sabab — sxema
 * bo'lib kodi yo'q forma foydalanuvchini ALDAYDI: u qiymat kiritadi,
 * "Saqlash" bosadi va hech narsa bo'lmaydi. Ko'rsatmaslik yaxshiroq.
 */
export function sozlamalarniTekshir(
  xom: unknown,
  xatolar: string[],
  ogohlantirishlar: string[],
): AppSozlamalari | null {
  if (xom === undefined || xom === null) return null
  if (!obyektmi(xom)) {
    xatolar.push('`sozlamalar` must be an object')
    return null
  }

  const maydonlar = sozlamaMaydonlariniTekshir(xom.maydonlar, xatolar, ogohlantirishlar)
  if (!maydonlar) {
    // Xato allaqachon yozilgan (massiv emas) yoki hammasi tashlangan.
    if (Array.isArray(xom.maydonlar)) {
      xatolar.push('no valid field is left in `sozlamalar.maydonlar`')
    }
    return null
  }

  const yoz = xom.yoz
  if (!satrmi(yoz) || yoz.trim().length === 0) {
    xatolar.push(
      '`sozlamalar.yoz` is required: without code that writes the values to the server ' +
        'the form misleads the user (they type something, but nothing happens)',
    )
    return null
  }
  if (yoz.length > STATE_KOD_CHEGARASI) {
    xatolar.push(
      `\`sozlamalar.yoz\` is too long: ${yoz.length} characters, limit ${STATE_KOD_CHEGARASI}`,
    )
    return null
  }

  // `oqi` IXTIYORIY va yaroqsizi TASHLANADI: u bo'lmasa forma bo'sh
  // ochiladi, bu ishlaydigan holat.
  let oqi: string | undefined
  if (xom.oqi !== undefined && xom.oqi !== null) {
    if (!satrmi(xom.oqi) || xom.oqi.trim().length === 0) {
      ogohlantirishlar.push('`sozlamalar.oqi` is not a string — dropped')
    } else if (xom.oqi.length > STATE_KOD_CHEGARASI) {
      ogohlantirishlar.push('`sozlamalar.oqi` is too long — dropped')
    } else {
      oqi = xom.oqi
    }
  }

  return { maydonlar, yoz, ...(oqi ? { oqi } : {}) }
}

/**
 * Amallarni tekshiradi va tozalaydi.
 *
 * Yaroqsiz amal TASHLANADI, nom takrorlansa manifest rad etiladi (URL yo'li
 * bitta — qaysi kod ishlashi noaniq bo'lardi).
 */
export function amallarniTekshir(
  xom: unknown,
  xatolar: string[],
  ogohlantirishlar: string[],
): AppAmali[] | null {
  if (xom === undefined || xom === null) return null
  if (!Array.isArray(xom)) {
    ogohlantirishlar.push('`amallar` is not an array — ignored')
    return null
  }

  if (xom.length > AMAL_SONI_CHEGARASI) {
    ogohlantirishlar.push(
      `${xom.length} actions were given, the first ${AMAL_SONI_CHEGARASI} were kept`,
    )
  }

  const natija: AppAmali[] = []
  const korilganNomlar = new Set<string>()

  for (const el of xom.slice(0, AMAL_SONI_CHEGARASI)) {
    if (!obyektmi(el)) {
      ogohlantirishlar.push('Action is not an object — dropped')
      continue
    }

    const nom = matnga(el.nom).trim()
    if (!AMAL_NOMI_NAQSHI.test(nom)) {
      ogohlantirishlar.push(
        `Invalid action name: ${JSON.stringify(el.nom)} — it must start with a lowercase ` +
          'letter and contain only `a-z0-9_` (it becomes part of a URL path)',
      )
      continue
    }

    if (korilganNomlar.has(nom)) {
      xatolar.push(`Duplicate action name: "${nom}"`)
      continue
    }
    korilganNomlar.add(nom)

    const kod = el.kod
    if (!satrmi(kod) || kod.trim().length === 0) {
      ogohlantirishlar.push(`Action "${nom}": the code is empty — dropped`)
      continue
    }
    if (kod.length > STATE_KOD_CHEGARASI) {
      ogohlantirishlar.push(`Action "${nom}": the code is too long (${kod.length} characters) — dropped`)
      continue
    }

    // Xavf darajasi tanilmasa `o'zgartirish` — ENG XAVFSIZ standart.
    // `o'qish` deb olsak, holat o'zgartiradigan amal auditda past darajada
    // ko'rinardi; `xavfli` deb olsak har tugma ogohlantirish bilan chiqardi.
    const xavf = AUDIT_DARAJALARI.includes(el.xavf as (typeof AUDIT_DARAJALARI)[number])
      ? (el.xavf as AuditLevel)
      : "o'zgartirish"

    const yangila = Array.isArray(el.yangila)
      ? el.yangila
          .map((n) => matnga(n).trim())
          .filter((n) => STATE_NOMI_NAQSHI.test(n))
          .slice(0, STATE_SONI_CHEGARASI)
      : []

    natija.push({
      nom,
      yorliq: matnga(el.yorliq).trim() || nom,
      ...(matnga(el.izoh).trim() ? { izoh: matnga(el.izoh).trim() } : {}),
      xavf,
      ...(el.tasdiq === true ? { tasdiq: true } : {}),
      kod,
      ...(yangila.length > 0 ? { yangila } : {}),
    })
  }

  return natija.length > 0 ? natija : null
}

/**
 * To'liq manifestni tekshiradi va tozalaydi.
 *
 * RAD ETADIGAN holatlar (`ok: false`) — ilovani umuman ko'rsatib bo'lmaydi:
 *   - `id` yo'q yoki noto'g'ri shaklda (u URL yo'li va papka nomiga tushadi)
 *   - `name` yo'q
 *   - `data`/`view` shakli buzuq yoki chegaradan oshgan
 *
 * TASHLAB KETADIGAN holatlar (`ok: true`, ogohlantirish bilan) — ilova
 * ko'rsatiladi, faqat buzuq qismisiz:
 *   - yaroqsiz vidjet
 *   - chegaradan oshgan vidjetlar
 *
 * Bu ajratim ataylab: bittagina buzuq vidjet uchun butun dashboardni
 * yo'qotish foydalanuvchiga zarar qiladi.
 */
export function manifestniTekshir(xom: unknown): TekshiruvNatijasi<AppManifest> {
  const xatolar: string[] = []
  const ogohlantirishlar: string[] = []

  if (!obyektmi(xom)) {
    return { ok: false, qiymat: null, xatolar: ['The manifest is not an object'], ogohlantirishlar }
  }

  const id = matnga(xom.id).trim()
  if (!id) {
    xatolar.push('`id` is required')
  } else if (!ID_NAQSHI.test(id)) {
    xatolar.push(
      '`id` may contain only lowercase letters, digits and `-` ' +
        '(starting with a letter or digit, at most 64 characters)',
    )
  }

  const name = matnga(xom.name).trim()
  if (!name) xatolar.push('`name` is required')

  // Vidjetlar: massiv bo'lmasa BO'SH deb qaraladi, rad etilmaydi —
  // `view` bo'lsa dashboard vidjetsiz ham to'liq ishlaydi.
  let widgets: Widget[] = []
  if (Array.isArray(xom.widgets)) {
    const xomlar = xom.widgets
    if (xomlar.length > VIDJET_CHEGARASI) {
      ogohlantirishlar.push(
        `${xomlar.length} widgets — the first ${VIDJET_CHEGARASI} were kept`,
      )
    }
    widgets = xomlar
      .slice(0, VIDJET_CHEGARASI)
      .map((w) => vidjetniTozala(w, ogohlantirishlar))
      .filter((w): w is Widget => w !== null)
  } else if (xom.widgets !== undefined) {
    ogohlantirishlar.push('`widgets` is not an array — treated as empty')
  }

  const data = dataniTekshir(xom.data, xatolar)
  const view = viewniTekshir(xom.view, xatolar)
  const states = statelarniTekshir(xom.states, xatolar, ogohlantirishlar)
  const sozlamalar = sozlamalarniTekshir(xom.sozlamalar, xatolar, ogohlantirishlar)
  const amallar = amallarniTekshir(xom.amallar, xatolar, ogohlantirishlar)

  // Ko'rsatadigan HECH NARSA yo'q bo'lsa — bu ilova emas. Bu holat
  // odatda AI natijani noto'g'ri shaklda yuborganini bildiradi, shuning
  // uchun xato matni unga aniq yo'l ko'rsatadi.
  //
  // Sozlamalar va amallar ham HISOBGA olinadi: faqat boshqaruv paneli
  // (forma + restart tugmasi) — to'liq ma'noli ilova, unga vidjet
  // majburlash ortiqcha qattiqlik bo'lardi.
  if (widgets.length === 0 && !view && !sozlamalar && !amallar) {
    xatolar.push(
      'The manifest has nothing to display: `widgets`, `view`, `sozlamalar` and ' +
        '`amallar` are all empty',
    )
  }

  // `amallar[].yangila` mavjud state'ga ishora qilishi kerak — aks holda
  // amaldan keyin "yangilash" jimgina hech narsa qilmasdi.
  if (amallar) {
    const stateNomlari = new Set((states ?? []).map((s) => s.nom))
    for (const amal of amallar) {
      const yoq = (amal.yangila ?? []).filter((n) => !stateNomlari.has(n))
      if (yoq.length > 0) {
        ogohlantirishlar.push(
          `Action "${amal.nom}": \`yangila\` refers to states that do not exist: ${yoq.join(', ')}`,
        )
        amal.yangila = (amal.yangila ?? []).filter((n) => stateNomlari.has(n))
        if (amal.yangila.length === 0) delete amal.yangila
      }
    }
  }

  if (xatolar.length > 0) return { ok: false, qiymat: null, xatolar, ogohlantirishlar }

  return {
    ok: true,
    qiymat: {
      id,
      name,
      icon: matnga(xom.icon) || '📦',
      tagline: matnga(xom.tagline),
      version: matnga(xom.version) || 'v1',
      service: matnga(xom.service),
      status: xom.status === 'idle' ? 'idle' : 'running',
      widgets,
      ...(data ? { data } : {}),
      ...(states ? { states } : {}),
      ...(view ? { view } : {}),
      ...(sozlamalar ? { sozlamalar } : {}),
      ...(amallar ? { amallar } : {}),
    },
    xatolar,
    ogohlantirishlar,
  }
}
