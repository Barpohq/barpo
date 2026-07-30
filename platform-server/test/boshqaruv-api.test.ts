// Boshqaruv qatlamining REST marshrutlari — forma va amallar.
//
// `api.test.ts` naqshi: xotira bazasi, Hono `app.request`, tarmoqsiz.
//
// Bu testlar himoya chegaralarini majburlaydi:
//   - sir qiymat javobda YO'Q (faqat `ornatilgan` bayrog'i)
//   - bo'sh sir mavjud qiymatni O'CHIRMAYDI
//   - naqsh buzilgan qiymat serverga UMUMAN bormaydi

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { AppManifest } from '@platforma/shared'
import { qulflarniTozala, sshFabrikasiniOrnat } from '../src/amal-bajar.ts'
import { app } from '../src/app.ts'
import { bazaOch, dbOrnat } from '../src/db.ts'
import type { IlovaSshApi } from '../src/ilova-ssh.ts'
import { ilovaSaqla } from '../src/repo.ts'
import { keshniTozala } from '../src/state-kesh.ts'
import { hub } from '../src/ws/hub.ts'

let db: Database
let envYozishlar: { yol: string; qiymatlar: Record<string, string> }[]
let buyruqlar: string[][]

function soxtaSsh(): IlovaSshApi {
  return {
    async buyruq(argv) {
      buyruqlar.push(argv)
      return { kod: 0, stdout: '', stderr: '' }
    },
    async envYoz(yol, qiymatlar) {
      envYozishlar.push({ yol, qiymatlar })
    },
    async faylOqi() {
      return null
    },
  }
}

/** Sozlamalari va amallari bor ilova */
const BOT: AppManifest = {
  id: 'telegram-bot',
  icon: '🤖',
  name: 'Telegram bot',
  tagline: 'Yangiliklar boti',
  version: 'v1',
  service: 'helsinki-1 · docker',
  status: 'running',
  widgets: [{ type: 'note', text: 'Bot ishlayapti' }],
  states: [{ nom: 'holat', kod: 'module.exports = async () => ({ faol: true })', interval: 5 }],
  sozlamalar: {
    maydonlar: [
      {
        kalit: 'token',
        turi: 'sir',
        yorliq: 'Bot tokeni',
        majburiy: true,
        naqsh: '^\\d+:[A-Za-z0-9_-]+$',
        naqshIzohi: 'Token `123456:ABC-DEF` shaklida bo\'lishi kerak',
      },
      { kalit: 'admin_id', turi: 'raqam', yorliq: 'Admin ID' },
      { kalit: 'rejim', turi: 'tanlov', yorliq: 'Rejim', variantlar: ['polling', 'webhook'] },
    ],
    yoz: `module.exports = async ({ qiymatlar, ssh }) => {
      const env = {}
      if (qiymatlar.token) env.TELEGRAM_TOKEN = qiymatlar.token
      if (qiymatlar.admin_id) env.ADMIN_ID = qiymatlar.admin_id
      if (qiymatlar.rejim) env.REJIM = qiymatlar.rejim
      await ssh('helsinki-1').envYoz('/opt/bot/.env', env)
      await ssh('helsinki-1').buyruq(['docker', 'restart', 'telegram-bot'])
      return { xabar: 'Saqlandi va bot restart qilindi' }
    }`,
    oqi: `module.exports = async () => ({ admin_id: '555', rejim: 'polling', token: '789:SIRLIQIYMAT' })`,
  },
  amallar: [
    {
      nom: 'restart',
      yorliq: 'Botni restart qilish',
      xavf: "o'zgartirish",
      tasdiq: true,
      kod: `module.exports = async ({ ssh }) => {
        await ssh('helsinki-1').buyruq(['docker', 'restart', 'telegram-bot'])
        return { xabar: 'Bot restart qilindi' }
      }`,
      yangila: ['holat'],
    },
    {
      nom: 'yiqiladi',
      yorliq: 'Yiqiladigan amal',
      kod: 'module.exports = async () => { throw new Error("konteyner topilmadi") }',
    },
  ],
}

beforeEach(() => {
  db = bazaOch(':memory:')
  dbOrnat(db)
  envYozishlar = []
  buyruqlar = []
  qulflarniTozala()
  keshniTozala()
  sshFabrikasiniOrnat(() => soxtaSsh())
  ilovaSaqla(BOT, db)
})

afterEach(() => {
  sshFabrikasiniOrnat(null)
  qulflarniTozala()
  keshniTozala()
  dbOrnat(null)
  hub.tozala()
  db.close()
})

async function get<T>(yol: string): Promise<{ status: number; body: T }> {
  const javob = await app.request(yol)
  return { status: javob.status, body: (await javob.json()) as T }
}

async function yubor<T>(
  yol: string,
  usul: 'PUT' | 'POST',
  tana?: unknown,
): Promise<{ status: number; body: T }> {
  const javob = await app.request(yol, {
    method: usul,
    ...(tana !== undefined
      ? { body: JSON.stringify(tana), headers: { 'content-type': 'application/json' } }
      : {}),
  })
  return { status: javob.status, body: (await javob.json()) as T }
}

interface SozlamaJavobi {
  maydonlar: { kalit: string; turi: string }[]
  qiymatlar: Record<string, string>
  ornatilgan: Record<string, boolean>
  ogohlantirish?: string
}

describe('GET /api/apps/:id/sozlama', () => {
  test('sxema va sirsiz qiymatlar qaytadi', async () => {
    const { status, body } = await get<SozlamaJavobi>('/api/apps/telegram-bot/sozlama')

    expect(status).toBe(200)
    expect(body.maydonlar).toHaveLength(3)
    expect(body.qiymatlar.admin_id).toBe('555')
    expect(body.qiymatlar.rejim).toBe('polling')
  })

  // ┌──────────────────────────────────────────────────────────────┐
  // │ QATLAMNING MARKAZIY QOIDASI. Token server → platforma →       │
  // │ brauzer yo'lini bosmasligi kerak.                             │
  // └──────────────────────────────────────────────────────────────┘
  test('SIR QIYMAT javobda YO\'Q — faqat `ornatilgan` bayrog\'i', async () => {
    const javob = await app.request('/api/apps/telegram-bot/sozlama')
    const xom = await javob.text()

    // `oqi` kodi tokenni QAYTARDI, lekin u filtrdan o'tmadi
    expect(xom).not.toContain('SIRLIQIYMAT')

    const body = JSON.parse(xom) as SozlamaJavobi
    expect(body.qiymatlar.token).toBeUndefined()
    // Server o'sha kalitni qaytargani — u serverda BOR degani
    expect(body.ornatilgan.token).toBe(true)
  })

  // Regressiya: `oqi` odatda `{ token: q.TOKEN }` qaytaradi va `.env` da
  // kalit yo'q bo'lsa qiymat `undefined` bo'ladi — lekin KALIT obyektda
  // turadi. Uni "bor" deb sanasak foydalanuvchi token yo'qligida ham
  // "✓ o'rnatilgan" ko'rardi va nega bot ishlamayotganini tushunmasdi.
  test('serverda token YO\'Q bo\'lsa `ornatilgan` false', async () => {
    ilovaSaqla(
      {
        ...BOT,
        sozlamalar: {
          ...BOT.sozlamalar!,
          oqi: 'module.exports = async () => ({ token: undefined, rejim: "polling" })',
        },
      },
      db,
    )

    const { body } = await get<SozlamaJavobi>('/api/apps/telegram-bot/sozlama')
    expect(body.ornatilgan.token).toBe(false)
    expect(body.qiymatlar.rejim).toBe('polling')
  })

  test('o\'qish yiqilsa forma BARIBIR ko\'rsatiladi', async () => {
    ilovaSaqla(
      {
        ...BOT,
        sozlamalar: {
          ...BOT.sozlamalar!,
          oqi: 'module.exports = async () => { throw new Error("ssh tushdi") }',
        },
      },
      db,
    )

    const { status, body } = await get<SozlamaJavobi>('/api/apps/telegram-bot/sozlama')

    // Foydalanuvchi yangi qiymat yozib tuzatishi mumkin — forma yopilmaydi.
    expect(status).toBe(200)
    expect(body.maydonlar).toHaveLength(3)
    expect(body.ogohlantirish).toContain('ssh')
  })

  test('sozlamasiz ilova 404', async () => {
    ilovaSaqla({ ...BOT, id: 'sozlamasiz', sozlamalar: undefined }, db)
    const { status } = await get('/api/apps/sozlamasiz/sozlama')
    expect(status).toBe(404)
  })

  test('yo\'q ilova 404', async () => {
    expect((await get('/api/apps/yoq/sozlama')).status).toBe(404)
  })
})

describe('PUT /api/apps/:id/sozlama', () => {
  test('qiymatlar serverga yoziladi', async () => {
    const { status, body } = await yubor<{ ok: boolean; xabar?: string }>(
      '/api/apps/telegram-bot/sozlama',
      'PUT',
      { qiymatlar: { token: '789456:ABCdef-xyz', admin_id: '111', rejim: 'webhook' } },
    )

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.xabar).toContain('Saqlandi')

    // Serverdagi `.env` ga yozildi
    expect(envYozishlar).toHaveLength(1)
    expect(envYozishlar[0]!.yol).toBe('/opt/bot/.env')
    expect(envYozishlar[0]!.qiymatlar.TELEGRAM_TOKEN).toBe('789456:ABCdef-xyz')
    // Va bot restart qilindi
    expect(buyruqlar[0]).toEqual(['docker', 'restart', 'telegram-bot'])
  })

  test('tananing o\'zi qiymatlar bo\'lishi ham mumkin', async () => {
    const { status } = await yubor('/api/apps/telegram-bot/sozlama', 'PUT', { rejim: 'webhook' })
    expect(status).toBe(200)
    expect(envYozishlar[0]!.qiymatlar.REJIM).toBe('webhook')
  })

  // ┌──────────────────────────────────────────────────────────────┐
  // │ BO'SH SIR — "O'ZGARTIRMADIM". Forma sir maydonini bo'sh        │
  // │ ko'rsatadi, ya'ni "tegmadim" ham bo'sh satr bo'lib keladi.     │
  // │ Bo'shni yuborsak mavjud token o'chib ketardi.                  │
  // └──────────────────────────────────────────────────────────────┘
  test('BO\'SH sir yuborilsa u yozilmaydi (mavjud token saqlanadi)', async () => {
    const { status } = await yubor('/api/apps/telegram-bot/sozlama', 'PUT', {
      qiymatlar: { token: '', rejim: 'webhook' },
    })

    expect(status).toBe(200)
    // Token env'ga TUSHMADI — eskisi serverda qoldi
    expect(envYozishlar[0]!.qiymatlar.TELEGRAM_TOKEN).toBeUndefined()
    expect(envYozishlar[0]!.qiymatlar.REJIM).toBe('webhook')
  })

  test('naqsh buzilgan qiymat SERVERGA BORMAYDI', async () => {
    const { status, body } = await yubor<{ ok: boolean; xatolar: string[] }>(
      '/api/apps/telegram-bot/sozlama',
      'PUT',
      { qiymatlar: { token: 'butunlay-notogri' } },
    )

    expect(status).toBe(400)
    expect(body.xatolar[0]).toContain('123456:ABC-DEF')
    // Eng muhimi: hech narsa yozilmadi
    expect(envYozishlar).toHaveLength(0)
    expect(buyruqlar).toHaveLength(0)
  })

  test('injection urinishi naqshda to\'xtaydi', async () => {
    const { status } = await yubor('/api/apps/telegram-bot/sozlama', 'PUT', {
      qiymatlar: { token: '123:abc"; rm -rf /; #' },
    })

    expect(status).toBe(400)
    expect(envYozishlar).toHaveLength(0)
  })

  test('raqam bo\'lmagan qiymat rad etiladi', async () => {
    const { status, body } = await yubor<{ xatolar: string[] }>(
      '/api/apps/telegram-bot/sozlama',
      'PUT',
      { qiymatlar: { admin_id: 'salom' } },
    )
    expect(status).toBe(400)
    expect(body.xatolar[0]).toContain('raqam')
  })

  test('sxemada yo\'q kalit e\'tiborsiz qoldiriladi', async () => {
    const { status } = await yubor('/api/apps/telegram-bot/sozlama', 'PUT', {
      qiymatlar: { rejim: 'polling', begona: 'x' },
    })

    expect(status).toBe(200)
    // Kod faqat e'lon qilingan maydonlarni ko'radi
    expect(Object.keys(envYozishlar[0]!.qiymatlar)).toEqual(['REJIM'])
  })

  test('o\'zgarish bo\'lmasa 400', async () => {
    const { status } = await yubor('/api/apps/telegram-bot/sozlama', 'PUT', { qiymatlar: {} })
    expect(status).toBe(400)
  })

  test('yozish yiqilsa 500 va aniq xato', async () => {
    ilovaSaqla(
      {
        ...BOT,
        sozlamalar: {
          ...BOT.sozlamalar!,
          yoz: 'module.exports = async () => { throw new Error("disk to\'ldi") }',
        },
      },
      db,
    )

    const { status, body } = await yubor<{ ok: boolean; xato: string }>(
      '/api/apps/telegram-bot/sozlama',
      'PUT',
      { qiymatlar: { rejim: 'polling' } },
    )

    expect(status).toBe(500)
    expect(body.ok).toBe(false)
    expect(body.xato).toContain('disk')
  })

  test('JSON bo\'lmasa 400', async () => {
    const javob = await app.request('/api/apps/telegram-bot/sozlama', {
      method: 'PUT',
      body: 'notjson',
      headers: { 'content-type': 'application/json' },
    })
    expect(javob.status).toBe(400)
  })

  test('auditga KALIT yoziladi, QIYMAT emas', async () => {
    await yubor('/api/apps/telegram-bot/sozlama', 'PUT', {
      qiymatlar: { token: '789456:SIRLIQIYMAT' },
    })

    const yozuvlar = db.query<{ action: string }, []>('SELECT action FROM audit_log').all()
    const matn = JSON.stringify(yozuvlar)

    expect(matn).toContain('token')
    // Sir auditga tushmasligi kerak — audit_log backup qilinadi va eksport
    // qilinishi mumkin.
    expect(matn).not.toContain('SIRLIQIYMAT')
  })
})

describe('POST /api/apps/:id/amal/:nom', () => {
  test('amal bajariladi va xabar qaytadi', async () => {
    const { status, body } = await yubor<{ ok: boolean; xabar: string }>(
      '/api/apps/telegram-bot/amal/restart',
      'POST',
    )

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.xabar).toBe('Bot restart qilindi')
    expect(buyruqlar[0]).toEqual(['docker', 'restart', 'telegram-bot'])
  })

  test('`yangila` dagi statelar MAJBURIY yangilanadi', async () => {
    const { body } = await yubor<{ statelar: Record<string, { ok: boolean; qiymat: unknown }> }>(
      '/api/apps/telegram-bot/amal/restart',
      'POST',
    )

    // Restart bosilganda status darhol o'zgarishi kerak — kesh interval
    // tugashini kutib turmasin.
    expect(body.statelar.holat.ok).toBe(true)
    expect(body.statelar.holat.qiymat).toEqual({ faol: true })
  })

  test('yiqilgan amal 200 va `ok: false` (server xatosi emas)', async () => {
    const { status, body } = await yubor<{ ok: boolean; xato: string }>(
      '/api/apps/telegram-bot/amal/yiqiladi',
      'POST',
    )

    // Bu ma'lumot xatosi, server xatosi emas — `states` bilan bir xil qaror.
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.xato).toContain('konteyner topilmadi')
  })

  test('yo\'q amal 404', async () => {
    expect((await yubor('/api/apps/telegram-bot/amal/yoq', 'POST')).status).toBe(404)
  })

  test('yo\'q ilova 404', async () => {
    expect((await yubor('/api/apps/yoq/amal/restart', 'POST')).status).toBe(404)
  })

  test('amal auditga yoziladi', async () => {
    await yubor('/api/apps/telegram-bot/amal/restart', 'POST')

    const yozuv = db
      .query<{ action: string; level: string; result: string }, []>(
        'SELECT action, level, result FROM audit_log ORDER BY rowid DESC LIMIT 1',
      )
      .get()

    expect(yozuv?.action).toContain('Botni restart qilish')
    expect(yozuv?.level).toBe("o'zgartirish")
    expect(yozuv?.result).toBe('OK')
  })

  test('yiqilgan amal auditda "rad etildi"', async () => {
    await yubor('/api/apps/telegram-bot/amal/yiqiladi', 'POST')

    const yozuv = db
      .query<{ result: string }, []>('SELECT result FROM audit_log ORDER BY rowid DESC LIMIT 1')
      .get()
    expect(yozuv?.result).toBe('rad etildi')
  })

  test('sirsiz sozlama qiymatlari amalga beriladi', async () => {
    ilovaSaqla(
      {
        ...BOT,
        amallar: [
          {
            nom: 'tekshir',
            yorliq: 'Tekshirish',
            kod: 'module.exports = async ({ sozlama }) => ({ xabar: "rejim=" + sozlama.rejim })',
          },
        ],
      },
      db,
    )

    const { body } = await yubor<{ xabar: string }>(
      '/api/apps/telegram-bot/amal/tekshir',
      'POST',
    )
    // `oqi` dan kelgan sirsiz qiymat
    expect(body.xabar).toBe('rejim=polling')
  })

  test('parallel bosish BITTA bajarilishga aylanadi', async () => {
    const [a, b] = await Promise.all([
      yubor<{ ok: boolean }>('/api/apps/telegram-bot/amal/restart', 'POST'),
      yubor<{ ok: boolean }>('/api/apps/telegram-bot/amal/restart', 'POST'),
    ])

    expect(a.body.ok).toBe(true)
    expect(b.body.ok).toBe(true)
    // Ikki restart emas, bitta
    expect(buyruqlar).toHaveLength(1)
  })
})
