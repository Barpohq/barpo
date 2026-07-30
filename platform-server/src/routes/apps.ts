// Ilova manifestlari — UI sidebar'dagi "Ilovalar" bo'limi va AppView shu
// endpointlardan oziqlanadi.

import { Hono } from 'hono'
import {
  amalBandmi,
  amalniBajar,
  sozlamalarniOqi,
  sozlamalarniYoz,
} from '../amal-bajar.ts'
import { auditYoz } from '../audit.ts'
import { ilovaOqi, ilovalarOqi } from '../repo.ts'
import { intervalniTogrila } from '../state-bajar.ts'
import { stateniOl } from '../state-kesh.ts'

export const appsRoutes = new Hono()

// Manifestlar ro'yxati — UI faqat manifestlarni kutadi, DB metadata emas
appsRoutes.get('/apps', (c) => {
  return c.json({ apps: ilovalarOqi().map((a) => a.manifest) })
})

appsRoutes.get('/apps/:id', (c) => {
  const record = ilovaOqi(c.req.param('id'))
  if (!record) return c.json({ error: 'App not found' }, 404)
  return c.json({
    manifest: record.manifest,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  })
})

// ---------------------------------------------------------------------------
// Jonli statelar
// ---------------------------------------------------------------------------
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ BU — AI YOZMAYDIGAN, OLDINDAN TAYYOR API.                            │
// │                                                                      │
// │ Agent hech qachon yangi endpoint qo'shmaydi. U faqat state KODINI    │
// │ yozadi (`manifest.states`), quyidagi ikki marshrut esa o'zgarmaydi.  │
// │ Frontend shularni polling qiladi va yangi qiymatlarni oladi.         │
// └──────────────────────────────────────────────────────────────────────┘

/**
 * Bitta state qiymati.
 *
 * Kesh interval bo'yicha ishlaydi: interval ichida kelgan so'rovlar
 * saqlangan natijani oladi, kod qayta bajarilmaydi (`state-kesh.ts`).
 * `?majburiy=1` — keshni chetlab o'tadi ("yangilash" tugmasi uchun).
 */
appsRoutes.get('/apps/:id/state/:nom', async (c) => {
  const appId = c.req.param('id')
  const nom = c.req.param('nom')

  const record = ilovaOqi(appId)
  if (!record) return c.json({ error: 'App not found' }, 404)

  const state = record.manifest.states?.find((s) => s.nom === nom)
  if (!state) return c.json({ error: `State not found: ${nom}` }, 404)

  const natija = await stateniOl(
    appId,
    state.nom,
    state.kod,
    intervalniTogrila(state.interval),
    c.req.query('majburiy') === '1',
  )

  // Kod yiqilsa ham HTTP 200: bu server xatosi emas, ma'lumot xatosi.
  // Frontend `ok: false` ni ko'rib eski qiymatni saqlab qoladi va
  // dashboardni yiqitmaydi.
  return c.json(natija)
})

/**
 * Hamma statelar bir so'rovda.
 *
 * Sahifa OCHILGANDA ishlatiladi: 6 ta state uchun 6 ta so'rov o'rniga
 * bitta. Keyingi yangilanishlar har state uchun alohida boradi, chunki
 * ularning intervallari har xil (CPU 5s, disk 30s).
 */
appsRoutes.get('/apps/:id/state', async (c) => {
  const appId = c.req.param('id')
  const record = ilovaOqi(appId)
  if (!record) return c.json({ error: 'App not found' }, 404)

  const statelar = record.manifest.states ?? []
  // Parallel: sekin state (masalan `ssh`) qolganlarini kutdirmasin.
  const natijalar = await Promise.all(
    statelar.map(async (s) => ({
      nom: s.nom,
      natija: await stateniOl(appId, s.nom, s.kod, intervalniTogrila(s.interval)),
    })),
  )

  const javob: Record<string, unknown> = {}
  for (const { nom, natija } of natijalar) javob[nom] = natija
  return c.json({ statelar: javob })
})

// ---------------------------------------------------------------------------
// Boshqaruv qatlami — sozlamalar (forma) va amallar (tugma)
// ---------------------------------------------------------------------------
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ BU HAM — AI YOZMAYDIGAN, OLDINDAN TAYYOR API.                        │
// │                                                                      │
// │ `states` bilan bir xil qoida: uch marshrut o'zgarmaydi, AI faqat      │
// │ KOD beradi (`sozlamalar.yoz`, `sozlamalar.oqi`, `amallar[].kod`).     │
// │                                                                      │
// │ HAQIQAT MANBAI — SERVER. Qiymatlar serverdagi ilovaning o'z           │
// │ konfiguratsiyasiga yoziladi, platforma bazasiga EMAS (`types.ts`      │
// │ dagi boshqaruv qatlami izohiga q.).                                   │
// └──────────────────────────────────────────────────────────────────────┘

/** Amal bajargan aktyor — audit uchun. Hozircha yagona foydalanuvchi. */
const AKTYOR = 'user'

/**
 * Sozlama sxemasi va joriy qiymatlar.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ SIR QIYMATLAR QAYTARILMAYDI — faqat `ornatilgan` bayrog'i.          │
 * │                                                                    │
 * │ Bu qatlamning markaziy qoidasi: token server → platforma → brauzer  │
 * │ yo'lini bosmaydi. Foydalanuvchi joriy tokenni ko'rmaydi, faqat       │
 * │ yangisini yozadi.                                                   │
 * └────────────────────────────────────────────────────────────────────┘
 */
appsRoutes.get('/apps/:id/sozlama', async (c) => {
  const appId = c.req.param('id')
  const record = ilovaOqi(appId)
  if (!record) return c.json({ error: 'App not found' }, 404)

  const sozlamalar = record.manifest.sozlamalar
  if (!sozlamalar) return c.json({ error: 'This app has no settings' }, 404)

  const oqilgan = await sozlamalarniOqi(sozlamalar, { appId, sozlama: {} })

  // Sir maydonlar uchun: qiymat emas, HOLAT. Qiymatning o'zi
  // `sozlamalarniOqi` da tashlangan; `ornatilgan` faqat "serverda bo'sh
  // bo'lmagan qiymat bor" degan bayroqni beradi.
  const ornatilgan: Record<string, boolean> = {}
  for (const maydon of sozlamalar.maydonlar) {
    if (maydon.turi !== 'sir') continue
    ornatilgan[maydon.kalit] = (oqilgan.ornatilgan ?? []).includes(maydon.kalit)
  }

  return c.json({
    maydonlar: sozlamalar.maydonlar,
    qiymatlar: oqilgan.qiymatlar,
    ornatilgan,
    // O'qish yiqilsa forma BARIBIR ko'rsatiladi (bo'sh qiymatlar bilan):
    // foydalanuvchi yangi qiymat yozib tuzatishi mumkin.
    ...(oqilgan.ok ? {} : { ogohlantirish: oqilgan.xato }),
  })
})

/**
 * Sozlama qiymatlarini serverga yozadi.
 *
 * BO'SH SIR — "O'ZGARTIRMADIM": forma sir maydonini bo'sh ko'rsatadi, ya'ni
 * "tegmadim" holati ham bo'sh satr bo'lib keladi. Bo'shni yuborsak mavjud
 * token o'chib ketardi (`mcp-kredensial.ts` dagi bilan bir xil qaror).
 */
appsRoutes.put('/apps/:id/sozlama', async (c) => {
  const appId = c.req.param('id')
  const record = ilovaOqi(appId)
  if (!record) return c.json({ error: 'App not found' }, 404)

  const sozlamalar = record.manifest.sozlamalar
  if (!sozlamalar) return c.json({ error: 'This app has no settings' }, 404)

  let tana: unknown
  try {
    tana = await c.req.json()
  } catch {
    return c.json({ error: 'Expected JSON' }, 400)
  }

  const xom =
    tana && typeof tana === 'object' && !Array.isArray(tana)
      ? ((tana as { qiymatlar?: unknown }).qiymatlar ?? tana)
      : null
  if (!xom || typeof xom !== 'object' || Array.isArray(xom)) {
    return c.json({ error: '`qiymatlar` must be an object' }, 400)
  }

  const kirish = xom as Record<string, unknown>
  const qiymatlar: Record<string, string> = {}
  const xatolar: string[] = []

  for (const maydon of sozlamalar.maydonlar) {
    const berilgan = kirish[maydon.kalit]

    // Kelmagan maydon — tegilmagan. Sxemada yo'q kalitlar ham shu yerda
    // tushib qoladi: kod faqat e'lon qilingan maydonlarni ko'radi.
    if (berilgan === undefined || berilgan === null) {
      if (maydon.majburiy && maydon.turi !== 'sir') {
        // Sir uchun bu xato EMAS: u allaqachon serverda bo'lishi mumkin.
        xatolar.push(`"${maydon.yorliq}" is required`)
      }
      continue
    }

    const qiymat =
      typeof berilgan === 'string'
        ? berilgan
        : typeof berilgan === 'number' || typeof berilgan === 'boolean'
          ? String(berilgan)
          : null

    if (qiymat === null) {
      xatolar.push(`"${maydon.yorliq}": value must be text`)
      continue
    }

    // Bo'sh sir — "o'zgartirmadim" (yuqoridagi izohga q.)
    if (maydon.turi === 'sir' && qiymat.length === 0) continue

    if (maydon.majburiy && qiymat.trim().length === 0) {
      xatolar.push(`"${maydon.yorliq}" is required`)
      continue
    }

    // ┌────────────────────────────────────────────────────────────────┐
    // │ INJECTION HIMOYASINING UCHINCHI QATLAMI.                       │
    // │                                                                │
    // │ Naqsh serverga UZATISHDAN OLDIN tekshiriladi — buzuq qiymat     │
    // │ `.env` ga umuman bormaydi.                                     │
    // └────────────────────────────────────────────────────────────────┘
    if (maydon.naqsh && qiymat.length > 0) {
      let mos = false
      try {
        mos = new RegExp(maydon.naqsh).test(qiymat)
      } catch {
        // Naqsh `manifest-tekshir.ts` da tekshirilgan, bu yerga yaroqsizi
        // kelmasligi kerak. Kelsa — validatsiyani O'TKAZIB yuboramiz,
        // chunki foydalanuvchini o'zi tuzata olmaydigan xato bilan
        // qamalda qoldirish yomonroq.
        mos = true
      }
      if (!mos) {
        xatolar.push(maydon.naqshIzohi || `"${maydon.yorliq}" does not match the required format`)
        continue
      }
    }

    if (maydon.turi === 'raqam' && qiymat.trim().length > 0 && !Number.isFinite(Number(qiymat))) {
      xatolar.push(`"${maydon.yorliq}" must be a number`)
      continue
    }

    qiymatlar[maydon.kalit] = qiymat
  }

  if (xatolar.length > 0) return c.json({ ok: false, xatolar }, 400)

  if (Object.keys(qiymatlar).length === 0) {
    return c.json({ ok: false, xatolar: ['No values changed'] }, 400)
  }

  const natija = await sozlamalarniYoz(sozlamalar, qiymatlar, { appId, sozlama: {} })

  // Audit: sozlamalar o'zgarishi holat o'zgartiradi, ya'ni yozilishi SHART.
  // KALITLAR yoziladi, QIYMATLAR emas — sir auditga tushmasligi kerak.
  auditYoz(
    AKTYOR,
    `Settings saved: ${Object.keys(qiymatlar).join(', ')}`,
    appId,
    "o'zgartirish",
    natija.ok ? 'OK' : 'rad etildi',
  )

  // Yozish yiqilsa 200 EMAS: forma foydalanuvchiga aniq xato ko'rsatishi kerak.
  return c.json(natija, natija.ok ? 200 : 500)
})

/**
 * Amalni bajaradi.
 *
 * `tasdiq` UI tomonda so'raladi — bu marshrut uni TEKSHIRMAYDI. Sabab
 * `types.ts` da yozilgan: tasdiq tasodifiy bosishga qarshi, hujumga qarshi
 * emas.
 */
appsRoutes.post('/apps/:id/amal/:nom', async (c) => {
  const appId = c.req.param('id')
  const nom = c.req.param('nom')

  const record = ilovaOqi(appId)
  if (!record) return c.json({ error: 'App not found' }, 404)

  const amal = record.manifest.amallar?.find((a) => a.nom === nom)
  if (!amal) return c.json({ error: `Action not found: ${nom}` }, 404)

  // Band bo'lsa 409: UI tugmani o'chirib turadi, lekin ikki brauzer oynasi
  // yoki sekin tarmoq bir vaqtda ikki so'rov yuborishi mumkin. Qulf
  // `amalniBajar` ichida ham bor — bu javob shunchaki aniqroq.
  const bandEdi = amalBandmi(appId, nom)

  // Sirsiz sozlama qiymatlari kodga beriladi — masalan konteyner nomi.
  const sozlamalar = record.manifest.sozlamalar
  const sozlama = sozlamalar
    ? (await sozlamalarniOqi(sozlamalar, { appId, sozlama: {} })).qiymatlar
    : {}

  const natija = await amalniBajar(amal, { appId, sozlama })

  auditYoz(
    AKTYOR,
    `Action executed: ${amal.yorliq}`,
    appId,
    amal.xavf ?? "o'zgartirish",
    natija.ok ? 'OK' : 'rad etildi',
  )

  // Amaldan keyin ko'rsatilgan statelar MAJBURIY yangilanadi: restart
  // bosilganda status darhol o'zgarishi kerak, kesh interval tugashini
  // kutib turmasin.
  const yangilangan: Record<string, unknown> = {}
  if (natija.ok && amal.yangila?.length) {
    const statelar = record.manifest.states ?? []
    await Promise.all(
      amal.yangila.map(async (stateNomi) => {
        const state = statelar.find((s) => s.nom === stateNomi)
        if (!state) return
        yangilangan[stateNomi] = await stateniOl(
          appId,
          state.nom,
          state.kod,
          intervalniTogrila(state.interval),
          true,
        )
      }),
    )
  }

  return c.json({
    ...natija,
    ...(bandEdi ? { bandEdi: true } : {}),
    ...(Object.keys(yangilangan).length > 0 ? { statelar: yangilangan } : {}),
  })
})
