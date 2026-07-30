// MCP HTTP transport — `Bun.serve` bilan haqiqiy server orqali.
//
// Ikkala variant tekshiriladi: `streamable-http` (oddiy JSON javob) va
// `sse` (`text/event-stream`). Ular bitta transport sinfi bilan ishlanadi —
// farq faqat javob formatida, shuning uchun ikkalasi ham sinalishi kerak.

import { afterEach, describe, expect, test } from 'bun:test'
import { McpKlient } from '../src/mcp-klient.ts'
import { httpTransportYarat, sseXabarlariniAjrat } from '../src/mcp-transport.ts'

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

interface SoxtaSozlama {
  /** SSE formatida javob berish */
  sse?: boolean
  /** `Mcp-Session-Id` sarlavhasini qaytarish */
  sessiya?: string
  /** Bu metodlarga HTTP xatosi qaytarish */
  xatoMetodlari?: string[]
  /** Javob tanasini buzish */
  axlat?: boolean
}

interface Kuzatuv {
  metodlar: string[]
  sessiyaSarlavhalari: (string | null)[]
  sarlavhalar: Record<string, string>[]
}

/** Soxta MCP HTTP server ko'taradi, url va kuzatuv qaytaradi */
function serverKotar(soz: SoxtaSozlama = {}): { url: string; kuzatuv: Kuzatuv } {
  const kuzatuv: Kuzatuv = { metodlar: [], sessiyaSarlavhalari: [], sarlavhalar: [] }

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const xabar = (await req.json()) as { id?: number; method?: string; params?: unknown }
      kuzatuv.metodlar.push(xabar.method ?? '')
      kuzatuv.sessiyaSarlavhalari.push(req.headers.get('Mcp-Session-Id'))
      kuzatuv.sarlavhalar.push(Object.fromEntries(req.headers.entries()))

      const sarlavhalar: Record<string, string> = {}
      if (soz.sessiya) sarlavhalar['Mcp-Session-Id'] = soz.sessiya

      if (soz.xatoMetodlari?.includes(xabar.method ?? '')) {
        return new Response('server rad etdi', { status: 400, headers: sarlavhalar })
      }

      // Xabarnoma — javob tanasi yo'q
      if (xabar.id === undefined) {
        return new Response(null, { status: 202, headers: sarlavhalar })
      }

      if (soz.axlat) {
        return new Response('bu JSON emas', {
          status: 200,
          headers: { ...sarlavhalar, 'Content-Type': 'application/json' },
        })
      }

      const javob = javobQur(xabar)

      if (soz.sse) {
        return new Response(`event: message\ndata: ${JSON.stringify(javob)}\n\n`, {
          status: 200,
          headers: { ...sarlavhalar, 'Content-Type': 'text/event-stream' },
        })
      }

      return new Response(JSON.stringify(javob), {
        status: 200,
        headers: { ...sarlavhalar, 'Content-Type': 'application/json' },
      })
    },
  })

  return { url: `http://localhost:${server.port}/mcp`, kuzatuv }
}

function javobQur(xabar: { id?: number; method?: string; params?: unknown }): unknown {
  const { id, method } = xabar
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'masofaviy-soxta', version: '2.0' },
      },
    }
  }
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [{ name: 'qidir', description: 'Masofaviy qidiruv', inputSchema: { type: 'object' } }],
      },
    }
  }
  if (method === 'tools/call') {
    const p = xabar.params as { name?: string; arguments?: { soz?: string } }
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `topildi: ${p?.arguments?.soz ?? ''}` }] },
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `noma'lum metod: ${method}` } }
}

function klientYarat(url: string, sarlavhalar: Record<string, string> = {}): McpKlient {
  return new McpKlient({
    transport: 'http',
    url,
    sarlavhalar,
    handshakeTimeoutMs: 5000,
    chaqiruvTimeoutMs: 5000,
  })
}

// ---------------------------------------------------------------------------

describe('streamable-http (oddiy JSON)', () => {
  test("to'liq oqim ishlaydi", async () => {
    const { url } = serverKotar()
    const klient = klientYarat(url)

    await klient.ulan()
    expect(klient.malumot?.serverInfo?.name).toBe('masofaviy-soxta')

    const toollar = await klient.toollarniOl()
    expect(toollar.map((t) => t.name)).toEqual(['qidir'])

    const natija = await klient.chaqir('qidir', { soz: 'mcp' })
    expect(natija.content[0]?.text).toBe('topildi: mcp')

    await klient.uz()
  }, 15_000)

  test('initialize dan keyin xabarnoma yuboriladi', async () => {
    const { url, kuzatuv } = serverKotar()
    const klient = klientYarat(url)
    await klient.ulan()

    expect(kuzatuv.metodlar).toEqual(['initialize', 'notifications/initialized'])
    await klient.uz()
  }, 15_000)

  test('sarlavhalar (kredensial) har so\'rovga qo\'shiladi', async () => {
    const { url, kuzatuv } = serverKotar()
    const klient = klientYarat(url, { Authorization: 'Bearer maxfiy-token' })

    await klient.ulan()
    await klient.chaqir('qidir', {})

    for (const s of kuzatuv.sarlavhalar) {
      expect(s.authorization).toBe('Bearer maxfiy-token')
    }
    await klient.uz()
  }, 15_000)
})

describe('sse (text/event-stream)', () => {
  test("to'liq oqim ishlaydi", async () => {
    const { url } = serverKotar({ sse: true })
    const klient = klientYarat(url)

    await klient.ulan()
    const toollar = await klient.toollarniOl()
    expect(toollar.map((t) => t.name)).toEqual(['qidir'])

    const natija = await klient.chaqir('qidir', { soz: 'sse' })
    expect(natija.content[0]?.text).toBe('topildi: sse')

    await klient.uz()
  }, 15_000)
})

describe('Mcp-Session-Id', () => {
  test('server bergan sessiya id keyingi so\'rovlarga qo\'shiladi', async () => {
    const { url, kuzatuv } = serverKotar({ sessiya: 'sessiya-abc' })
    const klient = klientYarat(url)

    await klient.ulan()
    await klient.chaqir('qidir', {})

    // Birinchi so'rovda sessiya hali yo'q, keyingilarida bo'lishi kerak
    expect(kuzatuv.sessiyaSarlavhalari[0]).toBeNull()
    expect(kuzatuv.sessiyaSarlavhalari.slice(1).every((s) => s === 'sessiya-abc')).toBe(true)

    await klient.uz()
  }, 15_000)

  test('sessiya id bermagan server ham ishlaydi', async () => {
    const { url, kuzatuv } = serverKotar()
    const klient = klientYarat(url)

    await klient.ulan()
    await klient.chaqir('qidir', {})

    expect(kuzatuv.sessiyaSarlavhalari.every((s) => s === null)).toBe(true)
    await klient.uz()
  }, 15_000)
})

describe('xato holatlari', () => {
  test('HTTP xatosi tushunarli xabar beradi', async () => {
    const { url } = serverKotar({ xatoMetodlari: ['initialize'] })
    const klient = klientYarat(url)

    await expect(klient.ulan()).rejects.toThrow(/400/)
  }, 15_000)

  test('javob tanasi xato sababini xato matniga qo\'shadi', async () => {
    const { url } = serverKotar({ xatoMetodlari: ['initialize'] })
    const klient = klientYarat(url)

    await expect(klient.ulan()).rejects.toThrow(/server rad etdi/)
  }, 15_000)

  test('XABARNOMA xatosi handshake\'ni YIQITMAYDI', async () => {
    // Ba'zi serverlar `notifications/initialized` ga 4xx qaytaradi —
    // `initialize` muvaffaqiyatli bo'lgani uchun ulanish tirik qolishi kerak
    const { url } = serverKotar({ xatoMetodlari: ['notifications/initialized'] })
    const klient = klientYarat(url)

    await klient.ulan()
    expect(klient.tayyormi).toBe(true)

    const natija = await klient.chaqir('qidir', { soz: 'baribir ishlaydi' })
    expect(natija.content[0]?.text).toBe('topildi: baribir ishlaydi')

    await klient.uz()
  }, 15_000)

  test('JSON bo\'lmagan javob xato beradi', async () => {
    const { url } = serverKotar({ axlat: true })
    const klient = klientYarat(url)

    await expect(klient.ulan()).rejects.toThrow(/JSON emas/)
  }, 15_000)

  test('mavjud bo\'lmagan manzil xato beradi', async () => {
    // 1 port — ulanish rad etiladi
    const klient = klientYarat('http://localhost:1/mcp')
    await expect(klient.ulan()).rejects.toThrow()
  }, 15_000)

  test('url\'siz http ulanmaydi', async () => {
    const klient = new McpKlient({ transport: 'http' })
    await expect(klient.ulan()).rejects.toThrow(/url/)
  })

  test('yopilgan transportga yozib bo\'lmaydi', async () => {
    const transport = httpTransportYarat('http://localhost:1/mcp')
    await transport.yop()
    await expect(transport.yubor({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow(/yopilgan/)
  })
})

describe('sseXabarlariniAjrat', () => {
  test('bitta data qatorini o\'qiydi', () => {
    const xabarlar = sseXabarlariniAjrat('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n')
    expect(xabarlar).toEqual([{ jsonrpc: '2.0', id: 1 }])
  })

  test('bir nechta hodisani o\'qiydi', () => {
    const matn = 'data: {"jsonrpc":"2.0","id":1}\n\ndata: {"jsonrpc":"2.0","id":2}\n\n'
    expect(sseXabarlariniAjrat(matn)).toEqual([
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: 2 },
    ])
  })

  test('data bo\'lmagan qatorlarni tashlaydi', () => {
    const matn = 'event: ping\nid: 42\nretry: 1000\ndata: {"jsonrpc":"2.0","id":1}\n\n'
    expect(sseXabarlariniAjrat(matn)).toEqual([{ jsonrpc: '2.0', id: 1 }])
  })

  test('JSON bo\'lmagan data ni tashlaydi, qolganini o\'qiydi', () => {
    const matn = 'data: axlat\n\ndata: {"jsonrpc":"2.0","id":2}\n\n'
    expect(sseXabarlariniAjrat(matn)).toEqual([{ jsonrpc: '2.0', id: 2 }])
  })

  test('[DONE] belgisini tashlaydi', () => {
    expect(sseXabarlariniAjrat('data: [DONE]\n\n')).toEqual([])
  })

  test('bo\'sh matn bo\'sh ro\'yxat', () => {
    expect(sseXabarlariniAjrat('')).toEqual([])
    expect(sseXabarlariniAjrat('\n\n\n')).toEqual([])
  })
})
