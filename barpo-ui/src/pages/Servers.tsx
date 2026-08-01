// Servers page — real SSH management.
//
// Adding a server = the backend installs the platform key on it, after which
// `ssh <name>` works without a password in your terminal TOO. The metrics on
// the card are read live over SSH every time the page opens (they are not
// stored in the database), so on a slow server the card sits in the "checking"
// state for a few seconds — that is not an error.

import { useCallback, useEffect, useState } from 'react'
import type { Server, ServerMetrics } from '@barpo/shared'
import {
  ApiError,
  fetchServerMetrics,
  deleteServer,
  addServer,
  fetchServers,
} from '../lib/api'
import { useToast } from '../lib/toast'
import { Card, Meter, PageHead, StatusDot } from '../ui'

// ---------------------------------------------------------------------------
// Add modal
// ---------------------------------------------------------------------------

function AddModal({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: (server: Server, connectionError?: string) => void
}) {
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('root')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { server, connectionError } = await addServer({
        name: name.trim(),
        host: host.trim(),
        port: port.trim(),
        username: username.trim(),
        password: password || undefined,
      })
      onAdded(server, connectionError)
      onClose()
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `${e.message}${e.detail ? ` — ${e.detail}` : ''}`
          : 'Could not add the server',
      )
      setBusy(false)
    }
  }

  const inputClass =
    'mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm ' +
    'outline-none focus:border-lazur-dim'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Add server"
    >
      <Card className="rise-in w-full max-w-md p-6">
        <form onClick={(e) => e.stopPropagation()} onSubmit={submit}>
          <h2 className="font-display text-lg font-semibold">Add server</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            The platform installs its SSH key on the server — after that{' '}
            <code className="font-mono text-lazur">ssh {name.trim() || 'server-name'}</code>{' '}
            works without a password in your terminal too.
          </p>

          <label className="mt-4 block text-xs font-medium uppercase tracking-wider text-faint">
            Name (ssh alias)
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="frankfurt-1"
              autoFocus
              required
            />
          </label>

          <div className="mt-3 flex gap-3">
            <label className="block flex-1 text-xs font-medium uppercase tracking-wider text-faint">
              Host
              <input
                className={inputClass}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="203.0.113.10"
                required
              />
            </label>
            <label className="block w-24 text-xs font-medium uppercase tracking-wider text-faint">
              Port
              <input
                className={inputClass}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
              />
            </label>
          </div>

          <label className="mt-3 block text-xs font-medium uppercase tracking-wider text-faint">
            User
            <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>

          <label className="mt-3 block text-xs font-medium uppercase tracking-wider text-faint">
            Password (optional)
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="leave empty if your key already gets you in"
              autoComplete="off"
            />
          </label>
          <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
            Your existing SSH keys are tried first. The password is only used for
            the initial connection and is never stored anywhere.
          </p>

          {error && (
            <p className="mt-3 rounded-lg bg-coral/10 px-3 py-2 text-xs leading-relaxed text-coral">
              {error}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-panel2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-lazur-dim px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-60"
            >
              {busy ? 'Installing key…' : 'Connect'}
            </button>
          </div>
        </form>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Delete confirmation
// ---------------------------------------------------------------------------

function DeleteModal({
  server,
  onClose,
  onDeleted,
}: {
  server: Server
  onClose: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await deleteServer(server.id)
      onDeleted()
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete')
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Delete server"
    >
      <Card className="rise-in w-full max-w-sm p-6">
        <div onClick={(e) => e.stopPropagation()}>
          <h2 className="font-display text-lg font-semibold">
            Delete {server.name}?
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            It will be removed from the list and from your ssh config. The platform
            key stays on the server itself (<code className="font-mono">authorized_keys</code>)
            — remove it by hand later if you want.
          </p>

          {error && (
            <p className="mt-3 rounded-lg bg-coral/10 px-3 py-2 text-xs text-coral">{error}</p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-panel2"
            >
              Cancel
            </button>
            <button
              onClick={remove}
              disabled={busy}
              className="rounded-lg bg-coral/80 px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-60"
            >
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Server card
// ---------------------------------------------------------------------------

function ServerCard({
  server,
  onDelete,
}: {
  server: Server
  onDelete: (s: Server) => void
}) {
  // undefined = still being requested
  const [metrics, setMetrics] = useState<ServerMetrics | undefined>()

  useEffect(() => {
    let alive = true
    setMetrics(undefined)
    fetchServerMetrics(server.id)
      .then((r) => alive && setMetrics(r.metrics))
      .catch((e) => alive && setMetrics({ status: 'error', error: e instanceof Error ? e.message : String(e) }))
    return () => {
      alive = false
    }
  }, [server.id])

  const connected = metrics?.status === 'connected'

  return (
    <Card className={`p-5 ${metrics?.status === 'error' ? 'border-coral/40' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate font-mono text-[15px] font-semibold">{server.name}</h2>
          <div className="mt-0.5 truncate text-xs text-muted">
            {server.username}@{server.host}
            {server.port !== 22 && `:${server.port}`}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-faint">ssh {server.name}</div>
        </div>
        {metrics === undefined ? (
          <span className="text-xs text-faint">checking…</span>
        ) : (
          <StatusDot status={connected ? 'healthy' : 'offline'} />
        )}
      </div>

      {connected && (
        <div className="mt-4 space-y-2.5">
          {(['cpu', 'ram', 'disk'] as const).map((k) => (
            <div key={k} className="flex items-center gap-3">
              <span className="w-8 font-mono text-[11px] uppercase text-faint">{k}</span>
              <div className="flex-1">
                <Meter value={metrics?.[k] ?? 0} />
              </div>
            </div>
          ))}
        </div>
      )}

      {metrics?.status === 'error' && (
        <p className="mt-3 rounded-lg bg-coral/10 px-3 py-2 font-mono text-[11px] leading-relaxed text-coral">
          {metrics.error}
        </p>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-[11px] text-faint">
        <span className="font-mono">{connected && metrics?.uptime ? `uptime ${metrics.uptime}` : '—'}</span>
        <button
          onClick={() => onDelete(server)}
          className="rounded-md px-2 py-1 text-coral/80 hover:bg-coral/10"
        >
          delete
        </button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Servers() {
  const [servers, setServers] = useState<Server[]>([])
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [deleting, setDeleting] = useState<Server | null>(null)
  const toast = useToast()

  const refresh = useCallback(() => {
    fetchServers()
      .then((r) => setServers(r.servers))
      .catch(() => toast('Could not load the server list', 'error'))
      .finally(() => setLoading(false))
  }, [toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="Servers"
        sub="The platform key is installed once — after that connections are passwordless and `ssh name` works in your terminal too"
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {servers.map((s) => (
          <ServerCard key={s.id} server={s} onDelete={setDeleting} />
        ))}

        <Card className="flex flex-col items-center justify-center border-dashed p-5 text-center">
          <div className="font-display text-sm font-semibold text-muted">
            {loading ? 'Loading…' : servers.length === 0 ? 'No servers yet' : 'Add server'}
          </div>
          <p className="mt-2 max-w-52 text-xs leading-relaxed text-faint">
            Enter a host and a name — the SSH key is installed automatically and
            no password is stored.
          </p>
          <button
            onClick={() => setAddOpen(true)}
            className="mt-3 rounded-lg bg-lazur-dim px-4 py-1.5 text-sm font-medium text-bg"
          >
            Add
          </button>
        </Card>
      </div>

      {addOpen && (
        <AddModal
          onClose={() => setAddOpen(false)}
          onAdded={(server, connectionError) => {
            refresh()
            if (connectionError) {
              toast(`${server.name} added, but the check failed: ${connectionError}`, 'warning')
            } else {
              toast(`${server.name} connected — «ssh ${server.name}» now works without a password`, 'success')
            }
          }}
        />
      )}

      {deleting && (
        <DeleteModal
          server={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            refresh()
            toast(`${deleting.name} deleted`, 'info')
          }}
        />
      )}
    </div>
  )
}
