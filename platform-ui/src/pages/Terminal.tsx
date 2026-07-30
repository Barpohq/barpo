import { useEffect, useRef, useState } from 'react'
import { tmuxLines } from '../data/mock'
import { Card, PageHead } from '../ui'

const kindStyle: Record<string, string> = {
  cmd: 'text-ink',
  info: 'text-muted',
  tool: 'text-lazur',
  out: 'text-faint',
  warn: 'text-gold',
  wait: 'text-gold',
}

export default function Terminal() {
  const [n, setN] = useState(1)
  const [approved, setApproved] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const finished = n >= tmuxLines.length

  useEffect(() => {
    if (finished) return
    const t = setTimeout(() => setN((v) => v + 1), 900)
    return () => clearTimeout(t)
  }, [n, finished])

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight })
  }, [n, approved])

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <PageHead
        title="Terminal"
        sub="A command given in chat starts Claude Code in a tmux session in the background — in Pro mode you watch it live"
      />

      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line bg-panel2 px-4 py-2">
          <span className="flex gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-coral/70" />
            <span className="size-2.5 rounded-full bg-gold/70" />
            <span className="size-2.5 rounded-full bg-mint/70" />
          </span>
          <span className="ml-2 font-mono text-xs text-muted">tmux: claude-code · helsinki-1 · 0:1</span>
          <span className="ml-auto rounded-md bg-bg px-2 py-0.5 font-mono text-[10px] text-lazur">live</span>
        </div>

        <div ref={boxRef} className="thin-scroll h-80 overflow-y-auto bg-bg px-4 py-3 font-mono text-[13px] leading-relaxed">
          {tmuxLines.slice(0, n).map((l, i) => (
            <div key={i} className={kindStyle[l.kind]}>
              {l.text}
            </div>
          ))}
          {approved && (
            <>
              <div className="text-mint">✓ Approved (firdavs, via chat)</div>
              <div className="text-muted">● Bash(rm -r models_cache/bge-m3-unused-snapshot-0612)</div>
              <div className="text-faint">  ⎿ 1.8G freed · disk: 84% → 61%</div>
              <div className="text-mint">✓ Done — result returned to chat and written to the audit log</div>
            </>
          )}
          {!finished && <span className="cursor-blink text-lazur">▍</span>}
        </div>

        {finished && !approved && (
          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
            <span className="text-sm text-gold">Action is at the "write" level — awaiting approval</span>
            <div className="flex gap-2">
              <button
                onClick={() => setApproved(true)}
                className="rounded-lg bg-lazur-dim px-3.5 py-1.5 text-sm font-semibold text-bg transition hover:brightness-110"
              >
                ✅ Approve
              </button>
              <button className="rounded-lg border border-line px-3.5 py-1.5 text-sm text-muted transition hover:border-coral hover:text-coral">
                ❌ Deny
              </button>
            </div>
          </div>
        )}
      </Card>

      <p className="mt-4 text-xs leading-relaxed text-faint">
        In simple mode this session is hidden — the user only sees the result in chat.
        Pro mode opens up every layer: tmux, logs, audit.
      </p>
    </div>
  )
}
