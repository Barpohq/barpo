import { useState } from 'react'
import { costDays, llmCalls, modelCosts } from '../data/mock'
import { Card, PageHead, StatTile } from '../ui'

const S1 = 'var(--color-s1)'
const S2 = 'var(--color-s2)'

// 7 kunlik xarajat — 2 seriyali stacked bar (agent kesimida)
function CostChart() {
  const [hover, setHover] = useState<number | null>(null)
  const W = 560
  const H = 180
  const pad = { l: 40, r: 8, t: 10, b: 24 }
  const max = 0.14
  const innerW = W - pad.l - pad.r
  const innerH = H - pad.t - pad.b
  const step = innerW / costDays.length
  const barW = Math.min(28, step * 0.5)
  const y = (v: number) => pad.t + innerH * (1 - v / max)

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="7 kunlik xarajat, agent kesimida">
        {[0, 0.05, 0.1].map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={W - pad.r} y1={y(g)} y2={y(g)} stroke="var(--color-line)" strokeWidth="1" />
            <text x={pad.l - 6} y={y(g) + 3} textAnchor="end" fontSize="10" fill="var(--color-faint)" fontFamily="var(--font-mono)">
              {g === 0 ? '0' : `$${g}`}
            </text>
          </g>
        ))}
        {costDays.map((d, i) => {
          const x = pad.l + step * i + (step - barW) / 2
          const hBot = innerH * (d.newsBot / max)
          const hMon = innerH * (d.monitor / max)
          const yBot = y(d.newsBot)
          return (
            <g
              key={d.day}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              opacity={hover === null || hover === i ? 1 : 0.45}
            >
              {/* hover nishoni — markdan kattaroq */}
              <rect x={pad.l + step * i} y={pad.t} width={step} height={innerH} fill="transparent" />
              <rect x={x} y={yBot} width={barW} height={hBot} rx="4" fill={S1} />
              {/* poydevor to'g'ri burchakli bo'lsin — pastki yumaloqlikni yopamiz */}
              <rect x={x} y={pad.t + innerH - Math.min(6, hBot)} width={barW} height={Math.min(6, hBot)} fill={S1} />
              {/* monitor segmenti — 2px bo'shliq bilan */}
              <rect x={x} y={yBot - hMon - 2} width={barW} height={hMon} rx="2" fill={S2} />
              <text x={x + barW / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--color-muted)" fontFamily="var(--font-mono)">
                {d.day}
              </text>
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute -top-1 rounded-lg border border-line bg-panel2 px-3 py-2 font-mono text-xs shadow-lg"
          style={{ left: `${((pad.l + step * hover + step / 2) / W) * 100}%`, transform: 'translateX(-50%)' }}
        >
          <div className="text-muted">{costDays[hover].day}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: S1 }} />
            news-bot ${costDays[hover].newsBot.toFixed(3)}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: S2 }} />
            monitor ${costDays[hover].monitor.toFixed(3)}
          </div>
        </div>
      )}
      <div className="mt-1 flex gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: S1 }} /> ai-news-bot</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: S2 }} /> server-monitor</span>
      </div>
    </div>
  )
}

// Model bo'yicha xarajat — bitta o'lchov, bitta rang, to'g'ridan-to'g'ri qiymat yorlig'i
function ModelChart() {
  const max = 2
  return (
    <div className="space-y-3">
      {modelCosts.map((m) => (
        <div key={m.model}>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="font-mono text-xs">{m.model}</span>
            <span className="text-[11px] text-faint">{m.task}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 flex-1 overflow-hidden rounded-r-[4px] bg-panel2">
              <div
                className="h-full rounded-r-[4px]"
                style={{ width: `${Math.max((m.cost / max) * 100, m.cost === 0 ? 0.8 : 2)}%`, background: S1 }}
              />
            </div>
            <span className="w-12 shrink-0 text-right font-mono text-xs text-muted">
              {m.cost === 0 ? 'bepul' : `$${m.cost.toFixed(2)}`}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function Dashboard() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead title="Boshqaruv paneli" sub="Xarajatlar, token sarfi va agentlar faoliyati — hammasi bir joyda" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Bugungi xarajat" value="$0.084" hint="kecha: $0.072" accent="var(--color-gold)" />
        <StatTile label="Oylik jami" value="$2.41" hint="~$0.60/post writer ulushi" />
        <StatTile label="Postlar (7 kun)" value="23" hint="21 nashr · 2 rad" />
        <StatTile label="Approval rate" value="96%" hint="avtonom rejimga: ≥95% ✓" accent="var(--color-lazur)" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="p-5 lg:col-span-3">
          <h2 className="mb-4 font-display text-sm font-semibold">Kunlik xarajat — 7 kun</h2>
          <CostChart />
        </Card>
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-4 font-display text-sm font-semibold">Model bo'yicha (30 kun)</h2>
          <ModelChart />
          <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-faint">
            Til sinovi tugagach writer flash modelga o'tsa, oylik xarajat ~5× tushadi.
          </p>
        </Card>
      </div>

      <Card className="mt-4 overflow-hidden">
        <h2 className="border-b border-line px-5 py-3 font-display text-sm font-semibold">
          Oxirgi LLM chaqiruvlari
        </h2>
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-faint">
                <th className="px-5 py-2 font-medium">Vaqt</th>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Vazifa</th>
                <th className="px-3 py-2 font-medium">Tokenlar</th>
                <th className="px-5 py-2 text-right font-medium">Narx</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              {llmCalls.map((c, i) => (
                <tr key={i} className="border-t border-line/60">
                  <td className="px-5 py-2.5 text-faint">{c.time}</td>
                  <td className="px-3 py-2.5">{c.agent}</td>
                  <td className="px-3 py-2.5 text-lazur">{c.model}</td>
                  <td className="px-3 py-2.5 text-muted">{c.task}</td>
                  <td className="px-3 py-2.5 text-muted">{c.tokens}</td>
                  <td className="px-5 py-2.5 text-right text-gold">{c.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
