// Hook managing the conversation list — the single source for the sidebar and
// the "Conversations" page.
//
// Difference from `useRunning()`: that one tracks ONLY the sessions currently
// streaming (for the live indicator), while this one returns ALL conversations
// — finished ones and ones that never started.
//
// Refresh policy: the list comes from REST, then it is re-requested whenever
// `chat.status` events arrive. Why re-request instead of building from the
// event? Title, message count and ordering are computed on the server —
// recomputing them on the client would mean maintaining two sources of truth.
// And `chat.status` is rare (a stream starting or finishing), so the number of
// requests stays small.
//
// `chat.status` is DELIBERATELY not filtered by session (see `eventSession()`
// in protocol.ts) — so even with a single conversation open, the completion of
// other conversations reaches this hook.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatSession } from '@platforma/shared'
import { fetchSessions } from './api'
import { ws } from './ws'

export interface ConversationsState {
  /** All conversations, by last activity (newest first) */
  conversations: ChatSession[]
  /** Has the first load finished */
  loading: boolean
  /** The list failed to load at all (server unreachable) */
  error: boolean
  /** Re-request the list by hand — after a delete or an edit */
  refresh: () => void
  /**
   * Change the list locally without waiting for the server.
   *
   * Used on delete and rename so the UI does not freeze until the response
   * arrives. `refresh()` is still called once the server replies.
   */
  update: (updater: (previous: ChatSession[]) => ChatSession[]) => void
}

/** Consecutive `chat.status` events are coalesced into one request (ms) */
const COALESCE_DELAY = 300

export function useConversations(): ConversationsState {
  const [conversations, setConversations] = useState<ChatSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  /** So state is not written after the component unmounts */
  const aliveRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(() => {
    fetchSessions()
      .then((list) => {
        if (!aliveRef.current) return
        setConversations(list)
        setError(false)
      })
      .catch(() => {
        if (aliveRef.current) setError(true)
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    aliveRef.current = true
    ws.connect()
    const unsubscribe = ws.subscribe(['chat'])

    // A stream starting or finishing changes the list: a new conversation
    // appears, or the ordering and title change. The events can arrive back to
    // back (several sessions finishing at once), so we coalesce them into a
    // single request with a short delay.
    const unwatch = ws.watch((event) => {
      if (event.type !== 'chat.status') return
      if (timerRef.current) return
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        refresh()
      }, COALESCE_DELAY)
    })

    refresh()

    return () => {
      aliveRef.current = false
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      unsubscribe()
      unwatch()
    }
  }, [refresh])

  return { conversations, loading, error, refresh, update: setConversations }
}
