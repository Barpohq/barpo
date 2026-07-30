// MCP kredensial ombori — maxfiy qiymatlar bazadan TASHQARIDA saqlanadi.
//
// Eng muhim xulq: BO'SH QIYMAT MAVJUDINI O'CHIRMAYDI. UI maxfiy qiymatni
// qaytarib ko'rsatmaydi, ya'ni "o'zgartirmadim" holati bo'sh input bo'lib
// keladi — bo'shni saqlasak forma har ochilganda token o'chib ketardi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FaylMcpKredensialOmbori,
  mcpKredensialOmbori,
  mcpKredensialOmboriniOrnat,
  mcpKredensialYoli,
  XotiraMcpKredensialOmbori,
} from '../src/mcp-kredensial.ts'

let papka: string
let yol: string

beforeEach(() => {
  papka = mkdtempSync(join(tmpdir(), 'mcp-kred-'))
  yol = join(papka, 'kredensiallar.json')
  process.env.PLATFORMA_MCP_KREDENSIAL = yol
})

afterEach(() => {
  rmSync(papka, { recursive: true, force: true })
  delete process.env.PLATFORMA_MCP_KREDENSIAL
  mcpKredensialOmboriniOrnat(null)
})

describe('yo\'l', () => {
  test('env berilsa shundan olinadi', () => {
    expect(mcpKredensialYoli()).toBe(yol)
  })

  test('env yo\'q bo\'lsa uy papkasida', () => {
    delete process.env.PLATFORMA_MCP_KREDENSIAL
    expect(mcpKredensialYoli()).toContain('.platforma')
    expect(mcpKredensialYoli()).toContain('mcp-kredensiallar.json')
  })
})

describe('FaylMcpKredensialOmbori', () => {
  test('saqlangan qiymat qaytib keladi', async () => {
    const ombor = new FaylMcpKredensialOmbori(yol)
    await ombor.saqla('ornatish-1', { TOKEN: 'maxfiy-qiymat' })
    expect(await ombor.ol('ornatish-1')).toEqual({ TOKEN: 'maxfiy-qiymat' })
  })

  test('yo\'q o\'rnatish uchun bo\'sh obyekt', async () => {
    const ombor = new FaylMcpKredensialOmbori(yol)
    expect(await ombor.ol('yoq')).toEqual({})
  })

  test('o\'rnatishlar bir-biriga aralashmaydi', async () => {
    const ombor = new FaylMcpKredensialOmbori(yol)
    await ombor.saqla('a', { TOKEN: 'birinchi' })
    await ombor.saqla('b', { TOKEN: 'ikkinchi' })

    expect(await ombor.ol('a')).toEqual({ TOKEN: 'birinchi' })
    expect(await ombor.ol('b')).toEqual({ TOKEN: 'ikkinchi' })
  })

  test("BO'SH QIYMAT mavjudini o'chirmaydi", async () => {
    const ombor = new FaylMcpKredensialOmbori(yol)
    await ombor.saqla('a', { TOKEN: 'asl' })
    // Foydalanuvchi formani qayta yubordi, maxfiy maydonga tegmadi
    await ombor.saqla('a', { TOKEN: '' })
    expect(await ombor.ol('a')).toEqual({ TOKEN: 'asl' })
  })

  test('qismli yangilash — boshqa kalitlar joyida qoladi', async () => {
    const ombor = new FaylMcpKredensialOmbori(yol)
    await ombor.saqla('a', { TOKEN: 'bir', PAROL: 'ikki' })
    await ombor.saqla('a', { TOKEN: 'yangi' })

    expect(await ombor.ol('a')).toEqual({ TOKEN: 'yangi', PAROL: 'ikki' })
  })

  test("bo'sh qiymatlar bilan fayl umuman yaratilmaydi", async () => {
    const ombor = new FaylMcpKredensialOmbori(yol)
    await ombor.saqla('a', { TOKEN: '' })
    expect(existsSync(yol)).toBe(false)
  })

  test("o'chirish faqat o'z yozuvini oladi", async () => {
    const ombor = new FaylMcpKredensialOmbori(yol)
    await ombor.saqla('a', { TOKEN: 'bir' })
    await ombor.saqla('b', { TOKEN: 'ikki' })

    await ombor.ochir('a')
    expect(await ombor.ol('a')).toEqual({})
    expect(await ombor.ol('b')).toEqual({ TOKEN: 'ikki' })
  })

  test("yo'q yozuvni o'chirish xato bermaydi", async () => {
    const ombor = new FaylMcpKredensialOmbori(yol)
    await ombor.ochir('yoq')
    expect(await ombor.ol('yoq')).toEqual({})
  })

  test('fayl faqat egasi uchun (600)', async () => {
    const ombor = new FaylMcpKredensialOmbori(yol)
    await ombor.saqla('a', { TOKEN: 'maxfiy' })

    const rejim = statSync(yol).mode & 0o777
    expect(rejim).toBe(0o600)
  })

  test('buzuq fayl bo\'sh ombor sifatida ochiladi', async () => {
    await Bun.write(yol, 'bu JSON emas {{{')
    const ombor = new FaylMcpKredensialOmbori(yol)
    expect(await ombor.ol('a')).toEqual({})

    // Ustiga yozish ishlashda davom etadi
    await ombor.saqla('a', { TOKEN: 'yangi' })
    expect(await ombor.ol('a')).toEqual({ TOKEN: 'yangi' })
  })

  test('massiv yozilgan fayl ham bo\'sh ombor', async () => {
    await Bun.write(yol, '[1,2,3]')
    const ombor = new FaylMcpKredensialOmbori(yol)
    expect(await ombor.ol('a')).toEqual({})
  })

  test('parallel saqlash navbatda bajariladi — yozuv yo\'qolmaydi', async () => {
    const ombor = new FaylMcpKredensialOmbori(yol)
    // Navbat bo'lmasa bu yozuvlar bir-birini bosib ketardi:
    // ikkalasi ham eski faylni o'qib, ustiga o'z nusxasini yozardi.
    await Promise.all([
      ombor.saqla('a', { TOKEN: 'bir' }),
      ombor.saqla('b', { TOKEN: 'ikki' }),
      ombor.saqla('c', { TOKEN: 'uch' }),
    ])

    expect(await ombor.ol('a')).toEqual({ TOKEN: 'bir' })
    expect(await ombor.ol('b')).toEqual({ TOKEN: 'ikki' })
    expect(await ombor.ol('c')).toEqual({ TOKEN: 'uch' })
  })
})

describe('XotiraMcpKredensialOmbori', () => {
  test('fayl omboriga mos xulq', async () => {
    const ombor = new XotiraMcpKredensialOmbori()
    await ombor.saqla('a', { TOKEN: 'bir' })
    expect(await ombor.ol('a')).toEqual({ TOKEN: 'bir' })

    await ombor.saqla('a', { TOKEN: '' })
    expect(await ombor.ol('a')).toEqual({ TOKEN: 'bir' })

    await ombor.ochir('a')
    expect(await ombor.ol('a')).toEqual({})
  })

  test("qaytarilgan obyekt nusxа — tashqi o'zgarish saqlanmaydi", async () => {
    const ombor = new XotiraMcpKredensialOmbori()
    await ombor.saqla('a', { TOKEN: 'bir' })

    const olingan = await ombor.ol('a')
    olingan.TOKEN = 'buzildi'
    expect(await ombor.ol('a')).toEqual({ TOKEN: 'bir' })
  })
})

describe('global ombor', () => {
  test('almashtirilgan ombor qaytariladi', async () => {
    const soxta = new XotiraMcpKredensialOmbori()
    mcpKredensialOmboriniOrnat(soxta)
    expect(mcpKredensialOmbori()).toBe(soxta)

    mcpKredensialOmboriniOrnat(null)
    expect(mcpKredensialOmbori()).not.toBe(soxta)
  })
})
