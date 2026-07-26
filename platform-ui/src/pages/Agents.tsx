import { useEffect, useRef, useState } from 'react'
import { agents, botLogLines } from '../data/mock'
import { Card, PageHead, StatusDot } from '../ui'

function LogStream() {
  const [n, setN] = useState(6)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (n >= botLogLines.length) return
    const t = setTimeout(() => setN((v) => v + 1), 1400)
    return () => clearTimeout(t)
  }, [n])

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight })
  }, [n])

  return (
    <div ref={boxRef} className="thin-scroll h-64 overflow-y-auto bg-bg px-4 py-3 font-mono text-xs leading-relaxed">
      {botLogLines.slice(0, n).map((l, i) => {
        const warn = l.includes('403') || l.includes('takror')
        return (
          <div key={i} className={warn ? 'text-gold' : 'text-muted'}>
            {l}
          </div>
        )
      })}
      {n < botLogLines.length && <span className="cursor-blink text-lazur">▍</span>}
    </div>
  )
}

export default function Agents() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead title="Agentlar" sub="Platformada ishlayotgan avtonom agentlar — har biri o'z jadvali va byudjeti bilan" />

      <div className="grid gap-4 lg:grid-cols-2">
        {agents.map((a) => (
          <Card key={a.id} className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-mono text-[15px] font-semibold text-lazur">{a.name}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{a.desc}</p>
              </div>
              <StatusDot status={a.status} pulse={a.status === 'running'} />
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4">
              {a.metrics.map((m) => (
                <div key={m.label}>
                  <dt className="text-[11px] uppercase tracking-wider text-faint">{m.label}</dt>
                  <dd className="mt-0.5 font-mono text-lg font-semibold">{m.value}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-xs text-muted">
              <div><span className="text-faint">Jadval:</span> {a.schedule}</div>
              <div><span className="text-faint">Keyingi run:</span> {a.nextRun}</div>
              <div><span className="text-faint">Modellar:</span> <span className="font-mono">{a.model}</span></div>
              <div>
                <span className="text-faint">Bugun:</span>{' '}
                <span className="font-mono text-gold">${a.todayCost.toFixed(3)}</span> · {a.todayCalls} chaqiruv
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card className="mt-4 overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="font-display text-sm font-semibold">ai-news-bot · jonli loglar</h2>
          <span className="font-mono text-[11px] text-faint">run #212 · bugun</span>
        </div>
        <LogStream />
      </Card>
    </div>
  )
}
