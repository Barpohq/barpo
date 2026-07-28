// Config fayllarini o'qish testlari.
//
// Eng muhim qism: LOYIHA CHEKLOVI. Loyiha configi repo bilan birga keladi,
// ya'ni uni begona odam yozgan bo'lishi mumkin. U xavfsizlik chegarasini
// pasaytira olmasligi kod darajasida majburlanadi — bu testlar shuni sinaydi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONFIG_FAYLI,
  LOYIHA_PAPKASI,
  config,
  configniOqi,
  configniYangila,
  loyihaChekloviniQoll,
} from '../src/oqish.ts'
import { standartConfig } from '../src/tekshir.ts'

let ildiz: string
let globalPapka: string
let ishPapkasi: string

beforeEach(() => {
  ildiz = mkdtempSync(join(tmpdir(), 'platforma-config-'))
  globalPapka = join(ildiz, 'global')
  ishPapkasi = join(ildiz, 'loyiha')
  mkdirSync(globalPapka, { recursive: true })
  mkdirSync(join(ishPapkasi, LOYIHA_PAPKASI), { recursive: true })
  configniYangila()
})

afterEach(() => {
  rmSync(ildiz, { recursive: true, force: true })
  configniYangila()
})

function globalYoz(mazmun: unknown): void {
  writeFileSync(join(globalPapka, CONFIG_FAYLI), JSON.stringify(mazmun))
}

function loyihaYoz(mazmun: unknown): void {
  writeFileSync(join(ishPapkasi, LOYIHA_PAPKASI, CONFIG_FAYLI), JSON.stringify(mazmun))
}

describe('fayl o\'qish', () => {
  test('fayl umuman bo\'lmasa standart config, ogohlantirishsiz', () => {
    const n = configniOqi({ globalPapka })
    expect(n.config).toEqual(standartConfig())
    expect(n.ogohlantirishlar).toEqual([])
    expect(n.oqilganFayllar).toEqual([])
  })

  test('buzuq JSON platformani to\'xtatmaydi', () => {
    writeFileSync(join(globalPapka, CONFIG_FAYLI), '{ buzuq json,,, ')
    const n = configniOqi({ globalPapka })
    expect(n.config).toEqual(standartConfig())
    expect(n.ogohlantirishlar.some((o) => o.sabab.includes('JSON buzuq'))).toBe(true)
  })

  test('JSON obyekt emas (massiv) — ogohlantirish', () => {
    writeFileSync(join(globalPapka, CONFIG_FAYLI), '[1, 2, 3]')
    const n = configniOqi({ globalPapka })
    expect(n.ogohlantirishlar.some((o) => o.sabab.includes('JSON obyekt'))).toBe(true)
  })

  test('global config qiymatlari qo\'llanadi', () => {
    globalYoz({ ruxsat: { rejim: 'auto' }, agent: { siqish: { zaxiraTokenlar: 8000 } } })
    const n = configniOqi({ globalPapka })
    expect(n.config.ruxsat.rejim).toBe('auto')
    expect(n.config.agent.siqish.zaxiraTokenlar).toBe(8000)
    // Ko'rsatilmagan maydonlar standart bo'yicha
    expect(n.config.agent.siqish.yoqilgan).toBe(true)
    expect(n.oqilganFayllar).toHaveLength(1)
  })

  test('loyiha configi globalni bosadi', () => {
    globalYoz({ agent: { siqish: { zaxiraTokenlar: 8000 } } })
    loyihaYoz({ agent: { siqish: { zaxiraTokenlar: 4000 } } })
    const n = configniOqi({ globalPapka, ishPapkasi })
    expect(n.config.agent.siqish.zaxiraTokenlar).toBe(4000)
    expect(n.oqilganFayllar).toHaveLength(2)
  })
})

describe('loyiha cheklovi — xavfsizlik chegarasi pasaymaydi', () => {
  test('loyiha rejimni auto ga KO\'TARA olmaydi', () => {
    // Global tasdiq, loyiha auto so'rayapti — rad etiladi
    globalYoz({ ruxsat: { rejim: 'tasdiq' } })
    loyihaYoz({ ruxsat: { rejim: 'auto' } })
    const n = configniOqi({ globalPapka, ishPapkasi })
    expect(n.config.ruxsat.rejim).toBe('tasdiq')
  })

  test('loyiha rejimni tasdiq ga TUSHIRA oladi', () => {
    globalYoz({ ruxsat: { rejim: 'auto' } })
    loyihaYoz({ ruxsat: { rejim: 'tasdiq' } })
    const n = configniOqi({ globalPapka, ishPapkasi })
    expect(n.config.ruxsat.rejim).toBe('tasdiq')
  })

  test('loyiha taqiqlarni olib tashlay olmaydi, faqat qo\'sha oladi', () => {
    globalYoz({ ruxsat: { qoshimchaTaqiqlar: ['deploy'] } })
    loyihaYoz({ ruxsat: { qoshimchaTaqiqlar: ['terraform'] } })
    const n = configniOqi({ globalPapka, ishPapkasi })
    expect(n.config.ruxsat.qoshimchaTaqiqlar).toContain('deploy')
    expect(n.config.ruxsat.qoshimchaTaqiqlar).toContain('terraform')
  })

  test('loyiha tool ro\'yxatini KENGAYTIRA olmaydi', () => {
    globalYoz({ agent: { toollar: { yoqilgan: ['read', 'grep'] } } })
    loyihaYoz({ agent: { toollar: { yoqilgan: ['read', 'grep', 'bash', 'write'] } } })
    const n = configniOqi({ globalPapka, ishPapkasi })
    expect(n.config.agent.toollar.yoqilgan).toEqual(['read', 'grep'])
  })

  test('loyiha tool ro\'yxatini TORAYTIRA oladi', () => {
    globalYoz({ agent: { toollar: { yoqilgan: ['read', 'grep', 'bash'] } } })
    loyihaYoz({ agent: { toollar: { yoqilgan: ['read'] } } })
    const n = configniOqi({ globalPapka, ishPapkasi })
    expect(n.config.agent.toollar.yoqilgan).toEqual(['read'])
  })

  test('xavfsizlikka tegishli bo\'lmagan maydonlar erkin bosadi', () => {
    globalYoz({ agent: { toollar: { bashTimeoutSekund: 60 } } })
    loyihaYoz({ agent: { toollar: { bashTimeoutSekund: 300 } } })
    const n = configniOqi({ globalPapka, ishPapkasi })
    expect(n.config.agent.toollar.bashTimeoutSekund).toBe(300)
  })

  test('chekloviniQoll global obyektni o\'zgartirmaydi', () => {
    const global = standartConfig()
    const nusxa = JSON.parse(JSON.stringify(global)) as typeof global
    loyihaChekloviniQoll(global, { ruxsat: { qoshimchaTaqiqlar: ['x'] } })
    expect(global).toEqual(nusxa)
  })
})

describe('kesh', () => {
  test('ikkinchi chaqiruv keshdan keladi', () => {
    globalYoz({ ruxsat: { rejim: 'auto' } })
    const birinchi = config({ globalPapka })
    // Faylni o'zgartiramiz, lekin kesh tozalanmagan
    globalYoz({ ruxsat: { rejim: 'tasdiq' } })
    const ikkinchi = config({ globalPapka })
    expect(ikkinchi).toBe(birinchi)
    expect(ikkinchi.config.ruxsat.rejim).toBe('auto')
  })

  test('configniYangila keshni tozalaydi', () => {
    globalYoz({ ruxsat: { rejim: 'auto' } })
    config({ globalPapka })
    globalYoz({ ruxsat: { rejim: 'tasdiq' } })
    configniYangila()
    expect(config({ globalPapka }).config.ruxsat.rejim).toBe('tasdiq')
  })

  test('ish papkasi o\'zgarsa qayta o\'qiladi', () => {
    // Har loyihaning o'z configi bor — kesh ularni aralashtirmasin
    globalYoz({ agent: { toollar: { bashTimeoutSekund: 60 } } })
    const birinchi = config({ globalPapka })
    loyihaYoz({ agent: { toollar: { bashTimeoutSekund: 90 } } })
    const ikkinchi = config({ globalPapka, ishPapkasi })
    expect(ikkinchi).not.toBe(birinchi)
    expect(ikkinchi.config.agent.toollar.bashTimeoutSekund).toBe(90)
  })
})
