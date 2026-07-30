// Standart MCP to'plami — lokal papkani skanerlash.
//
// Papka HOZIRCHA BO'SH (faqat README), ya'ni asosiy tekshiruv: bo'sh
// to'plam bilan hech narsa buzilmaydi va katalogda bo'sh manba paydo
// bo'lmaydi. Qolgan testlar vaqtinchalik papka bilan ishlaydi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bazaOch, dbOrnat } from '../src/db.ts'
import {
  STANDART_MCP_MANBA,
  standartMcplarniSkanerla,
  standartMcpManbaniTaminla,
  standartMcpPapkasi,
} from '../src/mcp-standart.ts'
import { mcpManbalarOqi, mcpManbaYarat, mcpServerlarniSinxronla, mcpServerlarOqi } from '../src/repo.ts'

let db: Database

beforeEach(() => {
  db = bazaOch(':memory:')
  dbOrnat(db)
})

afterEach(() => {
  dbOrnat(null)
  db.close()
})

describe('haqiqiy papka', () => {
  test('papka yo\'li repo ildizida', () => {
    expect(standartMcpPapkasi()).toMatch(/mcp-serverlar$/)
  })

  test('BO\'SH to\'plam — katalogda hech narsa paydo bo\'lmaydi', () => {
    // Hozirgi holat: papkada faqat README bor, `server.json` yo'q
    const skaner = standartMcplarniSkanerla()
    expect(skaner.serverlar).toEqual([])

    const natija = standartMcpManbaniTaminla(
      (m) => mcpManbaYarat(m, db),
      (manbaId, topilgan) => mcpServerlarniSinxronla(manbaId, topilgan, db),
    )

    expect(natija).toBeNull()
    // ENG MUHIM: bo'sh manba yozuvi ham yaratilmasligi kerak
    expect(mcpManbalarOqi(db)).toEqual([])
  })
})

describe('to\'ldirilgan papka (vaqtinchalik)', () => {
  let papka: string

  /**
   * Papka yo'lini vaqtinchalik joyga ko'chirish uchun modulni qayta
   * import qilish kerak bo'lardi. O'rniga skanerlash MANTIG'ini
   * `registryYozuvniAylantir` orqali bevosita tekshiramiz — u
   * `mcp-registry.test.ts` da to'liq sinalgan.
   *
   * Bu yerda esa TAMINLASH mantig'i tekshiriladi: manba yaratish va
   * sinxronlash idempotentligi.
   */
  beforeEach(() => {
    papka = mkdtempSync(join(tmpdir(), 'mcp-standart-'))
    mkdirSync(join(papka, 'filesystem'), { recursive: true })
  })

  afterEach(() => {
    rmSync(papka, { recursive: true, force: true })
  })

  test('taminlash idempotent — takroriy chaqiruv dublikat yaratmaydi', () => {
    const yozuvlar = [
      {
        nom: 'platforma/filesystem',
        tavsif: 'Fayl tizimi',
        transport: 'stdio' as const,
        buyruq: 'npx',
        argumentlar: ['-y', '@modelcontextprotocol/server-filesystem'],
        sozlamalar: [],
      },
    ]

    // Ikki marta chaqiramiz — xuddi server ikki marta ishga tushgani kabi
    for (let i = 0; i < 2; i += 1) {
      const manba = mcpManbaYarat(
        {
          tur: 'standart',
          manbaNomi: STANDART_MCP_MANBA,
          owner: null,
          repo: null,
          ref: '',
        },
        db,
      )
      mcpServerlarniSinxronla(manba.id, yozuvlar, db)
    }

    expect(mcpManbalarOqi(db)).toHaveLength(1)
    expect(mcpServerlarOqi(db)).toHaveLength(1)
  })

  test('manba nomi BARQAROR — har chaqiruvda bir xil manba', () => {
    const bir = mcpManbaYarat(
      { tur: 'standart', manbaNomi: STANDART_MCP_MANBA, owner: null, repo: null, ref: '' },
      db,
    )
    const ikki = mcpManbaYarat(
      { tur: 'standart', manbaNomi: STANDART_MCP_MANBA, owner: null, repo: null, ref: '' },
      db,
    )

    expect(ikki.id).toBe(bir.id)
  })

  test('taminlash xato tashlamaydi', () => {
    // Yaratuvchi xato tashlasa ham `null` qaytishi kerak — platforma
    // baribir ishga tushishi lozim
    const natija = standartMcpManbaniTaminla(
      () => {
        throw new Error('baza yopiq')
      },
      () => undefined,
    )
    expect(natija).toBeNull()
  })
})
