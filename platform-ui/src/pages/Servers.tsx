import { servers } from '../data/mock'
import { Card, Meter, PageHead, StatusDot } from '../ui'

export default function Servers() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="Serverlar"
        sub="Har bir serverda agent daemon — outbound WebSocket bilan ulanadi, port ochilmaydi, parol uzatilmaydi"
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {servers.map((s) => (
          <Card key={s.id} className={`p-5 ${s.status === 'warning' ? 'border-gold/40' : ''}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="font-mono text-[15px] font-semibold">{s.name}</h2>
                <div className="mt-0.5 text-xs text-muted">{s.role}</div>
                <div className="text-[11px] text-faint">{s.region}</div>
              </div>
              <StatusDot status={s.status} />
            </div>

            <div className="mt-4 space-y-2.5">
              {(['cpu', 'ram', 'disk'] as const).map((k) => (
                <div key={k} className="flex items-center gap-3">
                  <span className="w-8 font-mono text-[11px] uppercase text-faint">{k}</span>
                  <div className="flex-1">
                    <Meter value={s[k]} />
                  </div>
                </div>
              ))}
            </div>

            {s.note && (
              <p className="mt-3 rounded-lg bg-gold/10 px-3 py-2 text-xs leading-relaxed text-gold">
                {s.note}
              </p>
            )}

            <div className="mt-4 flex items-center justify-between border-t border-line pt-3 font-mono text-[11px] text-faint">
              <span>daemon {s.daemon}</span>
              <span>uptime {s.uptime}</span>
            </div>
          </Card>
        ))}

        <Card className="flex flex-col items-center justify-center border-dashed p-5 text-center">
          <div className="font-display text-sm font-semibold text-muted">Server qo'shish</div>
          <p className="mt-2 text-xs leading-relaxed text-faint">
            Bitta buyruq bilan daemon o'rnatiladi va server o'zi ulanadi:
          </p>
          <code className="mt-3 rounded-lg bg-bg px-3 py-2 font-mono text-[11px] text-lazur">
            curl -sL platforma.uz/agent | sh
          </code>
        </Card>
      </div>

      <Card className="mt-4 p-5">
        <h2 className="font-display text-sm font-semibold">Ruxsat darajalari</h2>
        <div className="mt-3 grid gap-3 text-sm md:grid-cols-3">
          <div className="rounded-lg bg-panel2 p-3">
            <div className="font-mono text-xs text-[#9dc0ef]">o'qish</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">Loglar, status, metrikalar — avtomatik bajariladi</p>
          </div>
          <div className="rounded-lg bg-panel2 p-3">
            <div className="font-mono text-xs text-[#e5c37f]">o'zgartirish</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">Deploy, restart, config — sozlanadigan (avto yoki tasdiq bilan)</p>
          </div>
          <div className="rounded-lg bg-panel2 p-3">
            <div className="font-mono text-xs text-[#ef978e]">xavfli</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">rm -rf, DROP DATABASE, DNS — har doim inson tasdig'i bilan</p>
          </div>
        </div>
      </Card>
    </div>
  )
}
