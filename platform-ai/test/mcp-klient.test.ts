// MCP klienti — birlik testlari (haqiqiy jarayonsiz).
//
// Jarayon `jarayonYaratuvchiniOrnat()` bilan almashtiriladi (`ssh.ts` dagi
// `bajaruvchiOrnat` uslubi), shuning uchun bu testlar tez ishlaydi va
// timeout/abort kabi holatlarni aniq boshqarish mumkin.
//
// Haqiqiy jarayon bilan to'liq oqim `mcp-klient-integratsiya.test.ts` da.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  MCP_PROTOKOL_VERSIYASI,
  natijaniAjrat,
  toollarniAjrat,
} from '../src/mcp-protokol.ts'
import {
  jarayonYaratuvchiniOrnat,
  stdioTransportYarat,
  type McpJarayon,
} from '../src/mcp-transport.ts'
import { McpKlient } from '../src/mcp-klient.ts'

afterEach(() => {
  jarayonYaratuvchiniOrnat(null)
})

// ---------------------------------------------------------------------------
// Soxta jarayon
// ---------------------------------------------------------------------------

interface SoxtaHolat {
  argv: string[]
  env: Record<string, string>
  yozilgan: string[]
  toxtatildi: number
  oldirildi: number
}

/**
 * Soxta jarayon yaratadi. `javobBer` — kelgan xabarga qanday javob
 * qaytarilishini belgilaydi (undefined qaytarsa javob bo'lmaydi).
 */
function soxtaOrnat(
  javobBer: (xabar: { id?: number; method?: string; params?: unknown }) => unknown,
  sozlama: { stderr?: string; sigtermsiz?: boolean } = {},
): SoxtaHolat {
  const holat: SoxtaHolat = { argv: [], env: {}, yozilgan: [], toxtatildi: 0, oldirildi: 0 }

  jarayonYaratuvchiniOrnat((argv, env) => {
    holat.argv = argv
    holat.env = env

    let chiqish: ((b: string) => void) | undefined
    let xatoOqim: ((b: string) => void) | undefined
    let tugat: ((kod: number) => void) | undefined
    const tugadi = new Promise<number>((r) => {
      tugat = r
    })

    const jarayon: McpJarayon = {
      yoz(matn) {
        holat.yozilgan.push(matn)
        // Kelgan har qatorga javob qaytaramiz
        for (const qator of matn.split('\n')) {
          if (!qator.trim()) continue
          const xabar = JSON.parse(qator) as { id?: number; method?: string; params?: unknown }
          const javob = javobBer(xabar)
          if (javob === undefined) continue
          // Javobni MIKROTASK'dan keyin beramiz — haqiqiy jarayonda ham
          // javob darhol kelmaydi va `sorov()` hali kutishga o'tmagan bo'ladi
          queueMicrotask(() => chiqish?.(`${JSON.stringify(javob)}\n`))
        }
      },
      chiqishniTingla(fn) {
        chiqish = fn
        if (sozlama.stderr) queueMicrotask(() => xatoOqim?.(sozlama.stderr as string))
      },
      xatoOqiminiTingla(fn) {
        xatoOqim = fn
      },
      toxtat() {
        holat.toxtatildi++
        if (!sozlama.sigtermsiz) tugat?.(0)
      },
      old() {
        holat.oldirildi++
        tugat?.(137)
      },
      tugadi,
    }
    return jarayon
  })

  return holat
}

/** Standart javob beruvchi — normal ishlaydigan server */
function normalJavob(xabar: { id?: number; method?: string; params?: unknown }): unknown {
  const { id, method } = xabar
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_PROTOKOL_VERSIYASI,
        serverInfo: { name: 'soxta', version: '1.0' },
      },
    }
  }
  if (method === 'notifications/initialized') return undefined
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [{ name: 'echo', description: 'aks-sado', inputSchema: { type: 'object' } }],
      },
    }
  }
  if (method === 'tools/call') {
    const p = xabar.params as { name?: string; arguments?: { matn?: string } }
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `echo: ${p?.arguments?.matn ?? ''}` }] },
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'noma\'lum metod' } }
}

function klientYarat(qoshimcha: Record<string, unknown> = {}): McpKlient {
  return new McpKlient({
    transport: 'stdio',
    buyruq: 'soxta-server',
    argumentlar: ['--test'],
    handshakeTimeoutMs: 200,
    chaqiruvTimeoutMs: 200,
    ...qoshimcha,
  })
}

// ---------------------------------------------------------------------------

describe('handshake', () => {
  test('ulanadi va serverInfo saqlanadi', async () => {
    const holat = soxtaOrnat(normalJavob)
    const klient = klientYarat()

    await klient.ulan()
    expect(klient.tayyormi).toBe(true)
    expect(klient.malumot?.serverInfo?.name).toBe('soxta')
    await klient.uz()
  })

  test('argv buyruq + argumentlardan quriladi', async () => {
    const holat = soxtaOrnat(normalJavob)
    const klient = klientYarat()
    await klient.ulan()

    expect(holat.argv).toEqual(['soxta-server', '--test'])
    await klient.uz()
  })

  test('env uzatiladi', async () => {
    const holat = soxtaOrnat(normalJavob)
    const klient = klientYarat({ env: { TOKEN: 'maxfiy' } })
    await klient.ulan()

    expect(holat.env).toEqual({ TOKEN: 'maxfiy' })
    await klient.uz()
  })

  test('initialize dan keyin initialized xabarnomasi yuboriladi', async () => {
    const holat = soxtaOrnat(normalJavob)
    const klient = klientYarat()
    await klient.ulan()

    const metodlar = holat.yozilgan.map((m) => (JSON.parse(m.trim()) as { method: string }).method)
    expect(metodlar).toEqual(['initialize', 'notifications/initialized'])
    await klient.uz()
  })

  test('ikki marta ulanish qayta handshake qilmaydi', async () => {
    const holat = soxtaOrnat(normalJavob)
    const klient = klientYarat()
    await klient.ulan()
    await klient.ulan()

    expect(holat.yozilgan.filter((m) => m.includes('initialize')).length).toBe(2) // initialize + initialized
    await klient.uz()
  })

  test('server javob bermasa timeout xatosi va jarayon yopiladi', async () => {
    const holat = soxtaOrnat(() => undefined)
    const klient = klientYarat()

    await expect(klient.ulan()).rejects.toThrow(/did not respond/)
    // Handshake muvaffaqiyatsiz — jarayon ORTDA QOLMASLIGI kerak
    expect(holat.toxtatildi).toBe(1)
    expect(klient.tayyormi).toBe(false)
  })

  test('JSON-RPC xatosi xato matnida ko\'rinadi', async () => {
    soxtaOrnat((x) => ({
      jsonrpc: '2.0',
      id: x.id,
      error: { code: -32000, message: 'ruxsat yo\'q' },
    }))
    const klient = klientYarat()

    await expect(klient.ulan()).rejects.toThrow(/ruxsat yo'q/)
  })

  test('stderr matni xato izohiga qo\'shiladi', async () => {
    soxtaOrnat(() => undefined, { stderr: 'npx: command not found' })
    const klient = klientYarat()

    await expect(klient.ulan()).rejects.toThrow(/command not found/)
  })

  test('buyruqsiz stdio ulanmaydi', async () => {
    const klient = new McpKlient({ transport: 'stdio' })
    await expect(klient.ulan()).rejects.toThrow(/command/)
  })

  test('url\'siz http ulanmaydi', async () => {
    // HTTP transport testlari `mcp-http.test.ts` da (Bun.serve bilan) —
    // bu yerda faqat sozlama tekshiruvi
    const klient = new McpKlient({ transport: 'http' })
    await expect(klient.ulan()).rejects.toThrow(/url/)
  })

  test('noma\'lum transport xato beradi', async () => {
    const klient = new McpKlient({ transport: 'grpc' as 'stdio' })
    await expect(klient.ulan()).rejects.toThrow(/Unknown transport/)
  })
})

describe('tools/list', () => {
  test('tool ro\'yxati keladi', async () => {
    soxtaOrnat(normalJavob)
    const klient = klientYarat()
    await klient.ulan()

    const toollar = await klient.toollarniOl()
    expect(toollar).toHaveLength(1)
    expect(toollar[0]?.name).toBe('echo')
    await klient.uz()
  })

  test('natija keshlanadi — ikkinchi so\'rov yuborilmaydi', async () => {
    const holat = soxtaOrnat(normalJavob)
    const klient = klientYarat()
    await klient.ulan()

    await klient.toollarniOl()
    await klient.toollarniOl()

    const listSoni = holat.yozilgan.filter((m) => m.includes('tools/list')).length
    expect(listSoni).toBe(1)
    await klient.uz()
  })

  test('ulanmasdan chaqirilsa xato', async () => {
    soxtaOrnat(normalJavob)
    const klient = klientYarat()
    await expect(klient.toollarniOl()).rejects.toThrow(/not connected/)
  })
})

describe('tools/call', () => {
  test('natija matni qaytadi', async () => {
    soxtaOrnat(normalJavob)
    const klient = klientYarat()
    await klient.ulan()

    const natija = await klient.chaqir('echo', { matn: 'salom' })
    expect(natija.content[0]?.text).toBe('echo: salom')
    expect(natija.isError).toBe(false)
    await klient.uz()
  })

  test('isError natija XATO TASHLAMAYDI', async () => {
    soxtaOrnat((x) => {
      if (x.method === 'initialize') return normalJavob(x)
      if (x.method === 'notifications/initialized') return undefined
      return {
        jsonrpc: '2.0',
        id: x.id,
        result: { content: [{ type: 'text', text: 'fayl topilmadi' }], isError: true },
      }
    })
    const klient = klientYarat()
    await klient.ulan()

    const natija = await klient.chaqir('ochish', {})
    expect(natija.isError).toBe(true)
    expect(natija.content[0]?.text).toBe('fayl topilmadi')
    await klient.uz()
  })

  test('JSON-RPC xatosi tashlanadi', async () => {
    soxtaOrnat((x) => {
      if (x.method === 'initialize') return normalJavob(x)
      if (x.method === 'notifications/initialized') return undefined
      return { jsonrpc: '2.0', id: x.id, error: { code: -32601, message: 'yo\'q tool' } }
    })
    const klient = klientYarat()
    await klient.ulan()

    await expect(klient.chaqir('yoq', {})).rejects.toThrow(/yo'q tool/)
    await klient.uz()
  })

  test('javob kelmasa timeout', async () => {
    soxtaOrnat((x) => {
      if (x.method === 'initialize') return normalJavob(x)
      return undefined
    })
    const klient = klientYarat()
    await klient.ulan()

    await expect(klient.chaqir('echo', {})).rejects.toThrow(/did not respond/)
    await klient.uz()
  })

  test('abort signali chaqiruvni uzadi', async () => {
    soxtaOrnat((x) => {
      if (x.method === 'initialize') return normalJavob(x)
      return undefined
    })
    const klient = klientYarat()
    await klient.ulan()

    const boshqaruv = new AbortController()
    const kutish = klient.chaqir('echo', {}, boshqaruv.signal)
    boshqaruv.abort()

    await expect(kutish).rejects.toThrow(/cancelled/)
    await klient.uz()
  })

  test('allaqachon abort qilingan signal darhol rad etadi', async () => {
    soxtaOrnat(normalJavob)
    const klient = klientYarat()
    await klient.ulan()

    const boshqaruv = new AbortController()
    boshqaruv.abort()
    await expect(klient.chaqir('echo', {}, boshqaruv.signal)).rejects.toThrow(/cancelled/)
    await klient.uz()
  })

  test('parallel chaqiruvlar id bo\'yicha ajratiladi', async () => {
    // Javoblarni TESKARI tartibda qaytaramiz — id moslashtirish
    // ishlayotganini shu tekshiradi
    const navbat: { id: number; matn: string }[] = []
    jarayonYaratuvchiniOrnat(() => {
      let chiqish: ((b: string) => void) | undefined
      return {
        yoz(matn) {
          for (const qator of matn.split('\n')) {
            if (!qator.trim()) continue
            const x = JSON.parse(qator) as {
              id?: number
              method?: string
              params?: { arguments?: { matn?: string } }
            }
            if (x.method === 'initialize') {
              queueMicrotask(() =>
                chiqish?.(`${JSON.stringify({ jsonrpc: '2.0', id: x.id, result: {} })}\n`),
              )
              continue
            }
            if (x.method === 'notifications/initialized') continue
            navbat.push({ id: x.id ?? 0, matn: x.params?.arguments?.matn ?? '' })
            // Ikkita to'planganda teskari tartibda javob beramiz
            if (navbat.length === 2) {
              for (const j of [...navbat].reverse()) {
                queueMicrotask(() =>
                  chiqish?.(
                    `${JSON.stringify({
                      jsonrpc: '2.0',
                      id: j.id,
                      result: { content: [{ type: 'text', text: j.matn }] },
                    })}\n`,
                  ),
                )
              }
            }
          }
        },
        chiqishniTingla(fn) {
          chiqish = fn
        },
        xatoOqiminiTingla() {},
        toxtat() {},
        old() {},
        tugadi: Promise.resolve(0),
      }
    })

    const klient = klientYarat()
    await klient.ulan()

    const [bir, ikki] = await Promise.all([
      klient.chaqir('echo', { matn: 'bir' }),
      klient.chaqir('echo', { matn: 'ikki' }),
    ])

    expect(bir.content[0]?.text).toBe('bir')
    expect(ikki.content[0]?.text).toBe('ikki')
    await klient.uz()
  })
})

describe('uz()', () => {
  test('jarayonni to\'xtatadi', async () => {
    const holat = soxtaOrnat(normalJavob)
    const klient = klientYarat()
    await klient.ulan()
    await klient.uz()

    expect(holat.toxtatildi).toBe(1)
    expect(klient.tayyormi).toBe(false)
  })

  test('ikki marta chaqirish xavfsiz', async () => {
    const holat = soxtaOrnat(normalJavob)
    const klient = klientYarat()
    await klient.ulan()
    await klient.uz()
    await klient.uz()

    expect(holat.toxtatildi).toBe(1)
  })

  test('kutayotgan so\'rov rad etiladi', async () => {
    soxtaOrnat((x) => {
      if (x.method === 'initialize') return normalJavob(x)
      return undefined
    })
    const klient = klientYarat({ chaqiruvTimeoutMs: 5000 })
    await klient.ulan()

    const kutish = klient.chaqir('echo', {})
    await klient.uz()

    await expect(kutish).rejects.toThrow(/was closed/)
  })

  test('yopilgandan keyin ulanish mumkin emas', async () => {
    soxtaOrnat(normalJavob)
    const klient = klientYarat()
    await klient.ulan()
    await klient.uz()

    await expect(klient.ulan()).rejects.toThrow(/closed/)
  })
})

describe('transport chidamliligi', () => {
  test('stdout dagi JSON bo\'lmagan qator protokolni buzmaydi', async () => {
    jarayonYaratuvchiniOrnat(() => {
      let chiqish: ((b: string) => void) | undefined
      return {
        yoz(matn) {
          const x = JSON.parse(matn.trim()) as { id?: number; method?: string }
          if (x.method !== 'initialize') return
          queueMicrotask(() => {
            // Server log yozdi, keyin haqiqiy javob
            chiqish?.('server ishga tushdi\n')
            chiqish?.(`${JSON.stringify({ jsonrpc: '2.0', id: x.id, result: {} })}\n`)
          })
        },
        chiqishniTingla(fn) {
          chiqish = fn
        },
        xatoOqiminiTingla() {},
        toxtat() {},
        old() {},
        tugadi: Promise.resolve(0),
      }
    })

    const klient = klientYarat()
    await klient.ulan()
    expect(klient.tayyormi).toBe(true)
    await klient.uz()
  })

  test('bo\'laklarga bo\'lingan xabar yig\'iladi', async () => {
    jarayonYaratuvchiniOrnat(() => {
      let chiqish: ((b: string) => void) | undefined
      return {
        yoz(matn) {
          const x = JSON.parse(matn.trim()) as { id?: number; method?: string }
          if (x.method !== 'initialize') return
          const javob = JSON.stringify({ jsonrpc: '2.0', id: x.id, result: { ok: true } })
          // Xabar TCP/pipe bo'laklariga bo'linib kelishi mumkin
          queueMicrotask(() => {
            chiqish?.(javob.slice(0, 10))
            chiqish?.(javob.slice(10))
            chiqish?.('\n')
          })
        },
        chiqishniTingla(fn) {
          chiqish = fn
        },
        xatoOqiminiTingla() {},
        toxtat() {},
        old() {},
        tugadi: Promise.resolve(0),
      }
    })

    const klient = klientYarat()
    await klient.ulan()
    expect(klient.tayyormi).toBe(true)
    await klient.uz()
  })

  test('yopilgan transportga yozib bo\'lmaydi', async () => {
    soxtaOrnat(normalJavob)
    const transport = stdioTransportYarat('a', [])
    await transport.yop()

    await expect(transport.yubor({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow(/closed/)
  })

  test('SIGTERM ga javob bermasa SIGKILL yuboriladi', async () => {
    const holat = soxtaOrnat(normalJavob, { sigtermsiz: true })
    const transport = stdioTransportYarat('a', [])

    // `yop()` SIGKILL taymerini kutadi — OLDIRISH_KUTISH_MS (2s)
    await transport.yop()

    expect(holat.toxtatildi).toBe(1)
    expect(holat.oldirildi).toBe(1)
  }, 10_000)
})

describe('protokol tahlili', () => {
  test('buzuq tool tarifi tashlanadi, qolgani qoladi', () => {
    const toollar = toollarniAjrat({
      tools: [
        { name: 'yaxshi', inputSchema: { type: 'object' } },
        { nom: 'nomsiz' }, // `name` yo'q
        null,
        'satr',
        { name: '' }, // bo'sh nom
        { name: 'sxemasiz' },
      ],
    })

    expect(toollar.map((t) => t.name)).toEqual(['yaxshi', 'sxemasiz'])
    // Sxemasiz tool bo'sh obyekt sxema oladi — provider so'rovi buzilmasin
    expect(toollar[1]?.inputSchema).toEqual({ type: 'object', properties: {} })
  })

  test('tools massiv bo\'lmasa bo\'sh ro\'yxat', () => {
    expect(toollarniAjrat({})).toEqual([])
    expect(toollarniAjrat({ tools: 'yoq' })).toEqual([])
    expect(toollarniAjrat(null)).toEqual([])
  })

  test('matn bo\'lmagan mazmun o\'rin egallovchi bo\'lib qoladi', () => {
    const natija = natijaniAjrat({
      content: [
        { type: 'text', text: 'salom' },
        { type: 'image', data: 'base64...' },
      ],
    })

    expect(natija.content[0]).toEqual({ type: 'text', text: 'salom' })
    expect(natija.content[1]?.text).toContain('image')
  })

  test('content yo\'q bo\'lsa bo\'sh matn', () => {
    expect(natijaniAjrat({}).content).toEqual([{ type: 'text', text: '' }])
    expect(natijaniAjrat(null).content).toEqual([{ type: 'text', text: '' }])
  })
})
