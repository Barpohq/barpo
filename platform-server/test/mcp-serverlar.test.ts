// MCP serverlar: baza qatlami.
//
// Tarmoq so'rovlari (registry, GitHub) SINALMAYDI — ular tashqi xizmatga
// bog'liq. Bu yerda ular kelgandan KEYINGI mantiq tekshiriladi: katalog
// UPSERT'i, qamrov, o'rnatish id'lari (kredensial kaliti shundan quriladi).
//
// `skilllar.test.ts` bilan bir xil naqsh — MCP modeli ham shu shaklda.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { McpKatalogYozuvi } from '@platforma/shared'
import { bazaOch, dbOrnat } from '../src/db.ts'
import {
  faolMcpServerlar,
  loyihaYarat,
  mcpManbaOchir,
  mcpManbalarOqi,
  mcpManbaYarat,
  mcpServerlarniSinxronla,
  mcpServerlarOqi,
  mcpServerOqi,
  mcpServerOrnat,
  mcpServerOrnatishniOchir,
} from '../src/repo.ts'

let db: Database

beforeEach(() => {
  db = bazaOch(':memory:')
  dbOrnat(db)
})

afterEach(() => {
  dbOrnat(null)
  db.close()
})

type XomYozuv = Omit<McpKatalogYozuvi, 'id' | 'manbaId' | 'createdAt'>

/** stdio server yozuvi — testlarda eng ko'p ishlatiladigan shakl */
function stdioYozuv(nom = 'github', qoshimcha: Partial<XomYozuv> = {}): XomYozuv {
  return {
    nom,
    tavsif: `${nom} vositalari`,
    transport: 'stdio',
    buyruq: 'npx',
    argumentlar: ['-y', `@example/${nom}`],
    sozlamalar: [],
    ...qoshimcha,
  }
}

/** Manba + bitta server yaratadi, server id'sini qaytaradi */
function manbaVaServer(nom = 'github') {
  const manba = mcpManbaYarat({
    tur: 'qolda',
    manbaNomi: nom,
    owner: null,
    repo: null,
    ref: '',
  })
  mcpServerlarniSinxronla(manba.id, [stdioYozuv(nom)])
  const server = mcpServerlarOqi().find((s) => s.nom === nom)
  if (!server) throw new Error('server yaratilmadi')
  return { manba, server }
}

describe('manbalar', () => {
  test('takroriy ulash mavjudini qaytaradi', () => {
    const a = mcpManbaYarat({ tur: 'github', manbaNomi: 'o/r', owner: 'o', repo: 'r', ref: '' })
    const b = mcpManbaYarat({ tur: 'github', manbaNomi: 'o/r', owner: 'o', repo: 'r', ref: '' })
    expect(b.id).toBe(a.id)
    expect(mcpManbalarOqi()).toHaveLength(1)
  })

  test('turi boshqa bo\'lsa alohida manba', () => {
    mcpManbaYarat({ tur: 'github', manbaNomi: 'x', owner: 'o', repo: 'r', ref: '' })
    mcpManbaYarat({ tur: 'qolda', manbaNomi: 'x', owner: null, repo: null, ref: '' })
    expect(mcpManbalarOqi()).toHaveLength(2)
  })

  test('ref boshqa bo\'lsa alohida manba', () => {
    mcpManbaYarat({ tur: 'github', manbaNomi: 'o/r', owner: 'o', repo: 'r', ref: '' })
    mcpManbaYarat({ tur: 'github', manbaNomi: 'o/r', owner: 'o', repo: 'r', ref: 'dev' })
    expect(mcpManbalarOqi()).toHaveLength(2)
  })

  test("manba o'chsa serverlari ham ketadi (CASCADE)", () => {
    const { manba } = manbaVaServer()
    expect(mcpServerlarOqi()).toHaveLength(1)
    expect(mcpManbaOchir(manba.id)).toBe(true)
    expect(mcpServerlarOqi()).toHaveLength(0)
  })
})

describe('sinxronlash', () => {
  test('qo\'shildi / yangilandi / o\'chirildi hisoblanadi', () => {
    const manba = mcpManbaYarat({
      tur: 'github',
      manbaNomi: 'o/r',
      owner: 'o',
      repo: 'r',
      ref: '',
    })

    const birinchi = mcpServerlarniSinxronla(manba.id, [stdioYozuv('a'), stdioYozuv('b')])
    expect(birinchi).toEqual({ qoshildi: 2, yangilandi: 0, ochirildi: 0 })

    // 'a' qoldi (yangilandi), 'b' yo'qoldi, 'c' qo'shildi
    const ikkinchi = mcpServerlarniSinxronla(manba.id, [stdioYozuv('a'), stdioYozuv('c')])
    expect(ikkinchi).toEqual({ qoshildi: 1, yangilandi: 1, ochirildi: 1 })
    expect(mcpServerlarOqi().map((s) => s.nom)).toEqual(['a', 'c'])
  })

  test("UPSERT id'ni saqlaydi — o'rnatish yo'qolmaydi", () => {
    const { manba, server } = manbaVaServer()
    mcpServerOrnat(server.id, 'global', null, {})

    // Tavsif o'zgargan holda qayta sinxronlash
    mcpServerlarniSinxronla(manba.id, [stdioYozuv('github', { tavsif: 'yangi tavsif' })])

    const keyin = mcpServerOqi(server.id)
    expect(keyin?.id).toBe(server.id)
    expect(keyin?.tavsif).toBe('yangi tavsif')
    expect(keyin?.ornatilgan).toHaveLength(1)
  })

  test('oxirgi sinxron vaqti yoziladi', () => {
    const { manba } = manbaVaServer()
    const yangilangan = mcpManbalarOqi().find((m) => m.id === manba.id)
    expect(yangilangan?.oxirgiSinxron).toBeTruthy()
  })

  test('argumentlar va sozlamalar JSON bo\'lib aylanib keladi', () => {
    const manba = mcpManbaYarat({ tur: 'qolda', manbaNomi: 'x', owner: null, repo: null, ref: '' })
    mcpServerlarniSinxronla(manba.id, [
      stdioYozuv('x', {
        argumentlar: ['-y', '@a/b', '--flag'],
        sozlamalar: [
          { nom: 'TOKEN', majburiy: true, maxfiy: true, izoh: 'kirish tokeni' },
          { nom: 'BASE_URL', majburiy: false, maxfiy: false, standart: 'https://a.b' },
        ],
      }),
    ])

    const server = mcpServerlarOqi()[0]
    expect(server?.argumentlar).toEqual(['-y', '@a/b', '--flag'])
    expect(server?.sozlamalar).toHaveLength(2)
    expect(server?.sozlamalar[0]).toMatchObject({ nom: 'TOKEN', maxfiy: true, majburiy: true })
  })

  test('http transport url bilan saqlanadi', () => {
    const manba = mcpManbaYarat({ tur: 'qolda', manbaNomi: 'h', owner: null, repo: null, ref: '' })
    mcpServerlarniSinxronla(manba.id, [
      {
        nom: 'masofaviy',
        tavsif: '',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        sozlamalar: [],
      },
    ])
    const server = mcpServerlarOqi()[0]
    expect(server?.transport).toBe('http')
    expect(server?.url).toBe('https://mcp.example.com/mcp')
    expect(server?.buyruq).toBeUndefined()
  })

  test('stdio buyruqsiz bazaga tushmaydi (CHECK)', () => {
    const manba = mcpManbaYarat({ tur: 'qolda', manbaNomi: 'b', owner: null, repo: null, ref: '' })
    expect(() =>
      mcpServerlarniSinxronla(manba.id, [
        { nom: 'buzuq', tavsif: '', transport: 'stdio', sozlamalar: [] },
      ]),
    ).toThrow()
  })

  test('http url\'siz bazaga tushmaydi (CHECK)', () => {
    const manba = mcpManbaYarat({ tur: 'qolda', manbaNomi: 'b', owner: null, repo: null, ref: '' })
    expect(() =>
      mcpServerlarniSinxronla(manba.id, [
        { nom: 'buzuq', tavsif: '', transport: 'http', sozlamalar: [] },
      ]),
    ).toThrow()
  })
})

describe("o'rnatish", () => {
  test('global o\'rnatish id qaytaradi va takrorlanmaydi', () => {
    const { server } = manbaVaServer()
    const id1 = mcpServerOrnat(server.id, 'global', null, {})
    const id2 = mcpServerOrnat(server.id, 'global', null, {})
    expect(id2).toBe(id1)
    expect(mcpServerOqi(server.id)?.ornatilgan).toHaveLength(1)
  })

  test('qayta o\'rnatish sozlama qiymatlarini yangilaydi', () => {
    const { server } = manbaVaServer()
    const id = mcpServerOrnat(server.id, 'global', null, { BASE_URL: 'https://a' })
    const yangiId = mcpServerOrnat(server.id, 'global', null, { BASE_URL: 'https://b' })

    expect(yangiId).toBe(id)
    const ornatish = mcpServerOqi(server.id)?.ornatilgan[0]
    expect(ornatish?.sozlamaQiymatlari).toEqual({ BASE_URL: 'https://b' })
  })

  test('bir server global va loyihada alohida o\'rnatiladi', () => {
    const { server } = manbaVaServer()
    const loyiha = loyihaYarat('test', '/tmp/test-loyiha')

    const globalId = mcpServerOrnat(server.id, 'global', null, {})
    const loyihaId = mcpServerOrnat(server.id, 'loyiha', loyiha.id, { BASE_URL: 'https://l' })

    expect(loyihaId).not.toBe(globalId)
    expect(mcpServerOqi(server.id)?.ornatilgan).toHaveLength(2)
  })

  test("o'rnatishni bekor qilish id qaytaradi", () => {
    const { server } = manbaVaServer()
    const id = mcpServerOrnat(server.id, 'global', null, {})

    expect(mcpServerOrnatishniOchir(server.id, 'global', null)).toBe(id)
    expect(mcpServerOrnatishniOchir(server.id, 'global', null)).toBeNull()
    expect(mcpServerOqi(server.id)?.ornatilgan).toHaveLength(0)
  })
})

describe('faolMcpServerlar', () => {
  test('faqat global — loyihasiz sessiya', () => {
    const { server } = manbaVaServer('a')
    const { server: b } = manbaVaServer('b')
    mcpServerOrnat(server.id, 'global', null, {})

    const faol = faolMcpServerlar(null)
    expect(faol.map((s) => s.nom)).toEqual(['a'])
    expect(faol.find((s) => s.id === b.id)).toBeUndefined()
  })

  test('global + loyiha birlashadi, takrorlanmaydi', () => {
    const { server: a } = manbaVaServer('a')
    const { server: b } = manbaVaServer('b')
    const loyiha = loyihaYarat('test', '/tmp/test-loyiha-2')

    mcpServerOrnat(a.id, 'global', null, {})
    // `a` ikki joyda ham o'rnatilgan — ro'yxatda BIR MARTA chiqishi kerak
    mcpServerOrnat(a.id, 'loyiha', loyiha.id, {})
    mcpServerOrnat(b.id, 'loyiha', loyiha.id, {})

    const faol = faolMcpServerlar(loyiha.id)
    expect(faol.map((s) => s.nom)).toEqual(['a', 'b'])
  })

  test('boshqa loyihaning serveri kirmaydi', () => {
    const { server } = manbaVaServer('a')
    const l1 = loyihaYarat('bir', '/tmp/l1')
    const l2 = loyihaYarat('ikki', '/tmp/l2')
    mcpServerOrnat(server.id, 'loyiha', l1.id, {})

    expect(faolMcpServerlar(l2.id)).toHaveLength(0)
    expect(faolMcpServerlar(l1.id)).toHaveLength(1)
  })

  test("o'rnatilmagan server faol emas", () => {
    manbaVaServer('a')
    expect(faolMcpServerlar(null)).toHaveLength(0)
    expect(mcpServerlarOqi()).toHaveLength(1)
  })
})
