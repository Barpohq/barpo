// Live indicator next to a session — shows that an agent is running in the
// background.
//
// The two states deliberately look different:
//   running             — a quiet blinking dot, it demands no attention;
//   awaiting-permission — a GOLD badge, because it will never move on without
//                         the user (the agent has stopped and is waiting).

interface Props {
  status: 'running' | 'awaiting-permission'
  /** Show text next to the badge as well (for the Agents page) */
  withText?: boolean
}

export default function StreamIndicator({ status, withText = false }: Props) {
  if (status === 'awaiting-permission') {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px]"
        style={{
          background: 'color-mix(in oklab, var(--color-gold) 18%, transparent)',
          color: 'var(--color-gold)',
        }}
        title="Agent is waiting for permission"
      >
        <span className="pulse-dot inline-block size-1.5 rounded-full bg-gold" aria-hidden />
        {withText ? 'awaiting permission' : 'permission'}
      </span>
    )
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-muted"
      title="Agent is running"
    >
      <span
        className="pulse-dot inline-block size-1.5 rounded-full"
        style={{ background: 'var(--color-mint)' }}
        aria-hidden
      />
      {withText && 'running'}
    </span>
  )
}
