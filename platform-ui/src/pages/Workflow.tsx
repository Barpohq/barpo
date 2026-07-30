import { workflowSteps } from '../data/mock'
import { Card, PageHead } from '../ui'

const stepColor = {
  done: 'var(--color-lazur-dim)',
  running: 'var(--color-gold)',
  waiting: 'var(--color-faint)',
} as const

const stepLabel = { done: 'done', running: 'running', waiting: 'queued' } as const

export default function Workflow() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <PageHead
        title="Workflow — news pipeline"
        sub="Today's run #212 · every stage is independent; on failure it resumes from here"
      />

      <div className="relative">
        {/* vertical line */}
        <div className="absolute top-2 bottom-6 left-[15px] w-px bg-line" aria-hidden />

        <div className="space-y-3">
          {workflowSteps.map((s, i) => (
            <div key={s.id} className="relative flex gap-4">
              <div
                className={`z-10 mt-4 flex size-8 shrink-0 items-center justify-center rounded-full border-2 bg-bg font-mono text-xs ${s.status === 'running' ? 'pulse-dot' : ''}`}
                style={{ borderColor: stepColor[s.status], color: stepColor[s.status] }}
              >
                {s.status === 'done' ? '✓' : i + 1}
              </div>

              <Card className={`flex-1 p-4 ${s.status === 'running' ? 'border-gold/50' : ''}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-2.5">
                    <h2 className="font-display text-[15px] font-semibold">{s.name}</h2>
                    <span className="text-xs text-faint">{s.desc}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm" style={{ color: stepColor[s.status] }}>
                      {s.stat}
                    </span>
                    <span className="rounded-md bg-panel2 px-2 py-0.5 font-mono text-[10px] text-muted">
                      {stepLabel[s.status]}
                    </span>
                  </div>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">{s.detail}</p>
              </Card>
            </div>
          ))}
        </div>
      </div>

      <Card className="mt-6 p-5">
        <h2 className="font-display text-sm font-semibold">Today's funnel</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-xs">
          {[
            ['412', 'items'],
            ['247', 'clusters'],
            ['151', 'accepted'],
            ['26', 'enriched'],
            ['5', 'posts'],
            ['4', 'published'],
          ].map(([n, label], i, arr) => (
            <span key={label} className="flex items-center gap-2">
              <span className="rounded-lg bg-panel2 px-3 py-1.5">
                <span className="text-ink">{n}</span> <span className="text-faint">{label}</span>
              </span>
              {i < arr.length - 1 && <span className="text-faint">→</span>}
            </span>
          ))}
        </div>
      </Card>
    </div>
  )
}
