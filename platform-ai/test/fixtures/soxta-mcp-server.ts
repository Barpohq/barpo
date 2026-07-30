// Test uchun soxta MCP server — HAQIQIY JARAYON sifatida ishga tushiriladi.
//
// `bun test/fixtures/soxta-mcp-server.ts` bilan ko'tariladi va stdin/stdout
// orqali newline-delimited JSON-RPC gapiradi. Ya'ni integratsiya testi butun
// zanjirni tekshiradi: `Bun.spawn` → stdin yozish → stdout o'qish → jarayon
// o'chishi. Soxta jarayon (`jarayonYaratuvchiniOrnat`) bilan bunday
// tekshirib bo'lmaydi.
//
// Xulqni env orqali boshqarish mumkin (testlar turli holatlarni sinaydi):
//   SOXTA_JIM=1        — hech qanday javob bermaydi (timeout sinovi)
//   SOXTA_XATO=1       — `initialize` ga JSON-RPC xatosi qaytaradi
//   SOXTA_STDERR=matn  — stderr ga yozadi va darhol chiqadi
//   SOXTA_AXLAT=1      — javobdan oldin stdout'ga JSON bo'lmagan qator yozadi
//   SOXTA_SIGTERMSIZ=1 — SIGTERM ni e'tiborsiz qoldiradi (SIGKILL sinovi)

const jim = process.env.SOXTA_JIM === '1'
const xatoRejimi = process.env.SOXTA_XATO === '1'
const axlat = process.env.SOXTA_AXLAT === '1'

// stderr ga yozib darhol chiqish — "ishga tushmadi" holatini taqlid qiladi
const stderrMatni = process.env.SOXTA_STDERR
if (stderrMatni) {
  process.stderr.write(`${stderrMatni}\n`)
  process.exit(1)
}

if (process.env.SOXTA_SIGTERMSIZ === '1') {
  // SIGTERM ga javob bermaydigan server — transport SIGKILL ga o'tishi kerak
  process.on('SIGTERM', () => {})
}

function yoz(x: unknown): void {
  process.stdout.write(`${JSON.stringify(x)}\n`)
}

interface Kelgan {
  id?: number
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

function javobBer(xabar: Kelgan): void {
  if (jim) return

  const { id, method } = xabar

  if (method === 'initialize') {
    if (xatoRejimi) {
      yoz({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: 'soxta ulanish xatosi' },
      })
      return
    }
    if (axlat) {
      // Ba'zi serverlar stdout'ga log yozadi — protokol buzilmasligi kerak
      process.stdout.write('DEBUG: server ishga tushdi\n')
    }
    yoz({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'soxta', version: '1.0.0' },
      },
    })
    return
  }

  // Xabarnoma — javob kutilmaydi
  if (method === 'notifications/initialized') return

  if (method === 'tools/list') {
    yoz({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Kirish matnini qaytaradi',
            inputSchema: {
              type: 'object',
              properties: { matn: { type: 'string' } },
              required: ['matn'],
            },
          },
          {
            name: 'xato_ber',
            description: 'Har doim xato natija qaytaradi',
            inputSchema: { type: 'object', properties: {} },
          },
          // Sxemasiz tool — `toollarniAjrat` uni bo'sh sxema bilan to'ldirishi kerak
          { name: 'sxemasiz' },
        ],
      },
    })
    return
  }

  if (method === 'tools/call') {
    const nom = xabar.params?.name
    if (nom === 'xato_ber') {
      yoz({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'ataylab xato' }], isError: true },
      })
      return
    }
    if (nom === 'echo') {
      const matn = String(xabar.params?.arguments?.matn ?? '')
      yoz({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${matn}` }] } })
      return
    }
    yoz({ jsonrpc: '2.0', id, error: { code: -32601, message: `noma'lum tool: ${nom}` } })
    return
  }

  yoz({ jsonrpc: '2.0', id, error: { code: -32601, message: `noma'lum metod: ${method}` } })
}

// stdin ni qatorlarga ajratib o'qiymiz — klient tomonidagi bilan bir xil mantiq
let bufer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (bolak: string) => {
  bufer += bolak
  let nl: number
  while ((nl = bufer.indexOf('\n')) >= 0) {
    const qator = bufer.slice(0, nl).trim()
    bufer = bufer.slice(nl + 1)
    if (!qator) continue
    try {
      javobBer(JSON.parse(qator) as Kelgan)
    } catch {
      // buzuq qatorni e'tiborsiz qoldiramiz
    }
  }
})

// stdin yopilsa server ham chiqadi — klient `yop()` da aynan shunday qiladi
process.stdin.on('end', () => process.exit(0))
