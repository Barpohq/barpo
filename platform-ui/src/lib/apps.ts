// Hook tracking the list of apps (dynamic dashboards) in the sidebar.
//
// It is assembled from two sources and both are needed (same reason as in
// `running.ts`):
//   1) GET /api/apps — the state when the page opens. Relying on the WS alone
//      would leave the list EMPTY after a refresh: the `app.installed` event
//      has already gone by.
//   2) `app.installed` / `app.updated` — when the agent publishes a new
//      dashboard the sidebar updates immediately, without a refresh.
//
// THIS DID NOT EXIST BEFORE: the sidebar was built from a mock list
// (`installedApps`) and never read from the server. As a result a dashboard
// never showed up even though `appPublish` had written it to the database —
// not even a refresh helped.

import { useEffect, useState } from 'react'
import { CHANNELS, type AppManifest } from '@platforma/shared'
import { fetchApps } from './api'
import { ws } from './ws'

export interface AppsState {
  apps: AppManifest[]
  /** Is the initial list still loading */
  loading: boolean
}

/** Adds a manifest to the list or replaces the existing one */
function merge(list: AppManifest[], incoming: AppManifest): AppManifest[] {
  const index = list.findIndex((a) => a.id === incoming.id)
  if (index === -1) return [...list, incoming]
  const copy = [...list]
  copy[index] = incoming
  return copy
}

export function useApps(): AppsState {
  const [apps, setApps] = useState<AppManifest[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    ws.connect()
    const unsubscribe = ws.subscribe([CHANNELS.apps])
    const unwatch = ws.watch((event) => {
      // A deletion carries the ID ALONE — by the time it is sent the folder is
      // gone, so there is no manifest left to describe.
      if (event.type === 'app.removed') {
        setApps((previous) => previous.filter((a) => a.id !== event.id))
        return
      }
      if (event.type !== 'app.installed' && event.type !== 'app.updated') return
      setApps((previous) => merge(previous, event.manifest))
    })

    // The initial list is requested AFTER the WS subscription: the other way
    // round, a dashboard published between the request and the subscription
    // would be lost.
    fetchApps()
      .then((list) => {
        if (cancelled) return
        setApps((previous) => {
          // A newer manifest that arrived over the WS WINS: it may have been
          // updated while the request was in flight, so we do not overwrite it
          // with the older copy.
          const known = new Set(previous.map((a) => a.id))
          return [...previous, ...list.filter((a) => !known.has(a.id))]
        })
      })
      .catch(() => {
        // If the list does not arrive the sidebar stays empty — that does not
        // bring the platform down, and the WS may fill it in later.
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      unwatch()
      unsubscribe()
    }
  }, [])

  return { apps, loading }
}
