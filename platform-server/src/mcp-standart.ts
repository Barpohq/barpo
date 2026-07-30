// Platforma bilan birga keladigan standart MCP serverlar.
//
// `standart-skilllar.ts` bilan BIR XIL naqsh va bir xil sabab: standart
// to'plam ham oddiy katalog yozuvi bo'lib o'tadi, faqat MANBASI boshqa —
// GitHub emas, repo ichidagi `mcp-serverlar/` papkasi. Katalog, o'rnatish
// va UI oqimlari manba turini bilmaydi.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ HOZIRCHA BO'SH — bu ATAYLAB.                                         │
// │                                                                      │
// │ Infratuzilma quriladi, mazmun keyin to'ldiriladi: "qaysi MCP server  │
// │ platforma tavsiyasi" degan savol mahsulot qarori, texnik emas.        │
// │                                                                      │
// │ Papka bo'sh bo'lsa `standartMcpManbaniTaminla()` `null` qaytaradi va  │
// │ katalogda hech narsa paydo bo'lmaydi. Birinchi `server.json`          │
// │ qo'shilgan kunda esa u avtomatik ko'rinadi — hech qanday kod          │
// │ o'zgartirish kerak emas.                                             │
// └──────────────────────────────────────────────────────────────────────┘
//
// SKILLLARDAN FARQI: ombor qatlami YO'Q. Skill o'rnatilganda fayl diskka
// ko'chadi; MCP serverda ko'chadigan fayl yo'q — `server.json` faqat
// metadata bo'lib bazaga tushadi va jarayon o'z paketini `npx`/`uvx` bilan
// o'zi oladi. Shu sabab `standartniOmborga()` ga o'xshash funksiya kerak emas.

import type { McpKatalogYozuvi } from '@platforma/shared'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { registryYozuvniAylantir, type RegistryServerYozuvi } from './mcp-registry.ts'

/**
 * Manba yozuvining `manbaNomi` qiymati.
 *
 * `mcpManbaYarat` takrorlanishni `(tur, manba_nomi, ref)` bo'yicha
 * aniqlaydi, shuning uchun bu qiymat BARQAROR bo'lishi shart — aks holda
 * har ishga tushishda yangi manba yaratilardi.
 */
export const STANDART_MCP_MANBA = 'platforma-standart'

/**
 * Standart MCP serverlar turadigan papka (repo ichida).
 *
 * `platform-server/src/...` → ikki qavat yuqori → monorepo ildizi.
 * `skills/` papkasi bilan yonma-yon turadi.
 */
export function standartMcpPapkasi(): string {
  return join(dirname(dirname(import.meta.dir)), 'mcp-serverlar')
}

export interface StandartMcpSkanerNatija {
  serverlar: Omit<McpKatalogYozuvi, 'id' | 'manbaId' | 'createdAt'>[]
  ogohlantirishlar: string[]
}

/**
 * Lokal `mcp-serverlar/` papkasini skanerlaydi.
 *
 * Har papkada bitta `server.json` kutiladi (rasmiy publish formati) —
 * `mcp-github.ts` va registry bilan AYNI sxema, shuning uchun
 * `registryYozuvniAylantir()` qayta ishlatiladi.
 *
 * XATO TASHLAMAYDI: papka yo'q yoki fayl buzuq bo'lsa bo'sh ro'yxat
 * qaytadi. Standart to'plamsiz ham platforma to'liq ishlaydi.
 */
export function standartMcplarniSkanerla(): StandartMcpSkanerNatija {
  const ildiz = standartMcpPapkasi()
  const ogohlantirishlar: string[] = []
  const serverlar: StandartMcpSkanerNatija['serverlar'] = []

  let papkalar: string[]
  try {
    papkalar = readdirSync(ildiz)
  } catch {
    // Papka hali yaratilmagan — normal holat
    return { serverlar, ogohlantirishlar }
  }

  for (const papka of papkalar.sort()) {
    const serverJson = join(ildiz, papka, 'server.json')
    try {
      if (!statSync(join(ildiz, papka)).isDirectory() || !existsSync(serverJson)) continue
    } catch {
      continue
    }

    let xom: string
    try {
      xom = readFileSync(serverJson, 'utf8')
    } catch {
      // Bitta fayl o'qilmasa qolganini yo'qotmaymiz
      continue
    }

    let malumot: RegistryServerYozuvi
    try {
      malumot = JSON.parse(xom) as RegistryServerYozuvi
    } catch {
      ogohlantirishlar.push(`${papka}: server.json JSON emas`)
      continue
    }

    const yozuv = registryYozuvniAylantir(malumot)
    if (!yozuv) {
      ogohlantirishlar.push(`${papka}: ishga tushirish usuli aniqlanmadi`)
      continue
    }

    serverlar.push(yozuv)
  }

  return { serverlar, ogohlantirishlar }
}

/**
 * Standart MCP manbasini katalogga yozadi/yangilaydi.
 *
 * HAR ISHGA TUSHISHDA chaqiriladi (`standartManbaniTaminla` bilan bir xil
 * sabab: platforma yangilanganda to'plam ham yangilanadi). Amal idempotent —
 * `mcpManbaYarat` manbani nom bo'yicha topadi, `mcpServerlarniSinxronla`
 * esa UPSERT qiladi va MAVJUD O'RNATISHLARNI saqlaydi.
 *
 * Bo'sh to'plam uchun `null` — bu ATAYLAB: bo'sh manba yozuvi katalogda
 * paydo bo'lib, UI'da hech narsa ko'rsatmaydigan bo'sh guruh yaratardi.
 *
 * XATO TASHLAMAYDI: katalogga yozib bo'lmasa platforma baribir ishga tushadi.
 */
export function standartMcpManbaniTaminla(
  manbaYarat: (m: {
    tur: 'standart'
    manbaNomi: string
    owner: null
    repo: null
    ref: string
  }) => { id: string },
  serverlarniSinxronla: (
    manbaId: string,
    topilgan: Omit<McpKatalogYozuvi, 'id' | 'manbaId' | 'createdAt'>[],
  ) => unknown,
): { manbaId: string; soni: number } | null {
  try {
    const skaner = standartMcplarniSkanerla()
    if (skaner.serverlar.length === 0) return null

    const manba = manbaYarat({
      tur: 'standart',
      manbaNomi: STANDART_MCP_MANBA,
      owner: null,
      repo: null,
      ref: '',
    })

    serverlarniSinxronla(manba.id, skaner.serverlar)

    return { manbaId: manba.id, soni: skaner.serverlar.length }
  } catch {
    return null
  }
}
