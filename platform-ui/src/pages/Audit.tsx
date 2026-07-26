import { useMemo, useState } from 'react'
import { auditLog, type AuditLevel } from '../data/mock'
import { Card, LevelBadge, PageHead } from '../ui'

const resultStyle: Record<string, string> = {
  OK: 'text-mint',
  tasdiqlandi: 'text-mint',
  'rad etildi': 'text-coral',
  kutmoqda: 'text-gold',
}

const levels: (AuditLevel | 'hammasi')[] = ['hammasi', "o'qish", "o'zgartirish", 'xavfli']

export default function Audit() {
  const [level, setLevel] = useState<(typeof levels)[number]>('hammasi')
  const [actor, setActor] = useState('hammasi')

  const actors = useMemo(() => ['hammasi', ...new Set(auditLog.map((e) => e.actor))], [])
  const rows = auditLog.filter(
    (e) => (level === 'hammasi' || e.level === level) && (actor === 'hammasi' || e.actor === actor),
  )

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="Audit log"
        sub="Har bir amal yozib boriladi: kim, nima, qachon, qanday daraja bilan. Append-only — o'zgartirib bo'lmaydi"
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-xs text-faint">Daraja:</span>
          {levels.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={`rounded-full px-3 py-1 text-xs transition ${
                level === l ? 'bg-lazur-dim font-semibold text-bg' : 'border border-line text-muted hover:text-ink'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-faint">
          Aktor:
          <select
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            className="rounded-lg border border-line bg-panel px-2 py-1 font-mono text-xs text-ink"
          >
            {actors.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <span className="ml-auto font-mono text-[11px] text-faint">{rows.length} yozuv · bugun</span>
      </div>

      <Card className="overflow-hidden">
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-faint">
                <th className="px-5 py-2.5 font-medium">Vaqt</th>
                <th className="px-3 py-2.5 font-medium">Aktor</th>
                <th className="px-3 py-2.5 font-medium">Amal</th>
                <th className="px-3 py-2.5 font-medium">Nishon</th>
                <th className="px-3 py-2.5 font-medium">Daraja</th>
                <th className="px-5 py-2.5 text-right font-medium">Natija</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={i} className="border-t border-line/60">
                  <td className="px-5 py-2.5 font-mono text-xs text-faint">{e.time}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-lazur">{e.actor}</td>
                  <td className="px-3 py-2.5 text-[13px]">{e.action}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-muted">{e.target}</td>
                  <td className="px-3 py-2.5"><LevelBadge level={e.level} /></td>
                  <td className={`px-5 py-2.5 text-right font-mono text-xs ${resultStyle[e.result]}`}>{e.result}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-sm text-faint">
                    Bu filtrga mos yozuv yo'q — filtrlarni kengaytiring
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
