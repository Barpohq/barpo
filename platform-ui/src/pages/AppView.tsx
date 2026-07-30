import type { AppManifest, Widget } from '../data/mock'
import AiKorinish from '../components/AiKorinish'
import AmalTugmalari from '../components/AmalTugmalari'
import SozlamaFormasi from '../components/SozlamaFormasi'
import { useIlovaStatelari } from '../lib/ilova-statelari'
import { Card, StatTile, StatusDot } from '../ui'

/**
 * Vidjet matnidagi `{{state.yol}}` shablonlarini jonli qiymat bilan
 * almashtiradi.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ NEGA KERAK. Vidjetlar manifestda MATN sifatida saqlanadi, ya'ni     │
 * │ ular qotib qolgan. Jonli statelar esa alohida keladi. Shablonsiz    │
 * │ AI faqat `view` (JSX) orqali jonli ma'lumot ko'rsata olardi —       │
 * │ oddiy stat kartasi uchun bu ortiqcha murakkablik.                   │
 * │                                                                    │
 * │ Endi: `value: "{{cpu.foiz}}%"` → `"3.2%"`.                          │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Qiymat topilmasa shablon O'Z HOLICHA qoladi — bu ataylab: bo'sh satr
 * ko'rsatish "ma'lumot yo'q" ni yashirardi, foydalanuvchi esa nima
 * kutilayotganini ko'rmasdi.
 */
function shablonniQoy(matn: string, data: Record<string, unknown>): string {
  if (!matn.includes('{{')) return matn
  return matn.replace(/\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g, (toliq, yol: string) => {
    const qiymat = yolBoyichaOl(data, yol)
    if (qiymat === undefined || qiymat === null) return toliq
    return typeof qiymat === 'object' ? JSON.stringify(qiymat) : String(qiymat)
  })
}

/** `a.b[0].c` shaklidagi yo'l bo'yicha qiymat oladi */
function yolBoyichaOl(manba: unknown, yol: string): unknown {
  let joriy: unknown = manba
  for (const bolak of yol.split(/[.[\]]/).filter(Boolean)) {
    if (joriy === null || typeof joriy !== 'object') return undefined
    joriy = (joriy as Record<string, unknown>)[bolak]
  }
  return joriy
}

/** Vidjetdagi hamma matnga shablonni qo'llaydi */
function vidjetgaShablon(w: Widget, data: Record<string, unknown>): Widget {
  const s = (m: string) => shablonniQoy(m, data)

  switch (w.type) {
    case 'stats':
      return {
        ...w,
        items: w.items.map((i) => ({
          ...i,
          value: s(i.value),
          ...(i.hint ? { hint: s(i.hint) } : {}),
        })),
      }
    case 'bars':
      return {
        ...w,
        items: w.items.map((i) => {
          // `value` raqam bo'lishi shart (chiziq kengligi shundan
          // hisoblanadi), shuning uchun shablon natijasi qayta raqamga
          // aylantiriladi. Aylanmasa eski qiymat qoladi.
          const xom = typeof i.value === 'number' ? i.value : Number(s(String(i.value)))
          return { ...i, value: Number.isFinite(xom) ? xom : 0, label: s(i.label) }
        }),
      }
    case 'table':
      return { ...w, rows: w.rows.map((r) => r.map(s)) }
    case 'logs':
      return { ...w, lines: w.lines.map(s) }
    case 'note':
      return { ...w, text: s(w.text) }
    case 'deploy':
      return { ...w, ...(w.extra ? { extra: s(w.extra) } : {}) }
    default:
      return w
  }
}

// Manifest'dagi vidjet sxemasini UI'ga aylantiradi — ilovalar o'z dashboardini
// data sifatida olib keladi, host esa render qiladi (server-driven UI).
function WidgetView({ w }: { w: Widget }) {
  switch (w.type) {
    case 'stats':
      return (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {w.items.map((s) => (
            <StatTile key={s.label} label={s.label} value={s.value} hint={s.hint} accent={s.accent} />
          ))}
        </div>
      )
    case 'bars': {
      const max = Math.max(...w.items.map((i) => i.value))
      return (
        <Card className="p-5">
          <h2 className="mb-4 font-display text-sm font-semibold">{w.title}</h2>
          <div className="space-y-3">
            {w.items.map((i) => (
              <div key={i.label}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="text-xs">{i.label}</span>
                  <span className="font-mono text-xs text-muted">
                    {i.value}
                    {w.suffix ?? ''}
                  </span>
                </div>
                <div className="h-3 overflow-hidden rounded-r-[4px] bg-panel2">
                  <div className="h-full rounded-r-[4px] bg-s1" style={{ width: `${(i.value / max) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )
    }
    case 'table':
      return (
        <Card className="overflow-hidden">
          <h2 className="border-b border-line px-5 py-3 font-display text-sm font-semibold">{w.title}</h2>
          <div className="thin-scroll overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-faint">
                  {w.columns.map((c) => (
                    <th key={c} className="px-5 py-2 font-medium">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {w.rows.map((r, i) => (
                  <tr key={i} className="border-t border-line/60">
                    {r.map((cell, j) => (
                      <td key={j} className={`px-5 py-2.5 ${j === 0 ? 'font-mono text-xs text-faint' : 'text-[13px] text-muted'}`}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )
    case 'logs':
      return (
        <Card className="overflow-hidden">
          <h2 className="border-b border-line px-5 py-3 font-display text-sm font-semibold">{w.title}</h2>
          <div className="thin-scroll max-h-48 overflow-y-auto bg-bg px-4 py-3 font-mono text-xs leading-relaxed text-muted">
            {w.lines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
            <span className="cursor-blink text-lazur">▍</span>
          </div>
        </Card>
      )
    case 'deploy':
      return (
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wider text-faint">Deploy</div>
              <a
                href={w.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 block truncate font-mono text-lg text-lazur hover:underline"
              >
                {w.url}
              </a>
              {w.extra && <div className="mt-1.5 text-xs leading-relaxed text-muted">{w.extra}</div>}
            </div>
            <div className="space-y-1.5 text-right">
              <span
                className={`inline-block rounded-md px-2 py-1 font-mono text-[11px] ${
                  w.kind === 'domen' ? 'bg-lazur-dim/15 text-lazur' : 'bg-gold/15 text-gold'
                }`}
              >
                {w.kind === 'domen' ? '🌐 domen ulangan' : '🔌 port preview'}
              </span>
              <div className="font-mono text-[11px] text-faint">server: {w.server}</div>
              {w.ssl && <div className="font-mono text-[11px] text-faint">SSL: {w.ssl}</div>}
            </div>
          </div>
        </Card>
      )
    case 'git':
      return (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
            <h2 className="font-display text-sm font-semibold">Git</h2>
            <span className="font-mono text-[11px] text-faint">
              {w.repo} · <span className="text-lazur">{w.branch}</span>
            </span>
          </div>
          <ul>
            {w.commits.map((c) => (
              <li key={c.hash} className="flex items-baseline gap-3 border-t border-line/60 px-5 py-2.5 first:border-t-0">
                <span className="font-mono text-xs text-lazur">{c.hash}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{c.msg}</span>
                <span className="shrink-0 font-mono text-[11px] text-faint">{c.time}</span>
              </li>
            ))}
          </ul>
        </Card>
      )
    case 'note':
      return (
        <p className="rounded-xl border border-dashed border-line px-4 py-3 text-xs leading-relaxed text-muted">
          {w.text}
        </p>
      )
  }
}

export default function AppView({ app }: { app: AppManifest }) {
  // AI ko'rinishi endi HOST daraxtida ishlaydi — alohida React runtime
  // yuklash kerak emas (avval iframe uchun ~190 KB yuklanardi).

  // Jonli statelar — har biri o'z intervali bilan polling qilinadi.
  const { qiymatlar, holatlar, yangila, natijalarniQoy } = useIlovaStatelari(app.id, app.states)

  // Manifestdagi `data` — BOSHLANG'ICH qiymat, jonli statelar uning
  // ustiga yoziladi. Shu tartib muhim: birinchi renderda sahifa bo'sh
  // turmaydi, keyin qiymatlar jonli ma'lumot bilan almashadi.
  const data = { ...(app.data ?? {}), ...qiymatlar }

  // Hech qachon muvaffaqiyat bermagan statelar — ular uchun ogohlantirish
  // ko'rsatamiz. Bir marta ishlagan, keyin yiqilgani ko'rsatilmaydi:
  // ekranda eskirgan bo'lsa ham haqiqiy qiymat turibdi.
  const yiqilganlar = Object.entries(holatlar).filter(
    ([, h]) => h.xato && h.qiymat === undefined,
  )

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-panel2 text-xl" aria-hidden>
            {app.icon}
          </span>
          <div>
            <h1 className="flex items-center gap-2.5 font-display text-2xl font-semibold tracking-tight">
              {app.name}
              <span className="font-mono text-xs font-normal text-faint">{app.version}</span>
            </h1>
            <p className="mt-1 text-sm text-muted">{app.tagline}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusDot status={app.status} pulse={app.status === 'running'} />
          <span className="font-mono text-[11px] text-faint">{app.service}</span>
        </div>
      </header>

      <div className="space-y-4">
        {/*
          AI yozgan maxsus ko'rinish — VIDJETLARDAN OLDIN.
          U izolyatsiyada (sandbox iframe) ishlaydi: yiqilsa faqat o'zi
          o'chadi, quyidagi vidjetlar va butun platforma butun qoladi.
        */}
        {app.view && (
          <AiKorinish
            kod={app.view.kod}
            data={data}
            // `appId` berilishi `ui.saqla`/`ui.amal` ni ochadi. Boshqaruvsiz
            // ilovada ular BERILMAYDI — ko'rinish faqat chizadi.
            {...(app.sozlamalar || app.amallar?.length ? { appId: app.id } : {})}
            onAmal={(javob) => {
              if (javob.statelar) natijalarniQoy(javob.statelar)
            }}
            onSaqlandi={yangila}
          />
        )}

        {/*
          BOSHQARUV VIDJETLARDAN OLDIN. Sabab: foydalanuvchi bu sahifaga
          odatda BIR NARSA QILISH uchun kiradi (tokenni yangilash, botni
          restart qilish) — o'qish uchun sidebar'dagi holat ham yetadi.
          Amallarni jadval va loglar ostiga ko'chirish ularni izlashga
          majbur qilardi.
        */}
        {app.amallar && app.amallar.length > 0 && (
          <AmalTugmalari
            appId={app.id}
            amallar={app.amallar}
            onBajarildi={(javob) => {
              // Server `yangila` dagi statelarni allaqachon qayta hisoblab
              // qaytardi — qayta so'rov kerak emas.
              if (javob.statelar) natijalarniQoy(javob.statelar)
            }}
          />
        )}

        {app.sozlamalar && (
          <SozlamaFormasi
            appId={app.id}
            // Saqlangandan keyin ilova restart bo'lgan bo'lishi mumkin —
            // hamma state majburan yangilanadi.
            onSaqlandi={yangila}
          />
        )}

        {/*
          Ishlamayotgan statelar. Faqat HECH QACHON qiymat bermaganlari
          ko'rsatiladi — bir marta ishlagani uchun ekranda haqiqiy (garchi
          eskirgan) qiymat turibdi va ogohlantirish chalg'itardi.
        */}
        {yiqilganlar.length > 0 && (
          <Card className="p-4">
            <div className="text-xs font-medium uppercase tracking-wider text-gold">
              Ma'lumot olinmadi
            </div>
            <ul className="mt-2 space-y-1">
              {yiqilganlar.map(([nom, h]) => (
                <li key={nom} className="font-mono text-[11px] text-faint">
                  {nom}: {h.xato}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {app.widgets.map((w, i) => (
          <WidgetView key={i} w={vidjetgaShablon(w, data)} />
        ))}
      </div>

      <p className="mt-6 font-mono text-[11px] text-faint">
        Bu sahifa ilova manifestidan dinamik render qilindi — host UI qayta build qilinmagan.
      </p>
    </div>
  )
}
