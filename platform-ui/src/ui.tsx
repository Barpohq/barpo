import type { ReactNode } from 'react'
import type { AuditLevel } from './data/mock'
import { LEVEL_LABEL } from './lib/audit-label'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-line bg-panel ${className}`}>
      {children}
    </div>
  )
}

export function PageHead({ title, sub }: { title: string; sub: string }) {
  return (
    <header className="mb-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted">{sub}</p>
    </header>
  )
}

export function StatTile({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-2 font-mono text-2xl font-semibold" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-faint">{hint}</div>}
    </Card>
  )
}

const statusMap = {
  running: { color: 'var(--color-mint)', label: 'running' },
  idle: { color: 'var(--color-muted)', label: 'idle' },
  paused: { color: 'var(--color-gold)', label: 'paused' },
  healthy: { color: 'var(--color-mint)', label: 'healthy' },
  warning: { color: 'var(--color-gold)', label: 'warning' },
  offline: { color: 'var(--color-coral)', label: 'offline' },
} as const

export function StatusDot({ status, pulse = false }: { status: keyof typeof statusMap; pulse?: boolean }) {
  const s = statusMap[status]
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span
        className={`inline-block size-2 rounded-full ${pulse ? 'pulse-dot' : ''}`}
        style={{ background: s.color }}
        aria-hidden
      />
      {s.label}
    </span>
  )
}

// `AuditLevel` values COME FROM THE DATABASE and are locked down by the
// `CHECK` constraint in `001-initial.ts` — changing them takes a migration.
// The value is therefore used as-is, and the UI renders its label through the
// map below.
//
// The map lives in `lib/audit-label.ts`: this file must only export components
// (a Vite fast refresh requirement).
const levelStyle: Record<AuditLevel, { bg: string; fg: string }> = {
  read: { bg: 'color-mix(in oklab, var(--color-s3) 18%, transparent)', fg: '#9dc0ef' },
  write: { bg: 'color-mix(in oklab, var(--color-gold) 16%, transparent)', fg: '#e5c37f' },
  dangerous: { bg: 'color-mix(in oklab, var(--color-coral) 18%, transparent)', fg: '#ef978e' },
}

export function LevelBadge({ level }: { level: AuditLevel }) {
  const s = levelStyle[level]
  return (
    <span
      className="inline-block rounded-md px-1.5 py-0.5 font-mono text-[11px]"
      style={{ background: s.bg, color: s.fg }}
    >
      {LEVEL_LABEL[level]}
    </span>
  )
}

export function Meter({ value, warnAt = 80 }: { value: number; warnAt?: number }) {
  const color = value >= warnAt ? 'var(--color-gold)' : 'var(--color-lazur-dim)'
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel2" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="w-9 shrink-0 text-right font-mono text-xs text-muted">{value}%</span>
    </div>
  )
}
