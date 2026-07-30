// MCP serverlar API — katalog, manba ulash, o'rnatish.
//
// Model: manba → katalog yozuvi → o'rnatish (qamrov).
// Batafsil: migrations/011-mcp-serverlar.ts.
//
// `routes/skills.ts` bilan bir xil shakl. UCHTA FARQ:
//
//   1) REGISTRY IKKI BOSQICHLI. GitHub'da bir repo = bir necha skill va
//      hammasi katalogga tushadi. Registry'da esa bitta qidiruv = ko'p
//      MUSTAQIL server; foydalanuvchi aniq birini tanlaydi. Shuning uchun
//      `qidir` (saqlamaydi) va `qoshish` (saqlaydi) alohida.
//
//   2) MAXFIY QIYMATLAR JAVOBDA QAYTMAYDI. Katalog va o'rnatish javoblarida
//      faqat "o'rnatilganmi" ma'lumoti bo'ladi, token hech qachon emas.
//
//   3) OMBOR YO'Q. MCP serverda diskka tushadigan fayl bo'lmaydi — jarayon
//      o'z paketini `npx`/`uvx` bilan o'zi oladi. Shuning uchun
//      `skill-ombor.ts` ga o'xshash qatlam kerak emas.
//
// TARMOQ SO'ROVLARI shu qatlamda: registry API va GitHub. Ikkalasida ham
// timeout bor (`mcp-registry.ts`, `github.ts`).

import { Hono } from 'hono'
import type { McpKatalogYozuvi, McpQamrov, McpSozlamaMaydoni } from '@platforma/shared'
import { auditYoz } from '../audit.ts'
import { manzilniAjrat } from '../github.ts'
import { mcpManbaniSkanerla } from '../mcp-github.ts'
import { mcpKredensialOmbori } from '../mcp-kredensial.ts'
import {
  registryQidir,
  registryYozuvniAylantir,
  sozlamaNomiToqrimi,
  type RegistryServerYozuvi,
} from '../mcp-registry.ts'
import {
  faolMcpServerlar,
  loyihaOqi,
  mcpManbaOchir,
  mcpManbalarOqi,
  mcpManbaOqi,
  mcpManbaYarat,
  mcpServerlarniSinxronla,
  mcpServerlarOqi,
  mcpServerOqi,
  mcpServerOrnat,
  mcpServerOrnatishniOchir,
} from '../repo.ts'

export const mcpRoutes = new Hono()

/** Foydalanuvchi kiritishi mumkin bo'lgan eng uzun matn — DoS himoyasi */
const MAKS_MATN = 500

/** Qo'lda qo'shishda ruxsat etilgan eng ko'p argument */
const MAKS_ARGUMENT = 50

// ---------------------------------------------------------------------------
// Katalog
// ---------------------------------------------------------------------------

mcpRoutes.get('/mcp', (c) => {
  return c.json({ serverlar: mcpServerlarOqi(), manbalar: mcpManbalarOqi() })
})

mcpRoutes.get('/mcp/manbalar', (c) => {
  return c.json({ manbalar: mcpManbalarOqi() })
})

/**
 * Sessiyada FAOL serverlar — diagnostika uchun.
 *
 * UI'da "bu loyihada nima ishlaydi" ni ko'rsatish uchun kerak. Kredensial
 * QAYTMAYDI (`mcpServerlarniYig` ularni umuman o'qimaydi).
 */
mcpRoutes.get('/mcp/faol', (c) => {
  const projectId = c.req.query('projectId') ?? null
  return c.json({ serverlar: faolMcpServerlar(projectId) })
})

// ---------------------------------------------------------------------------
// Manba 1: rasmiy registry
// ---------------------------------------------------------------------------

/**
 * Registry'da qidiradi. HECH NARSA SAQLAMAYDI.
 *
 * Natijalar UI'da ko'rsatiladi, foydalanuvchi bittasini tanlab
 * `/mcp/manba/registry` ga yuboradi.
 */
mcpRoutes.get('/mcp/registry/qidir', async (c) => {
  const soz = c.req.query('q')?.trim() ?? ''
  if (soz.length > MAKS_MATN) {
    return c.json({ error: 'Search term too long' }, 400)
  }

  let xomNatija: RegistryServerYozuvi[]
  try {
    xomNatija = await registryQidir(soz)
  } catch (xato) {
    return c.json({ error: xato instanceof Error ? xato.message : 'Search failed' }, 502)
  }

  // Ishlatib bo'lmaydigan yozuvlarni ro'yxatga chiqarmaymiz — foydalanuvchi
  // "Qo'shish" bosib xato olishi yomon tajriba bo'lardi.
  const natijalar = xomNatija
    .map((s) => {
      const yozuv = registryYozuvniAylantir(s)
      if (!yozuv) return null
      return {
        nom: yozuv.nom,
        tavsif: yozuv.tavsif,
        transport: yozuv.transport,
        versiya: s.version ?? null,
        sozlamalar: yozuv.sozlamalar,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  return c.json({ natijalar })
})

/**
 * Registry'dan tanlangan serverni katalogga qo'shadi.
 *
 * Nom bo'yicha QAYTA SO'RALADI (kiyentdan kelgan yozuvga ishonmaymiz):
 * aks holda foydalanuvchi ixtiyoriy buyruq bilan yozuv yuborib, uni
 * "registry'dan" deb ko'rsatishi mumkin edi.
 */
mcpRoutes.post('/mcp/manba/registry', async (c) => {
  let nom: unknown
  try {
    const tana = (await c.req.json()) as { nom?: unknown }
    nom = tana?.nom
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  if (typeof nom !== 'string' || !nom.trim() || nom.length > MAKS_MATN) {
    return c.json({ error: 'Server name is required' }, 400)
  }
  const tozaNom = nom.trim()

  let topilgan: RegistryServerYozuvi[]
  try {
    topilgan = await registryQidir(tozaNom, 20)
  } catch (xato) {
    return c.json({ error: xato instanceof Error ? xato.message : 'Registry error' }, 502)
  }

  const server = topilgan.find((s) => s.name === tozaNom)
  if (!server) {
    return c.json({ error: `Not found in the registry: ${tozaNom}` }, 404)
  }

  const yozuv = registryYozuvniAylantir(server)
  if (!yozuv) {
    return c.json({ error: 'No launch method could be determined for this server' }, 422)
  }

  const manba = mcpManbaYarat({
    tur: 'registry',
    manbaNomi: tozaNom,
    owner: null,
    repo: null,
    ref: '',
  })
  const natija = mcpServerlarniSinxronla(manba.id, [yozuv])

  auditYoz(
    'user',
    'MCP server added to the catalog',
    `${tozaNom} (registry)`,
    "o'zgartirish",
  )

  return c.json({ manba, ...natija }, 201)
})

// ---------------------------------------------------------------------------
// Manba 2: GitHub repo
// ---------------------------------------------------------------------------

mcpRoutes.post('/mcp/manba/github', async (c) => {
  let url: unknown
  try {
    const tana = (await c.req.json()) as { url?: unknown }
    url = tana?.url
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  if (typeof url !== 'string' || !url.trim() || url.length > MAKS_MATN) {
    return c.json({ error: 'Repository URL is required' }, 400)
  }

  const manzil = manzilniAjrat(url)
  if (!manzil) {
    return c.json(
      {
        error: 'Could not parse the URL',
        detail: 'For example: https://github.com/github/github-mcp-server',
      },
      400,
    )
  }

  let skaner: Awaited<ReturnType<typeof mcpManbaniSkanerla>>
  try {
    skaner = await mcpManbaniSkanerla(manzil)
  } catch (xato) {
    return c.json(
      { error: xato instanceof Error ? xato.message : 'Scan failed' },
      502,
    )
  }

  const manba = mcpManbaYarat({
    tur: 'github',
    manbaNomi: `${manzil.owner}/${manzil.repo}`,
    owner: manzil.owner,
    repo: manzil.repo,
    ref: skaner.ref,
  })
  const natija = mcpServerlarniSinxronla(manba.id, skaner.serverlar)

  auditYoz(
    'user',
    'MCP source connected',
    `${manzil.owner}/${manzil.repo} — ${natija.qoshildi} server`,
    "o'zgartirish",
  )

  return c.json({ manba, ...natija, ogohlantirishlar: skaner.ogohlantirishlar }, 201)
})

// ---------------------------------------------------------------------------
// Manba 3: qo'lda
// ---------------------------------------------------------------------------

interface QoldaTana {
  nom?: unknown
  tavsif?: unknown
  transport?: unknown
  buyruq?: unknown
  argumentlar?: unknown
  url?: unknown
  sozlamalar?: unknown
}

/**
 * Sozlama maydonlarini tekshiradi va tozalaydi.
 *
 * Foydalanuvchi kiritgan ma'lumot — noto'g'ri shakl bazaga tushmasligi
 * kerak. Xato bo'lsa matn qaytadi (chaqiruvchi 400 beradi).
 */
function sozlamalarniOqi(xom: unknown): { maydonlar: McpSozlamaMaydoni[] } | { xato: string } {
  if (xom === undefined || xom === null) return { maydonlar: [] }
  if (!Array.isArray(xom)) return { xato: 'sozlamalar must be an array' }
  if (xom.length > MAKS_ARGUMENT) return { xato: 'Too many setting fields' }

  const maydonlar: McpSozlamaMaydoni[] = []
  for (const element of xom) {
    if (!element || typeof element !== 'object') {
      return { xato: 'Every setting must be an object' }
    }
    const m = element as { nom?: unknown; izoh?: unknown; majburiy?: unknown; maxfiy?: unknown }
    if (typeof m.nom !== 'string' || !m.nom.trim()) {
      return { xato: 'Setting name is required' }
    }
    // Registry yo'li bilan BIR XIL qoida (`mcp-registry.ts`): jarayon
    // xulqini o'zgartiradigan nomlar (`NODE_OPTIONS`, `LD_PRELOAD`…) va
    // shakli buzuq nomlar qabul qilinmaydi. Qo'lda qo'shishda foydalanuvchi
    // o'ziga zarar qilmoqchi bo'lsa ham buni ochiq aytamiz — chalkash
    // "nega ishlamaydi" holatidan yaxshiroq.
    if (!sozlamaNomiToqrimi(m.nom.trim())) {
      return {
        xato: `Setting name rejected: ${m.nom.trim()} — only letters, digits, _ and -, and it must not be a name that alters process behaviour`,
      }
    }

    const maydon: McpSozlamaMaydoni = {
      nom: m.nom.trim(),
      majburiy: m.majburiy === true,
      maxfiy: m.maxfiy === true,
    }
    if (typeof m.izoh === 'string' && m.izoh.trim()) maydon.izoh = m.izoh.slice(0, MAKS_MATN)
    maydonlar.push(maydon)
  }
  return { maydonlar }
}

mcpRoutes.post('/mcp/manba/qolda', async (c) => {
  let tana: QoldaTana
  try {
    tana = (await c.req.json()) as QoldaTana
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  const { nom, transport } = tana
  if (typeof nom !== 'string' || !nom.trim() || nom.length > MAKS_MATN) {
    return c.json({ error: 'Server name is required' }, 400)
  }
  if (transport !== 'stdio' && transport !== 'http') {
    return c.json({ error: "transport must be 'stdio' or 'http'" }, 400)
  }

  const sozlamalar = sozlamalarniOqi(tana.sozlamalar)
  if ('xato' in sozlamalar) return c.json({ error: sozlamalar.xato }, 400)

  const yozuv: Omit<McpKatalogYozuvi, 'id' | 'manbaId' | 'createdAt'> = {
    nom: nom.trim(),
    tavsif: typeof tana.tavsif === 'string' ? tana.tavsif.slice(0, MAKS_MATN) : '',
    transport,
    sozlamalar: sozlamalar.maydonlar,
  }

  if (transport === 'stdio') {
    if (typeof tana.buyruq !== 'string' || !tana.buyruq.trim()) {
      return c.json({ error: 'A command is required for stdio' }, 400)
    }
    if (tana.buyruq.length > MAKS_MATN) return c.json({ error: 'Command too long' }, 400)

    let argumentlar: string[] = []
    if (tana.argumentlar !== undefined) {
      if (!Array.isArray(tana.argumentlar)) {
        return c.json({ error: 'argumentlar must be an array' }, 400)
      }
      if (tana.argumentlar.length > MAKS_ARGUMENT) {
        return c.json({ error: 'Too many arguments' }, 400)
      }
      if (!tana.argumentlar.every((a) => typeof a === 'string' && a.length <= MAKS_MATN)) {
        return c.json({ error: 'Every argument must be a short string' }, 400)
      }
      argumentlar = tana.argumentlar as string[]
    }

    yozuv.buyruq = tana.buyruq.trim()
    yozuv.argumentlar = argumentlar
  } else {
    if (typeof tana.url !== 'string' || !tana.url.trim()) {
      return c.json({ error: 'A url is required for http' }, 400)
    }
    // Faqat http(s): `file://` yoki boshqa sxema bilan ulanishga urinmaymiz
    let tekshirilgan: URL
    try {
      tekshirilgan = new URL(tana.url.trim())
    } catch {
      return c.json({ error: 'Invalid url' }, 400)
    }
    if (tekshirilgan.protocol !== 'http:' && tekshirilgan.protocol !== 'https:') {
      return c.json({ error: 'url must be http or https' }, 400)
    }
    yozuv.url = tekshirilgan.toString()
  }

  const manba = mcpManbaYarat({
    tur: 'qolda',
    manbaNomi: yozuv.nom,
    owner: null,
    repo: null,
    ref: '',
  })
  const natija = mcpServerlarniSinxronla(manba.id, [yozuv])

  auditYoz('user', 'MCP server added manually', yozuv.nom, "o'zgartirish")

  return c.json({ manba, ...natija }, 201)
})

// ---------------------------------------------------------------------------
// Sinxronlash va o'chirish
// ---------------------------------------------------------------------------

/**
 * Manbani qayta skanerlaydi.
 *
 * `qolda` va `standart` turlari uchun ma'nosiz — ular tashqi manbadan
 * kelmaydi.
 */
mcpRoutes.post('/mcp/manba/:id/sinxron', async (c) => {
  const manba = mcpManbaOqi(c.req.param('id'))
  if (!manba) return c.json({ error: 'Source not found' }, 404)

  if (manba.tur === 'github') {
    if (!manba.owner || !manba.repo) {
      return c.json({ error: 'Source information is incomplete' }, 422)
    }
    let skaner: Awaited<ReturnType<typeof mcpManbaniSkanerla>>
    try {
      skaner = await mcpManbaniSkanerla({ owner: manba.owner, repo: manba.repo, ref: manba.ref })
    } catch (xato) {
      return c.json(
        { error: xato instanceof Error ? xato.message : 'Scan failed' },
        502,
      )
    }
    const natija = mcpServerlarniSinxronla(manba.id, skaner.serverlar)
    auditYoz(
      'user',
      'MCP source synced',
      `${manba.manbaNomi} — +${natija.qoshildi} / -${natija.ochirildi}`,
      "o'zgartirish",
    )
    return c.json({ ...natija, ogohlantirishlar: skaner.ogohlantirishlar })
  }

  if (manba.tur === 'registry') {
    let topilgan: RegistryServerYozuvi[]
    try {
      topilgan = await registryQidir(manba.manbaNomi, 20)
    } catch (xato) {
      return c.json({ error: xato instanceof Error ? xato.message : 'Registry error' }, 502)
    }
    const server = topilgan.find((s) => s.name === manba.manbaNomi)
    const yozuv = server ? registryYozuvniAylantir(server) : null
    if (!yozuv) {
      return c.json({ error: `Not found in the registry: ${manba.manbaNomi}` }, 404)
    }
    const natija = mcpServerlarniSinxronla(manba.id, [yozuv])
    auditYoz('user', 'MCP source synced', manba.manbaNomi, "o'zgartirish")
    return c.json({ ...natija, ogohlantirishlar: [] })
  }

  return c.json({ error: `This source type cannot be synced: ${manba.tur}` }, 422)
})

/**
 * Manba, uning serverlari (CASCADE) va KREDENSIALLARI o'chadi.
 *
 * Kredensiallar bazada emas, alohida faylda — CASCADE ularga tegmaydi,
 * shuning uchun qo'lda tozalanadi. Aks holda o'chirilgan serverning tokeni
 * faylda abadiy yotib qolardi.
 */
mcpRoutes.delete('/mcp/manba/:id', async (c) => {
  const id = c.req.param('id')
  const manba = mcpManbaOqi(id)
  if (!manba) return c.json({ error: 'Source not found' }, 404)

  // O'chirishdan OLDIN o'rnatish id'larini yig'amiz — keyin ular yo'qoladi
  const ornatishlar = mcpServerlarOqi()
    .filter((s) => s.manbaId === id)
    .flatMap((s) => s.ornatilgan.map((o) => o.id))

  mcpManbaOchir(id)

  const ombor = mcpKredensialOmbori()
  for (const ornatishId of ornatishlar) {
    await ombor.ochir(ornatishId).catch(() => undefined)
  }

  auditYoz('user', 'MCP source removed', manba.manbaNomi, "o'zgartirish")

  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// O'rnatish
// ---------------------------------------------------------------------------

interface OrnatTana {
  qamrov?: unknown
  projectIds?: unknown
  /** Sozlama qiymatlari: maxfiylar kredensial omboriga, qolgani bazaga */
  sozlamaQiymatlari?: unknown
}

/** Kiritilgan qiymatlarni sxema bo'yicha ochiq/maxfiy qismlarga ajratadi */
function qiymatlarniAjrat(
  sozlamalar: readonly McpSozlamaMaydoni[],
  xom: unknown,
): { ochiq: Record<string, string>; maxfiy: Record<string, string>; xato?: string } {
  const ochiq: Record<string, string> = {}
  const maxfiy: Record<string, string> = {}

  if (xom === undefined || xom === null) return { ochiq, maxfiy }
  if (typeof xom !== 'object' || Array.isArray(xom)) {
    return { ochiq, maxfiy, xato: 'sozlamaQiymatlari must be an object' }
  }

  const kelgan = xom as Record<string, unknown>
  for (const maydon of sozlamalar) {
    const qiymat = kelgan[maydon.nom]
    if (qiymat === undefined) continue
    if (typeof qiymat !== 'string') {
      return { ochiq, maxfiy, xato: `"${maydon.nom}" value must be text` }
    }
    if (qiymat.length > 4000) {
      return { ochiq, maxfiy, xato: `"${maydon.nom}" value is too long` }
    }
    // SXEMADA E'LON QILINMAGAN kalitlar TASHLANADI (tsikl sxema bo'yicha
    // ketadi): foydalanuvchi ixtiyoriy env o'zgaruvchisini jarayonga
    // yubora olmasligi kerak.
    if (maydon.maxfiy) maxfiy[maydon.nom] = qiymat
    else ochiq[maydon.nom] = qiymat
  }

  return { ochiq, maxfiy }
}

/**
 * Serverni o'rnatadi: qamrov bazaga, maxfiy qiymatlar kredensial omboriga.
 *
 * MAJBURIY MAYDONLAR TEKSHIRILADI — usiz server ishga tushmasdi va
 * foydalanuvchi sababni chatdan izlashga majbur bo'lardi.
 */
mcpRoutes.post('/mcp/:id/ornat', async (c) => {
  const server = mcpServerOqi(c.req.param('id'))
  if (!server) return c.json({ error: 'MCP server not found' }, 404)

  let tana: OrnatTana
  try {
    tana = (await c.req.json()) as OrnatTana
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  const qamrov = tana.qamrov
  if (qamrov !== 'global' && qamrov !== 'loyiha') {
    return c.json({ error: "qamrov must be 'global' or 'loyiha'" }, 400)
  }

  let loyihalar: string[] = []
  if (qamrov === 'loyiha') {
    if (!Array.isArray(tana.projectIds) || tana.projectIds.length === 0) {
      return c.json({ error: 'Project scope needs at least one project selected' }, 400)
    }
    loyihalar = tana.projectIds.filter((x): x is string => typeof x === 'string')
    for (const id of loyihalar) {
      if (!loyihaOqi(id)) return c.json({ error: `Project not found: ${id}` }, 404)
    }
  }

  const ajratilgan = qiymatlarniAjrat(server.sozlamalar, tana.sozlamaQiymatlari)
  if (ajratilgan.xato) return c.json({ error: ajratilgan.xato }, 400)

  // Majburiy maydonlar: yoki hozir kelgan, yoki allaqachon saqlangan
  // bo'lishi kerak (qayta sozlashda maxfiy maydon bo'sh keladi).
  const ombor = mcpKredensialOmbori()
  const yetishmagan: string[] = []
  for (const maydon of server.sozlamalar) {
    if (!maydon.majburiy) continue
    const kelgan = maydon.maxfiy
      ? ajratilgan.maxfiy[maydon.nom]
      : ajratilgan.ochiq[maydon.nom]
    if (kelgan) continue
    if (maydon.standart) continue
    // Maxfiy maydon uchun oldingi o'rnatishda saqlangan bo'lishi mumkin
    if (maydon.maxfiy) {
      const mavjud = server.ornatilgan.length > 0
      if (mavjud) {
        const saqlangan = await ombor.ol(server.ornatilgan[0]!.id)
        if (saqlangan[maydon.nom]) continue
      }
    } else if (server.ornatilgan.some((o) => o.sozlamaQiymatlari[maydon.nom])) {
      continue
    }
    yetishmagan.push(maydon.nom)
  }

  if (yetishmagan.length > 0) {
    return c.json(
      {
        error: `Required setting not filled in: ${yetishmagan.join(', ')}`,
        yetishmagan,
      },
      400,
    )
  }

  const ornatishIdlari: string[] = []
  if (qamrov === 'global') {
    ornatishIdlari.push(mcpServerOrnat(server.id, 'global', null, ajratilgan.ochiq))
  } else {
    for (const projectId of loyihalar) {
      ornatishIdlari.push(mcpServerOrnat(server.id, 'loyiha', projectId, ajratilgan.ochiq))
    }
  }

  // Maxfiy qiymatlar — HAR o'rnatish uchun alohida (bir server ikki
  // loyihada turli token bilan ishlashi mumkin).
  if (Object.keys(ajratilgan.maxfiy).length > 0) {
    for (const ornatishId of ornatishIdlari) {
      await ombor.saqla(ornatishId, ajratilgan.maxfiy)
    }
  }

  auditYoz(
    'user',
    'MCP server installed',
    `${server.nom} — ${qamrov === 'global' ? 'global' : `${loyihalar.length} loyiha`}`,
    "o'zgartirish",
  )

  // Javobda MAXFIY QIYMAT YO'Q — `mcpServerOqi` ularni umuman o'qimaydi
  return c.json({ server: mcpServerOqi(server.id) })
})

/** O'rnatishni bekor qiladi va kredensialini tozalaydi */
mcpRoutes.delete('/mcp/:id/ornat', async (c) => {
  const server = mcpServerOqi(c.req.param('id'))
  if (!server) return c.json({ error: 'MCP server not found' }, 404)

  let tana: OrnatTana
  try {
    tana = (await c.req.json()) as OrnatTana
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  const qamrov = tana.qamrov
  if (qamrov !== 'global' && qamrov !== 'loyiha') {
    return c.json({ error: "qamrov must be 'global' or 'loyiha'" }, 400)
  }

  const projectIds = Array.isArray(tana.projectIds)
    ? tana.projectIds.filter((x): x is string => typeof x === 'string')
    : []

  const ochirilgan: string[] = []
  if (qamrov === 'global') {
    const id = mcpServerOrnatishniOchir(server.id, 'global', null)
    if (id) ochirilgan.push(id)
  } else {
    if (projectIds.length === 0) return c.json({ error: 'No project selected' }, 400)
    for (const projectId of projectIds) {
      const id = mcpServerOrnatishniOchir(server.id, 'loyiha', projectId)
      if (id) ochirilgan.push(id)
    }
  }

  // Kredensiallar bazada emas — CASCADE ularga tegmaydi
  const ombor = mcpKredensialOmbori()
  for (const id of ochirilgan) {
    await ombor.ochir(id).catch(() => undefined)
  }

  auditYoz('user', 'MCP installation removed', server.nom, "o'zgartirish")

  return c.json({ server: mcpServerOqi(server.id) })
})

/** Qamrov turlari — UI uchun (tip xavfsizligini saqlash) */
export type { McpQamrov }
