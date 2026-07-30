// Config tekshiruvi testlari.
//
// Asosiy majburiy xulq: tekshiruv HECH QACHON xato tashlamaydi. Har qanday
// axlat kirsa ham to'liq, ishlaydigan config chiqadi. Testlar shuni sinaydi —
// chunki bu platformaning ishga tushishi shunga bog'liq.

import { describe, expect, test } from 'bun:test'
import {
  configlarniBirlashtir,
  configniTekshir,
  maydonniTekshir,
  standartConfig,
  yoldanOqi,
  yolgaYoz,
} from '../src/tekshir.ts'
import { MAYDONLAR, type Config } from '../src/sxema.ts'

describe('yo\'l bilan ishlash', () => {
  test('ichma-ich yo\'ldan o\'qiydi', () => {
    const manba = { agent: { siqish: { yoqilgan: true } } }
    expect(yoldanOqi(manba, 'agent.siqish.yoqilgan')).toBe(true)
  })

  test('mavjud bo\'lmagan yo\'l undefined qaytaradi', () => {
    expect(yoldanOqi({ a: 1 }, 'b.c.d')).toBeUndefined()
  })

  test('primitiv ichiga kirmaydi', () => {
    expect(yoldanOqi({ a: 5 }, 'a.b')).toBeUndefined()
  })

  test('yo\'lga yozganda oraliq obyektlar yaratiladi', () => {
    const nishon: Record<string, unknown> = {}
    yolgaYoz(nishon, 'x.y.z', 42)
    expect(nishon).toEqual({ x: { y: { z: 42 } } })
  })

  test('primitiv o\'rnida obyekt yaratiladi', () => {
    const nishon: Record<string, unknown> = { x: 'matn' }
    yolgaYoz(nishon, 'x.y', 1)
    expect(nishon).toEqual({ x: { y: 1 } })
  })
})

describe('maydon tekshiruvi', () => {
  const sonMaydon = { yol: 't', tur: 'son', standart: 10, izoh: '', eng: { kam: 1, kop: 100 } } as const

  test('ko\'rsatilmagan maydon standart qiymat oladi, ogohlantirishsiz', () => {
    const n = maydonniTekshir(sonMaydon, undefined)
    expect(n.qiymat).toBe(10)
    expect(n.sabab).toBeUndefined()
  })

  test('noto\'g\'ri tur standartga qaytariladi', () => {
    const n = maydonniTekshir(sonMaydon, 'salom')
    expect(n.qiymat).toBe(10)
    expect(n.sabab).toContain('expected a number')
  })

  test('chegaradan kichik qiymat KESILADI, standartga qaytarilmaydi', () => {
    // Foydalanuvchi niyati aniq — shunchaki ruxsat etilgan oraliqqa keltiramiz
    const n = maydonniTekshir(sonMaydon, -5)
    expect(n.qiymat).toBe(1)
    expect(n.sabab).toContain('too small')
  })

  test('chegaradan katta qiymat kesiladi', () => {
    const n = maydonniTekshir(sonMaydon, 1e9)
    expect(n.qiymat).toBe(100)
  })

  test('NaN va Infinity son emas', () => {
    expect(maydonniTekshir(sonMaydon, Number.NaN).qiymat).toBe(10)
    expect(maydonniTekshir(sonMaydon, Number.POSITIVE_INFINITY).qiymat).toBe(10)
  })

  test('null faqat ruxsat berilgan maydonlarda qabul qilinadi', () => {
    expect(maydonniTekshir(sonMaydon, null).qiymat).toBe(10)
    const nullli = { yol: 't', tur: 'matn', standart: null, izoh: '', nullBolishiMumkin: true } as const
    expect(maydonniTekshir(nullli, null).qiymat).toBeNull()
  })

  test('tanlov ro\'yxatdan tashqari qiymatni rad etadi', () => {
    const tanlov = {
      yol: 't',
      tur: 'tanlov',
      standart: 'a',
      izoh: '',
      variantlar: ['a', 'b'],
    } as const
    expect(maydonniTekshir(tanlov, 'b').qiymat).toBe('b')
    const n = maydonniTekshir(tanlov, 'c')
    expect(n.qiymat).toBe('a')
    expect(n.sabab).toContain('options')
  })

  test('ro\'yxatdagi noto\'g\'ri elementlar tashlanadi, butun ro\'yxat emas', () => {
    const royxat = { yol: 't', tur: 'matnRoyxati', standart: [], izoh: '' } as const
    const n = maydonniTekshir(royxat, ['read', 42, 'bash', null])
    expect(n.qiymat).toEqual(['read', 'bash'])
    expect(n.sabab).toContain('dropped')
  })
})

describe('to\'liq config', () => {
  test('bo\'sh obyektdan to\'liq config quriladi', () => {
    const { config, ogohlantirishlar } = configniTekshir({})
    expect(ogohlantirishlar).toEqual([])
    expect(config.agent.siqish.yoqilgan).toBe(true)
    expect(config.ruxsat.rejim).toBe('tasdiq')
    expect(config.agent.toollar.yoqilgan).toContain('grep')
  })

  test('axlat kirsa ham ishlaydigan config chiqadi', () => {
    // Bu testning maqsadi: hech qanday kirish xato tashlamasin
    for (const axlat of [null, 42, 'matn', [], { agent: 'matn emas obyekt' }, { a: { b: { c: 1 } } }]) {
      const { config } = configniTekshir(axlat)
      expect(config.agent.siqish.zaxiraTokenlar).toBeGreaterThan(0)
      expect(['tasdiq', 'auto']).toContain(config.ruxsat.rejim)
    }
  })

  test('notanish maydon ogohlantirish beradi (imlo xatosi yo\'qolmasin)', () => {
    const { ogohlantirishlar } = configniTekshir({ agent: { siqish: { yoqilagan: true } } })
    expect(ogohlantirishlar.some((o) => o.yol === 'agent.siqish.yoqilagan')).toBe(true)
  })

  test('$schema notanish maydon hisoblanmaydi', () => {
    const { ogohlantirishlar } = configniTekshir({ $schema: './schema.json' })
    expect(ogohlantirishlar).toEqual([])
  })

  test('standartConfig har chaqiruvda yangi obyekt qaytaradi', () => {
    // Aks holda bir sessiya configni o'zgartirsa boshqasiga ta'sir qilardi
    const a = standartConfig()
    const b = standartConfig()
    a.agent.toollar.yoqilgan.push('yolgon')
    expect(b.agent.toollar.yoqilgan).not.toContain('yolgon')
  })
})

describe('birlashtirish', () => {
  test('ustki qatlam astkini bosadi', () => {
    const n = configlarniBirlashtir(
      { ruxsat: { rejim: 'tasdiq', kutishSoniya: 300 } },
      { ruxsat: { rejim: 'auto' } },
    )
    expect(n.ruxsat?.rejim).toBe('auto')
    // Ko'rsatilmagan maydon astkidan qoladi
    expect(n.ruxsat?.kutishSoniya).toBe(300)
  })

  test('undefined astki qatlamni o\'chirmaydi', () => {
    const n = configlarniBirlashtir(
      { ruxsat: { rejim: 'auto' } },
      { ruxsat: { rejim: undefined } },
    )
    expect(n.ruxsat?.rejim).toBe('auto')
  })

  test('massiv butunlay almashtiriladi, qo\'shilmaydi', () => {
    // "faqat read" degan cheklov globaldagi bash ni qo'shib yubormasin
    const n = configlarniBirlashtir(
      { agent: { toollar: { yoqilgan: ['read', 'bash'], bashTimeoutSekund: 120, natijaChegarasi: 2000 } } },
      { agent: { toollar: { yoqilgan: ['read'] } as Config['agent']['toollar'] } },
    )
    expect(n.agent?.toollar?.yoqilgan).toEqual(['read'])
  })
})

describe('sxema yaxlitligi', () => {
  test('MAYDONLAR va Config tipi mos keladi', () => {
    // Har e'lon qilingan yo'l haqiqiy configda mavjud bo'lishi kerak.
    // Bu ikkisi qo'lda sinxronlanadi — test uni majburlaydi.
    const config = standartConfig()
    for (const m of MAYDONLAR) {
      expect(yoldanOqi(config, m.yol), `${m.yol} configda yo'q`).not.toBeUndefined()
    }
  })

  test('har maydonda izoh bor (web UI shuni ko\'rsatadi)', () => {
    for (const m of MAYDONLAR) {
      expect(m.izoh.length, `${m.yol} izohsiz`).toBeGreaterThan(10)
    }
  })

  test('yo\'llar takrorlanmaydi', () => {
    const yollar = MAYDONLAR.map((m) => m.yol)
    expect(new Set(yollar).size).toBe(yollar.length)
  })

  test('tanlov maydonlarida variantlar bor va standart ular ichida', () => {
    for (const m of MAYDONLAR) {
      if (m.tur !== 'tanlov') continue
      expect(m.variantlar, `${m.yol} variantsiz`).toBeDefined()
      // `variantlar` — `readonly` literal massiv, `toContain` esa uning
      // aniq element tipini kutadi. Tekshiruv mazmuni saqlanadi.
      expect(m.variantlar as readonly string[]).toContain(m.standart as string)
    }
  })

  test('standart qiymatlar o\'z chegaralari ichida', () => {
    for (const m of MAYDONLAR) {
      const n = maydonniTekshir(m, m.standart)
      expect(n.sabab, `${m.yol} standarti o'z tekshiruvidan o'tmadi`).toBeUndefined()
    }
  })
})
