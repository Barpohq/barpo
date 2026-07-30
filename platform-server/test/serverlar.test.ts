// Serverlar API oqimi — qo'shish (kalit joylash bilan), o'chirish, metrika.
// SSH buyruqlar soxta bajaruvchi orqali, fayllar vaqtinchalik papkada.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { Server, ServerMetrika } from '@platforma/shared'
import { app } from '../src/app.ts'
import { bazaOch, dbOrnat } from '../src/db.ts'
import { serverlarOqi } from '../src/repo.ts'
import { bajaruvchiOrnat, boshqarilganConfigYoli, type BuyruqNatija } from '../src/ssh.ts'
import { hub } from '../src/ws/hub.ts'

let db: Database
let papka: string
let chaqiruvlar: string[][]

const OK: BuyruqNatija = { kod: 0, stdout: '', stderr: '' }
const RAD: BuyruqNatija = { kod: 255, stdout: '', stderr: 'Permission denied (publickey).' }

/** Standart soxta bajaruvchi: hamma ssh chaqiruvi muvaffaqiyatli */
function soxta(javob: (argv: string[]) => BuyruqNatija = () => OK) {
  bajaruvchiOrnat(async (argv) => {
    chaqiruvlar.push(argv)
    return javob(argv)
  })
}

beforeEach(() => {
  db = bazaOch(':memory:')
  dbOrnat(db)
  papka = mkdtempSync(join(tmpdir(), 'platforma-srv-'))
  process.env.PLATFORMA_SSH = join(papka, 'ssh')
  process.env.PLATFORMA_USER_SSH_CONFIG = join(papka, 'user-config')
  mkdirSync(join(papka, 'ssh'), { recursive: true })
  writeFileSync(join(papka, 'ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAATEST platforma\n')
  chaqiruvlar = []
  soxta()
})

afterEach(() => {
  bajaruvchiOrnat(null)
  delete process.env.PLATFORMA_SSH
  delete process.env.PLATFORMA_USER_SSH_CONFIG
  rmSync(papka, { recursive: true, force: true })
  dbOrnat(null)
  hub.tozala()
  db.close()
})

async function post(yol: string, tana: unknown) {
  const javob = await app.request(yol, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tana),
  })
  return { status: javob.status, body: (await javob.json()) as Record<string, unknown> }
}

describe('POST /api/servers', () => {
  test("to'liq oqim: kalit joylanadi, baza va config yoziladi", async () => {
    const { status, body } = await post('/api/servers', {
      name: 'sinov-1',
      host: '203.0.113.10',
      port: 22,
      username: 'root',
    })

    expect(status).toBe(201)
    const server = body.server as Server
    expect(server.name).toBe('sinov-1')
    expect(body.ulanishXatosi).toBeUndefined()

    // Baza
    expect(serverlarOqi(db)).toHaveLength(1)

    // Boshqariladigan config va Include
    const config = readFileSync(boshqarilganConfigYoli(), 'utf-8')
    expect(config).toContain('Host sinov-1')
    expect(config).toContain('HostName 203.0.113.10')
    const userConfig = readFileSync(join(papka, 'user-config'), 'utf-8')
    expect(userConfig).toContain(`Include ${boshqarilganConfigYoli()}`)
  })

  test('port berilmasa 22, username berilmasa root', async () => {
    const { status, body } = await post('/api/servers', { name: 's2', host: 'ex.uz' })
    expect(status).toBe(201)
    const server = body.server as Server
    expect(server.port).toBe(22)
    expect(server.username).toBe('root')
  })

  test("noto'g'ri nom 400 — config va bazaga hech narsa tushmaydi", async () => {
    const { status } = await post('/api/servers', { name: 'xato nom!', host: 'ex.uz' })
    expect(status).toBe(400)
    expect(serverlarOqi(db)).toHaveLength(0)
    expect(chaqiruvlar).toHaveLength(0)
  })

  test("noto'g'ri port 400", async () => {
    const { status } = await post('/api/servers', { name: 's', host: 'ex.uz', port: 99999 })
    expect(status).toBe(400)
  })

  test('takror nom 409', async () => {
    await post('/api/servers', { name: 'takror', host: 'ex.uz' })
    const { status } = await post('/api/servers', { name: 'takror', host: 'boshqa.uz' })
    expect(status).toBe(409)
    expect(serverlarOqi(db)).toHaveLength(1)
  })

  test("ulanib bo'lmasa 502 va bazada yozuv QOLMAYDI", async () => {
    soxta(() => RAD)
    const { status, body } = await post('/api/servers', { name: 'olis', host: 'olis.uz' })
    expect(status).toBe(502)
    expect(String(body.detail)).toContain('Enter a password')
    expect(serverlarOqi(db)).toHaveLength(0)
  })
})

describe('DELETE /api/servers/:id', () => {
  test("o'chiradi va config'dan olib tashlaydi", async () => {
    const { body } = await post('/api/servers', { name: 'ketuvchi', host: 'ex.uz' })
    const server = body.server as Server

    const javob = await app.request(`/api/servers/${server.id}`, { method: 'DELETE' })
    expect(javob.status).toBe(200)

    expect(serverlarOqi(db)).toHaveLength(0)
    const config = readFileSync(boshqarilganConfigYoli(), 'utf-8')
    expect(config).not.toContain('Host ketuvchi')
  })

  test("yo'q id 404", async () => {
    const javob = await app.request('/api/servers/yoq-id', { method: 'DELETE' })
    expect(javob.status).toBe(404)
  })
})

describe('GET /api/servers/:id/metrika', () => {
  test('jonli metrika qaytaradi', async () => {
    const { body } = await post('/api/servers', { name: 'metrik', host: 'ex.uz' })
    const server = body.server as Server

    soxta((argv) =>
      argv[0] === 'ssh'
        ? { kod: 0, stdout: 'UPTIME=up 2 hours\nLOAD=0.5\nNPROC=2\nRAM=100 25\nDISK=200 100\n', stderr: '' }
        : OK,
    )

    const javob = await app.request(`/api/servers/${server.id}/metrika`)
    expect(javob.status).toBe(200)
    const { metrika } = (await javob.json()) as { metrika: ServerMetrika }
    expect(metrika.holat).toBe('ulangan')
    expect(metrika.uptime).toBe('2 soat')
    expect(metrika.cpu).toBe(25)
    expect(metrika.ram).toBe(25)
    expect(metrika.disk).toBe(50)
  })

  test("ulanib bo'lmasa holat=xato, HTTP baribir 200", async () => {
    const { body } = await post('/api/servers', { name: 'uzik', host: 'ex.uz' })
    const server = body.server as Server

    soxta(() => ({ kod: 255, stdout: '', stderr: 'Connection timed out' }))

    const javob = await app.request(`/api/servers/${server.id}/metrika`)
    expect(javob.status).toBe(200)
    const { metrika } = (await javob.json()) as { metrika: ServerMetrika }
    expect(metrika.holat).toBe('xato')
    expect(metrika.xato).toContain('timed out')
  })

  test("yo'q id 404", async () => {
    const javob = await app.request('/api/servers/yoq/metrika')
    expect(javob.status).toBe(404)
  })
})
