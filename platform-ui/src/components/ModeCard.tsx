// The card shown in the chat when auto mode turns itself off.
//
// There are three possible reasons: the classifier failed, three blocks in a
// row, or twenty blocks in total in the session. In all three the agent keeps
// working — only now every dangerous action is asked about.
//
// There is no automatic recovery: the user has to press "Re-enable". The
// reason being that a mode changing back on its own would be confusing.

import { useState } from 'react'
import { Card } from '../ui'

interface Props {
  reason: string
  onReEnable: () => void
}

export default function ModeCard({ reason, onReEnable }: Props) {
  const [clicked, setClicked] = useState(false)

  return (
    <Card className="mt-3 overflow-hidden border-gold/40">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-gold">
            <span aria-hidden>⚠︎</span>
            <span>Auto mode turned off</span>
          </div>
          <p className="mt-1 text-sm text-muted">{reason}</p>
          <p className="mt-1 text-xs text-faint">
            The agent keeps working — every dangerous action is now asked about.
          </p>
        </div>
        <button
          onClick={() => {
            setClicked(true)
            onReEnable()
          }}
          disabled={clicked}
          className="shrink-0 rounded-lg border border-line px-3.5 py-1.5 text-sm text-muted transition enabled:hover:border-lazur-dim enabled:hover:text-ink disabled:opacity-40"
        >
          {clicked ? 'Enabling…' : 'Re-enable'}
        </button>
      </div>
    </Card>
  )
}
