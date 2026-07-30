import { useMemo, useState } from 'react'
import { auditLog, type AuditLevel } from '../data/mock'
import { LEVEL_LABEL, RESULT_LABEL } from '../lib/audit-yorliq'
import { Card, LevelBadge, PageHead } from '../ui'

// Kalitlar bazadan keladi (`seed.ts`) — yorliqlari `lib/audit-yorliq.ts` da
const resultStyle: Record<string, string> = {
  OK: 'text-mint',
  tasdiqlandi: 'text-mint',
  'rad etildi': 'text-coral',
  kutmoqda: 'text-gold',
}

/** `hammasi` — filtr qiymati, bazada uchramaydi */
const levels: (AuditLevel | 'hammasi')[] = ['hammasi', "o'qish", "o'zgartirish", 'xavfli']

const levelYorligi = (l: (typeof levels)[number]): string =>
  l === 'hammasi' ? 'all' : LEVEL_LABEL[l]

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
        sub="Every action is recorded: who, what, when and at which level. Append-only — it cannot be edited"
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-xs text-faint">Level:</span>
          {levels.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={`rounded-full px-3 py-1 text-xs transition ${
                level === l ? 'bg-lazur-dim font-semibold text-bg' : 'border border-line text-muted hover:text-ink'
              }`}
            >
              {levelYorligi(l)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-faint">
          Actor:
          <select
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            className="rounded-lg border border-line bg-panel px-2 py-1 font-mono text-xs text-ink"
          >
            {actors.map((a) => (
              <option key={a} value={a}>
                {a === 'hammasi' ? 'all' : a}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto font-mono text-[11px] text-faint">
          {rows.length} entries · today
        </span>
      </div>

      <Card className="overflow-hidden">
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-faint">
                <th className="px-5 py-2.5 font-medium">Time</th>
                <th className="px-3 py-2.5 font-medium">Actor</th>
                <th className="px-3 py-2.5 font-medium">Action</th>
                <th className="px-3 py-2.5 font-medium">Target</th>
                <th className="px-3 py-2.5 font-medium">Level</th>
                <th className="px-5 py-2.5 text-right font-medium">Result</th>
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
                  <td className={`px-5 py-2.5 text-right font-mono text-xs ${resultStyle[e.result]}`}>
                    {RESULT_LABEL[e.result] ?? e.result}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-sm text-faint">
                    No entries match this filter — try widening it
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
