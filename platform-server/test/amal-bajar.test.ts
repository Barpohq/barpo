// Amal va sozlama bajarish qatlami.
//
// Uch narsa majburlanadi:
//   1) QULF — bir xil amal ikki marta parallel ishlamaydi (ikki restart)
//   2) SIR OQMASLIGI — token xato matnida ham, natijada ham ko'rinmaydi
//   3) XATO IZOLYATSIYASI — AI kodi yiqilsa natija `ok: false`, throw emas

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AppAmali, AppSozlamalari } from '@platforma/shared'
import {
  AMAL_TIMEOUT_MS,
  amalBandmi,
  amalniBajar,
  qulflarniTozala,
  sirlarniTozala,
  sozlamalarniOqi,
  sozlamalarniYoz,
  sshFabrikasiniOrnat,
} from '../src/amal-bajar.ts'
import type { IlovaSshApi } from '../src/ilova-ssh.ts'

const kontekst = { appId: 'telegram-bot', sozlama: {} }

/** Soxta ssh — chaqiruvlarni yozib boradi */
let sshChaqiruvlari: { turi: string; arg: unknown }[]

function soxtaSsh(ustama: Partial<IlovaSshApi> = {}): IlovaSshApi {
  return {
    async buyruq(argv) {
      sshChaqiruvlari.push({ turi: 'buyruq', arg: argv })
      return { kod: 0, stdout: '', stderr: '' }
    },
    async envYoz(yol, qiymatlar) {
      sshChaqiruvlari.push({ turi: 'envYoz', arg: { yol, qiymatlar } })
    },
    async faylOqi() {
      return null
    },
    ...ustama,
  }
}

beforeEach(() => {
  sshChaqiruvlari = []
  qulflarniTozala()
  sshFabrikasiniOrnat(() => soxtaSsh())
})

afterEach(() => {
  sshFabrikasiniOrnat(null)
  qulflarniTozala()
})

function amal(kod: string, ustama: Partial<AppAmali> = {}): AppAmali {
  return { nom: 'restart', yorliq: 'Restart', kod, ...ustama }
}

describe('amalniBajar — asosiy oqim', () => {
  test('muvaffaqiyatli amal `ok: true` qaytaradi', async () => {
    const n = await amalniBajar(
      amal('module.exports = async () => ({ xabar: "Bajarildi" })'),
      kontekst,
    )

    expect(n.ok).toBe(true)
    expect(n.xabar).toBe('Bajarildi')
    expect(n.vaqt).toMatch(/^\d{4}-/)
  })

  test('satr qaytargan kod ham qabul qilinadi', async () => {
    // AI turli shaklda qaytaradi — rad etish amal ALLAQACHON bajarilgandan
    // keyin bo'lardi.
    const n = await amalniBajar(amal('module.exports = async () => "Tayyor"'), kontekst)
    expect(n.xabar).toBe('Tayyor')
  })

  test('hech narsa qaytarmagan kod ham muvaffaqiyatli', async () => {
    const n = await amalniBajar(amal('module.exports = async () => {}'), kontekst)
    expect(n.ok).toBe(true)
    expect(n.xabar).toBeUndefined()
  })

  test('`ssh` kodga beriladi va server nomi bilan chaqiriladi', async () => {
    await amalniBajar(
      amal('module.exports = async ({ ssh }) => { await ssh("helsinki-1").buyruq(["docker","restart","bot"]) }'),
      kontekst,
    )

    expect(sshChaqiruvlari).toHaveLength(1)
    expect(sshChaqiruvlari[0]!.arg).toEqual(['docker', 'restart', 'bot'])
  })

  test('`sozlama` kodga beriladi', async () => {
    const n = await amalniBajar(
      amal('module.exports = async ({ sozlama }) => ({ xabar: sozlama.rejim })'),
      { appId: 'bot', sozlama: { rejim: 'webhook' } },
    )
    expect(n.xabar).toBe('webhook')
  })

  test('`appId` kodga beriladi', async () => {
    const n = await amalniBajar(
      amal('module.exports = async ({ appId }) => ({ xabar: appId })'),
      kontekst,
    )
    expect(n.xabar).toBe('telegram-bot')
  })
})

describe('xato izolyatsiyasi — AI kodi platformani yiqitmasin', () => {
  test('yiqilgan kod XATO TASHLAMAYDI', async () => {
    const n = await amalniBajar(
      amal('module.exports = async () => { throw new Error("yiqildi") }'),
      kontekst,
    )

    expect(n.ok).toBe(false)
    expect(n.xato).toContain('yiqildi')
  })

  test('sintaksis xatosi publish paytida emas, bajarishda ushlanadi', async () => {
    const n = await amalniBajar(amal('module.exports = async () => { ('), kontekst)
    expect(n.ok).toBe(false)
    expect(n.xato).toBeTruthy()
  })

  test('funksiya qaytarmagan kod rad etiladi', async () => {
    const n = await amalniBajar(amal('const x = 1'), kontekst)
    expect(n.ok).toBe(false)
    expect(n.xato).toContain('module.exports')
  })

  test('bo\'sh kod rad etiladi', async () => {
    const n = await amalniBajar(amal('   '), kontekst)
    expect(n.ok).toBe(false)
  })

  test('`ssh` noto\'g\'ri ishlatilsa tushunarli xato', async () => {
    sshFabrikasiniOrnat(null)
    const n = await amalniBajar(
      amal('module.exports = async ({ ssh }) => { await ssh("").buyruq(["x"]) }'),
      kontekst,
    )
    expect(n.ok).toBe(false)
    expect(n.xato).toMatch(/server nomi/i)
  })

  test('timeout chegarasi belgilangan', () => {
    // 20s (state) yetmaydi: restart + healthcheck uzunroq.
    expect(AMAL_TIMEOUT_MS).toBeGreaterThan(20_000)
  })
})

describe('qulf — ikki restart bir-birini bosmasin', () => {
  test('parallel chaqiruv BITTA bajarilishga aylanadi', async () => {
    let sanoq = 0
    sshFabrikasiniOrnat(() =>
      soxtaSsh({
        async buyruq(argv) {
          sanoq++
          await new Promise((y) => setTimeout(y, 30))
          sshChaqiruvlari.push({ turi: 'buyruq', arg: argv })
          return { kod: 0, stdout: '', stderr: '' }
        },
      }),
    )

    const a = amal('module.exports = async ({ ssh }) => { await ssh("h").buyruq(["restart"]) }')

    // Tugma ikki marta bosildi
    const [n1, n2] = await Promise.all([
      amalniBajar(a, kontekst),
      amalniBajar(a, kontekst),
    ])

    // Ikkalasi ham muvaffaqiyatli, LEKIN buyruq bir marta ketgan
    expect(n1.ok).toBe(true)
    expect(n2.ok).toBe(true)
    expect(sanoq).toBe(1)
  })

  test('bajarilgandan keyin qulf ochiladi', async () => {
    const a = amal('module.exports = async () => ({ xabar: "ok" })')

    await amalniBajar(a, kontekst)
    expect(amalBandmi('telegram-bot', 'restart')).toBe(false)

    // Ikkinchi bosish yangi bajarilish
    const n = await amalniBajar(a, kontekst)
    expect(n.ok).toBe(true)
  })

  test('yiqilgandan keyin ham qulf ochiladi', async () => {
    const a = amal('module.exports = async () => { throw new Error("x") }')
    await amalniBajar(a, kontekst)
    // Aks holda ilova abadiy "band" bo'lib qolardi.
    expect(amalBandmi('telegram-bot', 'restart')).toBe(false)
  })

  test('turli amallar bir-birini kutmaydi', async () => {
    const sekin = amal('module.exports = async () => { await new Promise(y => setTimeout(y, 50)); return "a" }', {
      nom: 'sekin',
    })
    const tez = amal('module.exports = async () => "b"', { nom: 'tez' })

    const boshlangan = Date.now()
    const [, n2] = await Promise.all([
      amalniBajar(sekin, kontekst),
      amalniBajar(tez, kontekst),
    ])

    expect(n2.xabar).toBe('b')
    // "tez" "sekin" ni kutmagan
    expect(Date.now() - boshlangan).toBeLessThan(200)
  })

  test('turli ilovalarning bir xil amali bir-birini kutmaydi', async () => {
    let sanoq = 0
    const a = amal(`module.exports = async () => { return "x" }`)

    await Promise.all([
      amalniBajar(a, { appId: 'bot-1', sozlama: {} }).then(() => sanoq++),
      amalniBajar(a, { appId: 'bot-2', sozlama: {} }).then(() => sanoq++),
    ])

    expect(sanoq).toBe(2)
  })
})

describe('sirlarniTozala', () => {
  test('sir qiymat maskalanadi', () => {
    expect(sirlarniTozala('Xato: 7891234:AAHsecret rad etildi', ['7891234:AAHsecret'])).toBe(
      'Xato: ••• rad etildi',
    )
  })

  test('bir necha marta uchrasa hammasi maskalanadi', () => {
    expect(sirlarniTozala('a SIRLIQIYMAT b SIRLIQIYMAT', ['SIRLIQIYMAT'])).toBe('a ••• b •••')
  })

  // Qisqa qiymatlarni maskalash xabarni o'qishga yaroqsiz qilardi:
  // `1`, `bot`, `true` matnda tabiiy uchraydi.
  test('qisqa qiymatlar TOZALANMAYDI', () => {
    expect(sirlarniTozala('bot ishga tushdi', ['bot'])).toBe('bot ishga tushdi')
    expect(sirlarniTozala('holat: 1', ['1'])).toBe('holat: 1')
  })

  test('regex belgilari muammo qilmaydi', () => {
    // `split`/`join` regex qochirishni butunlay chetlab o'tadi. Qiymat
    // 8 belgidan uzun bo'lishi kerak (qisqa chegara — yuqoridagi testga q.).
    expect(sirlarniTozala('x $(a).b*[c]+d y', ['$(a).b*[c]+d'])).toBe('x ••• y')
  })

  test('sirsiz matn o\'zgarmaydi', () => {
    expect(sirlarniTozala('oddiy matn', [])).toBe('oddiy matn')
  })
})

describe('sozlamalarniYoz — sir oqmasligi', () => {
  const sozlamalar: AppSozlamalari = {
    maydonlar: [
      { kalit: 'token', turi: 'sir', yorliq: 'Token' },
      { kalit: 'rejim', turi: 'matn', yorliq: 'Rejim' },
    ],
    yoz: 'module.exports = async ({ qiymatlar, ssh }) => { await ssh("h").envYoz("/opt/bot/.env", { TOKEN: qiymatlar.token }); return { xabar: "Saqlandi" } }',
  }

  test('qiymatlar kodga uzatiladi va serverga yoziladi', async () => {
    const n = await sozlamalarniYoz(sozlamalar, { token: '789:SIRLIQIYMAT' }, kontekst)

    expect(n.ok).toBe(true)
    expect(n.xabar).toBe('Saqlandi')
    expect(sshChaqiruvlari[0]!.turi).toBe('envYoz')
    expect((sshChaqiruvlari[0]!.arg as { qiymatlar: object }).qiymatlar).toEqual({
      TOKEN: '789:SIRLIQIYMAT',
    })
  })

  // ┌──────────────────────────────────────────────────────────────┐
  // │ ENG MUHIM TEST. Bot "Invalid token: 789..." deb xato bersa,   │
  // │ o'sha matn auditga, WS'ga va brauzerga borardi.               │
  // └──────────────────────────────────────────────────────────────┘
  test('XATO MATNIDAGI token maskalanadi', async () => {
    const n = await sozlamalarniYoz(
      {
        ...sozlamalar,
        yoz: 'module.exports = async ({ qiymatlar }) => { throw new Error("Invalid token: " + qiymatlar.token) }',
      },
      { token: '789:SIRLIQIYMAT' },
      kontekst,
    )

    expect(n.ok).toBe(false)
    expect(n.xato).not.toContain('SIRLIQIYMAT')
    expect(n.xato).toContain('•••')
  })

  test('NATIJADAGI token ham maskalanadi', async () => {
    const n = await sozlamalarniYoz(
      {
        ...sozlamalar,
        yoz: 'module.exports = async ({ qiymatlar }) => ({ xabar: "Yozildi: " + qiymatlar.token })',
      },
      { token: '789:SIRLIQIYMAT' },
      kontekst,
    )

    expect(n.xabar).not.toContain('SIRLIQIYMAT')
  })

  test('sirsiz maydon maskalanmaydi', async () => {
    const n = await sozlamalarniYoz(
      {
        ...sozlamalar,
        yoz: 'module.exports = async ({ qiymatlar }) => ({ xabar: "Rejim: " + qiymatlar.rejim })',
      },
      { rejim: 'webhook-polling' },
      kontekst,
    )
    // Rejim sir emas — foydalanuvchi uni ko'rishi kerak
    expect(n.xabar).toBe('Rejim: webhook-polling')
  })

  test('yiqilgan yozish XATO TASHLAMAYDI', async () => {
    const n = await sozlamalarniYoz(
      { ...sozlamalar, yoz: 'module.exports = async () => { throw new Error("disk to\'ldi") }' },
      {},
      kontekst,
    )
    expect(n.ok).toBe(false)
    expect(n.xato).toContain('disk')
  })
})

describe('sozlamalarniOqi — sir QAYTARILMAYDI', () => {
  const sozlamalar: AppSozlamalari = {
    maydonlar: [
      { kalit: 'token', turi: 'sir', yorliq: 'Token' },
      { kalit: 'rejim', turi: 'matn', yorliq: 'Rejim' },
      { kalit: 'admin_id', turi: 'raqam', yorliq: 'Admin' },
    ],
    yoz: 'module.exports = async () => {}',
  }

  test('`oqi` yo\'q bo\'lsa bo\'sh qiymatlar — xato emas', async () => {
    const n = await sozlamalarniOqi(sozlamalar, kontekst)
    expect(n.ok).toBe(true)
    expect(n.qiymatlar).toEqual({})
  })

  test('sirsiz qiymatlar qaytadi', async () => {
    const n = await sozlamalarniOqi(
      { ...sozlamalar, oqi: 'module.exports = async () => ({ rejim: "webhook", admin_id: 123 })' },
      kontekst,
    )

    expect(n.ok).toBe(true)
    // Raqam satrga aylantiriladi — forma inputlari satr bilan ishlaydi
    expect(n.qiymatlar).toEqual({ rejim: 'webhook', admin_id: '123' })
  })

  // ┌──────────────────────────────────────────────────────────────┐
  // │ QATLAMNING ASOSIY QOIDASI. AI tokenni qaytarish TABIIY deb    │
  // │ o'ylaydi — shuning uchun filtr kodga ishonmaydi.              │
  // └──────────────────────────────────────────────────────────────┘
  test('sir kalit QAYTARILSA tashlanadi', async () => {
    const n = await sozlamalarniOqi(
      {
        ...sozlamalar,
        oqi: 'module.exports = async () => ({ token: "789:SIRLI", rejim: "polling" })',
      },
      kontekst,
    )

    expect(n.qiymatlar.token).toBeUndefined()
    expect(n.qiymatlar.rejim).toBe('polling')
    expect(n.tashlangan).toEqual(['token'])
    // Qiymat bor edi — "serverda o'rnatilgan" deb belgilanadi
    expect(n.ornatilgan).toEqual(['token'])
  })

  // ┌──────────────────────────────────────────────────────────────┐
  // │ TAVSIYA ETILGAN YO'L: sir uchun BOOLEAN.                      │
  // │                                                              │
  // │ Shunda token platforma xotirasiga umuman kelmaydi, lekin      │
  // │ "✓ o'rnatilgan" belgisi baribir ishlaydi.                     │
  // └──────────────────────────────────────────────────────────────┘
  test('sir uchun `true` — qiymatsiz "o\'rnatilgan"', async () => {
    const n = await sozlamalarniOqi(
      { ...sozlamalar, oqi: 'module.exports = async () => ({ token: true, rejim: "x" })' },
      kontekst,
    )

    expect(n.ornatilgan).toEqual(['token'])
    // Qiymat qaytarilmagani uchun "tashlangan" ham yo'q — AI xatosi emas
    expect(n.tashlangan).toBeUndefined()
    expect(n.qiymatlar.token).toBeUndefined()
  })

  test('sir uchun `false` — o\'rnatilmagan', async () => {
    const n = await sozlamalarniOqi(
      { ...sozlamalar, oqi: 'module.exports = async () => ({ token: false, rejim: "x" })' },
      kontekst,
    )
    expect(n.ornatilgan).toBeUndefined()
    expect(n.tashlangan).toBeUndefined()
  })

  // ┌──────────────────────────────────────────────────────────────┐
  // │ REGRESSIYA HIMOYASI. `oqi` odatda `{ token: q.TOKEN }`        │
  // │ qaytaradi — kalit `.env` da yo'q bo'lsa qiymat `undefined`,    │
  // │ lekin KALIT obyektda turadi. Uni "bor" deb sanasak            │
  // │ foydalanuvchi token yo'qligida ham "✓ o'rnatilgan" ko'rardi.   │
  // └──────────────────────────────────────────────────────────────┘
  test('BO\'SH sir qiymat "o\'rnatilgan" deb sanalmaydi', async () => {
    for (const kod of [
      'module.exports = async () => ({ token: undefined, rejim: "x" })',
      'module.exports = async () => ({ token: null, rejim: "x" })',
      'module.exports = async () => ({ token: "", rejim: "x" })',
    ]) {
      const n = await sozlamalarniOqi({ ...sozlamalar, oqi: kod }, kontekst)
      expect(n.ornatilgan).toBeUndefined()
      expect(n.qiymatlar.rejim).toBe('x')
    }
  })

  test('sxemada yo\'q kalit ham tashlanadi', async () => {
    const n = await sozlamalarniOqi(
      { ...sozlamalar, oqi: 'module.exports = async () => ({ begona: "x", rejim: "y" })' },
      kontekst,
    )
    // Forma uni ko'rsatmaydi — uzatish ortiqcha ma'lumot oqishi bo'lardi.
    expect(n.qiymatlar).toEqual({ rejim: 'y' })
  })

  test('obyekt qaytarmagan kod rad etiladi', async () => {
    for (const kod of [
      'module.exports = async () => "satr"',
      'module.exports = async () => [1,2]',
      'module.exports = async () => null',
    ]) {
      const n = await sozlamalarniOqi({ ...sozlamalar, oqi: kod }, kontekst)
      expect(n.ok).toBe(false)
    }
  })

  test('yiqilgan `oqi` XATO TASHLAMAYDI', async () => {
    const n = await sozlamalarniOqi(
      { ...sozlamalar, oqi: 'module.exports = async () => { throw new Error("ssh tushdi") }' },
      kontekst,
    )
    expect(n.ok).toBe(false)
    expect(n.xato).toContain('ssh')
    expect(n.qiymatlar).toEqual({})
  })
})
