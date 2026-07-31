// Model picker — choosing which model the chat talks to before it starts.
//
// There are many models (over 300 on this machine), so search is mandatory.
// The list is grouped by provider and free/local models come first (the server
// supplies the detection order and we preserve it).
//
// Once the session starts the picker locks: the provider cannot change, only
// the selected model's label is shown.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { BillingKind, ModelInfo } from '@platforma/shared'
import { storeModel } from '../lib/model-storage'

/**
 * Billing label. Separating subscription from API key is essential: if both
 * simply read "OpenAI", a user who assumes they are on their subscription can
 * end up spending through the paid API channel.
 */
const BILLING_LABEL: Record<BillingKind, { icon: string; text: string; color: string }> = {
  subscription: { icon: '⬢', text: 'subscription', color: 'text-mint' },
  local: { icon: '⌂', text: 'local', color: 'text-mint' },
  apiKey: { icon: '◇', text: 'API key', color: 'text-faint' },
}

/** Turns $/1M tokens into an easily readable form */
function priceText(m: ModelInfo): string {
  // On a subscription the tokens are covered by the monthly fee — showing $
  // would be misleading
  if (m.billing === 'subscription') return 'included'
  if (m.cost.input === 0 && m.cost.output === 0) return 'free'
  const f = (n: number) => (n < 1 ? n.toFixed(2) : n.toFixed(1))
  return `$${f(m.cost.input)}/$${f(m.cost.output)}`
}

function contextText(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

interface Props {
  models: ModelInfo[]
  selected: ModelInfo | null
  onSelect: (m: ModelInfo) => void
  /** The session has started — the provider is locked */
  locked: boolean
  loading?: boolean
  error?: string | null
}

export default function ModelPicker({
  models,
  selected,
  onSelect,
  locked,
  loading,
  error,
}: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const wrapper = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Closes when clicking outside
  useEffect(() => {
    if (!open) return
    function clicked(e: MouseEvent) {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false)
    }
    function keyed(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', clicked)
    document.addEventListener('keydown', keyed)
    return () => {
      document.removeEventListener('mousedown', clicked)
      document.removeEventListener('keydown', keyed)
    }
  }, [open])

  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  const groups = useMemo(() => {
    const s = search.trim().toLowerCase()
    const matched = s
      ? models.filter(
          (m) =>
            m.name.toLowerCase().includes(s) ||
            m.id.toLowerCase().includes(s) ||
            m.providerName.toLowerCase().includes(s),
        )
      : models

    // The server's order is preserved — a Map remembers insertion order. The
    // key is the provider id, so providers with the same name but different
    // sources (an OpenAI key and an OpenAI Codex subscription) do not merge.
    const map = new Map<string, { first: ModelInfo; models: ModelInfo[] }>()
    for (const m of matched) {
      const existing = map.get(m.provider)
      if (existing) existing.models.push(m)
      else map.set(m.provider, { first: m, models: [m] })
    }
    return [...map.values()]
  }, [models, search])

  const totalMatched = groups.reduce((s, g) => s + g.models.length, 0)

  function select(m: ModelInfo) {
    storeModel({ provider: m.provider, model: m.id })
    onSelect(m)
    setOpen(false)
    setSearch('')
  }

  // Locked state — the label only
  if (locked) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1 text-xs text-faint">
        <span className="inline-block size-1.5 rounded-full bg-lazur" aria-hidden />
        <span className="font-mono">
          {selected ? `${selected.providerName} · ${selected.name}` : 'model selected'}
        </span>
        {selected && (
          <span
            className={`font-mono text-[10px] ${BILLING_LABEL[selected.billing].color}`}
            title={`${BILLING_LABEL[selected.billing].text} — ${selected.source}`}
          >
            {BILLING_LABEL[selected.billing].icon} {BILLING_LABEL[selected.billing].text}
          </span>
        )}
        <span title="The provider cannot be changed once the chat has started">🔒</span>
      </div>
    )
  }

  return (
    <div ref={wrapper} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={loading || models.length === 0}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Pick a model — the provider locks once the chat starts"
        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[13px] transition disabled:opacity-50 ${
          open ? 'border-lazur-dim bg-panel2' : 'border-transparent hover:bg-panel2/60'
        }`}
      >
        {loading ? (
          <span className="text-muted">loading models…</span>
        ) : selected ? (
          <>
            <span className="font-mono text-xs text-lazur">{selected.providerName}</span>
            <span
              className={`font-mono text-[10px] ${BILLING_LABEL[selected.billing].color}`}
              title={`${BILLING_LABEL[selected.billing].text} — ${selected.source}`}
            >
              {BILLING_LABEL[selected.billing].icon}
            </span>
            <span className="truncate">{selected.name}</span>
          </>
        ) : (
          <span className="text-muted">{models.length ? 'Select a model' : 'No models found'}</span>
        )}
        <span className="ml-0.5 text-faint" aria-hidden>
          ▾
        </span>
      </button>

      {error && <p className="mt-1 text-xs text-coral">{error}</p>}

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full z-50 mb-2 max-h-[60vh] w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        >
          <div className="border-b border-line p-2">
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Model or provider name…"
              aria-label="Search models"
              // `focus-outside`: the field's own border instead of the global
              // ring — otherwise two borders stack once it opens
              className="focus-outside w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none transition placeholder:text-faint focus:border-lazur-dim"
            />
          </div>

          <div className="thin-scroll max-h-[calc(60vh-3.5rem)] overflow-y-auto">
            {totalMatched === 0 && (
              <p className="px-4 py-6 text-center text-sm text-muted">No matching models</p>
            )}

            {groups.map(({ first, models: groupModels }) => {
              const label = BILLING_LABEL[first.billing]
              return (
              <div key={first.provider}>
                <div className="sticky top-0 flex items-center justify-between gap-2 bg-panel2 px-3 py-1.5 font-mono text-[11px] text-muted">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{first.providerName}</span>
                    <span
                      className={`shrink-0 ${label.color}`}
                      title={`${label.text} — ${first.source}`}
                    >
                      {label.icon} {label.text}
                    </span>
                  </span>
                  <span className="shrink-0 text-faint">{groupModels.length}</span>
                </div>
                {groupModels.map((m) => {
                  const active = selected?.provider === m.provider && selected.id === m.id
                  return (
                    <button
                      key={`${m.provider}/${m.id}`}
                      role="option"
                      aria-selected={active}
                      onClick={() => select(m)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-panel2 ${
                        active ? 'bg-panel2' : ''
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{m.name}</span>
                        <span className="block truncate font-mono text-[11px] text-faint">{m.id}</span>
                      </span>
                      <span className="shrink-0 text-right font-mono text-[11px]">
                        <span className="block text-muted">{contextText(m.contextWindow)}</span>
                        <span
                          className={
                            m.billing === 'subscription' || (m.cost.input === 0 && m.cost.output === 0)
                              ? 'block text-mint'
                              : 'block text-gold'
                          }
                        >
                          {priceText(m)}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
