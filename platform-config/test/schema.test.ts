// JSON Schema generatsiyasi testlari.
//
// Eng muhim test — `schema.json` fayli eskirmaganini tekshirish. `sxema.ts`
// o'zgartirilib `bun run schema` unutilsa, tahrirlagichlar eski sxemani
// ko'rsatadi va foydalanuvchi to'g'ri yozgan sozlamani "xato" deb belgilaydi.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { MAYDONLAR } from '../src/sxema.ts'
import { schemaYasa } from '../src/schema-yasa.ts'
import { yoldanOqi } from '../src/tekshir.ts'

describe('schema generatsiyasi', () => {
  test('har maydon sxemada properties orqali mavjud', () => {
    const sxema = schemaYasa()
    for (const m of MAYDONLAR) {
      // `agent.siqish.yoqilgan` → properties.agent.properties.siqish.properties.yoqilgan
      const sxemaYoli = m.yol.split('.').join('.properties.')
      const tugun = yoldanOqi(sxema.properties, sxemaYoli)
      expect(tugun, `${m.yol} sxemada yo'q`).toBeDefined()
    }
  })

  test('izohlar sxemaga o\'tadi (tahrirlagich shuni ko\'rsatadi)', () => {
    const sxema = schemaYasa()
    const tugun = yoldanOqi(sxema.properties, 'agent.properties.siqish.properties.yoqilgan') as {
      description?: string
    }
    expect(tugun.description).toBeTruthy()
    expect(tugun.description).toBe(MAYDONLAR.find((m) => m.yol === 'agent.siqish.yoqilgan')!.izoh)
  })

  test('son chegaralari sxemaga o\'tadi', () => {
    const sxema = schemaYasa()
    const tugun = yoldanOqi(
      sxema.properties,
      'agent.properties.siqish.properties.zaxiraTokenlar',
    ) as { minimum?: number; maximum?: number }
    expect(tugun.minimum).toBe(1000)
    expect(tugun.maximum).toBe(200_000)
  })

  test('tanlov maydonida enum bor', () => {
    const sxema = schemaYasa()
    const tugun = yoldanOqi(sxema.properties, 'ruxsat.properties.rejim') as { enum?: string[] }
    expect(tugun.enum).toEqual(['tasdiq', 'auto'])
  })

  test('null ruxsat berilgan maydon ikki turli', () => {
    const sxema = schemaYasa()
    const tugun = yoldanOqi(sxema.properties, 'agent.properties.siqish.properties.modeli') as {
      type?: string[]
    }
    expect(tugun.type).toEqual(['string', 'null'])
  })

  test('notanish maydon taqiqlanadi (imlo xatosi ko\'rinsin)', () => {
    expect(schemaYasa().additionalProperties).toBe(false)
  })

  test('$schema maydoniga ruxsat berilgan', () => {
    const sxema = schemaYasa()
    expect((sxema.properties as Record<string, unknown>).$schema).toBeDefined()
  })
})

describe('schema.json fayli', () => {
  test('fayl generatsiya natijasiga mos (eskirmagan)', () => {
    // Bu test `sxema.ts` o'zgartirilib `bun run schema` unutilganini ushlaydi
    const yol = new URL('../schema.json', import.meta.url).pathname
    const fayldagi = readFileSync(yol, 'utf8')
    const kutilgan = `${JSON.stringify(schemaYasa(), null, 2)}\n`
    expect(
      fayldagi,
      "schema.json eskirgan — `bun run schema` ni ishga tushiring",
    ).toBe(kutilgan)
  })
})
