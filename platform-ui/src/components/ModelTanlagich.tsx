// Model tanlagich — chat boshlanishida qaysi model bilan suhbatlashishni tanlash.
//
// Modellar ko'p (bu PC'da 300 dan ortiq), shuning uchun qidiruv majburiy.
// Ro'yxat provider bo'yicha guruhlanadi va bepul/mahalliy modellar tepada
// turadi (aniqlash tartibini server beradi, biz uni saqlaymiz).
//
// Sessiya boshlangach tanlagich qulflanadi: provider o'zgarmaydi, faqat
// tanlangan model yorlig'i ko'rinadi.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo } from '@platforma/shared'
import { modelniSaqla } from '../lib/model-saqlash'

/** $/1M tokenni o'qilishi oson shaklga keltiradi */
function narxMatni(m: ModelInfo): string {
  if (m.cost.input === 0 && m.cost.output === 0) return 'bepul'
  const f = (n: number) => (n < 1 ? n.toFixed(2) : n.toFixed(1))
  return `$${f(m.cost.input)}/$${f(m.cost.output)}`
}

function kontekstMatni(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

interface Props {
  modellar: ModelInfo[]
  tanlangan: ModelInfo | null
  onTanla: (m: ModelInfo) => void
  /** Sessiya boshlangan — provider qulflangan */
  qulflangan: boolean
  yuklanmoqda?: boolean
  xato?: string | null
}

export default function ModelTanlagich({
  modellar,
  tanlangan,
  onTanla,
  qulflangan,
  yuklanmoqda,
  xato,
}: Props) {
  const [ochiq, setOchiq] = useState(false)
  const [qidiruv, setQidiruv] = useState('')
  const orash = useRef<HTMLDivElement>(null)
  const qidiruvRef = useRef<HTMLInputElement>(null)

  // Tashqariga bosilganda yopiladi
  useEffect(() => {
    if (!ochiq) return
    function bosildi(e: MouseEvent) {
      if (!orash.current?.contains(e.target as Node)) setOchiq(false)
    }
    function tugma(e: KeyboardEvent) {
      if (e.key === 'Escape') setOchiq(false)
    }
    document.addEventListener('mousedown', bosildi)
    document.addEventListener('keydown', tugma)
    return () => {
      document.removeEventListener('mousedown', bosildi)
      document.removeEventListener('keydown', tugma)
    }
  }, [ochiq])

  useEffect(() => {
    if (ochiq) qidiruvRef.current?.focus()
  }, [ochiq])

  const guruhlar = useMemo(() => {
    const s = qidiruv.trim().toLowerCase()
    const mos = s
      ? modellar.filter(
          (m) =>
            m.name.toLowerCase().includes(s) ||
            m.id.toLowerCase().includes(s) ||
            m.providerName.toLowerCase().includes(s),
        )
      : modellar

    // Server tartibini saqlaymiz — Map kiritilish tartibini eslaydi
    const xarita = new Map<string, ModelInfo[]>()
    for (const m of mos) {
      const bor = xarita.get(m.providerName)
      if (bor) bor.push(m)
      else xarita.set(m.providerName, [m])
    }
    return [...xarita.entries()]
  }, [modellar, qidiruv])

  const jamiMos = guruhlar.reduce((s, [, v]) => s + v.length, 0)

  function tanla(m: ModelInfo) {
    modelniSaqla({ provider: m.provider, model: m.id })
    onTanla(m)
    setOchiq(false)
    setQidiruv('')
  }

  // Qulflangan holat — faqat yorliq
  if (qulflangan) {
    return (
      <div className="flex items-center gap-2 text-xs text-faint">
        <span className="inline-block size-1.5 rounded-full bg-lazur" aria-hidden />
        <span className="font-mono">
          {tanlangan ? `${tanlangan.providerName} · ${tanlangan.name}` : 'model tanlangan'}
        </span>
        <span title="Suhbat boshlangach provider o'zgartirilmaydi">🔒</span>
      </div>
    )
  }

  return (
    <div ref={orash} className="relative">
      <button
        type="button"
        onClick={() => setOchiq((v) => !v)}
        disabled={yuklanmoqda || modellar.length === 0}
        aria-expanded={ochiq}
        aria-haspopup="listbox"
        className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm transition hover:border-lazur-dim disabled:opacity-50"
      >
        {yuklanmoqda ? (
          <span className="text-muted">modellar yuklanmoqda…</span>
        ) : tanlangan ? (
          <>
            <span className="font-mono text-xs text-lazur">{tanlangan.providerName}</span>
            <span>{tanlangan.name}</span>
          </>
        ) : (
          <span className="text-muted">{modellar.length ? 'Model tanlang' : 'Model topilmadi'}</span>
        )}
        <span className="text-faint" aria-hidden>
          ▾
        </span>
      </button>

      {xato && <p className="mt-1 text-xs text-coral">{xato}</p>}

      {ochiq && (
        <div
          role="listbox"
          className="absolute bottom-full z-50 mb-2 max-h-[60vh] w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        >
          <div className="border-b border-line p-2">
            <input
              ref={qidiruvRef}
              value={qidiruv}
              onChange={(e) => setQidiruv(e.target.value)}
              placeholder="Model yoki provider nomi…"
              aria-label="Model qidirish"
              className="w-full rounded-lg bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint"
            />
          </div>

          <div className="thin-scroll max-h-[calc(60vh-3.5rem)] overflow-y-auto">
            {jamiMos === 0 && (
              <p className="px-4 py-6 text-center text-sm text-muted">Mos model topilmadi</p>
            )}

            {guruhlar.map(([provider, guruhModellari]) => (
              <div key={provider}>
                <div className="sticky top-0 flex items-center justify-between bg-panel2 px-3 py-1.5 font-mono text-[11px] text-muted">
                  <span>{provider}</span>
                  <span className="text-faint">{guruhModellari.length}</span>
                </div>
                {guruhModellari.map((m) => {
                  const faol = tanlangan?.provider === m.provider && tanlangan.id === m.id
                  return (
                    <button
                      key={`${m.provider}/${m.id}`}
                      role="option"
                      aria-selected={faol}
                      onClick={() => tanla(m)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-panel2 ${
                        faol ? 'bg-panel2' : ''
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{m.name}</span>
                        <span className="block truncate font-mono text-[11px] text-faint">{m.id}</span>
                      </span>
                      <span className="shrink-0 text-right font-mono text-[11px]">
                        <span className="block text-muted">{kontekstMatni(m.contextWindow)}</span>
                        <span
                          className={
                            m.cost.input === 0 && m.cost.output === 0 ? 'block text-mint' : 'block text-gold'
                          }
                        >
                          {narxMatni(m)}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
