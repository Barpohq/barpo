// Agents page — the real agent streams running in the background.
//
// An "agent" here = a chat session with a stream running. The stream already
// runs in background mode on the server (the orchestrator is
// fire-and-forget); this page is its presentation layer: who is running, who
// is awaiting permission, and the stop button.
//
// The data source is `useRunning()`: the initial list from REST, subsequent
// changes from `chat.status` WS events.

import { useState } from 'react'
import StreamIndicator from '../components/StreamIndicator'
import { stopStream } from '../lib/api'
import { useRunning } from '../lib/running'
import { Card, PageHead } from '../ui'

export default function Agents() {
  const { running, titles, loading } = useRunning()
  /** Sessions whose stop request was sent but whose status has not arrived yet */
  const [stopping, setStopping] = useState<Record<string, true>>({})

  const list = Object.entries(running)

  async function stop(sessionId: string) {
    setStopping((s) => ({ ...s, [sessionId]: true }))
    try {
      await stopStream(sessionId)
      // We do not remove it from the list — the server sends a final
      // `chat.status` and the hook takes it out itself. That keeps the UI in
      // sync with the server: if stopping failed the session stays visible.
    } catch {
      // On error the button is restored — so the user can try again
      setStopping((s) => {
        const { [sessionId]: _removed, ...rest } = s
        return rest
      })
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="Agents"
        sub="Agent streams running in the background — each one belongs to a single chat"
      />

      {loading && list.length === 0 && (
        <p className="text-sm text-faint">Loading…</p>
      )}

      {!loading && list.length === 0 && (
        <Card className="px-6 py-10 text-center">
          <p className="text-sm text-muted">No agents are running right now.</p>
          <p className="mt-1.5 text-xs text-faint">
            Send a message in chat — the stream shows up here live.
          </p>
        </Card>
      )}

      {list.length > 0 && (
        <div className="space-y-3">
          {list.map(([sessionId, status]) => (
            <Card key={sessionId} className="flex items-center gap-4 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <h2 className="truncate font-mono text-sm font-semibold text-lazur">
                    {titles[sessionId] ?? 'Untitled chat'}
                  </h2>
                  <StreamIndicator status={status} withText />
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-faint">{sessionId}</p>
              </div>

              <button
                onClick={() => void stop(sessionId)}
                disabled={stopping[sessionId]}
                className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-muted transition enabled:hover:border-coral enabled:hover:text-coral disabled:opacity-40"
              >
                {stopping[sessionId] ? 'Stopping…' : 'Stop'}
              </button>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
