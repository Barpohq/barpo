// Rasmiy MCP registry klienti — https://registry.modelcontextprotocol.io
//
// `github.ts` bilan bir xil qoidalar: har so'rovda timeout, aniq xato
// xabarlari, tashqi ma'lumotga ishonmaslik.
//
// FARQLARI:
//   - autentifikatsiya YO'Q va rate limit e'lon qilinmagan (ochiq API);
//   - SAHIFALASH `cursor` orqali;
//   - `isLatest` FILTRI SHART (pastga q.).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ `server.json` KONVENSIYASI BILAN BIR XIL SXEMA.                      │
// │                                                                      │
// │ Registry qaytaradigan `server` obyekti va repo ildizidagi            │
// │ `server.json` fayli AYNI JSON shaklda (rasmiy publish formati).      │
// │ Shuning uchun `registryYozuvniAylantir()` ikkala manba uchun ham     │
// │ ishlatiladi (`mcp-github.ts`) — konvertatsiya mantig'i bir joyda.    │
// └──────────────────────────────────────────────────────────────────────┘

import type { McpKatalogYozuvi, McpSozlamaMaydoni } from '@platforma/shared'

const REGISTRY_API = 'https://registry.modelcontextprotocol.io/v0/servers'
const TIMEOUT_MS = 30_000

/** Bir qidiruvda qaytariladigan eng ko'p yozuv */
export const MAKS_REGISTRY_NATIJA = 50

/** Sahifalash tsikli uchun qat'iy chegara — cheksiz aylanish bo'lmasin */
const MAKS_SAHIFA = 10

// ---------------------------------------------------------------------------
// Registry sxemasi (bizga kerak bo'lgan qism)
// ---------------------------------------------------------------------------

/** `KeyValueInput` — env o'zgaruvchisi yoki HTTP sarlavha tavsifi */
export interface RegistryKirish {
  name?: string
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  default?: string
  /** Shablon bo'lishi mumkin: `Bearer {api_key}` */
  value?: string
}

/** `Argument` — pozitsion yoki nomli */
export interface RegistryArgument {
  type?: 'positional' | 'named'
  name?: string
  value?: string
  isRequired?: boolean
}

export interface RegistryPaket {
  registryType?: string
  registryBaseUrl?: string
  identifier?: string
  version?: string
  /** `npx` | `uvx` | `docker` — qaysi ishga tushirgich */
  runtimeHint?: string
  transport?: { type?: string }
  runtimeArguments?: RegistryArgument[]
  packageArguments?: RegistryArgument[]
  environmentVariables?: RegistryKirish[]
}

export interface RegistryRemote {
  type?: string
  url?: string
  headers?: RegistryKirish[]
}

export interface RegistryServerYozuvi {
  /** Reverse-DNS: `io.github.owner/repo` */
  name?: string
  description?: string
  title?: string
  version?: string
  packages?: RegistryPaket[]
  remotes?: RegistryRemote[]
}

interface RegistryJavobi {
  servers?: {
    server?: RegistryServerYozuvi
    _meta?: {
      'io.modelcontextprotocol.registry/official'?: { isLatest?: boolean; status?: string }
    }
  }[]
  metadata?: { nextCursor?: string }
}

// ---------------------------------------------------------------------------
// Qidiruv
// ---------------------------------------------------------------------------

/**
 * Registry'da qidiradi.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ `isLatest` FILTRI SHART — bu jonli API'da tekshirilgan.              │
 * │                                                                      │
 * │ Registry bir serverni HAR VERSIYASI bilan alohida yozuv qilib        │
 * │ qaytaradi (`com.example/github` 1.0.3, 1.0.4, 1.0.5 …). Filtrsiz     │
 * │ foydalanuvchi ro'yxatda bir xil nomni o'n marta ko'rardi.            │
 * │                                                                      │
 * │ `isLatest !== false` deb tekshiramiz (`=== true` emas): maydon       │
 * │ umuman bo'lmasa yozuvni TASHLAMAYMIZ — API kelajakda metadata        │
 * │ shaklini o'zgartirsa katalog bo'sh bo'lib qolmasin.                  │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * XATO TASHLAYDI — chaqiruvchi (route) uni 502 ga aylantiradi.
 */
export async function registryQidir(
  soz: string,
  limit = 30,
): Promise<RegistryServerYozuvi[]> {
  const natija: RegistryServerYozuvi[] = []
  const korilganNomlar = new Set<string>()
  let cursor: string | undefined
  let sahifa = 0

  do {
    const url = new URL(REGISTRY_API)
    if (soz.trim()) url.searchParams.set('search', soz.trim())
    url.searchParams.set('limit', String(Math.min(limit, MAKS_REGISTRY_NATIJA)))
    if (cursor) url.searchParams.set('cursor', cursor)

    let javob: Response
    try {
      javob = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (xato) {
      // Tarmoq xatosi yoki timeout — sabab aniq bo'lsin
      const sabab = xato instanceof Error ? xato.message : String(xato)
      throw new Error(`Could not reach the MCP registry: ${sabab}`)
    }

    if (!javob.ok) {
      throw new Error(`MCP registry error: ${javob.status} ${javob.statusText}`)
    }

    let malumot: RegistryJavobi
    try {
      malumot = (await javob.json()) as RegistryJavobi
    } catch {
      throw new Error('The MCP registry response is not JSON')
    }

    for (const yozuv of malumot.servers ?? []) {
      const server = yozuv.server
      if (!server?.name) continue
      const meta = yozuv._meta?.['io.modelcontextprotocol.registry/official']
      if (meta?.isLatest === false) continue
      // Bir nom ikki marta tushmasin (metadata yo'q yozuvlar uchun himoya)
      if (korilganNomlar.has(server.name)) continue
      korilganNomlar.add(server.name)
      natija.push(server)
      if (natija.length >= limit) return natija
    }

    cursor = malumot.metadata?.nextCursor
    sahifa += 1
  } while (cursor && sahifa < MAKS_SAHIFA)

  return natija
}

// ---------------------------------------------------------------------------
// Katalog shakliga aylantirish
// ---------------------------------------------------------------------------

type XomYozuv = Omit<McpKatalogYozuvi, 'id' | 'manbaId' | 'createdAt'>

/**
 * Sozlama nomi qabul qilinadimi.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ IKKI QATLAMLI HIMOYANING BIRINCHISI.                                 │
 * │                                                                      │
 * │ Yozuv UCHINCHI TOMON qo'lida: u `environmentVariables[].name` ga      │
 * │ ixtiyoriy nom yozishi mumkin. `NODE_OPTIONS` yoki `LD_PRELOAD` kabi   │
 * │ nom bilan u ISHONCHLI paketning jarayonini o'ziga bo'ysundirardi      │
 * │ (batafsil: `platform-ai/src/mcp-transport.ts` dagi                   │
 * │ `TAQIQLANGAN_ENV` izohi).                                            │
 * │                                                                      │
 * │ Bunday maydonni KATALOGGA UMUMAN KIRITMAYMIZ — u UI'da oddiy         │
 * │ sozlama bo'lib ko'rinmasligi kerak. Ikkinchi qatlam (transport)       │
 * │ baribir tekshiradi, lekin foydalanuvchiga yolg'on maydon              │
 * │ ko'rsatmaslik ham muhim.                                             │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Shakl ham tekshiriladi: env nomi / HTTP sarlavha nomi uchun oddiy
 * belgilar yetarli. `=`, bo'shliq, yangi qator kabi belgilar bo'lgan nom
 * hech qanday holatda to'g'ri emas.
 *
 * Eksport qilingan — test va `routes/mcp.ts` (qo'lda qo'shish) shundan
 * foydalanadi, ya'ni qoida bitta joyda.
 */
export function sozlamaNomiToqrimi(nom: string): boolean {
  if (!nom || nom.length > 200) return false
  // Faqat harf, raqam, `_` va `-` (HTTP sarlavhalarida `-` ishlatiladi)
  if (!/^[A-Za-z0-9_-]+$/.test(nom)) return false
  return !XAVFLI_SOZLAMA_NOMLARI.has(nom.toUpperCase())
}

/**
 * Katalogga kiritilmaydigan nomlar.
 *
 * `mcp-transport.ts` dagi `TAQIQLANGAN_ENV` bilan MOS bo'lishi kerak.
 * Ikki ro'yxat ataylab alohida: bu paket `platform-ai` ga bog'liq emas
 * (qatlam chegarasi), lekin ikkalasi bir xil maqsadga xizmat qiladi.
 * Transport qatlami — yakuniy hakam; bu yerda esa yozuv katalogga
 * tushmasligi ta'minlanadi.
 */
const XAVFLI_SOZLAMA_NOMLARI = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'BUN_INSPECT',
  'BUN_INSPECT_CONNECT_TO',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PATH',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
  'SHELL',
  'IFS',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
])

/**
 * `KeyValueInput` → bizning sozlama maydoni.
 *
 * Nomi qabul qilinmasa `null` — chaqiruvchi uni o'tkazib yuboradi.
 */
function kirishniAylantir(k: RegistryKirish): McpSozlamaMaydoni | null {
  if (!k.name) return null
  if (!sozlamaNomiToqrimi(k.name)) return null
  const maydon: McpSozlamaMaydoni = {
    nom: k.name,
    majburiy: k.isRequired === true,
    maxfiy: k.isSecret === true,
  }
  if (k.description) maydon.izoh = k.description
  if (k.default) maydon.standart = k.default
  return maydon
}

/**
 * `Argument` → buyruq satri bo'lagi.
 *
 * Nomli argument ikki bo'lakka aylanadi (`--flag`, `qiymat`) — `Bun.spawn`
 * argv MASSIVI bilan ishlaydi, ya'ni ular alohida element bo'lishi kerak.
 * Bitta satrga qo'shsak (`--flag qiymat`) server uni bitta argument deb
 * qabul qilardi.
 */
function argumentniAylantir(a: RegistryArgument): string[] {
  if (a.type === 'named' && a.name) {
    return a.value ? [a.name, a.value] : [a.name]
  }
  return a.value ? [a.value] : []
}

/**
 * Ishga tushirish buyrug'ini aniqlaydi.
 *
 * `runtimeHint` bo'lsa unga ishonamiz. Bo'lmasa paket turidan xulosa
 * qilamiz — bu ekotizimdagi amaldagi konvensiya (`npm` → `npx`,
 * `pypi` → `uvx`, `oci` → `docker`).
 */
function buyruqniAniqla(paket: RegistryPaket): string | null {
  if (paket.runtimeHint) return paket.runtimeHint
  switch (paket.registryType) {
    case 'npm':
      return 'npx'
    case 'pypi':
      return 'uvx'
    case 'oci':
      return 'docker'
    default:
      // `nuget`, `mcpb` va boshqalar uchun ishga tushirgich noma'lum —
      // taxmin qilib buzuq yozuv yaratgandan ko'ra tashlab ketamiz.
      return null
  }
}

/**
 * Registry (yoki `server.json`) yozuvini katalog shakliga aylantiradi.
 *
 * BIRINCHI mos variant tanlanadi: avval stdio paket, topilmasa masofaviy
 * ulanish. Server ikkalasini ham e'lon qilgan bo'lsa stdio afzal —
 * mahalliy jarayon tashqi xizmatga bog'liq emas va tezroq.
 *
 * `null` qaytsa — yozuvni ishlatib bo'lmaydi (na paket, na remote, yoki
 * ishga tushirgich noma'lum). Chaqiruvchi uni o'tkazib yuboradi va
 * ogohlantirish qo'shadi.
 */
export function registryYozuvniAylantir(s: RegistryServerYozuvi): XomYozuv | null {
  if (!s.name) return null

  const tavsif = s.description ?? ''
  const sozlamalar = (kirishlar?: RegistryKirish[]): McpSozlamaMaydoni[] =>
    (kirishlar ?? []).map(kirishniAylantir).filter((m): m is McpSozlamaMaydoni => m !== null)

  for (const paket of s.packages ?? []) {
    // Faqat stdio: boshqa transport turlari paket ichida uchramaydi, lekin
    // kelajakda paydo bo'lsa uni jimgina stdio deb ishlatish xato bo'lardi.
    if (paket.transport?.type && paket.transport.type !== 'stdio') continue
    if (!paket.identifier) continue

    const buyruq = buyruqniAniqla(paket)
    if (!buyruq) continue

    const argumentlar = [
      ...(paket.runtimeArguments ?? []).flatMap(argumentniAylantir),
      // Paket identifikatori: `npx -y @a/b` dagi `@a/b`. Docker uchun
      // bu image nomi (`ghcr.io/x/y:1.0`).
      paket.identifier,
      ...(paket.packageArguments ?? []).flatMap(argumentniAylantir),
    ]

    return {
      nom: s.name,
      tavsif,
      transport: 'stdio',
      buyruq,
      argumentlar,
      sozlamalar: sozlamalar(paket.environmentVariables),
    }
  }

  for (const masofaviy of s.remotes ?? []) {
    if (!masofaviy.url) continue
    // `streamable-http` va `sse` — ikkalasini ham bitta transport ishlaydi
    if (masofaviy.type && masofaviy.type !== 'streamable-http' && masofaviy.type !== 'sse') {
      continue
    }
    return {
      nom: s.name,
      tavsif,
      transport: 'http',
      url: masofaviy.url,
      sozlamalar: sozlamalar(masofaviy.headers),
    }
  }

  return null
}

/**
 * O'rin egallovchilarni almashtiradi: `Bearer {api_key}` → `Bearer sk-…`.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ SHELL ISHLATILMAYDI. Almashtirish oddiy matn amali va natija         │
 * │ `Bun.spawn` argv MASSIVI elementi bo'ladi. Ya'ni qiymat ichidagi     │
 * │ `;rm -rf ~` kabi matn hech qachon buyruq bo'lib bajarilmaydi.        │
 * │                                                                      │
 * │ Bu rasmiy MCP spec tavsiyasi (`Argument` ta'rifidagi ogohlantirish). │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Nomlar `{...}` ichida turli shaklda bo'lishi mumkin (`{api_key}`,
 * `{API_KEY}`) — solishtirish katta-kichik harf farqsiz va `_`/`-` farqsiz
 * qilinadi, chunki registry yozuvlarida ular izchil emas.
 */
export function orinEgallovchilarniAlmashtir(
  matn: string,
  qiymatlar: Record<string, string>,
): string {
  if (!matn.includes('{')) return matn

  // Kalitlarni normal shaklga keltirib xarita quramiz
  const xarita = new Map<string, string>()
  for (const [nom, qiymat] of Object.entries(qiymatlar)) {
    xarita.set(nom.toLowerCase().replace(/[_-]/g, ''), qiymat)
  }

  return matn.replace(/\{([\w.-]+)\}/g, (butun, nom: string) => {
    const qiymat = xarita.get(nom.toLowerCase().replace(/[_-]/g, ''))
    // Topilmasa O'ZGARISHSIZ qoldiramiz: bo'sh satr qilsak server
    // "argument berilmadi" emas, "argument bo'sh" deb tushunardi va xato
    // xabari chalg'ituvchi bo'lardi.
    return qiymat ?? butun
  })
}
