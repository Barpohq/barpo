// Config sozlamalari haqiqatan qo'llanadimi.
//
// Config yozilgani bilan uni hech kim o'qimasa foydasi yo'q. Bu testlar
// sozlama → xulq zanjirini sinaydi: qiymat o'zgarsa xulq ham o'zgaradimi.
//
// LLM chaqiruvi kerak bo'lmagan joylar sinaladi — ular sof mantiq.

import { describe, expect, test } from 'bun:test'
import { standartConfig } from '@platforma/config'
import { klassifikatorModeliniTanla } from '../src/klassifikator.ts'
import { RejimBoshqaruvchi } from '../src/rejim.ts'
import { RuxsatBoshqaruvchi } from '../src/ruxsat.ts'
import type { ModelInfo } from '@platforma/shared'

function model(id: string, provider = 'p'): ModelInfo {
  return {
    provider,
    providerName: provider,
    id,
    name: id,
    contextWindow: 100_000,
    reasoning: false,
    vision: false,
    cost: { input: 1, output: 1 },
    manba: 'kalit',
    manbaTuri: 'kalit',
  }
}

describe('rejim chegaralari configdan keladi', () => {
  test('standart chegara 3 ta ketma-ket blok', () => {
    const b = new RejimBoshqaruvchi('s1')
    b.ornat('auto')
    expect(b.blokBoldi()).toBe(false)
    expect(b.blokBoldi()).toBe(false)
    // Uchinchisida auto o'chadi
    expect(b.blokBoldi()).toBe(true)
    expect(b.rejim).toBe('tasdiq')
  })

  test('configdagi chegara qo\'llanadi', () => {
    const b = new RejimBoshqaruvchi('s2')
    b.chegaralarniOrnat(1, 50)
    b.ornat('auto')
    // Birinchi blokda o'chadi
    expect(b.blokBoldi()).toBe(true)
    expect(b.rejim).toBe('tasdiq')
    expect(b.sabab).toContain('ketma-ket 1 marta')
  })

  test('jami chegara ham configdan', () => {
    const b = new RejimBoshqaruvchi('s3')
    b.chegaralarniOrnat(100, 2)
    b.ornat('auto')
    b.blokBoldi()
    // Ketma-ket hisoblagichni nolga qaytaramiz, jami qoladi
    b.ruxsatBerildi()
    expect(b.blokBoldi()).toBe(true)
    expect(b.sabab).toContain('jami 2 marta')
  })

  test('noto\'g\'ri chegara e\'tiborsiz qoldiriladi', () => {
    // Config validatsiyasi buni ushlashi kerak, lekin ikkinchi himoya
    const b = new RejimBoshqaruvchi('s4')
    b.chegaralarniOrnat(0, -5)
    b.ornat('auto')
    expect(b.blokBoldi()).toBe(false)
    expect(b.blokBoldi()).toBe(false)
    expect(b.blokBoldi()).toBe(true) // standart 3 saqlanadi
  })
})

describe('ruxsat kutish muddati configdan keladi', () => {
  test('muddat tugasa RAD etiladi, ruxsat berilmaydi', async () => {
    // Eng muhim xulq: timeout hech qachon avtomatik ruxsatga aylanmaydi
    const b = new RuxsatBoshqaruvchi('s5')
    b.kutishMuddatiniOrnat(30)
    const javob = await b.sora({
      tur: 'buyruq',
      amal: 'bash',
      nishon: 'rm x',
      sabab: 'sinov',
      naqsh: 'rm',
    })
    expect(javob).toBe('rad')
  })

  test('noto\'g\'ri muddat e\'tiborsiz qoldiriladi', () => {
    const b = new RuxsatBoshqaruvchi('s6')
    // Xato tashlamasligi kerak
    expect(() => b.kutishMuddatiniOrnat(-1)).not.toThrow()
    expect(() => b.kutishMuddatiniOrnat(Number.NaN)).not.toThrow()
  })
})

describe('klassifikator modeli configdan keladi', () => {
  const modellar = [model('claude-haiku-4.5', 'anthropic'), model('gemini-2.5-flash-lite', 'google')]

  test('config berilmasa avtomatik tanlanadi', () => {
    const t = klassifikatorModeliniTanla(modellar)
    expect(t).toBeDefined()
    // Sinalgan modellar ustuvor
    expect(t?.model).toBe('gemini-2.5-flash-lite')
  })

  test('configdagi model ustun turadi', () => {
    const t = klassifikatorModeliniTanla(modellar, 'anthropic/claude-haiku-4.5')
    expect(t).toEqual({ provider: 'anthropic', model: 'claude-haiku-4.5' })
  })

  test('config null bo\'lsa avtomatik tanlashga qaytadi', () => {
    const t = klassifikatorModeliniTanla(modellar, null)
    expect(t?.model).toBe('gemini-2.5-flash-lite')
  })

  test('buzuq config qiymati e\'tiborsiz qoldiriladi', () => {
    // `provider/model` shakli buzilgan — avtomatik tanlashga qaytamiz
    const t = klassifikatorModeliniTanla(modellar, 'provider-siz-model')
    expect(t?.model).toBe('gemini-2.5-flash-lite')
  })

  test('env o\'zgaruvchisi configdan USTUN turadi', () => {
    // Env — vaqtinchalik nosozlikni chetlab o'tish uchun, shuning uchun
    // doimiy sozlamani bosishi kerak
    const oldingi = process.env.PLATFORMA_KLASSIFIKATOR_MODEL
    process.env.PLATFORMA_KLASSIFIKATOR_MODEL = 'env/model'
    try {
      const t = klassifikatorModeliniTanla(modellar, 'config/model')
      expect(t).toEqual({ provider: 'env', model: 'model' })
    } finally {
      if (oldingi === undefined) delete process.env.PLATFORMA_KLASSIFIKATOR_MODEL
      else process.env.PLATFORMA_KLASSIFIKATOR_MODEL = oldingi
    }
  })
})

describe('standart config qiymatlari mantiqiy', () => {
  test('tool ro\'yxatida barcha mavjud tool\'lar bor', () => {
    const s = standartConfig()
    for (const nom of ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']) {
      expect(s.agent.toollar.yoqilgan, `${nom} standart ro'yxatda yo'q`).toContain(nom)
    }
  })

  test('siqish standart holatda yoqilgan', () => {
    // O'chirilgan bo'lsa uzun suhbat sig'may qoladi — bu yomon standart
    expect(standartConfig().agent.siqish.yoqilgan).toBe(true)
  })

  test('boshlang\'ich rejim tasdiq (xavfsizroq tomon)', () => {
    expect(standartConfig().ruxsat.rejim).toBe('tasdiq')
  })

  test('saqlanadigan tokenlar zaxiradan katta emas bo\'lishi shart emas, lekin ikkalasi context window ga sig\'sin', () => {
    const s = standartConfig()
    const jami = s.agent.siqish.zaxiraTokenlar + s.agent.siqish.saqlanadiganTokenlar
    // Eng kichik keng tarqalgan context window ~128k
    expect(jami).toBeLessThan(128_000)
  })
})
