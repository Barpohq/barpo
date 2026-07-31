// Hook tracking the agent streams running in the background.
//
// It is assembled from two sources and both are needed:
//   1) GET /api/chat/running — the initial state when the page opens. Relying
//      on the WS alone would show nothing when the page is opened IN THE
//      MIDDLE of a stream: the start event has already gone by.
//   2) `chat.status` events — later changes arrive live.
//
// `chat.status` is deliberately not filtered by session (see `eventSession()`
// in protocol.ts), so even a client with a single conversation open receives
// the status of every session — the sidebar relies on exactly that.

import { useEffect, useState } from 'react'
import type { StreamStatus } from '@platforma/shared'
import { fetchRunning } from './api'
import { ws } from './ws'

/** Session id → its current status. A finished session leaves the map. */
export type RunningMap = Record<string, 'running' | 'awaiting-permission'>

/** Session titles — they come from the initial list */
export type TitleMap = Record<string, string>

export interface RunningState {
  /** Sessions that are streaming right now */
  running: RunningMap
  /** Known titles — the Agents page shows these instead of ids */
  titles: TitleMap
  /** Is the initial list still loading */
  loading: boolean
}

/**
 * Is this an active status — i.e. should the session stay in the list.
 *
 * Written as a type guard: on `done`/`error` the session is removed from the
 * list, so only the other two values ever land in the map.
 */
function isActive(status: StreamStatus): status is 'running' | 'awaiting-permission' {
  return status === 'running' || status === 'awaiting-permission'
}

export function useRunning(): RunningState {
  const [running, setRunning] = useState<RunningMap>({})
  const [titles, setTitles] = useState<TitleMap>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    ws.connect()
    const unsubscribe = ws.subscribe(['chat'])
    const unwatch = ws.watch((event) => {
      if (event.type !== 'chat.status') return
      const status = event.status
      const sessionId = event.sessionId
      setRunning((previous) => {
        if (!isActive(status)) {
          if (!(sessionId in previous)) return previous
          const { [sessionId]: _removed, ...rest } = previous
          return rest
        }
        if (previous[sessionId] === status) return previous
        return { ...previous, [sessionId]: status }
      })
    })

    // The initial list is requested AFTER the WS subscription: the other way
    // round, an event arriving between the request and the subscription would
    // be lost and the session would stay stuck as "running".
    fetchRunning()
      .then((list) => {
        if (cancelled) return
        setRunning((previous) => {
          // Newer data from the WS wins: the initial list reflects the state at
          // the moment the request was sent and may already be stale.
          const initial: RunningMap = {}
          for (const s of list) initial[s.sessionId] = s.status
          return { ...initial, ...previous }
        })
        setTitles((previous) => {
          const next = { ...previous }
          for (const s of list) if (s.title) next[s.sessionId] = s.title
          return next
        })
      })
      .catch(() => {
        // If the server is unreachable the indicators simply do not appear —
        // this is a supplementary signal, showing an error for it is overkill
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      unsubscribe()
      unwatch()
    }
  }, [])

  return { running, titles, loading }
}
