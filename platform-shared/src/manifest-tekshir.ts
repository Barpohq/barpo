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

import type { AppManifest, AppState, AppView, StatItem, Widget } from './types.ts'

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
    ogohlantirishlar.push('Vidjet obyekt emas — tashlandi')
    return null
  }

  const tur = xom.type
  if (!satrmi(tur) || !(VIDJET_TURLARI as readonly string[]).includes(tur)) {
    ogohlantirishlar.push(`Notanish vidjet turi: ${JSON.stringify(tur)} — tashlandi`)
    return null
  }

  switch (tur) {
    case 'stats': {
      if (!Array.isArray(xom.items)) {
        ogohlantirishlar.push("'stats' vidjetida `items` massiv emas — tashlandi")
        return null
      }
      const items = xom.items.slice(0, QATOR_CHEGARASI).map(statniTozala).filter((s): s is StatItem => s !== null)
      if (items.length === 0) {
        ogohlantirishlar.push("'stats' vidjetida yaroqli element yo'q — tashlandi")
        return null
      }
      return { type: 'stats', items }
    }

    case 'bars': {
      if (!Array.isArray(xom.items)) {
        ogohlantirishlar.push("'bars' vidjetida `items` massiv emas — tashlandi")
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
        ogohlantirishlar.push("'bars' vidjetida yaroqli element yo'q — tashlandi")
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
        ogohlantirishlar.push("'table' vidjetida `columns`/`rows` massiv emas — tashlandi")
        return null
      }
      const columns = xom.columns.map(matnga)
      if (columns.length === 0) {
        ogohlantirishlar.push("'table' vidjetida ustun yo'q — tashlandi")
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
        ogohlantirishlar.push("'logs' vidjetida `lines` massiv emas — tashlandi")
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
        ogohlantirishlar.push("'note' vidjetida matn yo'q — tashlandi")
        return null
      }
      return { type: 'note', text }
    }

    case 'deploy': {
      const url = matnga(xom.url)
      if (!url) {
        ogohlantirishlar.push("'deploy' vidjetida `url` yo'q — tashlandi")
        return null
      }
      // `AppView` buni `<a href>` ga qo'yadi. `javascript:` sxemasi shu
      // yerda kesiladi — aks holda manifest orqali XSS bo'lardi.
      if (!/^https?:\/\//i.test(url)) {
        ogohlantirishlar.push("'deploy' vidjetida `url` http(s) emas — tashlandi")
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
        ogohlantirishlar.push("'git' vidjetida `commits` massiv emas — tashlandi")
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
    xatolar.push('`data` obyekt bo\'lishi kerak (massiv yoki skalar emas)')
    return null
  }

  let json: string
  try {
    json = JSON.stringify(xom)
  } catch {
    xatolar.push('`data` JSON\'ga aylanmaydi — siklik havola yoki BigInt bormi?')
    return null
  }

  if (json.length > DATA_CHEGARASI) {
    xatolar.push(
      `\`data\` juda katta: ${json.length} belgi, chegara ${DATA_CHEGARASI}. ` +
        'Dashboard xulosa ko\'rsatishi kerak, to\'liq arxivni emas.',
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
    ogohlantirishlar.push('`states` massiv emas — e\'tiborsiz qoldirildi')
    return null
  }

  if (xom.length > STATE_SONI_CHEGARASI) {
    ogohlantirishlar.push(
      `${xom.length} ta state berildi, birinchi ${STATE_SONI_CHEGARASI} tasi olindi`,
    )
  }

  const natija: AppState[] = []
  const korilganNomlar = new Set<string>()

  for (const el of xom.slice(0, STATE_SONI_CHEGARASI)) {
    if (!obyektmi(el)) {
      ogohlantirishlar.push('State obyekt emas — tashlandi')
      continue
    }

    const nom = matnga(el.nom).trim()
    if (!STATE_NOMI_NAQSHI.test(nom)) {
      ogohlantirishlar.push(
        `State nomi yaroqsiz: ${JSON.stringify(el.nom)} — kichik harf bilan boshlanib, ` +
          '`a-z0-9_` dan iborat bo\'lishi kerak (u URL yo\'liga tushadi)',
      )
      continue
    }

    // Nom TAKRORLANSA manifest rad etiladi: `data[nom]` bitta joy, ya'ni
    // qaysi kod natijasi qolishi tasodifga bog'liq bo'lardi.
    if (korilganNomlar.has(nom)) {
      xatolar.push(`State nomi takrorlangan: "${nom}"`)
      continue
    }
    korilganNomlar.add(nom)

    const kod = el.kod
    if (!satrmi(kod) || kod.trim().length === 0) {
      ogohlantirishlar.push(`State "${nom}": kod bo'sh — tashlandi`)
      continue
    }
    if (kod.length > STATE_KOD_CHEGARASI) {
      ogohlantirishlar.push(
        `State "${nom}": kod juda uzun (${kod.length} belgi) — tashlandi`,
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
    xatolar.push('`view` obyekt bo\'lishi kerak')
    return null
  }

  const kod = xom.kod
  if (!satrmi(kod) || kod.trim().length === 0) {
    xatolar.push('`view.kod` bo\'sh bo\'lmagan satr bo\'lishi kerak')
    return null
  }
  if (kod.length > KOD_CHEGARASI) {
    xatolar.push(`\`view.kod\` juda uzun: ${kod.length} belgi, chegara ${KOD_CHEGARASI}`)
    return null
  }

  return { kod, xash: satrmi(xom.xash) ? xom.xash : '' }
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
    return { ok: false, qiymat: null, xatolar: ['Manifest obyekt emas'], ogohlantirishlar }
  }

  const id = matnga(xom.id).trim()
  if (!id) {
    xatolar.push('`id` majburiy')
  } else if (!ID_NAQSHI.test(id)) {
    xatolar.push(
      '`id` faqat kichik harf, raqam va `-` dan iborat bo\'lishi kerak ' +
        '(harf yoki raqam bilan boshlanadi, eng ko\'pi 64 belgi)',
    )
  }

  const name = matnga(xom.name).trim()
  if (!name) xatolar.push('`name` majburiy')

  // Vidjetlar: massiv bo'lmasa BO'SH deb qaraladi, rad etilmaydi —
  // `view` bo'lsa dashboard vidjetsiz ham to'liq ishlaydi.
  let widgets: Widget[] = []
  if (Array.isArray(xom.widgets)) {
    const xomlar = xom.widgets
    if (xomlar.length > VIDJET_CHEGARASI) {
      ogohlantirishlar.push(
        `Vidjetlar soni ${xomlar.length} — birinchi ${VIDJET_CHEGARASI} tasi olindi`,
      )
    }
    widgets = xomlar
      .slice(0, VIDJET_CHEGARASI)
      .map((w) => vidjetniTozala(w, ogohlantirishlar))
      .filter((w): w is Widget => w !== null)
  } else if (xom.widgets !== undefined) {
    ogohlantirishlar.push('`widgets` massiv emas — bo\'sh deb qabul qilindi')
  }

  const data = dataniTekshir(xom.data, xatolar)
  const view = viewniTekshir(xom.view, xatolar)
  const states = statelarniTekshir(xom.states, xatolar, ogohlantirishlar)

  // Ko'rsatadigan HECH NARSA yo'q bo'lsa — bu ilova emas. Bu holat
  // odatda AI natijani noto'g'ri shaklda yuborganini bildiradi, shuning
  // uchun xato matni unga aniq yo'l ko'rsatadi.
  if (widgets.length === 0 && !view) {
    xatolar.push(
      'Manifestda ko\'rsatadigan narsa yo\'q: `widgets` bo\'sh va `view` ham berilmagan',
    )
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
    },
    xatolar,
    ogohlantirishlar,
  }
}
