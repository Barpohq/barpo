// Permission request — appears in the chat when the agent attempts a
// dangerous action.
//
// Three choices: allow once, allow always (for the session) and deny. If no
// answer comes the server denies it itself after 5 minutes — so leaving the
// card unanswered is safe too.
//
// The "Always" button shows the pattern (`rm`, `git push`, or a file path) so
// the user knows exactly what they are permitting.

import { useState } from 'react'
import type { PermissionAnswer, PermissionRequest } from '@barpo/shared'
import { Card } from '../ui'

interface Props {
  request: PermissionRequest
  onAnswer: (answer: PermissionAnswer) => void
}

const kindIcon: Record<PermissionRequest['kind'], string> = {
  file: '📁',
  command: '⌘',
  mcp: '🔌',
}

/**
 * Shortens the pattern for the button label. File patterns contain the full
 * path (`read:/home/ms/.ssh/config`) — it does not fit on the button. The full
 * text stays in `title`.
 */
function patternLabel(pattern: string): string {
  const isPath = pattern.includes('/')
  if (!isPath) return pattern
  const [action, ...rest] = pattern.split(':')
  const path = rest.join(':') || pattern
  const name = path.split('/').filter(Boolean).pop() ?? path
  return rest.length > 0 ? `${action}: …/${name}` : `…/${name}`
}

export default function PermissionCard({ request, onAnswer }: Props) {
  // Once answered the card is removed from the chat (Chat.tsx). This flag
  // prevents a second click during the gap before it is removed.
  const [sending, setSending] = useState(false)

  function answer(value: PermissionAnswer) {
    if (sending) return
    setSending(true)
    onAnswer(value)
  }

  return (
    <Card className="mt-3 overflow-hidden border-gold/40">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-xs">
        <span className="pulse-dot inline-block size-1.5 rounded-full bg-gold" aria-hidden />
        <span className="text-gold">permission requested</span>
        <span className="text-faint">· {request.action}</span>
      </div>

      <div className="px-4 py-3">
        <div className="flex items-start gap-2">
          <span className="shrink-0" aria-hidden>
            {kindIcon[request.kind]}
          </span>
          <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-ink">
            {request.target}
          </code>
        </div>
        <p className="mt-2 text-sm text-muted">{request.reason}</p>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
        <button
          onClick={() => answer('allow')}
          disabled={sending}
          className="rounded-lg bg-lazur-dim px-3.5 py-1.5 text-sm font-semibold text-bg transition enabled:hover:brightness-110 disabled:opacity-40"
        >
          Allow
        </button>
        {request.pattern && (
          <button
            onClick={() => answer('always')}
            disabled={sending}
            className="max-w-[16rem] truncate rounded-lg border border-line px-3.5 py-1.5 text-sm text-muted transition enabled:hover:border-lazur-dim enabled:hover:text-ink disabled:opacity-40"
            title={`Won't be asked again for «${request.pattern}» in this chat`}
          >
            Always ({patternLabel(request.pattern)})
          </button>
        )}
        <button
          onClick={() => answer('deny')}
          disabled={sending}
          className="rounded-lg border border-line px-3.5 py-1.5 text-sm text-muted transition enabled:hover:border-coral enabled:hover:text-coral disabled:opacity-40"
        >
          Deny
        </button>
      </div>
    </Card>
  )
}
