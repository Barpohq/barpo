// MCP (Model Context Protocol) JSON-RPC shakllari — FAQAT bizga kerak bo'lgan qism.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NEGA RASMIY SDK OLMADIK.                                             │
// │                                                                      │
// │ `@modelcontextprotocol/sdk` — 4.1 MB, 693 fayl, 17 bog'liqlik        │
// │ (`express`, `cors`, `hono`, `jose`, `pkce-challenge`,                │
// │ `express-rate-limit`...). Ularning deyarli hammasi SERVER tomoni     │
// │ yoki OAuth uchun; bizga faqat klient kerak.                         │
// │                                                                      │
// │ Hal qiluvchi sabab — TESTLASH. SDK ning `StdioClientTransport` i     │
// │ `cross-spawn` ishlatadi, ya'ni loyihaning `bajaruvchiOrnat()`        │
// │ inyeksiya naqshi bilan uni almashtirib bo'lmaydi. Bizga esa jarayon  │
// │ ko'tarilishini soxtalashtirish kerak.                               │
// │                                                                      │
// │ ZARARI OCHIQ: spec kengaysa (resources, prompts, sampling) qo'lda   │
// │ kuzatib borish kerak. Hozircha faqat `tools/*` kerak.               │
// │ OAuth'li serverlar HAM ISHLAMAYDI — faqat statik kredensial         │
// │ (env yoki HTTP sarlavha).                                           │
// └──────────────────────────────────────────────────────────────────────┘
//
// Loyiha falsafasi ("o'z standartimizni o'ylab topmaymiz — MCP'ga tayanamiz")
// buzilmaydi: u STANDART haqida, klient implementatsiyasi haqida emas.
// Biz standart protokolda gaplashamiz, faqat kutubxonani o'zimiz yozamiz.

/**
 * E'lon qiladigan protokol versiyasi.
 *
 * Server BOSHQA versiya qaytarishi mumkin va bu XATO EMAS: spec bo'yicha
 * klient serverning javobiga moslashadi. Biz versiyani faqat e'lon qilamiz,
 * javobdagi qiymatni tekshirmaymiz — aks holda har spec yangilanishida
 * ishlaydigan serverlar ulanmay qolardi.
 */
export const MCP_PROTOKOL_VERSIYASI = '2025-06-18'

export interface JsonRpcSorov {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

/** Xabarnoma — javob KUTILMAYDI (`id` yo'q) */
export interface JsonRpcXabarnoma {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcXato {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcJavob {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: JsonRpcXato
}

export type JsonRpcKelgan = JsonRpcJavob | JsonRpcXabarnoma

/** Kelgan xabar javobmi (id bor) yoki xabarnomami */
export function javobmi(x: JsonRpcKelgan): x is JsonRpcJavob {
  return typeof (x as JsonRpcJavob).id === 'number'
}

/**
 * Server e'lon qilgan tool.
 *
 * `inputSchema` — JSON Schema. U TO'G'RIDAN-TO'G'RI agent tooliga
 * (`parameters`) beriladi: `QidiruvTooli.parameters` tipi `unknown`, ya'ni
 * konvertatsiya kerak emas (`mcp-toollari.ts` ga q.).
 */
export interface McpToolTarifi {
  name: string
  description?: string
  inputSchema: unknown
}

/** `tools/call` natijasi */
export interface McpToolNatijasi {
  content: { type: string; text?: string }[]
  /**
   * Server tool bajarilishida xato bo'lganini shu bilan bildiradi.
   *
   * MUHIM: bu JSON-RPC xatosi EMAS. Protokol darajasida chaqiruv
   * muvaffaqiyatli, faqat tool o'zi xato natija qaytardi (masalan "fayl
   * topilmadi"). Ikkisi farqlanadi: JSON-RPC xatosi `Error` bo'lib
   * tashlanadi, bu esa agentga oddiy natija bo'lib boradi.
   */
  isError?: boolean
}

/** `initialize` javobi — bizga faqat diagnostika uchun kerak */
export interface McpServerMalumoti {
  protocolVersion?: string
  serverInfo?: { name?: string; version?: string }
  capabilities?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Javob tahlili
// ---------------------------------------------------------------------------

/**
 * `tools/list` natijasidan tool ro'yxatini ajratadi.
 *
 * NOTO'G'RI SHAKLGA CHIDAMLI: `tools` massiv bo'lmasa yoki elementda `name`
 * bo'lmasa — o'sha element jimgina tashlanadi, xato tashlanmaydi. Sabab:
 * bitta buzuq tool tarifi butun serverni ishdan chiqarmasligi kerak. Server
 * uchinchi tomon kodi va uning spec'ga to'liq mosligiga tayanib bo'lmaydi.
 */
export function toollarniAjrat(natija: unknown): McpToolTarifi[] {
  if (!natija || typeof natija !== 'object') return []
  const xom = (natija as { tools?: unknown }).tools
  if (!Array.isArray(xom)) return []

  const toollar: McpToolTarifi[] = []
  for (const t of xom) {
    if (!t || typeof t !== 'object') continue
    const tarif = t as { name?: unknown; description?: unknown; inputSchema?: unknown }
    if (typeof tarif.name !== 'string' || !tarif.name) continue
    toollar.push({
      name: tarif.name,
      description: typeof tarif.description === 'string' ? tarif.description : undefined,
      // Sxema yo'q bo'lsa bo'sh obyekt: model argumentsiz chaqiradi.
      // `undefined` qoldirsak provider so'rovi buzilishi mumkin.
      inputSchema: tarif.inputSchema ?? { type: 'object', properties: {} },
    })
  }
  return toollar
}

/**
 * `tools/call` natijasini normal shaklga keltiradi.
 *
 * Server matn bo'lmagan mazmun (`image`, `resource`) qaytarishi mumkin —
 * ular hozircha O'TKAZIB YUBORILMAYDI, balki turi ko'rsatilgan o'rin
 * egallovchi matnga aylanadi. Sabab: agentga "natija bo'sh" deb ko'rsatish
 * yolg'on bo'lardi — u qayta urinib vaqt sarflardi.
 */
export function natijaniAjrat(natija: unknown): McpToolNatijasi {
  if (!natija || typeof natija !== 'object') {
    return { content: [{ type: 'text', text: '' }] }
  }
  const xom = natija as { content?: unknown; isError?: unknown }
  const isError = xom.isError === true

  if (!Array.isArray(xom.content)) {
    return { content: [{ type: 'text', text: '' }], isError }
  }

  const content = xom.content.map((c) => {
    if (!c || typeof c !== 'object') return { type: 'text', text: String(c ?? '') }
    const bolak = c as { type?: unknown; text?: unknown }
    const tur = typeof bolak.type === 'string' ? bolak.type : 'text'
    if (tur === 'text') {
      return { type: 'text', text: typeof bolak.text === 'string' ? bolak.text : '' }
    }
    return { type: tur, text: `[${tur} — non-text content]` }
  })

  return { content, isError }
}
