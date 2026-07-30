---
name: dashboard-jsx
description: Use when a dashboard needs a custom layout that the built-in widgets cannot express, and you are about to pass `view` (JSX source) to appPublish. Explains the required component shape, the platform components and Tailwind classes available to it, and how live `states` data reaches the code. Read this BEFORE writing any view code.
license: ichki
---

# Maxsus dashboard ko'rinishi (JSX)

`appPublish` ning `view` maydoniga o'z JSX kodingizni berishingiz mumkin.
Bu vidjetlar ifodalay olmaydigan tartib kerak bo'lganda ishlatiladi.

**Avval vidjetlar bilan qilib ko'ring** (`dashboard-yaratish` skilliga
qarang) — ular ishonchliroq va tezroq. Kod yozish faqat haqiqatan zarur
bo'lganda.

## Majburiy shakl

```jsx
export default function View({ data, ui }) {
  return <div>...</div>
}
```

`export default` **shart**. Komponent ikki props oladi:

- `data` — `appPublish` da bergan ma'lumot + jonli `states` qiymatlari
- `ui` — platforma komponentlari (pastda)

## Nima mavjud

### Platforma komponentlari — `ui`

Bularni ishlating, shunda dashboard qolgan UI bilan **bir xil** ko'rinadi:

```jsx
<ui.Card className="p-5">...</ui.Card>
<ui.StatTile label="CPU" value="3.2%" hint="4 yadro" accent="#45c8b5" />
<ui.StatusDot status="running" pulse />
```

`StatusDot` holatlari: `running`, `idle`, `paused`, `healthy`, `warning`,
`offline`.

### Tailwind klasslari

Platformaning butun uslub tizimi ochiq:

```jsx
<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
  <div className="rounded-xl border border-line bg-panel p-4">
    <span className="text-xs uppercase tracking-wider text-muted">CPU</span>
    <div className="mt-2 font-mono text-2xl font-semibold text-lazur">3.2%</div>
  </div>
</div>
```

Rang klasslari: `text-ink`, `text-muted`, `text-faint`, `text-lazur`,
`text-gold`, `text-coral`, `text-mint`, `bg-panel`, `bg-panel2`, `bg-bg`,
`border-line`.

### React hooklari

Import qilmasdan ishlatasiz — ular tayyor:

`useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`,
`useReducer`, `useLayoutEffect`, `useId`

```jsx
export default function View({ data }) {
  const [tanlangan, setTanlangan] = useState(null)
  const jami = useMemo(() => data.postlar.length, [data.postlar])
  return <div>{jami} ta post</div>
}
```

## Nima MUMKIN EMAS

| Taqiqlangan | Nima uchun | O'rniga |
|---|---|---|
| `import` / `require` | Kod bundle qilinmaydi | React, hooklar, `ui` allaqachon berilgan |
| `fetch`, `WebSocket` | Ixtiyoriy tarmoq chiqishi yo'q | o'qish uchun `states`, yozish uchun `ui.amal` / `ui.saqla` |
| `localStorage`, cookie | Ko'rinish holatsiz bo'lsin | `useState` |

## Yozish — `ui.amal` va `ui.saqla`

Ilovada `sozlamalar` yoki `amallar` bo'lsa, ko'rinish ularni chaqira oladi:

```jsx
export default function View({ data, ui }) {
  const [ketmoqda, setKetmoqda] = useState(false)

  async function restart() {
    setKetmoqda(true)
    const javob = await ui.amal('restart')     // amallar[].nom
    setKetmoqda(false)
  }

  return (
    <ui.Card className="p-5">
      <button onClick={restart} disabled={ketmoqda}>
        {ketmoqda ? 'Bajarilmoqda…' : 'Restart'}
      </button>
    </ui.Card>
  )
}
```

`ui.saqla({ token: '...' })` — sozlama qiymatlarini yozadi.
`ui.sozlama` — joriy sirsiz qiymatlar (sirlar bu yerda **yo'q**).

Bu ikki funksiya **faqat shu ilovaning** marshrutlariga boradi — boshqa
ilovaga murojaat qilib bo'lmaydi. Shuning uchun `fetch` taqiqi buzilmaydi.

**Avval sxemani ko'rib chiqing.** `sozlamalar.maydonlar` bilan forma
platforma tomonidan render qilinadi va validatsiya, sir maskalash,
"bo'sh sir = o'zgartirmadim" qoidasi unda tayyor. `ui.saqla` ni faqat
sxema sig'maydigan holatda ishlating — tafsilotlar `dashboard-boshqaruv`
skillida.

## Jonli ma'lumot — `states`

Vaqt o'tishi bilan o'zgaradigan qiymat uchun `fetch` yozmang. `states`
qo'shing (`dashboard-yaratish` skilliga qarang) — ular serverda
bajariladi va `data` ga **avtomatik tushadi**:

```
appPublish({
  states: [
    { nom: "cpu", interval: 5, kod: "module.exports = async () => ({ foiz: 3.2 })" }
  ],
  view: "..."
})
```

Kod ichida `data.cpu.foiz` mavjud bo'ladi va **har 5 soniyada yangi qiymat
bilan qayta render bo'ladi**. Siz uchun bu shunchaki props o'zgarishi:

```jsx
export default function View({ data }) {
  return <div>CPU: {data.cpu?.foiz}%</div>
}
```

`data.cpu` boshida `undefined` bo'lishi mumkin (birinchi so'rov hali
kelmagan) — `?.` bilan himoyalang.

Nega shunday: `states` keshlanadi va interval bo'yicha aniq bir marta
bajariladi. `fetch` bilan yozsangiz, har ochiq tab so'rovni takrorlardi
va yangilanish oralig'ini platforma boshqara olmasdi.

## To'liq misol

```jsx
export default function View({ data, ui }) {
  const [filtr, setFiltr] = useState('hammasi')
  const postlar = (data.postlar ?? []).filter(
    (p) => filtr === 'hammasi' || p.holat === filtr
  )

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ui.StatTile label="CPU" value={`${data.cpu?.foiz ?? '—'}%`} />
        <ui.StatTile label="RAM" value={data.ram?.foiz ?? '—'} hint={data.ram?.bosh} />
      </div>

      <ui.Card className="overflow-hidden">
        <div className="flex gap-2 border-b border-line px-5 py-3">
          {['hammasi', 'nashr', 'kutmoqda'].map((f) => (
            <button
              key={f}
              onClick={() => setFiltr(f)}
              className={`rounded-md px-2.5 py-1 text-xs transition ${
                filtr === f ? 'bg-lazur text-bg' : 'text-muted hover:text-ink'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <table className="w-full text-left text-sm">
          <tbody>
            {postlar.map((p, i) => (
              <tr key={i} className="border-t border-line/60">
                <td className="px-5 py-2.5 font-mono text-xs text-faint">{p.vaqt}</td>
                <td className="px-5 py-2.5 text-[13px]">{p.sarlavha}</td>
                <td className="px-5 py-2.5 text-[13px] text-muted">{p.holat}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ui.Card>
    </div>
  )
}
```

## Xato bo'lsa nima bo'ladi

Kodingiz kompilyatsiya qilinmasa yoki render paytida yiqilsa:

- **Platforma ishlashda davom etadi** — hech narsa buzilmaydi
- Vidjetlar berilgan bo'lsa, ular baribir ko'rsatiladi
- O'rniga qisqa xato bloki chiqadi

Shuning uchun `view` bilan birga `widgets` ham berish yaxshi odat.

## Tez-tez uchraydigan xatolar

| Xato | To'g'ri yo'l |
|---|---|
| `import React from 'react'` | Import kerak emas — hammasi berilgan |
| `fetch('/api/...')` — o'qish uchun | `states` qo'shing |
| `fetch('/api/...')` — yozish uchun | `ui.amal(nom)` / `ui.saqla({...})` |
| `export function View()` | `export default function View()` |
| `data.cpu.foiz` (himoyasiz) | `data.cpu?.foiz` — birinchi renderda bo'sh |
| `<Card>` | `<ui.Card>` — komponentlar `ui` ichida |
