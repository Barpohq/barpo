// MCP servers page — adding, configuring, installing.
//
// The same three layers as `Skills.tsx` (source → catalog → scope), but with
// TWO EXTRA things:
//
//   1) FOUR KINDS OF SOURCE. A registry search, a GitHub repo, manual entry
//      and the platform's builtin set. Each has its own modal.
//
//   2) SETTING VALUES. Installing a skill only asks for the scope; an MCP
//      server usually needs a token as well. Secret fields are shown with
//      `type="password"` and are NEVER displayed back — an empty input means
//      "I did not change it" (the password pattern from `Servers.tsx`).

import { useEffect, useMemo, useState } from 'react'
import type {
  McpServer,
  McpSettingField,
  McpSource,
  McpTransportKind,
  Project,
} from '@barpo/shared'
import {
  ApiError,
  fetchProjects,
  addMcpFromGithub,
  deleteMcpSource,
  syncMcpSource,
  installMcpServer,
  uninstallMcpServer,
  addMcpManually,
  mcpRegistrySearch,
  addMcpFromRegistry,
  fetchMcpServers,
  type McpRegistryResult,
} from '../lib/api'
import { useToast } from '../lib/toast'
import { Card, PageHead } from '../ui'

/** Transport label — it must read the same on the card and in the modal */
const transportLabel: Record<McpTransportKind, string> = {
  stdio: 'local',
  http: 'remote',
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------

function Modal({
  title,
  onClose,
  children,
  width = 'max-w-md',
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  width?: string
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <Card className={`rise-in w-full ${width} p-6`}>
        <div onClick={(e) => e.stopPropagation()}>{children}</div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Registry search modal
// ---------------------------------------------------------------------------

/**
 * Searching the official registry.
 *
 * TWO-STEP: the search results STORE NOTHING; only once the user picks one
 * does it land in the catalog. That is the difference from the GitHub flow for
 * skills — there one repo = several skills and all of them entered the
 * catalog.
 */
function RegistryModal({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: () => Promise<unknown>
}) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<McpRegistryResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  const search = async () => {
    setSearching(true)
    setError(null)
    try {
      setResults(await mcpRegistrySearch(term))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not search')
      setResults(null)
    } finally {
      setSearching(false)
    }
  }

  const add = async (name: string) => {
    setBusyName(name)
    setError(null)
    try {
      await addMcpFromRegistry(name)
      await onAdded()
      toast(`${name} added to the catalog`)
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add')
    } finally {
      setBusyName(null)
    }
  }

  return (
    <Modal title="Official registry" onClose={onClose} width="max-w-2xl">
      <h2 className="font-display text-lg font-semibold">Official registry</h2>
      <p className="mt-1.5 text-sm text-muted">
        registry.modelcontextprotocol.io — open MCP servers from the ecosystem
      </p>

      <div className="mt-4 flex gap-2">
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search()
          }}
          placeholder="github, postgres, slack…"
          aria-label="Search the registry"
          className="flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
        />
        <button
          onClick={search}
          disabled={searching}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-coral">{error}</p>}

      {results !== null && (
        <div className="mt-4 max-h-96 space-y-2 overflow-y-auto">
          {results.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">Nothing found.</p>
          ) : (
            results.map((n) => (
              <div
                key={n.name}
                className="flex items-start justify-between gap-3 rounded-lg border border-line bg-bg p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-[13px] text-ink">{n.name}</span>
                    <span className="shrink-0 rounded-md bg-panel2 px-1.5 py-0.5 text-[10px] text-faint">
                      {transportLabel[n.transport]}
                    </span>
                    {n.version && (
                      <span className="shrink-0 text-[11px] text-faint">v{n.version}</span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">
                    {n.description || '(no description)'}
                  </p>
                  {n.settings.length > 0 && (
                    <p className="mt-1 text-[11px] text-faint">
                      {n.settings.length} settings required
                      {n.settings.some((s) => s.secret) && ' (including a key)'}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => void add(n.name)}
                  disabled={busyName !== null}
                  className="shrink-0 rounded-lg border border-lazur-dim px-3 py-1.5 text-xs text-lazur transition hover:bg-lazur-dim hover:text-bg disabled:opacity-50"
                >
                  {busyName === n.name ? '…' : 'Add'}
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <div className="mt-5 flex justify-end">
        <button
          onClick={onClose}
          className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
        >
          Close
        </button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// GitHub connect modal
// ---------------------------------------------------------------------------

function GithubModal({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: () => Promise<unknown>
}) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await addMcpFromGithub(url)
      await onAdded()
      const warnCount = result.warnings?.length ?? 0
      toast(
        `${result.added} servers added${warnCount > 0 ? ` · ${warnCount} warnings` : ''}`,
      )
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? (e.detail ?? e.message) : 'Could not connect')
      setBusy(false)
    }
  }

  return (
    <Modal title="GitHub repo" onClose={onClose}>
      <h2 className="font-display text-lg font-semibold">GitHub repo</h2>
      <p className="mt-1.5 text-sm text-muted">
        The repo is scanned for <code className="font-mono text-xs text-ink">server.json</code> files —
        the official declaration format for MCP servers.
      </p>

      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && url.trim()) void connect()
        }}
        placeholder="github/github-mcp-server"
        aria-label="Repo address"
        className="mt-4 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
      />

      {error && <p className="mt-3 text-sm text-coral">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={connect}
          disabled={busy || !url.trim()}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Manual add modal
// ---------------------------------------------------------------------------

/** A setting row the user adds by hand */
interface SettingRow {
  name: string
  secret: boolean
  required: boolean
}

function ManualModal({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: () => Promise<unknown>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [transport, setTransport] = useState<McpTransportKind>('stdio')
  const [command, setCommand] = useState('npx')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [settings, setSettings] = useState<SettingRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  const ready =
    name.trim() !== '' && (transport === 'stdio' ? command.trim() !== '' : url.trim() !== '')

  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      await addMcpManually({
        name: name.trim(),
        description: description.trim() || undefined,
        transport,
        ...(transport === 'stdio'
          ? {
              command: command.trim(),
              // Arguments are split on WHITESPACE. A simple rule: values
              // containing spaces are rare in MCP arguments (they are usually
              // a package name and flags).
              args: args.trim() ? args.trim().split(/\s+/) : [],
            }
          : { url: url.trim() }),
        settings: settings
          .filter((s) => s.name.trim())
          .map((s) => ({ name: s.name.trim(), required: s.required, secret: s.secret })),
      })
      await onAdded()
      toast(`${name.trim()} added`)
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add')
      setBusy(false)
    }
  }

  const updateRow = (index: number, change: Partial<SettingRow>) => {
    setSettings((old) =>
      old.map((s, i) => (i === index ? { ...s, ...change } : s)),
    )
  }

  return (
    <Modal title="Add manually" onClose={onClose} width="max-w-lg">
      <h2 className="font-display text-lg font-semibold">Add manually</h2>
      <p className="mt-1.5 text-sm text-muted">
        You enter the start command or the remote address yourself.
      </p>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wider text-faint">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="github"
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wider text-faint">
            Description (optional)
          </span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What it does — the agent reads this text"
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
          />
        </label>

        <div>
          <span className="text-xs font-medium uppercase tracking-wider text-faint">Transport</span>
          <div className="mt-1.5 flex gap-4">
            {(['stdio', 'http'] as const).map((t) => (
              <label key={t} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="transport"
                  checked={transport === t}
                  onChange={() => setTransport(t)}
                />
                <span className="text-muted">
                  {t === 'stdio' ? 'Local process (stdio)' : 'Remote (http)'}
                </span>
              </label>
            ))}
          </div>
        </div>

        {transport === 'stdio' ? (
          <>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wider text-faint">
                Command
              </span>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
                className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wider text-faint">
                Arguments
              </span>
              <input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-everything"
                className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
              />
              <span className="mt-1 block text-[11px] text-faint">
                Separated by spaces. The command runs directly, not through a shell.
              </span>
            </label>
          </>
        ) : (
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wider text-faint">URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com/mcp"
              className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
            />
          </label>
        )}

        {/* Setting fields — the env vars / headers the server asks for */}
        <div className="rounded-lg border border-line bg-bg p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-faint">
              Settings {transport === 'stdio' ? '(env)' : '(headers)'}
            </span>
            <button
              onClick={() =>
                setSettings((e) => [...e, { name: '', secret: true, required: true }])
              }
              className="text-xs text-lazur transition hover:brightness-125"
            >
              + add
            </button>
          </div>

          {settings.length === 0 ? (
            <p className="mt-2 text-[11px] text-faint">
              If the server asks for a token or an address, add it here.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {settings.map((s, i) => (
                // eslint-disable-next-line react/no-array-index-key -- the row order is stable
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={s.name}
                    onChange={(e) => updateRow(i, { name: e.target.value })}
                    placeholder={transport === 'stdio' ? 'GITHUB_TOKEN' : 'Authorization'}
                    className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-2 py-1.5 font-mono text-xs outline-none placeholder:text-faint focus:border-lazur-dim"
                  />
                  <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted">
                    <input
                      type="checkbox"
                      checked={s.secret}
                      onChange={(e) => updateRow(i, { secret: e.target.checked })}
                    />
                    secret
                  </label>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted">
                    <input
                      type="checkbox"
                      checked={s.required}
                      onChange={(e) => updateRow(i, { required: e.target.checked })}
                    />
                    required
                  </label>
                  <button
                    onClick={() => setSettings((e) => e.filter((_, j) => j !== i))}
                    aria-label="Delete row"
                    className="shrink-0 text-sm text-faint transition hover:text-coral"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-coral">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={add}
          disabled={busy || !ready}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Install modal
// ---------------------------------------------------------------------------

/**
 * Scope + setting values.
 *
 * SECRET VALUES ARE NEVER SHOWN. The server does not return them in the
 * response, so all there is here is an empty input. Leaving it empty keeps the
 * stored value in place — we say that plainly to the user, otherwise they
 * would be left wondering "did my token get wiped?".
 */
function InstallModal({
  server,
  projects,
  onClose,
  onSave,
}: {
  server: McpServer
  projects: Project[]
  onClose: () => void
  onSave: (
    global: boolean,
    projectIds: string[],
    values: Record<string, string>,
  ) => Promise<void>
}) {
  const [global, setGlobal] = useState(server.installs.some((o) => o.scope === 'global'))
  const [selected, setSelected] = useState<Set<string>>(
    new Set(
      server.installs
        .filter((o) => o.scope === 'project' && o.projectId)
        .map((o) => o.projectId!),
    ),
  )
  // Plain values come from the existing install; secrets are ALWAYS empty
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    const install = server.installs[0]
    for (const field of server.settings) {
      if (field.secret) continue
      initial[field.name] =
        install?.settingValues[field.name] ?? field.default ?? ''
    }
    return initial
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nothing = !global && selected.size === 0
  const isInstalled = server.installs.length > 0

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSave(global, [...selected], values)
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save')
      setBusy(false)
    }
  }

  return (
    <Modal title={`${server.name} settings`} onClose={onClose} width="max-w-lg">
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">{server.name}</h2>
        <span className="shrink-0 rounded-md bg-panel2 px-2 py-0.5 text-[10px] text-faint">
          {transportLabel[server.transport]}
        </span>
      </div>
      {server.description && <p className="mt-1.5 text-sm text-muted">{server.description}</p>}

      {/* Startup detail — so the user knows WHAT is going to run */}
      <div className="mt-4 rounded-lg border border-line bg-bg p-3">
        <div className="text-xs font-medium uppercase tracking-wider text-faint">
          {server.transport === 'stdio' ? 'Runs' : 'Connects to'}
        </div>
        <code className="mt-1.5 block break-all font-mono text-[11px] leading-relaxed text-ink">
          {server.transport === 'stdio'
            ? [server.command, ...(server.args ?? [])].join(' ')
            : server.url}
        </code>
      </div>

      {/* Setting values */}
      {server.settings.length > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-bg p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-faint">
            Settings
          </div>
          <div className="mt-3 space-y-3">
            {server.settings.map((field) => (
              <SettingInput
                key={field.name}
                field={field}
                value={values[field.name] ?? ''}
                isInstalled={isInstalled}
                onChange={(q) => setValues((old) => ({ ...old, [field.name]: q }))}
              />
            ))}
          </div>
          {server.settings.some((s) => s.secret) && (
            <p className="mt-3 text-[11px] leading-relaxed text-faint">
              Secret values are not written to the database — they are kept in a separate
              file and never shown back. Leave a field empty to keep the stored value.
            </p>
          )}
        </div>
      )}

      {/* Scope */}
      <div className="mt-3 rounded-lg border border-line bg-bg p-4">
        <div className="text-xs font-medium uppercase tracking-wider text-faint">
          Where it should work
        </div>

        <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={global}
            onChange={(e) => setGlobal(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="text-ink">Everywhere (global)</span>
            <span className="block text-xs text-faint">
              Available in all chats and projects
            </span>
          </span>
        </label>

        {projects.length > 0 && (
          <>
            <div className="mt-4 text-xs font-medium uppercase tracking-wider text-faint">
              Or in selected projects
            </div>
            <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
              {projects.map((l) => (
                <label key={l.id} className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(l.id)}
                    onChange={(e) => {
                      const next = new Set(selected)
                      if (e.target.checked) next.add(l.id)
                      else next.delete(l.id)
                      setSelected(next)
                    }}
                  />
                  <span className="text-muted">{l.name}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-faint">
        The server starts at the beginning of every chat and exposes its tools to the agent.
        Every call asks for permission — just like running a command.
      </p>

      {error && <p className="mt-3 text-sm text-coral">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={save}
          disabled={busy}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? 'Saving…' : nothing ? 'Uninstall' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}

/** A single setting field — a password input when it is secret */
function SettingInput({
  field,
  value,
  isInstalled,
  onChange,
}: {
  field: McpSettingField
  value: string
  isInstalled: boolean
  onChange: (q: string) => void
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-xs text-ink">{field.name}</span>
        {field.required && <span className="text-[10px] text-coral">required</span>}
        {field.secret && <span className="text-[10px] text-gold">secret</span>}
      </span>
      {field.hint && (
        <span className="mt-0.5 block text-[11px] leading-relaxed text-faint">{field.hint}</span>
      )}
      <input
        // Secret values must not end up in the browser's password manager —
        // they are managed by the platform's own store
        type={field.secret ? 'password' : 'text'}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          field.secret && isInstalled
            ? '(stored — type to change it)'
            : (field.default ?? '')
        }
        className="mt-1 w-full rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-faint focus:border-lazur-dim"
      />
    </label>
  )
}

// ---------------------------------------------------------------------------
// Sources section
// ---------------------------------------------------------------------------

function Sources({
  sources,
  onRefreshed,
}: {
  sources: McpSource[]
  onRefreshed: () => Promise<unknown>
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  const sync = async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      const result = await syncMcpSource(id)
      await onRefreshed()
      toast(`+${result.added} / -${result.deleted}`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not sync')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (m: McpSource) => {
    if (!confirm(`Delete ${m.sourceName}? Its servers and keys go with it.`)) return
    setBusyId(m.id)
    setError(null)
    try {
      await deleteMcpSource(m.id)
      await onRefreshed()
      toast('Source deleted')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete')
    } finally {
      setBusyId(null)
    }
  }

  if (sources.length === 0) return null

  return (
    <Card className="mb-6 p-5">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">Sources</div>
      {error && <p className="mt-2 text-sm text-coral">{error}</p>}
      <div className="mt-3 space-y-2">
        {sources.map((m) => {
          // `manual` and `builtin` sources cannot be synced — they do not
          // come from an external source
          const canSync = m.kind === 'github' || m.kind === 'registry'
          return (
            <div
              key={m.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[13px] text-ink">{m.sourceName}</span>
                  <span className="shrink-0 rounded-md bg-panel2 px-1.5 py-0.5 text-[10px] text-faint">
                    {m.kind}
                  </span>
                </div>
                {m.lastSync && (
                  <span className="text-[11px] text-faint">
                    {new Date(m.lastSync).toLocaleDateString()}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {canSync && (
                  <button
                    onClick={() => void sync(m.id)}
                    disabled={busyId !== null}
                    className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted transition hover:text-ink disabled:opacity-50"
                  >
                    {busyId === m.id ? '…' : 'Sync'}
                  </button>
                )}
                {m.kind !== 'builtin' && (
                  <button
                    onClick={() => void remove(m)}
                    disabled={busyId !== null}
                    className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted transition hover:border-coral/40 hover:text-coral disabled:opacity-50"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Mcp() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [sources, setSources] = useState<McpSource[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState<McpServer | null>(null)
  const [addModal, setAddModal] = useState<'registry' | 'github' | 'manual' | null>(null)
  const [search, setSearch] = useState('')

  /** RETURNS the new list — so an open modal does not go stale (`Skills.tsx` pattern) */
  const load = async (): Promise<McpServer[] | null> => {
    try {
      const [catalog, projectList] = await Promise.all([fetchMcpServers(), fetchProjects()])
      setServers(catalog.servers)
      setSources(catalog.sources)
      setProjects(projectList)
      setError(null)
      return catalog.servers
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the data')
      return null
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  /**
   * Saves the scope and settings.
   *
   * The same diff logic as `saveScope` in `Skills.tsx`, plus one thing: the
   * setting values are sent to EVERY install (they are tied to the install
   * row).
   */
  const save = async (
    server: McpServer,
    global: boolean,
    projectIds: string[],
    values: Record<string, string>,
  ) => {
    const wasGlobal = server.installs.some((o) => o.scope === 'global')
    const oldProjects = new Set(
      server.installs
        .filter((o) => o.scope === 'project' && o.projectId)
        .map((o) => o.projectId!),
    )
    const newProjects = new Set(projectIds)
    const toRemove = [...oldProjects].filter((id) => !newProjects.has(id))

    // Installing is idempotent and refreshes the settings, so we call it
    // again for existing scopes too — the values may have changed
    // (`installMcpServer` performs an UPDATE).
    if (global) await installMcpServer(server.id, 'global', values)
    if (projectIds.length > 0) await installMcpServer(server.id, 'project', values, projectIds)
    if (!global && wasGlobal) await uninstallMcpServer(server.id, 'global')
    if (toRemove.length > 0) {
      await uninstallMcpServer(server.id, 'project', toRemove)
    }

    await load()
  }

  const scopeText = (server: McpServer): string => {
    const global = server.installs.some((o) => o.scope === 'global')
    const projectCount = server.installs.filter((o) => o.scope === 'project').length
    if (global && projectCount > 0) return `Global + ${projectCount} projects`
    if (global) return 'Global'
    if (projectCount > 0) return `${projectCount} projects`
    return ''
  }

  const visible = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return servers
    return servers.filter((s) => {
      const text = `${s.name} ${s.description}`.toLowerCase()
      return words.every((term) => text.includes(term))
    })
  }, [servers, search])

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="MCP servers"
        sub="Connect external tools to the agent: registry, GitHub or manually"
      />

      {/* Ways to add a server */}
      <Card className="mb-6 p-5">
        <div className="text-xs font-medium uppercase tracking-wider text-faint">
          Add server
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => setAddModal('registry')}
            className="rounded-lg border border-lazur-dim px-3 py-2 text-sm text-lazur transition hover:bg-lazur-dim hover:text-bg"
          >
            Official registry
          </button>
          <button
            onClick={() => setAddModal('github')}
            className="rounded-lg border border-line px-3 py-2 text-sm text-muted transition hover:text-ink"
          >
            GitHub repo
          </button>
          <button
            onClick={() => setAddModal('manual')}
            className="rounded-lg border border-line px-3 py-2 text-sm text-muted transition hover:text-ink"
          >
            Manually
          </button>
        </div>
      </Card>

      <Sources sources={sources} onRefreshed={load} />

      {error && (
        <Card className="mb-6 border-coral/40 p-4">
          <p className="text-sm text-coral">{error}</p>
        </Card>
      )}

      {!loading && servers.length > 3 && (
        <div className="mb-5">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            aria-label="Search MCP servers"
            className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
          />
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : servers.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">
            The catalog is empty. Add a server using one of the buttons above.
          </p>
          <p className="mt-2 text-xs text-faint">
            MCP is the standard for connecting external tools to an AI. Once a server is
            installed, its tools show up in the chat.
          </p>
        </Card>
      ) : visible.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">Nothing found.</p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((s) => {
            const scope = scopeText(s)
            const needsKey = s.settings.some((x) => x.required && x.secret)
            return (
              <Card key={s.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="min-w-0 truncate font-display text-[15px] font-semibold" title={s.name}>
                    {s.name}
                  </h2>
                  <span className="shrink-0 rounded-md bg-panel2 px-2 py-0.5 text-[10px] text-faint">
                    {transportLabel[s.transport]}
                  </span>
                </div>

                <div className="mt-2 flex-1">
                  <p className="line-clamp-3 text-sm leading-relaxed text-muted">
                    {s.description || '(no description)'}
                  </p>
                  {needsKey && (
                    <p className="mt-1.5 text-[11px] text-gold">requires a key</p>
                  )}
                </div>

                <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
                  {scope ? (
                    <span className="truncate text-sm text-mint" title={scope}>
                      ✓ {scope}
                    </span>
                  ) : (
                    <span className="text-xs text-faint">not installed</span>
                  )}
                  <button
                    onClick={() => setModal(s)}
                    className={
                      scope
                        ? 'shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition hover:text-ink'
                        : 'shrink-0 rounded-lg border border-lazur-dim px-3 py-1.5 text-sm text-lazur transition hover:bg-lazur-dim hover:text-bg'
                    }
                  >
                    {scope ? 'Configure' : 'Install'}
                  </button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {addModal === 'registry' && (
        <RegistryModal onClose={() => setAddModal(null)} onAdded={load} />
      )}
      {addModal === 'github' && (
        <GithubModal onClose={() => setAddModal(null)} onAdded={load} />
      )}
      {addModal === 'manual' && (
        <ManualModal onClose={() => setAddModal(null)} onAdded={load} />
      )}

      {modal && (
        <InstallModal
          server={modal}
          projects={projects}
          onClose={() => setModal(null)}
          onSave={(global, ids, values) => save(modal, global, ids, values)}
        />
      )}
    </div>
  )
}
