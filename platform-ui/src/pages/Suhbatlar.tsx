// Barcha suhbatlar sahifasi — sidebar'dagi oxirgi 5 taning to'liq ko'rinishi.
//
// Ro'yxat App'dan keladi (`useSuhbatlar` u yerda bir marta chaqiriladi),
// shuning uchun sidebar bilan har doim bir xil ma'lumotni ko'rsatadi va
// o'chirish/qayta nomlash ikkalasida bir vaqtda aks etadi.
//
// Filtrlar (qidiruv, loyiha) MAHALLIY — serverga so'rov yubormaydi. Sabab:
// suhbatlar soni bir foydalanuvchida yuzlab bo'ladi, mingga yetmaydi;
// mahalliy filtr esa darhol ishlaydi va tarmoqqa bog'liq emas.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatSession, Project } from '@platforma/shared'
import OqimIndikatori from '../components/OqimIndikatori'
import { ApiXatosi, sessiyaOchir, sessiyaSarlavhaOzgart } from '../lib/api'
import type { IshlayotganlarXaritasi } from '../lib/ishlayotganlar'
import { GURUH_TARTIBI, qisqaVaqt, sanaGuruhi, type SanaGuruhi } from '../lib/sana'
import { useToast } from '../lib/toast'
import { Card, PageHead } from '../ui'

interface Props {
  suhbatlar: ChatSession[]
  ishlayotganlar: IshlayotganlarXaritasi
  loyihalar: Project[]
  ochiqSessiya: string | null
  yuklanmoqda: boolean
  xato: boolean
  /** Ro'yxatni serverdan qayta so'rash */
  yangila: () => void
  /** Mahalliy o'zgartirish — server javobini kutmasdan ko'rsatish uchun */
  ozgart: (yangilagich: (oldingi: ChatSession[]) => ChatSession[]) => void
  onSuhbatOch: (sessionId: string) => void
  onYangiSuhbat: () => void
}

/** Loyiha filtri: hammasi | loyihasiz | <loyiha id> */
type LoyihaFiltri = 'hammasi' | 'yoq' | string

export default function Suhbatlar({
  suhbatlar,
  ishlayotganlar,
  loyihalar,
  ochiqSessiya,
  yuklanmoqda,
  xato,
  yangila,
  ozgart,
  onSuhbatOch,
  onYangiSuhbat,
}: Props) {
  const [qidiruv, setQidiruv] = useState('')
  const [loyihaFiltri, setLoyihaFiltri] = useState<LoyihaFiltri>('hammasi')
  /** Hozir tahrirlanayotgan suhbat va uning yangi nomi */
  const [tahrir, setTahrir] = useState<{ id: string; matn: string } | null>(null)
  /** O'chirish tasdig'i kutilayotgan suhbat */
  const [ochirilsinmi, setOchirilsinmi] = useState<ChatSession | null>(null)
  const [amalKetmoqda, setAmalKetmoqda] = useState(false)
  const toast = useToast()
  const tahrirRef = useRef<HTMLInputElement>(null)

  // Tahrir boshlanganda matn tanlangan holda fokus oladi — foydalanuvchi
  // darhol yangi nom yoza oladi
  useEffect(() => {
    if (tahrir) tahrirRef.current?.select()
  }, [tahrir])

  const loyihaNomlari = useMemo(() => {
    const xarita: Record<string, string> = {}
    for (const l of loyihalar) xarita[l.id] = l.name
    return xarita
  }, [loyihalar])

  const filtrlangan = useMemo(() => {
    const qidiruvMatni = qidiruv.trim().toLowerCase()
    return suhbatlar.filter((s) => {
      if (qidiruvMatni && !s.title.toLowerCase().includes(qidiruvMatni)) return false
      if (loyihaFiltri === 'hammasi') return true
      if (loyihaFiltri === 'yoq') return !s.projectId
      return s.projectId === loyihaFiltri
    })
  }, [suhbatlar, qidiruv, loyihaFiltri])

  // Sana bo'yicha guruhlash. `useMemo` ichida `new Date()` bir marta olinadi
  // — aks holda ro'yxatning boshi va oxiri turli "hozir" ga taqqoslanardi.
  const guruhlar = useMemo(() => {
    const hozir = new Date()
    const xarita = new Map<SanaGuruhi, ChatSession[]>()
    for (const s of filtrlangan) {
      const guruh = sanaGuruhi(s.updatedAt, hozir)
      const mavjud = xarita.get(guruh)
      if (mavjud) mavjud.push(s)
      else xarita.set(guruh, [s])
    }
    return GURUH_TARTIBI.filter((g) => xarita.has(g)).map((g) => ({
      nom: g,
      suhbatlar: xarita.get(g) ?? [],
    }))
  }, [filtrlangan])

  async function nomniSaqla() {
    if (!tahrir) return
    const yangiNom = tahrir.matn.trim()
    const eski = suhbatlar.find((s) => s.id === tahrir.id)

    // O'zgarmagan yoki bo'sh nom — jimgina yopamiz
    if (!yangiNom || yangiNom === eski?.title) {
      setTahrir(null)
      return
    }

    const id = tahrir.id
    setTahrir(null)
    // Darhol ko'rsatamiz, server javobini kutmasdan
    ozgart((r) => r.map((s) => (s.id === id ? { ...s, title: yangiNom } : s)))

    try {
      await sessiyaSarlavhaOzgart(id, yangiNom)
    } catch (x) {
      // Eski nomni qaytarish uchun serverdan qayta so'raymiz — mahalliy
      // holatni "orqaga qaytarish"dan ishonchliroq
      yangila()
      toast(
        x instanceof ApiXatosi ? `Rename failed: ${x.message}` : 'Rename failed',
        'error',
      )
    }
  }

  async function ochir(s: ChatSession) {
    setAmalKetmoqda(true)
    try {
      await sessiyaOchir(s.id)
      ozgart((r) => r.filter((x) => x.id !== s.id))
      setOchirilsinmi(null)
      // Ochiq suhbat o'chirilgan bo'lsa — bo'sh chatga tushamiz
      if (s.id === ochiqSessiya) onYangiSuhbat()
    } catch (x) {
      toast(
        x instanceof ApiXatosi ? `Delete failed: ${x.message}` : 'Could not delete the chat',
        'error',
      )
      setOchirilsinmi(null)
    } finally {
      setAmalKetmoqda(false)
    }
  }

  const bosh = !yuklanmoqda && suhbatlar.length === 0
  const filtrBosh = !yuklanmoqda && suhbatlar.length > 0 && filtrlangan.length === 0

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <PageHead
        title="Chats"
        sub="All chats — the ones running in the background are marked with a live indicator"
      />

      {/* Control row: search + project filter + new chat */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <svg
            viewBox="0 0 20 20"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
          >
            <circle cx="9" cy="9" r="5.5" />
            <path d="m13.5 13.5 3 3" strokeLinecap="round" />
          </svg>
          <input
            value={qidiruv}
            onChange={(e) => setQidiruv(e.target.value)}
            placeholder="Search by chat name…"
            aria-label="Search"
            className="w-full rounded-xl border border-line bg-panel py-2 pr-3 pl-9 text-sm outline-none transition placeholder:text-faint focus:border-lazur-dim"
          />
        </div>

        {loyihalar.length > 0 && (
          <select
            value={loyihaFiltri}
            onChange={(e) => setLoyihaFiltri(e.target.value)}
            aria-label="Filter by project"
            className="shrink-0 rounded-xl border border-line bg-panel px-3 py-2 text-sm text-muted outline-none transition focus:border-lazur-dim"
          >
            <option value="hammasi">All projects</option>
            <option value="yoq">No project</option>
            {loyihalar.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}

        <button
          onClick={onYangiSuhbat}
          className="shrink-0 rounded-xl bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110"
        >
          + New chat
        </button>
      </div>

      {yuklanmoqda && suhbatlar.length === 0 && (
        <p className="text-sm text-faint">Loading…</p>
      )}

      {xato && suhbatlar.length === 0 && (
        <Card className="px-6 py-8 text-center">
          <p className="text-sm text-coral">Could not load the chat list.</p>
          <button
            onClick={yangila}
            className="mt-3 rounded-lg border border-line px-3 py-1.5 text-xs text-muted transition hover:border-lazur-dim hover:text-lazur"
          >
            Try again
          </button>
        </Card>
      )}

      {bosh && !xato && (
        <Card className="px-6 py-10 text-center">
          <p className="text-sm text-muted">No chats yet.</p>
          <p className="mt-1.5 text-xs text-faint">
            Send a message in chat — it gets saved here.
          </p>
        </Card>
      )}

      {filtrBosh && (
        <Card className="px-6 py-8 text-center">
          <p className="text-sm text-muted">No chats match these filters.</p>
        </Card>
      )}

      <div className="space-y-6">
        {guruhlar.map((guruh) => (
          <section key={guruh.nom}>
            <h2 className="mb-2 px-1 text-[10px] font-semibold tracking-widest text-faint uppercase">
              {guruh.nom}
            </h2>
            <div className="space-y-1.5">
              {guruh.suhbatlar.map((s) => {
                const holat = ishlayotganlar[s.id]
                const tahrirlanmoqda = tahrir?.id === s.id
                const loyihaNomi = s.projectId ? loyihaNomlari[s.projectId] : undefined

                return (
                  <Card
                    key={s.id}
                    className={`group flex items-center gap-3 px-4 py-3 transition ${
                      s.id === ochiqSessiya ? 'border-lazur-dim' : 'hover:border-faint'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      {tahrirlanmoqda ? (
                        <input
                          ref={tahrirRef}
                          value={tahrir.matn}
                          onChange={(e) => setTahrir({ id: s.id, matn: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void nomniSaqla()
                            if (e.key === 'Escape') setTahrir(null)
                          }}
                          onBlur={() => void nomniSaqla()}
                          aria-label="Chat name"
                          maxLength={200}
                          className="w-full rounded-md border border-lazur-dim bg-bg px-2 py-1 text-sm outline-none"
                        />
                      ) : (
                        <button
                          onClick={() => onSuhbatOch(s.id)}
                          className="flex w-full min-w-0 items-center gap-2 text-left"
                        >
                          <span className="truncate text-sm font-medium">{s.title}</span>
                          {holat && <OqimIndikatori holat={holat} />}
                        </button>
                      )}

                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] text-faint">
                        <span>{qisqaVaqt(s.updatedAt)}</span>
                        {loyihaNomi && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="truncate text-muted">{loyihaNomi}</span>
                          </>
                        )}
                        {s.model && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="truncate">{s.model}</span>
                          </>
                        )}
                        {s.xabarlarSoni === 0 && (
                          <>
                            <span aria-hidden>·</span>
                            <span>empty</span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Amallar — sichqoncha kelganda yoki fokusda ko'rinadi.
                        `focus-within` majburiy: klaviatura bilan yurganda
                        tugmalar ko'rinmay qolmasligi kerak. */}
                    {!tahrirlanmoqda && (
                      <div className="flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          onClick={() => setTahrir({ id: s.id, matn: s.title })}
                          title="Rename"
                          aria-label={`Rename "${s.title}"`}
                          className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-muted transition hover:border-lazur-dim hover:text-lazur"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => setOchirilsinmi(s)}
                          title="Delete"
                          aria-label={`Delete chat "${s.title}"`}
                          className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-muted transition hover:border-coral hover:text-coral"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </Card>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      {/* O'chirish tasdig'i — qaytarib bo'lmaydigan amal, shuning uchun modal */}
      {ochirilsinmi && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
          onClick={() => !amalKetmoqda && setOchirilsinmi(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Delete chat"
        >
          <Card className="rise-in w-full max-w-sm p-6">
            <div onClick={(e) => e.stopPropagation()}>
              <h2 className="font-display text-lg font-semibold">Delete this chat?</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                <span className="text-ink">{ochirilsinmi.title}</span> — will be deleted along with
                all of its messages. This cannot be undone.
              </p>
              {ishlayotganlar[ochirilsinmi.id] && (
                <p className="mt-2 text-xs text-gold">
                  An agent is currently running in this chat — it will be stopped too.
                </p>
              )}

              <div className="mt-5 flex justify-end gap-2">
                <button
                  onClick={() => setOchirilsinmi(null)}
                  disabled={amalKetmoqda}
                  className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void ochir(ochirilsinmi)}
                  disabled={amalKetmoqda}
                  className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-40"
                >
                  {amalKetmoqda ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
