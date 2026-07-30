// Bazadagi yozuvni ulanish sozlamasiga aylantirish.
//
// ENG MUHIM TEKSHIRUVLAR:
//   1) maxfiy qiymatlar KREDENSIAL OMBORIDAN qo'shiladi (bazadan emas);
//   2) loyiha o'rnatishi global'dan USTUN turadi;
//   3) o'rin egallovchilar ({token}) almashtiriladi;
//   4) SXEMADA E'LON QILINMAGAN kalitlar env'ga TUSHMAYDI.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { McpServer } from '@platforma/shared'
import { bazaOch, dbOrnat } from '../src/db.ts'
import {
  mcpKredensialOmboriniOrnat,
  XotiraMcpKredensialOmbori,
} from '../src/mcp-kredensial.ts'
import { mcpSozlamaQur, ornatishniTanla, ulanadiganServerlar } from '../src/mcp-ulash.ts'
import {
  loyihaYarat,
  mcpManbaYarat,
  mcpServerlarniSinxronla,
  mcpServerlarOqi,
  mcpServerOqi,
  mcpServerOrnat,
} from '../src/repo.ts'

let db: Database
let ombor: XotiraMcpKredensialOmbori

beforeEach(() => {
  db = bazaOch(':memory:')
  dbOrnat(db)
  ombor = new XotiraMcpKredensialOmbori()
  mcpKredensialOmboriniOrnat(ombor)
})

afterEach(() => {
  mcpKredensialOmboriniOrnat(null)
  dbOrnat(null)
  db.close()
})

/** stdio server yaratadi (sozlama sxemasi bilan) */
function serverYarat(
  nom = 'github',
  qoshimcha: Partial<Parameters<typeof mcpServerlarniSinxronla>[1][number]> = {},
): McpServer {
  const manba = mcpManbaYarat({
    tur: 'qolda',
    manbaNomi: nom,
    owner: null,
    repo: null,
    ref: '',
  })
  mcpServerlarniSinxronla(manba.id, [
    {
      nom,
      tavsif: '',
      transport: 'stdio',
      buyruq: 'npx',
      argumentlar: ['-y', '@example/srv'],
      sozlamalar: [],
      ...qoshimcha,
    },
  ])
  const server = mcpServerlarOqi().find((s) => s.nom === nom)
  if (!server) throw new Error('server yaratilmadi')
  return server
}

describe('ornatishniTanla', () => {
  test("o'rnatilmagan server uchun undefined", () => {
    const server = serverYarat()
    expect(ornatishniTanla(server, null)).toBeUndefined()
  })

  test('loyihasiz sessiya global o\'rnatishni oladi', () => {
    const server = serverYarat()
    mcpServerOrnat(server.id, 'global', null, {})
    const yangi = mcpServerOqi(server.id)!

    expect(ornatishniTanla(yangi, null)?.qamrov).toBe('global')
  })

  test('LOYIHA o\'rnatishi global\'dan USTUN', () => {
    const server = serverYarat()
    const loyiha = loyihaYarat('test', '/tmp/l1')
    mcpServerOrnat(server.id, 'global', null, { BASE_URL: 'global-url' })
    mcpServerOrnat(server.id, 'loyiha', loyiha.id, { BASE_URL: 'loyiha-url' })
    const yangi = mcpServerOqi(server.id)!

    const tanlangan = ornatishniTanla(yangi, loyiha.id)
    expect(tanlangan?.qamrov).toBe('loyiha')
    expect(tanlangan?.sozlamaQiymatlari).toEqual({ BASE_URL: 'loyiha-url' })
  })

  test('boshqa loyiha uchun global qaytadi', () => {
    const server = serverYarat()
    const l1 = loyihaYarat('bir', '/tmp/l1')
    const l2 = loyihaYarat('ikki', '/tmp/l2')
    mcpServerOrnat(server.id, 'global', null, {})
    mcpServerOrnat(server.id, 'loyiha', l1.id, {})
    const yangi = mcpServerOqi(server.id)!

    expect(ornatishniTanla(yangi, l2.id)?.qamrov).toBe('global')
  })
})

describe('mcpSozlamaQur — stdio', () => {
  test("o'rnatilmagan server null", async () => {
    const server = serverYarat()
    expect(await mcpSozlamaQur(server, null)).toBeNull()
  })

  test('asosiy sozlama quriladi', async () => {
    const server = serverYarat()
    mcpServerOrnat(server.id, 'global', null, {})
    const yangi = mcpServerOqi(server.id)!

    const sozlama = await mcpSozlamaQur(yangi, null)
    expect(sozlama).toEqual({
      id: server.id,
      nom: 'github',
      sozlama: {
        transport: 'stdio',
        buyruq: 'npx',
        argumentlar: ['-y', '@example/srv'],
        env: {},
      },
    })
  })

  test('MAXFIY qiymat kredensial omboridan env ga qo\'shiladi', async () => {
    const server = serverYarat('github', {
      sozlamalar: [{ nom: 'GITHUB_TOKEN', majburiy: true, maxfiy: true }],
    })
    const ornatishId = mcpServerOrnat(server.id, 'global', null, {})
    await ombor.saqla(ornatishId, { GITHUB_TOKEN: 'ghp_maxfiy' })
    const yangi = mcpServerOqi(server.id)!

    const sozlama = await mcpSozlamaQur(yangi, null)
    expect(sozlama?.sozlama.env).toEqual({ GITHUB_TOKEN: 'ghp_maxfiy' })
  })

  test('OCHIQ va MAXFIY qiymatlar birlashadi', async () => {
    const server = serverYarat('srv', {
      sozlamalar: [
        { nom: 'BASE_URL', majburiy: false, maxfiy: false },
        { nom: 'TOKEN', majburiy: true, maxfiy: true },
      ],
    })
    const ornatishId = mcpServerOrnat(server.id, 'global', null, { BASE_URL: 'https://a.b' })
    await ombor.saqla(ornatishId, { TOKEN: 'maxfiy' })
    const yangi = mcpServerOqi(server.id)!

    const sozlama = await mcpSozlamaQur(yangi, null)
    expect(sozlama?.sozlama.env).toEqual({ BASE_URL: 'https://a.b', TOKEN: 'maxfiy' })
  })

  test('standart qiymat eng past ustuvorlikda', async () => {
    const server = serverYarat('srv', {
      sozlamalar: [{ nom: 'REJIM', majburiy: false, maxfiy: false, standart: 'oddiy' }],
    })
    mcpServerOrnat(server.id, 'global', null, {})
    let yangi = mcpServerOqi(server.id)!
    expect((await mcpSozlamaQur(yangi, null))?.sozlama.env).toEqual({ REJIM: 'oddiy' })

    // Foydalanuvchi kiritsa u ustun turadi
    mcpServerOrnat(server.id, 'global', null, { REJIM: 'tez' })
    yangi = mcpServerOqi(server.id)!
    expect((await mcpSozlamaQur(yangi, null))?.sozlama.env).toEqual({ REJIM: 'tez' })
  })

  test('SXEMADA YO\'Q kalit env ga TUSHMAYDI', async () => {
    const server = serverYarat('srv', {
      sozlamalar: [{ nom: 'RUXSAT_ETILGAN', majburiy: false, maxfiy: false }],
    })
    // Bazaga qo'lda ortiqcha kalit yozilgan bo'lsa ham (masalan eski
    // sxemadan qolgan) u jarayonga uzatilmasligi kerak
    mcpServerOrnat(server.id, 'global', null, {
      RUXSAT_ETILGAN: 'ha',
      PATH: '/buzuq',
      LD_PRELOAD: '/xavfli.so',
    })
    const yangi = mcpServerOqi(server.id)!

    const env = (await mcpSozlamaQur(yangi, null))?.sozlama.env
    expect(env).toEqual({ RUXSAT_ETILGAN: 'ha' })
    expect(env).not.toHaveProperty('PATH')
    expect(env).not.toHaveProperty('LD_PRELOAD')
  })

  test('bo\'sh qiymat env ga tushmaydi', async () => {
    const server = serverYarat('srv', {
      sozlamalar: [{ nom: 'IXTIYORIY', majburiy: false, maxfiy: false }],
    })
    mcpServerOrnat(server.id, 'global', null, { IXTIYORIY: '' })
    const yangi = mcpServerOqi(server.id)!

    expect((await mcpSozlamaQur(yangi, null))?.sozlama.env).toEqual({})
  })

  test("O'RIN EGALLOVCHI argumentda almashtiriladi", async () => {
    const server = serverYarat('srv', {
      argumentlar: ['-y', '@example/srv', '--token', '{token}'],
      sozlamalar: [{ nom: 'token', majburiy: true, maxfiy: true }],
    })
    const ornatishId = mcpServerOrnat(server.id, 'global', null, {})
    await ombor.saqla(ornatishId, { token: 'sirli-qiymat' })
    const yangi = mcpServerOqi(server.id)!

    const sozlama = await mcpSozlamaQur(yangi, null)
    expect(sozlama?.sozlama.argumentlar).toEqual([
      '-y',
      '@example/srv',
      '--token',
      'sirli-qiymat',
    ])
  })

  test('buyruqsiz stdio null qaytaradi', async () => {
    // Bazada CHECK bu holatni to'sadi, lekin himoya ikki qatlamli bo'lsin
    const server = serverYarat()
    mcpServerOrnat(server.id, 'global', null, {})
    const yangi = { ...mcpServerOqi(server.id)!, buyruq: undefined }

    expect(await mcpSozlamaQur(yangi, null)).toBeNull()
  })
})

describe('mcpSozlamaQur — http', () => {
  function httpServerYarat(nom = 'masofaviy', sozlamalar: McpServer['sozlamalar'] = []) {
    const manba = mcpManbaYarat({
      tur: 'qolda',
      manbaNomi: nom,
      owner: null,
      repo: null,
      ref: '',
    })
    mcpServerlarniSinxronla(manba.id, [
      {
        nom,
        tavsif: '',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        sozlamalar,
      },
    ])
    return mcpServerlarOqi().find((s) => s.nom === nom)!
  }

  test('url va sarlavhalar quriladi', async () => {
    const server = httpServerYarat('masofaviy', [
      { nom: 'Authorization', majburiy: true, maxfiy: true },
    ])
    const ornatishId = mcpServerOrnat(server.id, 'global', null, {})
    await ombor.saqla(ornatishId, { Authorization: 'Bearer sirli' })
    const yangi = mcpServerOqi(server.id)!

    const sozlama = await mcpSozlamaQur(yangi, null)
    expect(sozlama?.sozlama).toEqual({
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      sarlavhalar: { Authorization: 'Bearer sirli' },
    })
  })

  test('sarlavhasiz http server ham ishlaydi', async () => {
    const server = httpServerYarat()
    mcpServerOrnat(server.id, 'global', null, {})
    const yangi = mcpServerOqi(server.id)!

    expect((await mcpSozlamaQur(yangi, null))?.sozlama.sarlavhalar).toEqual({})
  })
})

describe('ulanadiganServerlar', () => {
  test("faqat o'rnatilganlar qaytadi", async () => {
    const a = serverYarat('a')
    serverYarat('b') // o'rnatilmagan
    mcpServerOrnat(a.id, 'global', null, {})

    const natija = await ulanadiganServerlar(mcpServerlarOqi(), null)
    expect(natija.map((s) => s.nom)).toEqual(['a'])
  })

  test("bo'sh ro'yxat bo'sh natija", async () => {
    expect(await ulanadiganServerlar([], null)).toEqual([])
  })

  test('loyiha bo\'yicha filtrlanadi', async () => {
    const a = serverYarat('a')
    const loyiha = loyihaYarat('test', '/tmp/l')
    mcpServerOrnat(a.id, 'loyiha', loyiha.id, {})

    // Loyihasiz sessiyada bu server global emas, ya'ni sozlama topilmaydi
    expect(await ulanadiganServerlar(mcpServerlarOqi(), null)).toEqual([])
    expect(await ulanadiganServerlar(mcpServerlarOqi(), loyiha.id)).toHaveLength(1)
  })
})
