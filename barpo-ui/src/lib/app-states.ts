// Hook that polls dashboard states.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ EVERY STATE GETS ITS OWN INTERVAL.                                   │
// │                                                                      │
// │ Values on a dashboard do not go stale at the same rate: CPU changes  │
// │ every 5 seconds, disk usage barely moves in 60. Tying them all to a  │
// │ single timer would make the fastest one recompute the whole set —    │
// │ `df` would run every 5 seconds for no reason.                        │
// │                                                                      │
// │ Hence a SEPARATE timer per state.                                    │
// └──────────────────────────────────────────────────────────────────────┘
//
// POLLING STOPS WHILE THE TAB IS IN THE BACKGROUND (`visibilitychange`):
// keeping `ssh` requests going while the user works in another window is
// wasteful. When the tab comes back it refreshes once immediately, so no stale
// value is left on screen.
//
// NO NEW ENDPOINT: the server already serves `/api/apps/:id/state/:name`, the
// AI only writes the code inside it.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppState } from '@barpo/shared'

/** Client-side state of a single dashboard state */
export interface StateEntry {
  /** Last successful value. On error the PREVIOUS one is kept. */
  value?: unknown
  /** Last error — the value is shown regardless, this is only a marker */
  error?: string
  /** Is a request in flight right now */
  loading: boolean
  /** Last successful refresh (ISO) */
  time?: string
}

export type StateMap = Record<string, StateEntry>

/** Result of one state request — the shape the server returns */
export interface StateResponse {
  ok: boolean
  value?: unknown
  error?: string
  time: string
}

/**
 * Polls the states and returns their values.
 *
 * `states` are the definitions from the manifest. A separate timer is built
 * for each of them (`interval` in seconds).
 */
export interface AppStatesHook {
  values: Record<string, unknown>
  entries: StateMap
  /** Forces a re-read of every state */
  refresh: () => void
  /** Applies results supplied from outside — without a new request */
  applyResults: (results: Record<string, StateResponse>) => void
}

export function useAppStates(
  appId: string,
  states: AppState[] | undefined,
): AppStatesHook {
  const [entries, setEntries] = useState<StateMap>({})

  // Turn the state list into a stable key: even if the manifest is a new
  // object on every render, the timers must not be rebuilt until its CONTENT
  // changes.
  const key = JSON.stringify(
    (states ?? []).map((s) => [s.name, s.interval ?? 0]),
  )

  // `states` is kept in a ref so the effect does not take it as a dependency
  // (the `key` above is enough).
  const statesRef = useRef(states)
  statesRef.current = states

  const read = useCallback(
    async (name: string, force = false) => {
      setEntries((e) => ({ ...e, [name]: { ...e[name], loading: true } }))
      try {
        const response = await fetch(
          `/api/apps/${encodeURIComponent(appId)}/state/${encodeURIComponent(name)}` +
            (force ? '?force=1' : ''),
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const r = (await response.json()) as StateResponse

        setEntries((e) => ({
          ...e,
          [name]: r.ok
            ? { value: r.value, loading: false, time: r.time }
            : // ON ERROR THE OLD VALUE IS KEPT: emptying the dashboard because
              // one `ssh` call failed is wrong — a stale value beats no value.
              { ...e[name], error: r.error, loading: false },
        }))
      } catch (error) {
        setEntries((e) => ({
          ...e,
          [name]: {
            ...e[name],
            error: error instanceof Error ? error.message : String(error),
            loading: false,
          },
        }))
      }
    },
    [appId],
  )

  useEffect(() => {
    const list = statesRef.current ?? []
    if (list.length === 0) return

    let alive = true
    const timers: ReturnType<typeof setInterval>[] = []

    // The first read happens immediately — the page must not sit empty.
    for (const s of list) void read(s.name)

    function startTimers() {
      for (const s of list) {
        const seconds = s.interval ?? 0
        // No `interval` — the value does not change, so no timer is needed.
        if (seconds <= 0) continue
        timers.push(
          setInterval(() => {
            if (alive) void read(s.name)
          }, seconds * 1000),
        )
      }
    }

    function clearTimers() {
      while (timers.length) clearInterval(timers.pop()!)
    }

    if (document.visibilityState === 'visible') startTimers()

    // Polling stops while the tab is in the background and refreshes at once
    // when it returns.
    function visibilityChanged() {
      if (document.visibilityState === 'visible') {
        for (const s of list) void read(s.name)
        startTimers()
      } else {
        clearTimers()
      }
    }

    document.addEventListener('visibilitychange', visibilityChanged)

    return () => {
      alive = false
      clearTimers()
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [appId, key, read])

  /** Force-refreshes every state (for the "refresh" button) */
  const refresh = useCallback(() => {
    for (const s of statesRef.current ?? []) void read(s.name, true)
  }, [read])

  /**
   * Applies results supplied from outside — WITHOUT a new request.
   *
   * When an action runs, the server has already recomputed the states listed
   * in `refresh` and returns them in the response (`routes/apps.ts`). Handing
   * them over here skips the second HTTP request entirely — so after pressing
   * restart the status updates IMMEDIATELY and `ssh` is not called twice.
   */
  const applyResults = useCallback(
    (results: Record<string, StateResponse>) => {
      setEntries((e) => {
        const next = { ...e }
        for (const [name, r] of Object.entries(results)) {
          next[name] = r.ok
            ? { value: r.value, loading: false, time: r.time }
            : // Same rule as with polling: on error the old value is kept.
              { ...e[name], error: r.error, loading: false }
        }
        return next
      })
    },
    [],
  )

  const values: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(entries)) {
    if (entry.value !== undefined) values[name] = entry.value
  }

  return { values, entries, refresh, applyResults }
}
