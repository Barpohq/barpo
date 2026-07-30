// ssh.ts — tarmoqsiz testlar: buyruq bajaruvchi soxta, fayl yo'llari
// vaqtinchalik papkada (PLATFORMA_SSH / PLATFORMA_USER_SSH_CONFIG).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from '@platforma/shared'
import {
  bajaruvchiOrnat,
  boshqarilganConfigYoli,
  boshqarilganConfigYoz,
  includeTaminla,
  kalitJoyla,
  metrikaTahlil,
  type BuyruqNatija,
} from '../src/ssh.ts'

let papka: string

/** Soxta bajaruvchi chaqiruvlari — har test tekshiradi */
let chaqiruvlar: { argv: string[]; env?: Record<string, string>; stdin?: string }[]

function soxtaBajaruvchi(javob: (argv: string[]) => BuyruqNatija) {
  bajaruvchiOrnat(async (argv, imkoniyat) => {
    chaqiruvlar.push({ argv, env: imkoniyat?.env, stdin: imkoniyat?.stdin })
    return javob(argv)
  })
}

const OK: BuyruqNatija = { kod: 0, stdout: '', stderr: '' }
const RAD: BuyruqNatija = { kod: 255, stdout: '', stderr: 'Permission denied (publickey).' }

beforeEach(() => {
  papka = mkdtempSync(join(tmpdir(), 'platforma-ssh-'))
  process.env.PLATFORMA_SSH = join(papka, 'ssh')
  process.env.PLATFORMA_USER_SSH_CONFIG = join(papka, 'user-config')
  chaqiruvlar = []
  // Ochiq kalit oldindan yoziladi — ssh-keygen chaqirilmasin
  mkdirSync(join(papka, 'ssh'), { recursive: true })
  writeFileSync(join(papka, 'ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAATEST platforma\n')
})

afterEach(() => {
  bajaruvchiOrnat(null)
  delete process.env.PLATFORMA_SSH
  delete process.env.PLATFORMA_USER_SSH_CONFIG
  rmSync(papka, { recursive: true, force: true })
})

function server(qisman: Partial<Server> = {}): Server {
  return {
    id: 'x',
    name: 'sinov-1',
    host: '203.0.113.10',
    port: 22,
    username: 'root',
    createdAt: '2026-07-29T00:00:00.000Z',
    ...qisman,
  }
}

describe('boshqarilganConfigYoz', () => {
  test('har server uchun Host bloki yozadi', () => {
    boshqarilganConfigYoz([server(), server({ id: 'y', name: 'ikkinchi', host: 'ex.uz', port: 2222, username: 'deploy' })])

    const matn = readFileSync(boshqarilganConfigYoli(), 'utf-8')
    expect(matn).toContain('Host sinov-1')
    expect(matn).toContain('HostName 203.0.113.10')
    expect(matn).toContain('Host ikkinchi')
    expect(matn).toContain('Port 2222')
    expect(matn).toContain('User deploy')
    expect(matn).toContain('IdentitiesOnly yes')
    expect(matn).toContain('StrictHostKeyChecking accept-new')
  })

  test("bo'sh ro'yxatda ham fayl yoziladi (o'chirilgan server chiqib ketadi)", () => {
    boshqarilganConfigYoz([server()])
    boshqarilganConfigYoz([])
    const matn = readFileSync(boshqarilganConfigYoli(), 'utf-8')
    expect(matn).not.toContain('Host sinov-1')
  })
})

describe('includeTaminla', () => {
  test("yo'q faylga Include yozadi", () => {
    includeTaminla()
    const matn = readFileSync(join(papka, 'user-config'), 'utf-8')
    expect(matn).toContain(`Include ${boshqarilganConfigYoli()}`)
  })

  test('mavjud tarkib saqlanadi va Include BOSHIDA turadi', () => {
    writeFileSync(join(papka, 'user-config'), 'Host eski\n  HostName eski.uz\n')
    includeTaminla()
    const matn = readFileSync(join(papka, 'user-config'), 'utf-8')
    expect(matn).toContain('Host eski')
    // Include birinchi Host'dan OLDIN — aks holda o'sha blokga tegishli bo'lib qoladi
    expect(matn.indexOf('Include')).toBeLessThan(matn.indexOf('Host eski'))
  })

  test('ikkinchi chaqiruv takror qator yozmaydi (idempotent)', () => {
    includeTaminla()
    includeTaminla()
    const matn = readFileSync(join(papka, 'user-config'), 'utf-8')
    const soni = matn.split('\n').filter((q) => q.startsWith('Include ')).length
    expect(soni).toBe(1)
  })
})

describe('kalitJoyla', () => {
  test('mavjud kalit kirsa — bitta ssh chaqiruvi, sshpass yo\'q', async () => {
    soxtaBajaruvchi(() => OK)
    await kalitJoyla({ host: 'ex.uz', port: 22, username: 'root' })

    expect(chaqiruvlar).toHaveLength(1)
    const argv = chaqiruvlar[0]!.argv
    expect(argv[0]).toBe('ssh')
    expect(argv).toContain('BatchMode=yes')
    expect(argv).toContain('root@ex.uz')
    // Skript idempotent qo'shishni o'z ichiga oladi
    expect(argv.at(-1)).toContain('authorized_keys')
    expect(argv.at(-1)).toContain('ssh-ed25519 AAAATEST platforma')
  })

  test("kalit kirmasa va parol yo'q — tushunarli xato", async () => {
    soxtaBajaruvchi(() => RAD)
    await expect(kalitJoyla({ host: 'ex.uz', port: 22, username: 'root' })).rejects.toThrow(
      /Parol kiriting/,
    )
  })

  test('parol bilan — sshpass SSHPASS env orqali chaqiriladi', async () => {
    soxtaBajaruvchi((argv) => (argv[0] === 'sshpass' ? OK : RAD))
    await kalitJoyla({ host: 'ex.uz', port: 2222, username: 'root' }, 'sirli')

    expect(chaqiruvlar).toHaveLength(2)
    const ikkinchi = chaqiruvlar[1]!
    expect(ikkinchi.argv[0]).toBe('sshpass')
    expect(ikkinchi.argv).toContain('-e')
    expect(ikkinchi.env?.SSHPASS).toBe('sirli')
    // Parol argv ichida KO'RINMASLIGI kerak
    expect(ikkinchi.argv.join(' ')).not.toContain('sirli')
    expect(ikkinchi.argv).toContain('2222')
  })

  test("parol noto'g'ri bo'lsa aniq xabar", async () => {
    soxtaBajaruvchi((argv) =>
      argv[0] === 'sshpass' ? { kod: 5, stdout: '', stderr: 'Permission denied' } : RAD,
    )
    await expect(
      kalitJoyla({ host: 'ex.uz', port: 22, username: 'root' }, 'xato-parol'),
    ).rejects.toThrow(/Parol noto'g'ri/)
  })
})

describe('metrikaTahlil', () => {
  test("to'liq chiqishni foizlarga aylantiradi", () => {
    const m = metrikaTahlil(
      [
        'UPTIME=up 3 days, 4 hours, 12 minutes',
        'LOAD=1.5',
        'NPROC=4',
        'RAM=8000000000 2000000000',
        'DISK=100000 84000',
      ].join('\n'),
    )
    expect(m.holat).toBe('ulangan')
    expect(m.uptime).toBe('3 kun 4 soat 12 daqiqa')
    expect(m.cpu).toBe(38) // 1.5 / 4 = 37.5% → 38
    expect(m.ram).toBe(25)
    expect(m.disk).toBe(84)
  })

  test('yetishmagan qatorlar maydonni bo\'sh qoldiradi, holat baribir ulangan', () => {
    const m = metrikaTahlil('UPTIME=up 5 minutes\n')
    expect(m.holat).toBe('ulangan')
    expect(m.uptime).toBe('5 daqiqa')
    expect(m.cpu).toBeUndefined()
    expect(m.ram).toBeUndefined()
    expect(m.disk).toBeUndefined()
  })

  test('load yadro sonidan oshsa 100% da qirqiladi', () => {
    const m = metrikaTahlil('LOAD=9.0\nNPROC=2\n')
    expect(m.cpu).toBe(100)
  })
})

describe('kalitTaminla (bilvosita)', () => {
  test("pub fayl yo'q bo'lsa ssh-keygen chaqiriladi", async () => {
    rmSync(join(papka, 'ssh', 'id_ed25519.pub'))
    soxtaBajaruvchi((argv) => {
      if (argv[0] === 'ssh-keygen') {
        // Haqiqiy keygen faylni o'zi yozadi — soxtasi ham shunday qiladi
        writeFileSync(join(papka, 'ssh', 'id_ed25519.pub'), 'ssh-ed25519 YANGI platforma\n')
        return OK
      }
      return OK
    })

    await kalitJoyla({ host: 'ex.uz', port: 22, username: 'root' })
    expect(chaqiruvlar[0]!.argv[0]).toBe('ssh-keygen')
    expect(existsSync(join(papka, 'ssh', 'id_ed25519.pub'))).toBe(true)
  })
})
