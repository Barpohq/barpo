// Ruxsat boshqaruvchisi — so'rov, javob, "har doim" naqshi, timeout.

import { afterEach, describe, expect, test } from 'bun:test'
import type { RuxsatSorovi } from '@platforma/shared'
import { RuxsatBoshqaruvchi, ruxsatBoshqaruvchisi, ruxsatBoshqaruvchisiniYop, ruxsatlarniTozala } from '../src/ruxsat.ts'

afterEach(() => {
  ruxsatlarniTozala()
})

const sorash = (naqsh = 'rm') => ({
  tur: 'buyruq' as const,
  amal: 'bash',
  nishon: 'rm -rf x',
  sabab: 'test',
  naqsh,
})

describe('so\'rov va javob', () => {
  test('kuzatuvchiga so\'rov keladi', async () => {
    const b = new RuxsatBoshqaruvchi('s1')
    const olingan: RuxsatSorovi[] = []
    b.kuzat((s) => olingan.push(s))

    const kutish = b.sora(sorash())
    expect(olingan).toHaveLength(1)
    expect(olingan[0]?.sessionId).toBe('s1')
    expect(olingan[0]?.nishon).toBe('rm -rf x')

    b.javobBer(olingan[0]!.id, 'ruxsat')
    expect(await kutish).toBe('ruxsat')
  })

  test('rad javobi qaytadi', async () => {
    const b = new RuxsatBoshqaruvchi('s1')
    b.kuzat((s) => b.javobBer(s.id, 'rad'))
    expect(await b.sora(sorash())).toBe('rad')
  })

  test('noma\'lum id uchun javobBer false qaytaradi', () => {
    const b = new RuxsatBoshqaruvchi('s1')
    expect(b.javobBer('yoq-bunday', 'ruxsat')).toBe(false)
  })

  test('kutayotgan so\'rovlar ro\'yxatda ko\'rinadi', async () => {
    const b = new RuxsatBoshqaruvchi('s1')
    const kutish = b.sora(sorash())
    expect(b.kutayotganSorovlar).toHaveLength(1)

    b.javobBer(b.kutayotganSorovlar[0]!.id, 'rad')
    await kutish
    expect(b.kutayotganSorovlar).toHaveLength(0)
  })
})

describe('har doim ruxsat', () => {
  test('naqsh eslab qolinadi va qayta so\'ralmaydi', async () => {
    const b = new RuxsatBoshqaruvchi('s1')
    let soralganSoni = 0
    b.kuzat((s) => {
      soralganSoni += 1
      b.javobBer(s.id, 'hardoim')
    })

    expect(await b.sora(sorash('git push'))).toBe('ruxsat')
    expect(soralganSoni).toBe(1)

    // Ikkinchi va uchinchi marta so'ralmaydi
    expect(await b.sora(sorash('git push'))).toBe('ruxsat')
    expect(await b.sora(sorash('git push'))).toBe('ruxsat')
    expect(soralganSoni).toBe(1)
    expect(b.hardoimlar).toEqual(['git push'])
  })

  test('boshqa naqsh qayta so\'raladi', async () => {
    const b = new RuxsatBoshqaruvchi('s1')
    let soralganSoni = 0
    b.kuzat((s) => {
      soralganSoni += 1
      b.javobBer(s.id, 'hardoim')
    })

    await b.sora(sorash('git push'))
    await b.sora(sorash('rm'))
    expect(soralganSoni).toBe(2)
  })

  test('hardoimRuxsatmi tekshiruvi', async () => {
    const b = new RuxsatBoshqaruvchi('s1')
    b.kuzat((s) => b.javobBer(s.id, 'hardoim'))
    expect(b.hardoimRuxsatmi('rm')).toBe(false)
    await b.sora(sorash('rm'))
    expect(b.hardoimRuxsatmi('rm')).toBe(true)
  })

  test('rad javobi naqshni eslab qolmaydi', async () => {
    const b = new RuxsatBoshqaruvchi('s1')
    b.kuzat((s) => b.javobBer(s.id, 'rad'))
    await b.sora(sorash('rm'))
    expect(b.hardoimlar).toHaveLength(0)
  })

  test('bo\'sh naqsh eslab qolinmaydi', async () => {
    const b = new RuxsatBoshqaruvchi('s1')
    b.kuzat((s) => b.javobBer(s.id, 'hardoim'))
    await b.sora({ ...sorash(''), naqsh: '' })
    expect(b.hardoimlar).toHaveLength(0)
  })
})

describe('parallel so\'rovlar', () => {
  test('har biri o\'z javobini oladi', async () => {
    const b = new RuxsatBoshqaruvchi('s1')
    const olingan: RuxsatSorovi[] = []
    b.kuzat((s) => olingan.push(s))

    const a = b.sora({ ...sorash('a'), nishon: 'A' })
    const c = b.sora({ ...sorash('b'), nishon: 'B' })
    expect(olingan).toHaveLength(2)

    // Teskari tartibda javob beramiz
    const bSorovi = olingan.find((s) => s.nishon === 'B')!
    const aSorovi = olingan.find((s) => s.nishon === 'A')!
    b.javobBer(bSorovi.id, 'rad')
    b.javobBer(aSorovi.id, 'ruxsat')

    expect(await a).toBe('ruxsat')
    expect(await c).toBe('rad')
  })
})

describe('yopish', () => {
  test('yopilganda kutayotganlar rad etiladi', async () => {
    const b = new RuxsatBoshqaruvchi('s1')
    const kutish = b.sora(sorash())
    b.yop()
    expect(await kutish).toBe('rad')
  })

  test('yopilgandan keyingi so\'rov darhol rad', async () => {
    const b = new RuxsatBoshqaruvchi('s1')
    b.yop()
    expect(await b.sora(sorash())).toBe('rad')
  })
})

describe('reestr', () => {
  test('bir xil sessiya uchun bir xil boshqaruvchi', () => {
    const a = ruxsatBoshqaruvchisi('s1')
    const b = ruxsatBoshqaruvchisi('s1')
    expect(a).toBe(b)
  })

  test('turli sessiyalar ajratilgan', () => {
    expect(ruxsatBoshqaruvchisi('s1')).not.toBe(ruxsatBoshqaruvchisi('s2'))
  })

  test('yopilgach yangi boshqaruvchi beriladi', () => {
    const a = ruxsatBoshqaruvchisi('s1')
    ruxsatBoshqaruvchisiniYop('s1')
    expect(ruxsatBoshqaruvchisi('s1')).not.toBe(a)
  })

  test('bir sessiyaning hardoimlari boshqasiga o\'tmaydi', async () => {
    const a = ruxsatBoshqaruvchisi('s1')
    a.kuzat((s) => a.javobBer(s.id, 'hardoim'))
    await a.sora(sorash('rm'))

    const b = ruxsatBoshqaruvchisi('s2')
    expect(b.hardoimRuxsatmi('rm')).toBe(false)
  })
})
