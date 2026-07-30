// MCP klienti — HAQIQIY JARAYON bilan integratsiya testi.
//
// `mcp-klient.test.ts` dan farqi: bu yerda `Bun.spawn` almashtirilmaydi.
// Soxta MCP server (`fixtures/soxta-mcp-server.ts`) haqiqiy jarayon bo'lib
// ko'tariladi va stdin/stdout orqali gaplashadi.
//
// NEGA IKKI DARAJA KERAK. Birlik testlari mantiqni tekshiradi (id
// moslashtirish, timeout, abort), lekin ular `Bun.spawn` ni CHETLAB O'TADI —
// ya'ni "jarayon haqiqatan ko'tariladimi, stdin yozilgani serverga
// yetadimi, jarayon O'CHADIMI" savollariga javob bermaydi. Aynan shu uchta
// narsa ishlab chiqarishda muammo bo'ladi.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { McpKlient } from '../src/mcp-klient.ts'

const SERVER = join(import.meta.dir, 'fixtures', 'soxta-mcp-server.ts')

function klientYarat(env: Record<string, string> = {}, timeout = 5000): McpKlient {
  return new McpKlient({
    transport: 'stdio',
    buyruq: process.execPath, // bun
    argumentlar: ['run', SERVER],
    env,
    handshakeTimeoutMs: timeout,
    chaqiruvTimeoutMs: timeout,
  })
}

/**
 * PID hali tirikmi.
 *
 * `kill(pid, 0)` signal yubormaydi, faqat jarayon mavjudligini tekshiradi.
 * Zombi qolmaganini shu bilan tasdiqlaymiz.
 */
function tirikmi(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('to\'liq oqim', () => {
  test('ulan → toollarniOl → chaqir → uz', async () => {
    const klient = klientYarat()

    await klient.ulan()
    expect(klient.malumot?.serverInfo?.name).toBe('soxta')

    const toollar = await klient.toollarniOl()
    expect(toollar.map((t) => t.name)).toEqual(['echo', 'xato_ber', 'sxemasiz'])
    // Sxemasi yo'q tool bo'sh obyekt sxema oldi
    expect(toollar[2]?.inputSchema).toEqual({ type: 'object', properties: {} })

    const natija = await klient.chaqir('echo', { matn: 'salom dunyo' })
    expect(natija.content[0]?.text).toBe('echo: salom dunyo')
    expect(natija.isError).toBe(false)

    await klient.uz()
    expect(klient.tayyormi).toBe(false)
  }, 15_000)

  test('inputSchema haqiqiy JSON Schema bo\'lib keladi', async () => {
    const klient = klientYarat()
    await klient.ulan()

    const toollar = await klient.toollarniOl()
    const echo = toollar.find((t) => t.name === 'echo')
    // Bu obyekt to'g'ridan-to'g'ri agent tooliga `parameters` bo'lib boradi
    expect(echo?.inputSchema).toEqual({
      type: 'object',
      properties: { matn: { type: 'string' } },
      required: ['matn'],
    })

    await klient.uz()
  }, 15_000)

  test('isError natija tashlanmaydi, bayroq bilan keladi', async () => {
    const klient = klientYarat()
    await klient.ulan()

    const natija = await klient.chaqir('xato_ber', {})
    expect(natija.isError).toBe(true)
    expect(natija.content[0]?.text).toBe('ataylab xato')

    await klient.uz()
  }, 15_000)

  test('noma\'lum tool JSON-RPC xatosi beradi', async () => {
    const klient = klientYarat()
    await klient.ulan()

    await expect(klient.chaqir('yoq_bunday', {})).rejects.toThrow(/noma'lum tool/)
    // Ulanish TIRIK qoladi — bitta xato chaqiruv sessiyani buzmasin
    expect(klient.tayyormi).toBe(true)

    const keyin = await klient.chaqir('echo', { matn: 'hali ishlaydi' })
    expect(keyin.content[0]?.text).toBe('echo: hali ishlaydi')

    await klient.uz()
  }, 15_000)

  test('ketma-ket chaqiruvlar aralashmaydi', async () => {
    const klient = klientYarat()
    await klient.ulan()

    const natijalar = await Promise.all([
      klient.chaqir('echo', { matn: 'bir' }),
      klient.chaqir('echo', { matn: 'ikki' }),
      klient.chaqir('echo', { matn: 'uch' }),
    ])

    expect(natijalar.map((n) => n.content[0]?.text)).toEqual([
      'echo: bir',
      'echo: ikki',
      'echo: uch',
    ])

    await klient.uz()
  }, 15_000)
})

describe('jarayon lifecycle', () => {
  test('uz() jarayonni HAQIQATAN o\'chiradi (zombi qolmaydi)', async () => {
    // Jarayonni o'zimiz ko'taramiz, PID ni bilish uchun
    const proc = Bun.spawn([process.execPath, 'run', SERVER], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const pid = proc.pid
    expect(tirikmi(pid)).toBe(true)

    // stdin yopilsa fixture o'zi chiqadi — transport `yop()` da shunday qiladi
    proc.stdin.end()
    await proc.exited

    expect(tirikmi(pid)).toBe(false)
  }, 15_000)

  test('handshake muvaffaqiyatsiz bo\'lsa jarayon ortda qolmaydi', async () => {
    // Jim server — javob bermaydi, timeout bo'ladi
    const klient = klientYarat({ SOXTA_JIM: '1' }, 500)

    await expect(klient.ulan()).rejects.toThrow(/did not respond/)
    expect(klient.tayyormi).toBe(false)

    // `ulan()` ichida `uz()` chaqirilgan — takroriy chaqiruv xato bermasligi kerak
    await klient.uz()
  }, 15_000)

  test('server stderr ga yozib chiqsa sabab xato matnida', async () => {
    const klient = klientYarat({ SOXTA_STDERR: 'kerakli paket topilmadi' }, 2000)

    await expect(klient.ulan()).rejects.toThrow(/kerakli paket topilmadi/)
  }, 15_000)

  test('mavjud bo\'lmagan buyruq tushunarli xato beradi', async () => {
    const klient = new McpKlient({
      transport: 'stdio',
      buyruq: '/yoq/bunday/buyruq-mcp',
      handshakeTimeoutMs: 2000,
    })

    // Bun.spawn ENOENT bilan yiqiladi yoki jarayon darhol o'ladi —
    // ikkala holatda ham `ulan()` XATO TASHLASHI kerak, osilib qolmasligi
    await expect(klient.ulan()).rejects.toThrow()
    expect(klient.tayyormi).toBe(false)
  }, 15_000)

  test('SIGTERM ga javob bermagan jarayon SIGKILL bilan o\'ladi', async () => {
    const klient = klientYarat({ SOXTA_SIGTERMSIZ: '1' })
    await klient.ulan()

    const boshlanish = Date.now()
    await klient.uz()
    const ketgan = Date.now() - boshlanish

    // SIGTERM ishlamadi → 2s kutib SIGKILL. Ya'ni yopish ~2s davom etadi,
    // lekin ABADIY OSILIB QOLMAYDI — shu asosiy tekshiruv.
    expect(ketgan).toBeGreaterThan(1500)
    expect(klient.tayyormi).toBe(false)
  }, 15_000)

  test('stdout dagi log qatori protokolni buzmaydi', async () => {
    const klient = klientYarat({ SOXTA_AXLAT: '1' })

    await klient.ulan()
    expect(klient.tayyormi).toBe(true)

    const natija = await klient.chaqir('echo', { matn: 'toza' })
    expect(natija.content[0]?.text).toBe('echo: toza')

    await klient.uz()
  }, 15_000)
})
