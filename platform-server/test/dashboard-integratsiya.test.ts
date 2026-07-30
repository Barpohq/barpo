// Dinamik dashboard — uchidan-uchiga oqim.
//
// `appPublish` tool'idan bazagacha bo'lgan butun zanjir shu yerda
// tekshiriladi: tekshiruv → kompilyatsiya → saqlash → o'qish.
//
// ASOSIY TALAB: AI xatosi PLATFORMANI YIQITMASLIGI kerak. Testlarning
// katta qismi aynan shuni majburlaydi — buzuq kod yoki buzuq manifest
// kelganda nima SAQLANIB QOLISHINI tekshiradi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { appPublishToolYarat } from '@platforma/ai'
import { bazaOch } from '../src/db.ts'
import { dashboardniSaqla } from '../src/dashboard-saqlash.ts'
import { ilovaOqi } from '../src/repo.ts'

let db: Database

beforeEach(() => {
  db = bazaOch(':memory:')
})

afterEach(() => {
  db.close()
})

const asos = {
  id: 'sinov-ilova',
  name: 'Sinov ilova',
  widgets: [{ type: 'note', text: 'salom' }],
}

describe('dashboardniSaqla — asosiy oqim', () => {
  test('vidjetli manifest saqlanadi va o\'qiladi', async () => {
    const n = await dashboardniSaqla(asos, db)
    expect(n.ok).toBe(true)
    expect(n.yangi).toBe(true)

    const yozuv = ilovaOqi('sinov-ilova', db)
    expect(yozuv?.manifest.name).toBe('Sinov ilova')
    expect(yozuv?.manifest.widgets).toHaveLength(1)
  })

  test('bir xil id bilan qayta chaqirish ALMASHTIRADI', async () => {
    await dashboardniSaqla(asos, db)
    const n = await dashboardniSaqla({ ...asos, name: 'Yangilangan' }, db)

    expect(n.ok).toBe(true)
    expect(n.yangi).toBe(false)
    expect(ilovaOqi('sinov-ilova', db)?.manifest.name).toBe('Yangilangan')
  })

  test('buzuq manifest RAD ETILADI va hech narsa saqlanmaydi', async () => {
    const n = await dashboardniSaqla({ name: 'idsiz' }, db)
    expect(n.ok).toBe(false)
    expect(n.xatolar?.length).toBeGreaterThan(0)
    expect(ilovaOqi('idsiz', db)).toBeNull()
  })
})

describe('JSX kod oqimi', () => {
  test('to\'g\'ri kod kompilyatsiya qilinib saqlanadi', async () => {
    const n = await dashboardniSaqla(
      { ...asos, view: { kod: 'export default function View({ data }) { return <i>{data.a}</i> }' } },
      db,
    )
    expect(n.ok).toBe(true)

    const view = ilovaOqi('sinov-ilova', db)?.manifest.view
    // Bazada MANBA emas, kompilyatsiya qilingan kod turishi kerak
    expect(view?.kod).toContain('React.createElement')
    // Kod `new Function` bajaradigan shaklda: komponentni qaytaradi
    expect(view?.kod).toContain('return __natija__')
    expect(view?.xash).toBeTruthy()
  })

  test('data snapshot manifest bilan birga saqlanadi', async () => {
    const n = await dashboardniSaqla(
      { ...asos, data: { klasterlar: 247, postlar: ['a', 'b'] } },
      db,
    )
    expect(n.ok).toBe(true)
    expect(ilovaOqi('sinov-ilova', db)?.manifest.data).toEqual({
      klasterlar: 247,
      postlar: ['a', 'b'],
    })
  })
})

describe('XATO IZOLYATSIYASI — asosiy talab', () => {
  test('buzuq kod TASHLANADI, vidjetlar SAQLANADI', async () => {
    const n = await dashboardniSaqla(
      { ...asos, view: { kod: 'export default () => <div>' } },
      db,
    )

    // Ilova saqlanishi SHART: bitta buzuq kod uchun butun dashboardni
    // yo'qotish foydalanuvchiga zarar qiladi.
    expect(n.ok).toBe(true)
    expect(n.ogohlantirishlar?.join(' ')).toContain('did not compile')

    const manifest = ilovaOqi('sinov-ilova', db)?.manifest
    expect(manifest?.widgets).toHaveLength(1)
    expect(manifest?.view).toBeUndefined()
  })

  test('fetch ishlatilgan kod tashlanadi, vidjetlar qoladi', async () => {
    const n = await dashboardniSaqla(
      { ...asos, view: { kod: 'export default () => { fetch("/api/x"); return <i/> }' } },
      db,
    )
    expect(n.ok).toBe(true)
    expect(ilovaOqi('sinov-ilova', db)?.manifest.view).toBeUndefined()
  })

  test('vidjetsiz + buzuq kod = RAD ETILADI', async () => {
    // Ko'rsatadigan hech narsa qolmaydi — bo'sh sahifa ko'rsatgandan
    // ko'ra AI'ga xatoni qaytarib, tuzattirgan ma'qul.
    const n = await dashboardniSaqla(
      { ...asos, widgets: [], view: { kod: 'export default () => <div>' } },
      db,
    )
    expect(n.ok).toBe(false)
    expect(ilovaOqi('sinov-ilova', db)).toBeNull()
  })

  test('buzuq vidjet tashlanadi, sog\'lari saqlanadi', async () => {
    const n = await dashboardniSaqla(
      {
        ...asos,
        widgets: [
          { type: 'note', text: 'yaxshi' },
          { type: 'notanish-tur' },
          { type: 'bars', title: 'T', items: [{ label: 'a', value: 'raqam-emas' }] },
        ],
      },
      db,
    )
    expect(n.ok).toBe(true)
    expect(ilovaOqi('sinov-ilova', db)?.manifest.widgets).toHaveLength(1)
    expect(n.ogohlantirishlar?.length).toBeGreaterThan(0)
  })
})

describe('appPublish tool orqali to\'liq zanjir', () => {
  /** Tool'ni agent chaqiradigan shaklda ishga tushiradi */
  async function publish(params: Record<string, unknown>) {
    const tool = appPublishToolYarat((m) => dashboardniSaqla(m, db))
    const natija = await tool.execute('id-1', params as never, undefined, undefined, {
      env: { cwd: '/istalgan' },
    })
    return {
      matn: natija.content.map((b) => ('text' in b ? b.text : '')).join(''),
      isError: natija.isError,
    }
  }

  test('tool chaqiruvi bazaga yozadi', async () => {
    const n = await publish({
      id: 'oxirgi-sinov',
      name: 'Oxirgi sinov',
      widgets: [{ type: 'stats', items: [{ label: 'A', value: '1' }] }],
    })

    expect(n.isError).toBeFalsy()
    expect(n.matn).toContain('published')
    expect(ilovaOqi('oxirgi-sinov', db)?.manifest.widgets).toHaveLength(1)
  })

  test('tool `view` satrini kompilyatsiyagacha olib boradi', async () => {
    await publish({
      id: 'kodli',
      name: 'Kodli',
      data: { son: 5 },
      view: 'export default function View({ data }) { return <b>{data.son}</b> }',
    })

    const manifest = ilovaOqi('kodli', db)?.manifest
    expect(manifest?.view?.kod).toContain('React.createElement')
    expect(manifest?.data).toEqual({ son: 5 })
  })

  test('rad etilgan chaqiruv modelga XATO bo\'lib qaytadi', async () => {
    const n = await publish({ id: 'YOMON ID', name: 'x' })
    expect(n.isError).toBe(true)
    expect(n.matn).toContain('REJECTED')
  })
})
