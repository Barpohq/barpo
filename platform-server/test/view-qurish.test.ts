// JSX kompilyatsiyasi — AI kodidagi xato butun dashboardni yiqitmasligini
// va sandbox'da ishlamaydigan konstruksiyalar erta ushlanishini majburlaydi.

import { describe, expect, test } from 'bun:test'
import { kodXashi, skriptgaXavfsiz, taqiqlanganlarniTop, viewniQur } from '../src/view-qurish.ts'

describe('viewniQur — muvaffaqiyatli yo\'l', () => {
  test('JSX React.createElement ga aylanadi', async () => {
    const n = await viewniQur('export default function View({ data }) { return <div>{data.a}</div> }')
    expect(n.ok).toBe(true)
    expect(n.kod).toContain('React.createElement')
    // Klassik transform: import QO'SHILMASLIGI shart, aks holda brauzerda
    // modul yuklovchi yo'qligi sabab kod umuman ishga tushmasdi.
    expect(n.kod).not.toContain('jsx-runtime')
    expect(n.kod).not.toMatch(/^\s*import\s/m)
  })

  test('React hooklari global sifatida qoladi', async () => {
    const n = await viewniQur(
      'export default function View() { const [a] = useState(0); return <b>{a}</b> }',
    )
    expect(n.ok).toBe(true)
    expect(n.kod).toContain('useState')
  })

  test('xash manba bo\'yicha barqaror va o\'zgarishga sezgir', async () => {
    const a = await viewniQur('export default () => <i>a</i>')
    const b = await viewniQur('export default () => <i>a</i>')
    const c = await viewniQur('export default () => <i>b</i>')
    expect(a.xash).toBe(b.xash!)
    expect(a.xash).not.toBe(c.xash!)
    expect(a.xash).toBe(kodXashi('export default () => <i>a</i>'))
  })

  test('fragment va ichma-ich element ishlaydi', async () => {
    const n = await viewniQur('export default () => <><span>a</span><span>b</span></>')
    expect(n.ok).toBe(true)
    expect(n.kod).toContain('React.Fragment')
  })

  test('natija HAQIQATAN bajariladi va komponent qaytaradi', async () => {
    // Bu eng muhim test: kod `new Function` orqali brauzerda aynan
    // shunday chaqiriladi (`AiKorinish.tsx`). Shakl buzilsa dashboard
    // butunlay ishlamaydi, lekin qolgan testlar buni sezmasdi.
    const n = await viewniQur(
      'export default function View({ data, ui }) { return <ui.Card>{data.a}</ui.Card> }',
    )
    expect(n.ok).toBe(true)

    const soxtaReact = {
      createElement: (tur: unknown, _p: unknown, ...bolalar: unknown[]) => ({ tur, bolalar }),
      Fragment: 'fragment',
    }
    const komponent = new Function('React', 'useState', n.kod!)(soxtaReact, () => [])
    expect(typeof komponent).toBe('function')

    const element = komponent({ data: { a: 'salom' }, ui: { Card: 'CARD' } })
    expect(element).toEqual({ tur: 'CARD', bolalar: ['salom'] })
  })

  test('hooklar argument sifatida yetib boradi', async () => {
    const n = await viewniQur(
      'export default function View() { const [x] = useState(7); return <i>{x}</i> }',
    )
    expect(n.ok).toBe(true)

    const soxtaReact = { createElement: (_t: unknown, _p: unknown, ...b: unknown[]) => b }
    const komponent = new Function('React', 'useState', n.kod!)(soxtaReact, (v: unknown) => [v])
    expect(komponent({})).toEqual([7])
  })
})

describe('viewniQur — xato XATO TASHLAMAYDI, natija qaytaradi', () => {
  test('sintaksis xatosi ushlanadi', async () => {
    const n = await viewniQur('export default () => <div>')
    expect(n.ok).toBe(false)
    expect(n.kod).toBeUndefined()
    expect(n.xatolar.length).toBeGreaterThan(0)
  })

  test('import rad etiladi va sabab tushuntiriladi', async () => {
    const n = await viewniQur('import React from "react"\nexport default () => <i/>')
    expect(n.ok).toBe(false)
    expect(n.xatolar.join(' ')).toContain('import')
  })

  test('bo\'sh kod xato beradi', async () => {
    const n = await viewniQur('')
    expect(n.ok).toBe(false)
  })

  test('dinamik import() ham rad etiladi', async () => {
    // Bundler buni tashqi bog'liqlik deb o'tkazib yuborardi va kod
    // sandbox'da JIM yiqilardi — AI sababni bilmasdi.
    const n = await viewniQur('export default () => { import("react"); return <i/> }')
    expect(n.ok).toBe(false)
    expect(n.xatolar.join(' ')).toContain('import')
  })
})

describe('skriptgaXavfsiz — inline script uzilishining oldini oladi', () => {
  // REGRESSIYA. Bu bug brauzerda amalda uchradi: React kodidagi
  // `"<script></script>"` satri sandbox HTML'ining script blokini erta
  // yopib, bundle'ning qolgan qismi SAHIFA MATNI bo'lib ko'ringan.
  // Natijada `window.React` aniqlanmay, sandbox "React runtime
  // yuklanmadi" xatosini bergan.
  test('</script ketma-ketligi qochiriladi', () => {
    expect(skriptgaXavfsiz('a = "</script>"')).toBe('a = "<\\/script>"')
  })

  test('katta-kichik harf farq qilmaydi', () => {
    // HTML tahlilchisi `</SCRIPT` ni ham yopilish deb biladi
    expect(skriptgaXavfsiz('x = "</SCRIPT>"')).toContain('<\\/SCRIPT')
    expect(skriptgaXavfsiz('x = "</ScRiPt>"')).toContain('<\\/ScRiPt')
  })

  test('boshqa teglarga tegilmaydi', () => {
    expect(skriptgaXavfsiz('x = "</div>"')).toBe('x = "</div>"')
  })

  test('kompilyatsiya natijasi allaqachon tozalangan', async () => {
    // Himoya kod QURILAYOTGAN joyda — UI qayta ishlashi shart emas
    const n = await viewniQur('export default () => { const s = "</script>"; return <i>{s}</i> }')
    expect(n.ok).toBe(true)
    expect(n.kod).not.toContain('</script')
    expect(n.kod).toContain('<\\/script')
  })
})

describe('taqiqlanganlarniTop — ko\'rinish kodi faqat chizadi', () => {
  test('fetch rad etiladi va `states` ga yo\'naltiriladi', async () => {
    // Ko'rinish host'da ishlaydi, ya'ni `fetch` TEXNIK jihatdan mumkin.
    // Lekin u ishlatilmasligi kerak: ma'lumot `states` orqali keladi,
    // faqat o'shanda kesh va interval boshqaruvi ishlaydi.
    const n = await viewniQur('export default () => { fetch("/api/x"); return <i/> }')
    expect(n.ok).toBe(false)
    // Sabab AYTILISHI muhim: aks holda AI xuddi shu xatoni takrorlardi
    expect(n.xatolar.join(' ')).toContain('states')
  })

  test('tarmoq API\'lari aniqlanadi', () => {
    expect(taqiqlanganlarniTop('new WebSocket("ws://x")')).toHaveLength(1)
    expect(taqiqlanganlarniTop('new XMLHttpRequest()')).toHaveLength(1)
  })

  test('brauzer xotirasi aniqlanadi', () => {
    expect(taqiqlanganlarniTop('localStorage.getItem("a")')).toHaveLength(1)
    expect(taqiqlanganlarniTop('document.cookie')).toHaveLength(1)
  })

  test('toza kodda ogohlantirish yo\'q', () => {
    expect(taqiqlanganlarniTop('const a = data.x.map(v => v * 2)')).toHaveLength(0)
  })
})
