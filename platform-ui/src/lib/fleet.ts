// Hook feeding the header ticker: how many servers are connected and whether
// any of them is running out of disk.
//
// The ticker used to show made-up numbers ("5/5 servers connected",
// "helsinki-1 disk 84%") that stayed the same whether you had five servers or
// none. Everything here is read from the real endpoints instead.
//
// Every metric costs a LIVE SSH connection (`/api/servers/:id/metrics` opens
// one per call — see servers.ts), so the fleet is polled slowly and the
// requests for the individual servers are issued together, not in a chain.

import { useEffect, useState } from 'react'
import type { ServerMetrics } from '@platforma/shared'
import { fetchServers, fetchServerMetrics } from './api'

/** How often the fleet is re-read. SSH is expensive, and disk usage is slow-moving. */
const REFRESH_MS = 60_000

/** Above this the disk gets its own ticker item — below it, nothing is shown. */
const DISK_WARN = 80

export interface FleetState {
  /** How many servers are registered at all */
  total: number
  /** How many of them answered over SSH */
  connected: number
  /** The most loaded disk once it passes the warning line */
  diskWarning?: { server: string; disk: number }
  /** True until the first pass finishes — the ticker stays quiet meanwhile */
  loading: boolean
}

const EMPTY: FleetState = { total: 0, connected: 0, loading: true }

export function useFleet(): FleetState {
  const [state, setState] = useState<FleetState>(EMPTY)

  useEffect(() => {
    let cancelled = false

    async function load() {
      let servers: Awaited<ReturnType<typeof fetchServers>>['servers']
      try {
        servers = (await fetchServers()).servers
      } catch {
        // The server list is unreachable — the ticker simply shows nothing.
        // This is a supplementary signal; an error banner would be overkill.
        if (!cancelled) setState({ total: 0, connected: 0, loading: false })
        return
      }
      if (cancelled) return

      if (servers.length === 0) {
        setState({ total: 0, connected: 0, loading: false })
        return
      }

      // In parallel: with five servers a chain would mean five SSH round trips
      // one after another. A failed metric counts as "not connected", which is
      // exactly what it means.
      const results = await Promise.all(
        servers.map((s) =>
          fetchServerMetrics(s.id)
            .then((r) => ({ name: s.name, metrics: r.metrics }))
            .catch(() => ({ name: s.name, metrics: { status: 'error' } as ServerMetrics })),
        ),
      )
      if (cancelled) return

      const online = results.filter((r) => r.metrics.status === 'connected')

      // The worst disk wins — one warning line is enough; the Servers page has
      // the full picture.
      let diskWarning: FleetState['diskWarning']
      for (const r of online) {
        const disk = r.metrics.disk
        if (disk === undefined || disk < DISK_WARN) continue
        if (!diskWarning || disk > diskWarning.disk) diskWarning = { server: r.name, disk }
      }

      setState({
        total: servers.length,
        connected: online.length,
        diskWarning,
        loading: false,
      })
    }

    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return state
}
