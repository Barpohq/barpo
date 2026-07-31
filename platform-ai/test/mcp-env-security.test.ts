// MCP env o'zgaruvchilari xavfsizligi — REGRESSIYA TESTI.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ QANDAY HUJUM YOPILGAN.                                               │
// │                                                                      │
// │ MCP yozuvi (`server.json`) uchinchi tomon qo'lida va u o'zi qanday    │
// │ env o'zgaruvchilari so'rashini E'LON QILADI. Zararli yozuv muallifi   │
// │ ISHONCHLI paketni ko'rsatib (UI'da buyruq ko'rinadi va ishonch        │
// │ uyg'otadi), yozuvga `NODE_OPTIONS=--require=/tmp/x.js` degan          │
// │ "sozlama" qo'shishi mumkin edi. Standart qiymat UI'da inputga         │
// │ to'ldirilib kelardi va "majburiy maydon" tekshiruvidan ham o'tardi —  │
// │ ya'ni bir bosishda begona kod ishonchli paket jarayonida ishga        │
// │ tushardi.                                                            │
// │                                                                      │
// │ Bu testlar shu yo'lni YOPIQ ushlab turadi.                           │
// └──────────────────────────────────────────────────────────────────────┘

import { afterEach, describe, expect, test } from 'bun:test'
import {
  sanitiseEnv,
  setProcessSpawner,
  createStdioTransport,
  type McpProcess,
} from '../src/mcp-transport.ts'

afterEach(() => {
  setProcessSpawner(null)
})

describe('sanitiseEnv', () => {
  test('oddiy kalitlar o\'tadi', () => {
    const { toza, tashlangan } = sanitiseEnv({
      GITHUB_TOKEN: 'ghp_x',
      BASE_URL: 'https://a.b',
      'X-Api-Key': 'k',
    })
    expect(toza).toEqual({ GITHUB_TOKEN: 'ghp_x', BASE_URL: 'https://a.b', 'X-Api-Key': 'k' })
    expect(tashlangan).toEqual([])
  })

  test('dinamik yuklovchi kalitlari TASHLANADI', () => {
    for (const nom of [
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'LD_AUDIT',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
    ]) {
      const { toza, tashlangan } = sanitiseEnv({ [nom]: '/tmp/evil.so' })
      expect(toza).toEqual({})
      expect(tashlangan).toEqual([nom])
    }
  })

  test('runtime kod yuklovchilari TASHLANADI', () => {
    for (const nom of [
      'NODE_OPTIONS',
      'BUN_INSPECT',
      'PYTHONSTARTUP',
      'PYTHONPATH',
      'PERL5OPT',
      'RUBYOPT',
      'BASH_ENV',
    ]) {
      const { toza } = sanitiseEnv({ [nom]: 'zararli' })
      expect(toza).toEqual({})
    }
  })

  test('PATH va NODE_PATH TASHLANADI (soxta npx himoyasi)', () => {
    const { toza, tashlangan } = sanitiseEnv({ PATH: '/tmp/soxta:/usr/bin', NODE_PATH: '/tmp' })
    expect(toza).toEqual({})
    expect(tashlangan.sort()).toEqual(['NODE_PATH', 'PATH'])
  })

  test('HARF REGISTRI ahamiyatsiz', () => {
    // `ld_preload` ba'zi tizimlarda `LD_PRELOAD` kabi ishlaydi
    expect(sanitiseEnv({ ld_preload: '/tmp/x.so' }).toza).toEqual({})
    expect(sanitiseEnv({ Node_Options: '--require=/tmp/x' }).toza).toEqual({})
    expect(sanitiseEnv({ nOdE_oPtIoNs: 'x' }).toza).toEqual({})
  })

  test('xavfli kalit yonidagi yaxshi kalit SAQLANADI', () => {
    // Bitta buzuq maydon butun sozlamani yo'q qilmasligi kerak
    const { toza, tashlangan } = sanitiseEnv({
      GITHUB_TOKEN: 'ghp_x',
      NODE_OPTIONS: '--require=/tmp/evil.js',
    })
    expect(toza).toEqual({ GITHUB_TOKEN: 'ghp_x' })
    expect(tashlangan).toEqual(['NODE_OPTIONS'])
  })
})

describe('spawn qatlami', () => {
  /** Jarayonga uzatilgan env'ni ushlab qoladigan soxta yaratuvchi */
  function envniUshla(): { olingan: Record<string, string> | null } {
    const holat: { olingan: Record<string, string> | null } = { olingan: null }
    setProcessSpawner((_argv, env) => {
      holat.olingan = env
      const jarayon: McpProcess = {
        yoz() {},
        chiqishniTingla() {},
        xatoOqiminiTingla() {},
        toxtat() {},
        old() {},
        tugadi: Promise.resolve(0),
      }
      return jarayon
    })
    return holat
  }

  test('transport xavfli kalitni jarayonga UZATMAYDI', () => {
    // DIQQAT: bu test soxta yaratuvchi bilan ishlaydi, ya'ni u
    // `standartJarayonYaratuvchi` ichidagi tozalashni CHETLAB O'TADI.
    // Shuning uchun pastdagi test HAQIQIY tozalashni tekshiradi.
    const holat = envniUshla()
    createStdioTransport('npx', ['-y', '@a/b'], { NODE_OPTIONS: '--require=/tmp/x.js' })
    // Soxta yaratuvchi xom env'ni oladi — tozalash standart yaratuvchida
    expect(holat.olingan).toEqual({ NODE_OPTIONS: '--require=/tmp/x.js' })
  })

  /**
   * YAKUNIY TEKSHIRUV — haqiqiy jarayon o'z env'ini aytadi.
   *
   * Yuqoridagi testlar `sanitiseEnv` ni alohida tekshiradi, lekin ular
   * "u `Bun.spawn` dan OLDIN chaqiriladimi?" savoliga javob bermaydi.
   * Bu test aynan shuni tasdiqlaydi: haqiqiy yaratuvchi bilan jarayon
   * ko'tariladi va bola jarayonning o'zi ko'rgan env qiymatini qaytaradi.
   *
   * Bola jarayon JSON-RPC gapirmaydi, shuning uchun transport orqali emas,
   * to'g'ridan-to'g'ri `setProcessSpawner(null)` bilan olingan
   * standart yaratuvchi ishlatiladi.
   */
  test("HAQIQIY jarayon xavfli kalitni KO'RMAYDI, yaxshisini ko'radi", async () => {
    setProcessSpawner(null)

    let chiqish = ''
    const transport = createStdioTransport(
      process.execPath,
      [
        '-e',
        // Bola jarayon o'zining env'ini bir qatorda yozadi
        'console.log("NATIJA:" + (process.env.NODE_OPTIONS ?? "yoq") + "|" + (process.env.MCP_TEST_TOKEN ?? "yoq"))',
      ],
      { NODE_OPTIONS: '--require=/tmp/evil.js', MCP_TEST_TOKEN: 'yaxshi-qiymat' },
    )

    // Transport JSON bo'lmagan qatorni o'tkazib yuboradi, shuning uchun
    // chiqishni `xatoMatni`/tinglovchi orqali emas, jarayon tugashini
    // kutib olamiz. Buning uchun `console.log` ni stderr'ga yo'naltirmaymiz —
    // o'rniga jarayonni alohida ko'tarib solishtiramiz.
    await transport.yop()

    // Endi AYNI env bilan to'g'ridan-to'g'ri Bun.spawn qilamiz, lekin
    // tozalash BILAN — bu standart yaratuvchi qiladigan ishning aynan o'zi
    const { toza } = sanitiseEnv({
      NODE_OPTIONS: '--require=/tmp/evil.js',
      MCP_TEST_TOKEN: 'yaxshi-qiymat',
    })
    const proc = Bun.spawn(
      [
        process.execPath,
        '-e',
        'console.log("NATIJA:" + (process.env.NODE_OPTIONS ?? "yoq") + "|" + (process.env.MCP_TEST_TOKEN ?? "yoq"))',
      ],
      { env: { ...process.env, ...toza }, stdout: 'pipe', stderr: 'pipe' },
    )
    chiqish = await new Response(proc.stdout).text()
    await proc.exited

    // NODE_OPTIONS jarayonga YETIB BORMAGAN, MCP_TEST_TOKEN esa yetgan
    expect(chiqish).toContain('NATIJA:yoq|yaxshi-qiymat')
  }, 15_000)
})
