// Kredensial ombori — pi-ai OAuth tokenlarni shu orqali yangilaydi,
// shuning uchun `modify` ning ketma-ketligi kritik.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Credential } from '@earendil-works/pi-ai'
import { FaylKredensialOmbori, XotiraKredensialOmbori } from '../src/kredensial.ts'

let papka: string
let yol: string

beforeEach(() => {
  papka = mkdtempSync(join(tmpdir(), 'platforma-kred-'))
  yol = join(papka, 'ai-auth.json')
})

afterEach(() => {
  rmSync(papka, { recursive: true, force: true })
})

const kalit = (k: string): Credential => ({ type: 'api_key', key: k })

describe('FaylKredensialOmbori', () => {
  test('mavjud bo\'lmagan fayl — bo\'sh ombor', async () => {
    const o = new FaylKredensialOmbori(yol)
    expect(await o.read('openai')).toBeUndefined()
    expect(await o.list()).toHaveLength(0)
  })

  test('yozilgan kredensial qayta o\'qiladi', async () => {
    const o = new FaylKredensialOmbori(yol)
    await o.modify('openai', async () => kalit('sk-1'))

    const oqilgan = await o.read('openai')
    expect(oqilgan?.type).toBe('api_key')
    expect((oqilgan as { key: string }).key).toBe('sk-1')

    // Yangi ombor obyekti ham o'sha fayldan o'qiydi
    const boshqa = new FaylKredensialOmbori(yol)
    expect(await boshqa.read('openai')).toBeTruthy()
  })

  test('modify hozirgi qiymatni ko\'radi', async () => {
    const o = new FaylKredensialOmbori(yol)
    await o.modify('openai', async () => kalit('birinchi'))

    let korilgan: Credential | undefined
    await o.modify('openai', async (hozirgi) => {
      korilgan = hozirgi
      return kalit('ikkinchi')
    })

    expect((korilgan as { key: string }).key).toBe('birinchi')
    expect(((await o.read('openai')) as { key: string }).key).toBe('ikkinchi')
  })

  test('undefined qaytarilsa yozuv o\'zgarmaydi', async () => {
    const o = new FaylKredensialOmbori(yol)
    await o.modify('openai', async () => kalit('asl'))
    await o.modify('openai', async () => undefined)
    expect(((await o.read('openai')) as { key: string }).key).toBe('asl')
  })

  test('parallel modify\'lar ketma-ket bajariladi (yozuv yo\'qolmaydi)', async () => {
    const o = new FaylKredensialOmbori(yol)
    // Har biri hozirgi qiymatga qo'shadi — serializatsiya bo'lmasa
    // ba'zilari bir-birini yo'qotardi
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        o.modify('p', async (hozirgi) => {
          const eski = hozirgi?.type === 'api_key' ? (hozirgi.key ?? '') : ''
          return kalit(`${eski}${i}`)
        }),
      ),
    )
    const oxirgi = (await o.read('p')) as { key: string }
    expect(oxirgi.key).toHaveLength(10)
  })

  test('delete yozuvni o\'chiradi', async () => {
    const o = new FaylKredensialOmbori(yol)
    await o.modify('openai', async () => kalit('sk-1'))
    await o.delete('openai')
    expect(await o.read('openai')).toBeUndefined()
  })

  test('list sirlarni ochmaydi, faqat metadata beradi', async () => {
    const o = new FaylKredensialOmbori(yol)
    await o.modify('openai', async () => kalit('maxfiy'))
    await o.modify('anthropic', async () => ({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
    }))

    const royxat = await o.list()
    expect(royxat).toHaveLength(2)
    expect(royxat.map((r) => r.providerId).sort()).toEqual(['anthropic', 'openai'])
    // Metadata'da faqat providerId va type bo'lishi kerak
    for (const r of royxat) expect(Object.keys(r).sort()).toEqual(['providerId', 'type'])
  })

  test('buzuq fayl — bo\'sh ombor sifatida ishlaydi, throw qilmaydi', async () => {
    await Bun.write(yol, 'bu json emas {{{')
    const o = new FaylKredensialOmbori(yol)
    expect(await o.read('openai')).toBeUndefined()
    // Yozish ham ishlashi kerak (buzuq fayl ustiga)
    await o.modify('openai', async () => kalit('yangi'))
    expect(await o.read('openai')).toBeTruthy()
  })
})

describe('XotiraKredensialOmbori', () => {
  test('asosiy amallar ishlaydi', async () => {
    const o = new XotiraKredensialOmbori()
    expect(await o.read('x')).toBeUndefined()
    await o.modify('x', async () => kalit('k'))
    expect(((await o.read('x')) as { key: string }).key).toBe('k')
    await o.delete('x')
    expect(await o.read('x')).toBeUndefined()
  })
})
