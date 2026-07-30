// Jonli state qatlami — bajarish, kesh va per-state intervallar.
//
// ASOSIY TALAB: har state MUSTAQIL. CPU 5 soniyada yangilansa, disk 60
// soniyada — ular bir-birini qayta hisoblatmasligi kerak.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { bazaOch } from '../src/db.ts'
import { dashboardniSaqla } from '../src/dashboard-saqlash.ts'
import { ilovaOqi } from '../src/repo.ts'
import {
  ENG_QISQA_INTERVAL,
  intervalniTogrila,
  kodniTekshir,
  stateniBajar,
} from '../src/state-bajar.ts'
import { ilovaKeshiniTozala, keshHajmi, keshniTozala, stateniOl } from '../src/state-kesh.ts'

let db: Database

beforeEach(() => {
  db = bazaOch(':memory:')
  keshniTozala()
})

afterEach(() => {
  db.close()
})

describe('stateniBajar', () => {
  test('oddiy qiymat qaytadi', async () => {
    const n = await stateniBajar('module.exports = async () => ({ a: 1 })', 'x')
    expect(n.ok).toBe(true)
    expect(n.qiymat).toEqual({ a: 1 })
  })

  test('require va child_process ishlaydi', async () => {
    // Bu qatlamning butun maqsadi — serverdan haqiqiy ma'lumot olish
    const n = await stateniBajar(
      `module.exports = async () => {
         const { execSync } = require('child_process')
         return { chiqish: execSync('echo salom').toString().trim() }
       }`,
      'x',
    )
    expect(n.ok).toBe(true)
    expect(n.qiymat).toEqual({ chiqish: 'salom' })
  })

  test('kod yiqilsa XATO TASHLANMAYDI, natija qaytadi', async () => {
    const n = await stateniBajar("module.exports = async () => { throw new Error('yiqildi') }", 'x')
    expect(n.ok).toBe(false)
    expect(n.xato).toContain('yiqildi')
  })

  test('sintaksis xatosi ushlanadi', async () => {
    const n = await stateniBajar('bu ( sintaksis xato', 'x')
    expect(n.ok).toBe(false)
    expect(n.xato).toContain('Syntax error')
  })

  test('funksiya bermagan kod rad etiladi', async () => {
    const n = await stateniBajar('module.exports = 42', 'x')
    expect(n.ok).toBe(false)
    expect(n.xato).toContain('module.exports')
  })

  test('JSON\'ga aylanmaydigan natija rad etiladi', async () => {
    const n = await stateniBajar(
      'module.exports = async () => { const a = {}; a.o = a; return a }',
      'x',
    )
    expect(n.ok).toBe(false)
    expect(n.xato).toContain('JSON')
  })
})

describe('intervalniTogrila — juda tez polling oldini oladi', () => {
  test('chegaradan kichik interval ko\'tariladi', () => {
    expect(intervalniTogrila(1)).toBe(ENG_QISQA_INTERVAL)
    expect(intervalniTogrila(0.5)).toBe(ENG_QISQA_INTERVAL)
  })

  test('normal interval o\'zgarmaydi', () => {
    expect(intervalniTogrila(30)).toBe(30)
  })

  test('yo\'q yoki nol — avtomatik yangilanmaydi', () => {
    expect(intervalniTogrila(undefined)).toBe(0)
    expect(intervalniTogrila(0)).toBe(0)
    expect(intervalniTogrila(-5)).toBe(0)
  })
})

describe('kesh — har state MUSTAQIL', () => {
  test('interval ichida kod QAYTA BAJARILMAYDI', async () => {
    // Har chaqiruvda o'zgaradigan qiymat: kesh ishlasa u o'zgarmaydi
    const kod = 'module.exports = async () => ({ n: Math.random() })'
    const a = await stateniOl('app', 'cpu', kod, 60)
    const b = await stateniOl('app', 'cpu', kod, 60)
    expect(b.qiymat).toEqual(a.qiymat!)
  })

  test('turli statelar bir-birini QAYTA HISOBLATMAYDI', async () => {
    // Aynan shu talab: CPU 5s da yangilansa, disk 60s da qolishi kerak
    const kod = 'module.exports = async () => ({ n: Math.random() })'
    const cpu = await stateniOl('app', 'cpu', kod, 3)
    const disk = await stateniOl('app', 'disk', kod, 60)
    expect(cpu.qiymat).not.toEqual(disk.qiymat!)

    // Disk keshi CPU so'roviga tegmaydi
    const diskYana = await stateniOl('app', 'disk', kod, 60)
    expect(diskYana.qiymat).toEqual(disk.qiymat!)
  })

  test('kod o\'zgarsa kesh ISHLATILMAYDI', async () => {
    const a = await stateniOl('app', 's', 'module.exports = async () => 1', 60)
    const b = await stateniOl('app', 's', 'module.exports = async () => 2', 60)
    expect(a.qiymat).toBe(1)
    expect(b.qiymat).toBe(2)
  })

  test('majburiy keshni chetlab o\'tadi', async () => {
    const kod = 'module.exports = async () => ({ n: Math.random() })'
    const a = await stateniOl('app', 's', kod, 60)
    const b = await stateniOl('app', 's', kod, 60, true)
    expect(b.qiymat).not.toEqual(a.qiymat!)
  })

  test('parallel so\'rovlar BITTA bajarishni bo\'lishadi', async () => {
    // Aks holda 3 ta ochiq tab = 3 barobar `ssh` yuki
    const kod = 'module.exports = async () => ({ n: Math.random() })'
    const [a, b, c] = await Promise.all([
      stateniOl('app', 's', kod, 60),
      stateniOl('app', 's', kod, 60),
      stateniOl('app', 's', kod, 60),
    ])
    expect(b.qiymat).toEqual(a.qiymat!)
    expect(c.qiymat).toEqual(a.qiymat!)
  })

  test('xato natija ham keshlanadi', async () => {
    // Yiqilayotgan kod har so'rovda qayta bajarilsa, timeout'lar to'planardi
    const kod = "module.exports = async () => { throw new Error('x') }"
    await stateniOl('app', 's', kod, 60)
    const hajm = keshHajmi()
    await stateniOl('app', 's', kod, 60)
    expect(keshHajmi()).toBe(hajm)
  })

  test('ilova keshi tozalanadi', async () => {
    await stateniOl('app1', 's', 'module.exports = async () => 1', 60)
    await stateniOl('app2', 's', 'module.exports = async () => 1', 60)
    ilovaKeshiniTozala('app1')
    expect(keshHajmi()).toBe(1)
  })
})

describe('kodniTekshir', () => {
  test('yaroqli kod xatosiz o\'tadi', () => {
    expect(kodniTekshir('module.exports = async () => ({})')).toEqual([])
  })

  test('bo\'sh kod rad etiladi', () => {
    expect(kodniTekshir('   ').length).toBeGreaterThan(0)
  })

  test('sintaksis xatosi ushlanadi', () => {
    expect(kodniTekshir('function ( {').length).toBeGreaterThan(0)
  })
})

describe('manifest bilan integratsiya', () => {
  const asos = {
    id: 'state-sinov',
    name: 'State sinov',
    widgets: [{ type: 'note', text: 'salom' }],
  }

  test('statelar manifest bilan saqlanadi', async () => {
    const n = await dashboardniSaqla(
      {
        ...asos,
        states: [
          { nom: 'cpu', kod: 'module.exports = async () => 1', interval: 5 },
          { nom: 'disk', kod: 'module.exports = async () => 2', interval: 60 },
        ],
      },
      db,
    )
    expect(n.ok).toBe(true)

    const states = ilovaOqi('state-sinov', db)?.manifest.states
    expect(states).toHaveLength(2)
    // Har state o'z intervalini saqlashi SHART
    expect(states?.find((s) => s.nom === 'cpu')?.interval).toBe(5)
    expect(states?.find((s) => s.nom === 'disk')?.interval).toBe(60)
  })

  test('buzuq state TASHLANADI, sog\'i qoladi', async () => {
    const n = await dashboardniSaqla(
      {
        ...asos,
        states: [
          { nom: 'yaxshi', kod: 'module.exports = async () => 1' },
          { nom: 'buzuq', kod: 'bu ( sintaksis xato' },
        ],
      },
      db,
    )
    expect(n.ok).toBe(true)
    expect(ilovaOqi('state-sinov', db)?.manifest.states).toHaveLength(1)
    expect(n.ogohlantirishlar?.join(' ')).toContain('buzuq')
  })

  test('yaroqsiz nom tashlanadi (URL yo\'liga tushadi)', async () => {
    const n = await dashboardniSaqla(
      { ...asos, states: [{ nom: '../etc', kod: 'module.exports = async () => 1' }] },
      db,
    )
    expect(n.ok).toBe(true)
    expect(ilovaOqi('state-sinov', db)?.manifest.states).toBeUndefined()
  })

  test('takrorlangan nom manifestni RAD ETADI', async () => {
    // `data[nom]` bitta joy — qaysi kod qolishi tasodifga bog'liq bo'lardi
    const n = await dashboardniSaqla(
      {
        ...asos,
        states: [
          { nom: 'cpu', kod: 'module.exports = async () => 1' },
          { nom: 'cpu', kod: 'module.exports = async () => 2' },
        ],
      },
      db,
    )
    expect(n.ok).toBe(false)
    expect(n.xatolar?.join(' ')).toContain('Duplicate')
  })
})
