// Manifest validatori — dinamik dashboardning birinchi himoya qavati.
//
// Bu testlarning maqsadi bitta: AI yozgan buzuq manifest PLATFORMANI
// yiqitmasligini majburlash. Shuning uchun ko'p holat "xato tashlanmasin,
// natija `ok: false` bo'lsin" shaklida tekshiriladi.

import { describe, expect, test } from 'bun:test'
import {
  DATA_CHEGARASI,
  KOD_CHEGARASI,
  VIDJET_CHEGARASI,
  manifestniTekshir,
  vidjetniTozala,
} from '@platforma/shared'

/** Eng kichik yaroqli manifest */
const asos = {
  id: 'test-ilova',
  name: 'Test ilova',
  widgets: [{ type: 'note', text: 'salom' }],
}

describe('manifestniTekshir — asosiy shakl', () => {
  test('yaroqli manifest o\'tadi va tozalangan qiymat qaytadi', () => {
    const n = manifestniTekshir(asos)
    expect(n.ok).toBe(true)
    expect(n.qiymat?.id).toBe('test-ilova')
    // Berilmagan maydonlar standart qiymat oladi — AI hammasini yozishga
    // majbur bo'lmasin.
    expect(n.qiymat?.icon).toBe('📦')
    expect(n.qiymat?.status).toBe('running')
  })

  test('obyekt bo\'lmagan kirish xato TASHLAMAYDI', () => {
    for (const xom of [null, undefined, 42, 'satr', [], true]) {
      const n = manifestniTekshir(xom)
      expect(n.ok).toBe(false)
      expect(n.qiymat).toBeNull()
      expect(n.xatolar.length).toBeGreaterThan(0)
    }
  })

  test('id yo\'q yoki noto\'g\'ri shaklda bo\'lsa rad etiladi', () => {
    expect(manifestniTekshir({ ...asos, id: '' }).ok).toBe(false)
    // id URL yo'liga va papka nomiga tushadi — bu naqsh yo'l chiqishini yopadi
    expect(manifestniTekshir({ ...asos, id: '../etc' }).ok).toBe(false)
    expect(manifestniTekshir({ ...asos, id: 'Katta-Harf' }).ok).toBe(false)
    expect(manifestniTekshir({ ...asos, id: 'a'.repeat(65) }).ok).toBe(false)
  })

  test('ko\'rsatadigan narsa bo\'lmasa rad etiladi', () => {
    const n = manifestniTekshir({ ...asos, widgets: [] })
    expect(n.ok).toBe(false)
  })

  test('vidjetsiz, lekin view bilan — o\'tadi', () => {
    const n = manifestniTekshir({
      ...asos,
      widgets: [],
      view: { kod: 'export default () => null' },
    })
    expect(n.ok).toBe(true)
    expect(n.qiymat?.view?.kod).toContain('export default')
  })
})

describe('vidjetniTozala — qisman buzilish butun dashboardni yo\'qotmaydi', () => {
  test('buzuq vidjet tashlanadi, sog\'i qoladi', () => {
    const n = manifestniTekshir({
      ...asos,
      widgets: [
        { type: 'note', text: 'birinchi' },
        { type: 'yoq-bunday-tur', text: 'buzuq' },
        null,
        { type: 'note', text: 'oxirgi' },
      ],
    })
    expect(n.ok).toBe(true)
    expect(n.qiymat?.widgets).toHaveLength(2)
    expect(n.ogohlantirishlar.length).toBeGreaterThan(0)
  })

  test('bars: raqam bo\'lmagan value tashlanadi', () => {
    const ogoh: string[] = []
    const w = vidjetniTozala(
      { type: 'bars', title: 'T', items: [{ label: 'a', value: 'yuz' }, { label: 'b', value: 10 }] },
      ogoh,
    )
    // 'yuz' NaN berardi va chiziq ko'rinmasdi — jim buzilish
    expect(w).toEqual({ type: 'bars', title: 'T', items: [{ label: 'b', value: 10 }] })
  })

  test('table: qatorlar ustunlar soniga majburan moslashadi', () => {
    const ogoh: string[] = []
    const w = vidjetniTozala(
      { type: 'table', title: 'T', columns: ['a', 'b'], rows: [['1'], ['1', '2', '3']] },
      ogoh,
    )
    expect(w).toEqual({ type: 'table', title: 'T', columns: ['a', 'b'], rows: [['1', ''], ['1', '2']] })
  })

  test('deploy: javascript: sxemasi rad etiladi (XSS yo\'li)', () => {
    const ogoh: string[] = []
    expect(vidjetniTozala({ type: 'deploy', url: 'javascript:alert(1)' }, ogoh)).toBeNull()
    expect(vidjetniTozala({ type: 'deploy', url: 'https://a.uz', server: 's' }, ogoh)).not.toBeNull()
  })

  test('vidjetlar soni chegaralanadi', () => {
    const kop = Array.from({ length: VIDJET_CHEGARASI + 10 }, (_, i) => ({ type: 'note', text: `n${i}` }))
    const n = manifestniTekshir({ ...asos, widgets: kop })
    expect(n.qiymat?.widgets).toHaveLength(VIDJET_CHEGARASI)
  })
})

describe('data — snapshot chegaralari', () => {
  test('yaroqli data saqlanadi', () => {
    const n = manifestniTekshir({ ...asos, data: { klasterlar: 247, postlar: ['a'] } })
    expect(n.qiymat?.data).toEqual({ klasterlar: 247, postlar: ['a'] })
  })

  test('obyekt bo\'lmagan data rad etiladi', () => {
    expect(manifestniTekshir({ ...asos, data: [1, 2] }).ok).toBe(false)
    expect(manifestniTekshir({ ...asos, data: 'satr' }).ok).toBe(false)
  })

  test('chegaradan katta data rad etiladi', () => {
    const n = manifestniTekshir({ ...asos, data: { katta: 'x'.repeat(DATA_CHEGARASI) } })
    expect(n.ok).toBe(false)
    expect(n.xatolar.join(' ')).toContain('too large')
  })

  test('siklik havola xato TASHLAMAYDI', () => {
    const siklik: Record<string, unknown> = { a: 1 }
    siklik.ozi = siklik
    const n = manifestniTekshir({ ...asos, data: siklik })
    expect(n.ok).toBe(false)
    expect(n.xatolar.join(' ')).toContain('JSON')
  })
})

describe('view — kod shakli', () => {
  test('bo\'sh kod rad etiladi', () => {
    expect(manifestniTekshir({ ...asos, view: { kod: '   ' } }).ok).toBe(false)
  })

  test('chegaradan uzun kod rad etiladi', () => {
    const n = manifestniTekshir({ ...asos, view: { kod: 'x'.repeat(KOD_CHEGARASI + 1) } })
    expect(n.ok).toBe(false)
  })
})
