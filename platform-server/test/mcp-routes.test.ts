// MCP API — HTTP darajasida.
//
// Hono ilovasi orqali chaqiriladi (tarmoq porti ochilmaydi — `app.fetch`).
// Registry va GitHub so'rovlari SINALMAYDI: ular tashqi xizmatga bog'liq.
// Bu yerda qo'lda qo'shish, o'rnatish, validatsiya va MAXFIY QIYMAT
// OQIB KETMASLIGI tekshiriladi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { appYarat } from '../src/app.ts'
import { bazaOch, dbOrnat } from '../src/db.ts'
import {
  mcpKredensialOmboriniOrnat,
  XotiraMcpKredensialOmbori,
} from '../src/mcp-kredensial.ts'
import { loyihaYarat, mcpServerlarOqi } from '../src/repo.ts'

let db: Database
let app: ReturnType<typeof appYarat>
let ombor: XotiraMcpKredensialOmbori

beforeEach(() => {
  db = bazaOch(':memory:')
  dbOrnat(db)
  ombor = new XotiraMcpKredensialOmbori()
  mcpKredensialOmboriniOrnat(ombor)
  app = appYarat()
})

afterEach(() => {
  mcpKredensialOmboriniOrnat(null)
  dbOrnat(null)
  db.close()
})

/** JSON POST/DELETE yordamchisi */
async function sorov(
  usul: 'POST' | 'DELETE' | 'GET',
  yol: string,
  tana?: unknown,
): Promise<{ status: number; javob: any }> {
  const javob = await app.fetch(
    new Request(`http://localhost/api${yol}`, {
      method: usul,
      headers: tana ? { 'Content-Type': 'application/json' } : {},
      body: tana ? JSON.stringify(tana) : undefined,
    }),
  )
  const matn = await javob.text()
  return { status: javob.status, javob: matn ? JSON.parse(matn) : null }
}

/** Qo'lda stdio server qo'shadi va uning id'sini qaytaradi */
async function serverQosh(
  nom = 'test-srv',
  sozlamalar: unknown[] = [],
): Promise<string> {
  await sorov('POST', '/mcp/manba/qolda', {
    nom,
    transport: 'stdio',
    buyruq: 'npx',
    argumentlar: ['-y', '@a/b'],
    sozlamalar,
  })
  const server = mcpServerlarOqi().find((s) => s.nom === nom)
  if (!server) throw new Error('server qo\'shilmadi')
  return server.id
}

// ---------------------------------------------------------------------------

describe('GET /mcp', () => {
  test("bo'sh katalog", async () => {
    const { status, javob } = await sorov('GET', '/mcp')
    expect(status).toBe(200)
    expect(javob).toEqual({ serverlar: [], manbalar: [] })
  })

  test("qo'shilgan server ko'rinadi", async () => {
    await serverQosh('github')
    const { javob } = await sorov('GET', '/mcp')
    expect(javob.serverlar).toHaveLength(1)
    expect(javob.serverlar[0].nom).toBe('github')
    expect(javob.manbalar).toHaveLength(1)
  })
})

describe("POST /mcp/manba/qolda", () => {
  test('stdio server qo\'shiladi', async () => {
    const { status, javob } = await sorov('POST', '/mcp/manba/qolda', {
      nom: 'github',
      tavsif: 'GitHub vositalari',
      transport: 'stdio',
      buyruq: 'npx',
      argumentlar: ['-y', '@example/github'],
    })

    expect(status).toBe(201)
    expect(javob.qoshildi).toBe(1)
    expect(javob.manba.tur).toBe('qolda')

    const server = mcpServerlarOqi()[0]
    expect(server?.buyruq).toBe('npx')
    expect(server?.argumentlar).toEqual(['-y', '@example/github'])
  })

  test('http server qo\'shiladi', async () => {
    const { status } = await sorov('POST', '/mcp/manba/qolda', {
      nom: 'masofaviy',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
    })

    expect(status).toBe(201)
    expect(mcpServerlarOqi()[0]?.url).toBe('https://mcp.example.com/mcp')
  })

  test('sozlama maydonlari saqlanadi', async () => {
    await sorov('POST', '/mcp/manba/qolda', {
      nom: 'srv',
      transport: 'stdio',
      buyruq: 'npx',
      sozlamalar: [
        { nom: 'TOKEN', majburiy: true, maxfiy: true, izoh: 'kirish tokeni' },
        { nom: 'BASE_URL' },
      ],
    })

    const sozlamalar = mcpServerlarOqi()[0]?.sozlamalar
    expect(sozlamalar).toEqual([
      { nom: 'TOKEN', majburiy: true, maxfiy: true, izoh: 'kirish tokeni' },
      { nom: 'BASE_URL', majburiy: false, maxfiy: false },
    ])
  })

  describe('validatsiya', () => {
    test('nomsiz — 400', async () => {
      const { status } = await sorov('POST', '/mcp/manba/qolda', { transport: 'stdio' })
      expect(status).toBe(400)
    })

    test("noma'lum transport — 400", async () => {
      const { status, javob } = await sorov('POST', '/mcp/manba/qolda', {
        nom: 'a',
        transport: 'grpc',
      })
      expect(status).toBe(400)
      expect(javob.error).toMatch(/stdio.*http/)
    })

    test('stdio buyruqsiz — 400', async () => {
      const { status } = await sorov('POST', '/mcp/manba/qolda', {
        nom: 'a',
        transport: 'stdio',
      })
      expect(status).toBe(400)
    })

    test('http url\'siz — 400', async () => {
      const { status } = await sorov('POST', '/mcp/manba/qolda', {
        nom: 'a',
        transport: 'http',
      })
      expect(status).toBe(400)
    })

    test('file:// url RAD ETILADI', async () => {
      const { status, javob } = await sorov('POST', '/mcp/manba/qolda', {
        nom: 'a',
        transport: 'http',
        url: 'file:///etc/passwd',
      })
      expect(status).toBe(400)
      expect(javob.error).toMatch(/http/)
    })

    test("noto'g'ri url — 400", async () => {
      const { status } = await sorov('POST', '/mcp/manba/qolda', {
        nom: 'a',
        transport: 'http',
        url: 'bu url emas',
      })
      expect(status).toBe(400)
    })

    test('argumentlar massiv bo\'lmasa — 400', async () => {
      const { status } = await sorov('POST', '/mcp/manba/qolda', {
        nom: 'a',
        transport: 'stdio',
        buyruq: 'npx',
        argumentlar: 'satr',
      })
      expect(status).toBe(400)
    })

    test('juda ko\'p argument — 400', async () => {
      const { status } = await sorov('POST', '/mcp/manba/qolda', {
        nom: 'a',
        transport: 'stdio',
        buyruq: 'npx',
        argumentlar: Array.from({ length: 100 }, (_, i) => `a${i}`),
      })
      expect(status).toBe(400)
    })

    test('sozlama nomsiz — 400', async () => {
      const { status } = await sorov('POST', '/mcp/manba/qolda', {
        nom: 'a',
        transport: 'stdio',
        buyruq: 'npx',
        sozlamalar: [{ izoh: 'nomsiz' }],
      })
      expect(status).toBe(400)
    })

    test('XAVFLI SOZLAMA NOMI rad etiladi (REGRESSIYA)', async () => {
      // Qo'lda qo'shishda ham registry bilan bir xil qoida: jarayon
      // xulqini o'zgartiradigan env nomi qabul qilinmaydi
      for (const nom of ['NODE_OPTIONS', 'LD_PRELOAD', 'PATH', 'ld_preload']) {
        const { status, javob } = await sorov('POST', '/mcp/manba/qolda', {
          nom: `srv-${nom}`,
          transport: 'stdio',
          buyruq: 'npx',
          sozlamalar: [{ nom, majburiy: true }],
        })
        expect(status).toBe(400)
        expect(javob.error).toContain(nom)
      }
      expect(mcpServerlarOqi()).toHaveLength(0)
    })

    test('shakli buzuq sozlama nomi rad etiladi', async () => {
      const { status } = await sorov('POST', '/mcp/manba/qolda', {
        nom: 'a',
        transport: 'stdio',
        buyruq: 'npx',
        sozlamalar: [{ nom: 'A=B' }],
      })
      expect(status).toBe(400)
    })

    test('JSON bo\'lmagan tana — 400', async () => {
      const javob = await app.fetch(
        new Request('http://localhost/api/mcp/manba/qolda', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'bu JSON emas',
        }),
      )
      expect(javob.status).toBe(400)
    })
  })
})

describe('POST /mcp/:id/ornat', () => {
  test('global o\'rnatish', async () => {
    const id = await serverQosh()
    const { status, javob } = await sorov('POST', `/mcp/${id}/ornat`, { qamrov: 'global' })

    expect(status).toBe(200)
    expect(javob.server.ornatilgan).toHaveLength(1)
    expect(javob.server.ornatilgan[0].qamrov).toBe('global')
  })

  test('loyiha o\'rnatishi', async () => {
    const id = await serverQosh()
    const loyiha = loyihaYarat('test', '/tmp/l')

    const { status, javob } = await sorov('POST', `/mcp/${id}/ornat`, {
      qamrov: 'loyiha',
      projectIds: [loyiha.id],
    })

    expect(status).toBe(200)
    expect(javob.server.ornatilgan[0].projectId).toBe(loyiha.id)
  })

  test('MAXFIY QIYMAT javobda QAYTMAYDI', async () => {
    const id = await serverQosh('srv', [{ nom: 'TOKEN', majburiy: true, maxfiy: true }])

    const { status, javob } = await sorov('POST', `/mcp/${id}/ornat`, {
      qamrov: 'global',
      sozlamaQiymatlari: { TOKEN: 'ghp_juda_maxfiy' },
    })

    expect(status).toBe(200)
    // Butun javobda token izi bo'lmasligi kerak
    expect(JSON.stringify(javob)).not.toContain('ghp_juda_maxfiy')
    // Lekin u kredensial omborida saqlangan bo'lishi kerak
    const ornatishId = javob.server.ornatilgan[0].id
    expect(await ombor.ol(ornatishId)).toEqual({ TOKEN: 'ghp_juda_maxfiy' })
  })

  test('MAXFIY QIYMAT bazaga tushmaydi', async () => {
    const id = await serverQosh('srv', [{ nom: 'TOKEN', majburiy: true, maxfiy: true }])
    await sorov('POST', `/mcp/${id}/ornat`, {
      qamrov: 'global',
      sozlamaQiymatlari: { TOKEN: 'ghp_maxfiy' },
    })

    // Butun bazani matn sifatida tekshiramiz
    const qatorlar = db
      .query<{ sozlama_qiymatlari: string }, []>('SELECT sozlama_qiymatlari FROM mcp_ornatish')
      .all()
    for (const q of qatorlar) {
      expect(q.sozlama_qiymatlari).not.toContain('ghp_maxfiy')
    }
  })

  test('OCHIQ qiymat bazaga tushadi', async () => {
    const id = await serverQosh('srv', [{ nom: 'BASE_URL', maxfiy: false }])
    const { javob } = await sorov('POST', `/mcp/${id}/ornat`, {
      qamrov: 'global',
      sozlamaQiymatlari: { BASE_URL: 'https://a.b' },
    })

    expect(javob.server.ornatilgan[0].sozlamaQiymatlari).toEqual({ BASE_URL: 'https://a.b' })
  })

  test('MAJBURIY maydon to\'ldirilmasa — 400', async () => {
    const id = await serverQosh('srv', [{ nom: 'TOKEN', majburiy: true, maxfiy: true }])
    const { status, javob } = await sorov('POST', `/mcp/${id}/ornat`, { qamrov: 'global' })

    expect(status).toBe(400)
    expect(javob.yetishmagan).toEqual(['TOKEN'])
  })

  test('standart qiymati bor majburiy maydon so\'ralmaydi', async () => {
    const id = await serverQosh('srv', [{ nom: 'REJIM', majburiy: true }])
    // `standart` qo'lda qo'shishda sxemaga tushmaydi, shuning uchun bu
    // holat faqat registry yozuvlarida bo'ladi — lekin mantiq bir xil
    const { status } = await sorov('POST', `/mcp/${id}/ornat`, {
      qamrov: 'global',
      sozlamaQiymatlari: { REJIM: 'oddiy' },
    })
    expect(status).toBe(200)
  })

  test('qayta o\'rnatishda maxfiy maydon BO\'SH kelsa saqlangani qoladi', async () => {
    const id = await serverQosh('srv', [{ nom: 'TOKEN', majburiy: true, maxfiy: true }])
    const { javob: birinchi } = await sorov('POST', `/mcp/${id}/ornat`, {
      qamrov: 'global',
      sozlamaQiymatlari: { TOKEN: 'asl-token' },
    })
    const ornatishId = birinchi.server.ornatilgan[0].id

    // UI maxfiy qiymatni ko'rsatmaydi → forma bo'sh input bilan qaytadi
    const { status } = await sorov('POST', `/mcp/${id}/ornat`, {
      qamrov: 'global',
      sozlamaQiymatlari: { TOKEN: '' },
    })

    expect(status).toBe(200)
    expect(await ombor.ol(ornatishId)).toEqual({ TOKEN: 'asl-token' })
  })

  test('SXEMADA YO\'Q kalit e\'tiborsiz qoldiriladi', async () => {
    const id = await serverQosh('srv', [{ nom: 'RUXSAT', maxfiy: false }])
    const { javob } = await sorov('POST', `/mcp/${id}/ornat`, {
      qamrov: 'global',
      sozlamaQiymatlari: { RUXSAT: 'ha', PATH: '/buzuq' },
    })

    expect(javob.server.ornatilgan[0].sozlamaQiymatlari).toEqual({ RUXSAT: 'ha' })
  })

  describe('validatsiya', () => {
    test("noma'lum server — 404", async () => {
      const { status } = await sorov('POST', '/mcp/yoq-bunday/ornat', { qamrov: 'global' })
      expect(status).toBe(404)
    })

    test("noto'g'ri qamrov — 400", async () => {
      const id = await serverQosh()
      const { status } = await sorov('POST', `/mcp/${id}/ornat`, { qamrov: 'hammasi' })
      expect(status).toBe(400)
    })

    test('loyiha qamrovi loyihasiz — 400', async () => {
      const id = await serverQosh()
      const { status } = await sorov('POST', `/mcp/${id}/ornat`, { qamrov: 'loyiha' })
      expect(status).toBe(400)
    })

    test("mavjud bo'lmagan loyiha — 404", async () => {
      const id = await serverQosh()
      const { status } = await sorov('POST', `/mcp/${id}/ornat`, {
        qamrov: 'loyiha',
        projectIds: ['yoq'],
      })
      expect(status).toBe(404)
    })

    test('qiymat matn bo\'lmasa — 400', async () => {
      const id = await serverQosh('srv', [{ nom: 'A' }])
      const { status } = await sorov('POST', `/mcp/${id}/ornat`, {
        qamrov: 'global',
        sozlamaQiymatlari: { A: 123 },
      })
      expect(status).toBe(400)
    })
  })
})

describe('DELETE /mcp/:id/ornat', () => {
  test("o'rnatish va KREDENSIAL o'chadi", async () => {
    const id = await serverQosh('srv', [{ nom: 'TOKEN', majburiy: true, maxfiy: true }])
    const { javob } = await sorov('POST', `/mcp/${id}/ornat`, {
      qamrov: 'global',
      sozlamaQiymatlari: { TOKEN: 'maxfiy' },
    })
    const ornatishId = javob.server.ornatilgan[0].id
    expect(await ombor.ol(ornatishId)).toEqual({ TOKEN: 'maxfiy' })

    const { status, javob: keyin } = await sorov('DELETE', `/mcp/${id}/ornat`, {
      qamrov: 'global',
    })

    expect(status).toBe(200)
    expect(keyin.server.ornatilgan).toHaveLength(0)
    // Kredensial ORTDA QOLMASLIGI kerak
    expect(await ombor.ol(ornatishId)).toEqual({})
  })

  test('loyiha o\'rnatishi o\'chadi', async () => {
    const id = await serverQosh()
    const loyiha = loyihaYarat('test', '/tmp/l')
    await sorov('POST', `/mcp/${id}/ornat`, { qamrov: 'loyiha', projectIds: [loyiha.id] })

    const { status, javob } = await sorov('DELETE', `/mcp/${id}/ornat`, {
      qamrov: 'loyiha',
      projectIds: [loyiha.id],
    })

    expect(status).toBe(200)
    expect(javob.server.ornatilgan).toHaveLength(0)
  })

  test('loyiha tanlanmasa — 400', async () => {
    const id = await serverQosh()
    const { status } = await sorov('DELETE', `/mcp/${id}/ornat`, { qamrov: 'loyiha' })
    expect(status).toBe(400)
  })
})

describe('DELETE /mcp/manba/:id', () => {
  test("manba, serverlari va KREDENSIALLARI o'chadi", async () => {
    const id = await serverQosh('srv', [{ nom: 'TOKEN', majburiy: true, maxfiy: true }])
    const { javob } = await sorov('POST', `/mcp/${id}/ornat`, {
      qamrov: 'global',
      sozlamaQiymatlari: { TOKEN: 'maxfiy' },
    })
    const ornatishId = javob.server.ornatilgan[0].id
    const manbaId = mcpServerlarOqi()[0]!.manbaId

    const { status } = await sorov('DELETE', `/mcp/manba/${manbaId}`)

    expect(status).toBe(200)
    expect(mcpServerlarOqi()).toHaveLength(0)
    // CASCADE bazani tozalaydi, lekin kredensial FAYLDA — u ham ketishi kerak
    expect(await ombor.ol(ornatishId)).toEqual({})
  })

  test("noma'lum manba — 404", async () => {
    const { status } = await sorov('DELETE', '/mcp/manba/yoq')
    expect(status).toBe(404)
  })
})

describe('POST /mcp/manba/:id/sinxron', () => {
  test("qo'lda manbani sinxronlab bo'lmaydi — 422", async () => {
    await serverQosh()
    const manbaId = mcpServerlarOqi()[0]!.manbaId
    const { status, javob } = await sorov('POST', `/mcp/manba/${manbaId}/sinxron`)

    expect(status).toBe(422)
    expect(javob.error).toMatch(/qolda/)
  })

  test("noma'lum manba — 404", async () => {
    const { status } = await sorov('POST', '/mcp/manba/yoq/sinxron')
    expect(status).toBe(404)
  })
})

describe('GET /mcp/faol', () => {
  test("faqat o'rnatilganlar", async () => {
    const a = await serverQosh('a')
    await serverQosh('b')
    await sorov('POST', `/mcp/${a}/ornat`, { qamrov: 'global' })

    const { javob } = await sorov('GET', '/mcp/faol')
    expect(javob.serverlar.map((s: { nom: string }) => s.nom)).toEqual(['a'])
  })
})
