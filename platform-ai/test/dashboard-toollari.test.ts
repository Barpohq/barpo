// `appPublish` tool'ining xulqi: manba inversiyasi, shartli e'lon qilinishi,
// rad etishning modelga qanday yetkazilishi va promptga mosligi.
//
// Bu tool'da baza ham, fayl tizimi ham yo'q — u faqat chaqiruvchi bergan
// funksiyaga tayanadi. Shu sababli testlar soxta manba bilan ishlaydi.

import { describe, expect, test } from 'bun:test'
import { AGENT_SISTEM_PROMPT } from '../src/agent.ts'
import {
  DASHBOARD_PROMPT_QISMI,
  appPublishToolYarat,
  dashboardToollari,
  dashboardToollariXom,
  natijaniMatnga,
  type AppPublishKirishi,
  type DashboardManbasi,
  type DashboardNatijasi,
} from '../src/dashboard-toollari.ts'

const kirish: AppPublishKirishi = {
  id: 'test-ilova',
  name: 'Test ilova',
  widgets: [{ type: 'note', text: 'salom' }],
}

/** Tool'ni `agent.ts` chaqiradigan shaklda ishga tushiradi */
async function toolniChaqir(manba: DashboardManbasi, params: AppPublishKirishi = kirish) {
  const tool = appPublishToolYarat(manba)
  const natija = await tool.execute('id-1', params, undefined, undefined, {
    env: { cwd: '/istalgan/joy' },
  })
  return {
    matn: natija.content.map((b) => ('text' in b ? b.text : '')).join(''),
    details: natija.details,
    isError: natija.isError,
  }
}

describe('manba inversiyasi', () => {
  test('manifest manbaga uzatiladi', async () => {
    let olingan: unknown
    await toolniChaqir((m) => {
      olingan = m
      return { ok: true, yangi: true }
    })
    expect(olingan).toMatchObject({ id: 'test-ilova', name: 'Test ilova' })
  })

  test('view SATR sifatida kelib, manifestga OBYEKT bo\'lib tushadi', async () => {
    // Modeldan ichma-ich obyekt so'rash uni adashtiradi, kontrakt esa
    // `{ kod, xash }` kutadi — aylantirish tool ichida bo'lishi kerak.
    let olingan: Record<string, unknown> = {}
    await toolniChaqir(
      (m) => {
        olingan = m as Record<string, unknown>
        return { ok: true }
      },
      { ...kirish, view: 'export default () => null' },
    )
    expect(olingan.view).toEqual({ kod: 'export default () => null', xash: '' })
  })

  test('bo\'sh view manifestga umuman tushmaydi', async () => {
    let olingan: Record<string, unknown> = {}
    await toolniChaqir(
      (m) => {
        olingan = m as Record<string, unknown>
        return { ok: true }
      },
      { ...kirish, view: '   ' },
    )
    expect('view' in olingan).toBe(false)
  })

  test('asinxron manba qo\'llab-quvvatlanadi', async () => {
    const n = await toolniChaqir(async () => ({ ok: true, yangi: true }))
    expect(n.isError).toBeFalsy()
  })
})

describe('rad etish modelga xato bo\'lib yetadi', () => {
  test('ok:false bo\'lsa isError qo\'yiladi va sabablar matnga tushadi', async () => {
    const n = await toolniChaqir(() => ({
      ok: false,
      xatolar: ['`id` majburiy', '`data` juda katta'],
    }))
    // isError bo'lmasa model "bajarildi" deb o'ylab davom etardi
    expect(n.isError).toBe(true)
    expect(n.matn).toContain('REJECTED')
    expect(n.matn).toContain('`id` majburiy')
    expect(n.matn).toContain('`data` juda katta')
    // Modelga aniq keyingi qadam ko'rsatilsin
    expect(n.matn).toContain('appPublish again')
  })

  test('rad etilganda "saqlanmadi" aniq aytiladi', async () => {
    const n = await toolniChaqir(() => ({ ok: false, xatolar: ['x'] }))
    expect(n.matn.toLowerCase()).toContain('nothing was saved')
  })
})

describe('natijaniMatnga', () => {
  test('yangi va yangilangan holat farqlanadi', () => {
    expect(natijaniMatnga('a', { ok: true, yangi: true })).toContain('published')
    expect(natijaniMatnga('a', { ok: true, yangi: false })).toContain('updated')
  })

  test('ogohlantirishlar ko\'rsatiladi, lekin xato deb atalmaydi', () => {
    const m = natijaniMatnga('a', {
      ok: true,
      yangi: true,
      ogohlantirishlar: ["Notanish vidjet turi: 'chart' — tashlandi"],
    })
    expect(m).toContain('published')
    expect(m).toContain("'chart'")
    expect(m).not.toContain('REJECTED')
  })
})

describe('tafsilotlar (UI tool kartasi uchun)', () => {
  test('vidjetlar soni va kod borligi qaytadi', async () => {
    const n = await toolniChaqir(() => ({ ok: true }), {
      ...kirish,
      widgets: [{ type: 'note', text: 'a' }, { type: 'note', text: 'b' }],
      view: 'export default () => null',
    })
    expect(n.details).toEqual({
      appId: 'test-ilova',
      ok: true,
      vidjetlar: 2,
      kodBor: true,
      sozlamalar: 0,
      amallar: 0,
    })
  })

  test('vidjetsiz chaqiruvda ham yiqilmaydi', async () => {
    const n = await toolniChaqir(() => ({ ok: true }), { id: 'a', name: 'A' })
    expect(n.details?.vidjetlar).toBe(0)
    expect(n.details?.kodBor).toBe(false)
  })

  test('boshqaruv qatlami sanaladi', async () => {
    const n = await toolniChaqir(() => ({ ok: true }), {
      ...kirish,
      sozlamalar: {
        maydonlar: [
          { kalit: 'token', turi: 'sir', yorliq: 'Token' },
          { kalit: 'rejim', turi: 'matn', yorliq: 'Rejim' },
        ],
        yoz: 'module.exports = async () => {}',
      },
      amallar: [{ nom: 'restart', yorliq: 'Restart', kod: 'module.exports = async () => {}' }],
    })

    expect(n.details?.sozlamalar).toBe(2)
    expect(n.details?.amallar).toBe(1)
  })
})

describe('shartli e\'lon qilinish', () => {
  test('manba yo\'q bo\'lsa tool UMUMAN e\'lon qilinmaydi', () => {
    // "Bor, lekin ishlamaydi" dan yaxshiroq: model yo'q imkoniyatni
    // qayta-qayta urinmaydi.
    expect(dashboardToollariXom(undefined)).toHaveLength(0)
    expect(dashboardToollari(undefined)).toHaveLength(0)
  })

  test('manba bor bo\'lsa bitta tool chiqadi', () => {
    const manba: DashboardManbasi = () => ({ ok: true })
    expect(dashboardToollariXom(manba).map((t) => t.name)).toEqual(['appPublish'])
    expect(dashboardToollari(manba).map((t) => t.name)).toEqual(['appPublish'])
  })
})

describe('prompt tool bilan mos', () => {
  test('tool bor bo\'lsa prompt uni tilga oladi', () => {
    const p = AGENT_SISTEM_PROMPT('/ish', undefined, undefined, undefined, false, true)
    expect(p).toContain('appPublish')
    // Asosiy qoida promptda bo'lishi shart — aks holda agent endpoint yozadi
    expect(p).toContain('do NOT write an HTTP endpoint')
  })

  test('tool yo\'q bo\'lsa prompt uni UMUMAN tilga olmaydi', () => {
    const p = AGENT_SISTEM_PROMPT('/ish', undefined, undefined, undefined, false, false)
    expect(p).not.toContain('appPublish')
  })

  test('prompt qismi tool tavsifi bilan bir xil qoidani aytadi', () => {
    const qoida = DASHBOARD_PROMPT_QISMI.qoida.join(' ')
    expect(qoida).toContain('appPublish')
    // Jonli ma'lumot `states` orqali kelishi promptda aytilishi shart:
    // aks holda AI qiymatlarni `data` ga qo'yib, dashboard muzlab qolardi
    expect(qoida).toContain('states')
  })
})

describe('asosiy qoidalar tavsifda aytilgan', () => {
  test('tool tavsifi API yozmaslikni va `states` ni ochiq aytadi', async () => {
    const tool = appPublishToolYarat(() => ({ ok: true }))
    // Qator uzilishlari tekshiruvga xalaqit bermasin
    const tavsif = tool.description.replace(/\s+/g, ' ')

    expect(tavsif).toContain('do NOT write an API')
    // O'zgaradigan qiymat uchun `states` kerakligi — eng ko'p
    // yanglishtiradigan joy, shuning uchun tavsifda bo'lishi shart
    expect(tavsif).toContain('states')
    expect(tavsif).toContain('frozen forever')
  })
})

describe('natija shakli', () => {
  test('DashboardNatijasi ixtiyoriy maydonlarsiz ham ishlaydi', () => {
    const n: DashboardNatijasi = { ok: true }
    expect(natijaniMatnga('a', n)).toContain('updated')
  })
})
