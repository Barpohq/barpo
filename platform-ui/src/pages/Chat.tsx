// Chat sahifasi — haqiqiy LLM bilan suhbat.
//
// Oqim: xabar REST orqali yuboriladi (POST /api/chat/send → 202), javob esa
// WebSocket orqali bo'laklab keladi (chat.delta → chat.done | chat.error).
// Nega ikkiga bo'lingan? So'rovning qabul qilinganini (yoki rad etilganini,
// masalan 409 provider qulfi) darhol bilish kerak, javob esa uzoq davom
// etadi — uni HTTP javobida ushlab turish shart emas.
//
// Sessiya birinchi xabarda avtomatik yaratiladi va o'sha payt provider
// qulflanadi. Sessiya tarixi UI'si (eski suhbatlar ro'yxati) keyingi
// bosqichda qo'shiladi.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppManifest,
  ModelInfo,
  Project,
  RejimHolati,
  RuxsatJavobi,
  RuxsatRejimi,
  RuxsatSorovi,
  ToolChaqiruv,
} from '@platforma/shared'
import LoyihaTanlagich from '../components/LoyihaTanlagich'
import Markdown from '../components/Markdown'
import ModelTanlagich from '../components/ModelTanlagich'
import OqimIndikatori from '../components/OqimIndikatori'
import RejimAlmashtirgich from '../components/RejimAlmashtirgich'
import RejimKartasi from '../components/RejimKartasi'
import RuxsatKartasi from '../components/RuxsatKartasi'
import ToolKartasi from '../components/ToolKartasi'
import {
  ApiXatosi,
  loyihalarOl,
  loyihaYarat as loyihaYaratSorov,
  modellarOl,
  oqimniToxtat,
  rejimOrnat as rejimOrnatSorov,
  ruxsatJavobiYubor,
  sessiyaYarat,
  xabarYubor,
} from '../lib/api'
import { useIshlayotganlar } from '../lib/ishlayotganlar'
import { saqlangandanOqi } from '../lib/model-saqlash'
import { ws } from '../lib/ws'

interface Msg {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Agent shu javob davomida bajargan tool chaqiruvlari, tartib bo'yicha */
  toolCards?: ToolChaqiruv[]
  /** Javob oqimi tugadimi — false bo'lsa kursor miltillaydi */
  oqmoqda?: boolean
  xato?: string
}

/** Kiritish maydoni shundan oshmaydi — ~8 qator, keyin ichida aylanadi */
const KIRITISH_MAX_BALANDLIK = 200

const takliflar = [
  'Salom! O\'zingni tanishtir',
  'TypeScript va JavaScript farqi nima?',
  'Menga qisqa she\'r yozib ber',
  'Bugungi rejamni tuzishga yordam ber',
]

interface ChatProps {
  pro: boolean
  onInstallApp: (m: AppManifest) => void
  openApp: (id: string) => void
}

export default function Chat({ pro }: ChatProps) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const [modellar, setModellar] = useState<ModelInfo[]>([])
  const [tanlangan, setTanlangan] = useState<ModelInfo | null>(null)
  const [modelYuklanmoqda, setModelYuklanmoqda] = useState(true)
  const [modelXato, setModelXato] = useState<string | null>(null)

  // Loyihalar: ro'yxat + shu suhbat uchun tanlangani. Tanlov sessiya
  // yaratilgunga qadar o'zgartirilishi mumkin, keyin qulflanadi.
  const [loyihalar, setLoyihalar] = useState<Project[]>([])
  const [loyiha, setLoyiha] = useState<Project | null>(null)

  const [sessionId, setSessionId] = useState<string | null>(null)
  /**
   * `sessionId` ning ref nusxasi — WS tinglovchisi uchun.
   *
   * Tinglovchi `useEffect` da BIR MARTA ro'yxatdan o'tadi, shuning uchun u
   * o'zi yaratilgan paytdagi state'ni yopib qoladi ("stale closure"). Ref
   * har doim joriy qiymatni beradi, tinglovchini qayta ro'yxatdan
   * o'tkazmasdan.
   */
  const sessionIdRef = useRef<string | null>(null)
  /** Javob kutayotgan ruxsat so'rovlari va allaqachon berilgan javoblar */
  const [ruxsatlar, setRuxsatlar] = useState<RuxsatSorovi[]>([])
  const [ruxsatJavoblari, setRuxsatJavoblari] = useState<Record<string, RuxsatJavobi>>({})
  const [rejim, setRejim] = useState<RejimHolati>({ rejim: 'tasdiq' })
  // Fonda ishlayotgan BOSHQA suhbatlar — `chat.status` sessiya bo'yicha
  // filtrlanmagani uchun bu yerda ham ko'rinadi (protocol.ts ga q.).
  const { ishlayotganlar, sarlavhalar } = useIshlayotganlar()
  const endRef = useRef<HTMLDivElement>(null)
  const kiritishRef = useRef<HTMLTextAreaElement>(null)
  // Hozir javob kutilayotgan xabar id'si — WS eventlari shu bo'yicha topiladi
  const kutilayotgan = useRef<string | null>(null)

  // --- Modellarni yuklash ---
  useEffect(() => {
    let bekor = false
    modellarOl()
      .then((javob) => {
        if (bekor) return
        setModellar(javob.models)

        // Oldin tanlangani hali mavjudmi — bo'lmasa birinchisini olamiz
        const saqlangan = saqlangandanOqi()
        const topilgan =
          (saqlangan &&
            javob.models.find((m) => m.provider === saqlangan.provider && m.id === saqlangan.model)) ||
          javob.models[0] ||
          null
        setTanlangan(topilgan)

        if (javob.models.length === 0) {
          setModelXato(
            "Hech qanday AI provider topilmadi. API kalitini muhit o'zgaruvchisiga qo'ying yoki Ollama'ni ishga tushiring.",
          )
        }
      })
      .catch((xato: unknown) => {
        if (bekor) return
        setModelXato(xato instanceof Error ? xato.message : 'Modellarni yuklab bo\'lmadi')
      })
      .finally(() => {
        if (!bekor) setModelYuklanmoqda(false)
      })
    return () => {
      bekor = true
    }
  }, [])

  // --- Loyihalarni yuklash ---
  //
  // Xato bo'lsa jim qolamiz: loyiha ixtiyoriy imkoniyat, u yuklanmasa
  // suhbat loyihasiz (o'z papkasida) baribir ishlaydi.
  useEffect(() => {
    let bekor = false
    loyihalarOl()
      .then((royxat) => {
        if (!bekor) setLoyihalar(royxat)
      })
      .catch(() => undefined)
    return () => {
      bekor = true
    }
  }, [])

  // --- WS: javob oqimini tinglash ---
  //
  // IKKI QATLAMLI HIMOYA (sessiya izolyatsiyasi):
  //   1) serverga `sub.sessionId` yuboriladi — u begona sessiya eventlarini
  //      umuman yubormaydi (pastdagi `sessiyaniKuzat` effekti);
  //   2) shunga qaramay kelgan eventning `sessionId` si tekshiriladi.
  // Ikkinchisi ortiqcha emas: sessiya yaratilgunga qadar (birinchi xabar
  // yuborilayotgan payt) filtr hali o'rnatilmagan bo'lishi mumkin, qayta
  // ulanish paytida ham qisqa oyna bor. Server xatosi UI'da begona matn
  // bo'lib ko'rinmasligi kerak.
  useEffect(() => {
    ws.ulan()
    const obunaBekor = ws.obuna(['chat'])
    const kuzatBekor = ws.kuzat((event) => {
      // Sessiyali chat eventi boshqa suhbatga tegishli bo'lsa — e'tiborsiz.
      // `sessionIdRef` ishlatiladi (state emas): bu tinglovchi bir marta
      // ro'yxatdan o'tadi va eski state'ni yopib qolib ketardi.
      if ('sessionId' in event && event.type.startsWith('chat.')) {
        const joriy = sessionIdRef.current
        if (joriy !== null && event.sessionId !== joriy) return
      }

      switch (event.type) {
        case 'chat.delta':
          setMsgs((m) =>
            m.map((x) => (x.id === event.messageId ? { ...x, text: x.text + event.delta } : x)),
          )
          break

        case 'chat.tool':
          // Bir xil `id` bilan bir necha marta keladi: ishlamoqda → tugadi.
          // Mavjud kartani almashtiramiz, yo'q bo'lsa oxiriga qo'shamiz.
          setMsgs((m) =>
            m.map((x) => {
              if (x.id !== event.messageId) return x
              const mavjud = x.toolCards ?? []
              const indeks = mavjud.findIndex((t) => t.id === event.tool.id)
              const yangi =
                indeks >= 0
                  ? mavjud.map((t, i) => (i === indeks ? event.tool : t))
                  : [...mavjud, event.tool]
              return { ...x, toolCards: yangi }
            }),
          )
          break

        case 'chat.permission':
          setRuxsatlar((r) => (r.some((s) => s.id === event.sorov.id) ? r : [...r, event.sorov]))
          break

        case 'chat.klassifikator':
          // Qaror oxirgi tool kartasiga yorliq bo'lib yopishadi
          setMsgs((m) =>
            m.map((x) => {
              if (x.id !== event.messageId || !x.toolCards?.length) return x
              const kartalar = [...x.toolCards]
              const oxirgi = kartalar.length - 1
              kartalar[oxirgi] = { ...kartalar[oxirgi]!, klassifikator: event.qaror }
              return { ...x, toolCards: kartalar }
            }),
          )
          break

        case 'chat.rejim':
          setRejim(event.holat)
          break

        case 'chat.done':
          setMsgs((m) => m.map((x) => (x.id === event.messageId ? { ...x, oqmoqda: false } : x)))
          setRuxsatlar([])
          if (kutilayotgan.current === event.messageId) {
            kutilayotgan.current = null
            setBusy(false)
          }
          break

        case 'chat.error':
          setMsgs((m) =>
            m.map((x) =>
              x.id === event.messageId ? { ...x, oqmoqda: false, xato: event.error } : x,
            ),
          )
          setRuxsatlar([])
          if (kutilayotgan.current === event.messageId) {
            kutilayotgan.current = null
            setBusy(false)
          }
          break

        default:
          // Boshqa kanallar bu sahifaga tegishli emas
          break
      }
    })
    return () => {
      obunaBekor()
      kuzatBekor()
    }
  }, [])

  // Sessiya o'zgarganda: ref'ni yangilaymiz va serverga qaysi sessiyani
  // kuzatayotganimizni aytamiz. Shundan keyin boshqa oynadagi suhbatning
  // eventlari bu ulanishga umuman kelmaydi.
  useEffect(() => {
    sessionIdRef.current = sessionId
    ws.sessiyaniKuzat(sessionId ?? undefined)
  }, [sessionId])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [msgs])

  // Textarea balandligi matnga moslashadi. Avval `auto` — aks holda scrollHeight
  // hech qachon kamaymaydi va maydon qatorlar o'chirilganda ham baland qoladi.
  useEffect(() => {
    const el = kiritishRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, KIRITISH_MAX_BALANDLIK)}px`
  }, [input])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  const send = useCallback(
    async (xom?: string) => {
      const text = (xom ?? input).trim()
      if (!text || busy || !tanlangan) return

      setInput('')
      setBusy(true)
      setMsgs((m) => [...m, { id: `u-${crypto.randomUUID()}`, role: 'user', text }])

      try {
        // Sessiya hali yo'q bo'lsa — birinchi xabarda yaratamiz
        let sid = sessionId
        if (!sid) {
          // Loyiha shu yerda BIR MARTA bog'lanadi — keyin sessiya ish
          // papkasi bilan birga qulflanadi
          const sessiya = await sessiyaYarat(text.slice(0, 60), loyiha?.id)
          sid = sessiya.id
          setSessionId(sid)
          // Sessiyagacha tanlangan rejimni serverga yetkazamiz
          if (rejim.rejim === 'auto') {
            try {
              setRejim(await rejimOrnatSorov(sid, 'auto'))
            } catch {
              // Rejim o'rnatilmasa tasdiq holicha qoladi — xabar berish shart emas,
              // almashtirgich holatni ko'rsatib turadi
              setRejim({ rejim: 'tasdiq' })
            }
          }
        }

        const javob = await xabarYubor(sid, text, {
          provider: tanlangan.provider,
          model: tanlangan.id,
        })

        kutilayotgan.current = javob.messageId
        setMsgs((m) => [
          ...m,
          { id: javob.messageId, role: 'assistant', text: '', oqmoqda: true },
        ])
      } catch (xato) {
        const xabar =
          xato instanceof ApiXatosi
            ? xato.detail
              ? `${xato.message} — ${xato.detail}`
              : xato.message
            : xato instanceof Error
              ? xato.message
              : "Noma'lum xato"
        setMsgs((m) => [
          ...m,
          { id: `x-${crypto.randomUUID()}`, role: 'assistant', text: '', xato: xabar },
        ])
        setBusy(false)
      }
    },
    [busy, input, loyiha?.id, rejim.rejim, sessionId, tanlangan],
  )

  /**
   * Yangi loyiha yaratadi va ro'yxatga qo'shadi.
   *
   * Xato tanlagich ichida ko'rsatiladi — shuning uchun bu yerda ushlanmaydi.
   */
  const loyihaYarat = useCallback(async (nom: string): Promise<Project> => {
    const yangi = await loyihaYaratSorov(nom)
    setLoyihalar((r) => [yangi, ...r])
    return yangi
  }, [])

  async function ruxsatBer(sorov: RuxsatSorovi, javob: RuxsatJavobi) {
    // Javobni darhol ko'rsatamiz — server tasdiqlashini kutmaymiz
    setRuxsatJavoblari((r) => ({ ...r, [sorov.id]: javob }))
    try {
      await ruxsatJavobiYubor(sorov.sessionId, sorov.id, javob)
    } catch (xato) {
      // Yuborilmasa foydalanuvchi bilishi kerak — agent kutib turibdi
      setToast(
        xato instanceof ApiXatosi
          ? `Javob yuborilmadi: ${xato.message}`
          : "Ruxsat javobi yuborilmadi",
      )
      setRuxsatJavoblari((r) => {
        const { [sorov.id]: _olib, ...qolgan } = r
        return qolgan
      })
    }
  }

  async function rejimniOzgart(yangi: RuxsatRejimi) {
    if (!sessionId) {
      // Sessiya hali yo'q — tanlovni eslab qolamiz, birinchi xabarda qo'llanadi
      setRejim({ rejim: yangi })
      return
    }
    const oldingi = rejim
    setRejim({ rejim: yangi }) // darhol ko'rsatamiz
    try {
      setRejim(await rejimOrnatSorov(sessionId, yangi))
    } catch (xato) {
      setRejim(oldingi)
      setToast(
        xato instanceof ApiXatosi ? `Rejim o'zgarmadi: ${xato.message}` : "Rejim o'zgarmadi",
      )
    }
  }

  async function toxtat() {
    if (!sessionId) return
    try {
      await oqimniToxtat(sessionId)
    } catch {
      // to'xtatish muvaffaqiyatsiz bo'lsa ham UI bloklanmasin
    }
    kutilayotgan.current = null
    setBusy(false)
    setMsgs((m) => m.map((x) => (x.oqmoqda ? { ...x, oqmoqda: false } : x)))
  }

  const empty = msgs.length === 0
  const qulflangan = sessionId !== null
  /** Shu oyna kuzatmayotgan, lekin fonda ishlayotgan sessiyalar */
  const fondagilar = Object.entries(ishlayotganlar).filter(([id]) => id !== sessionId)
  const tanlanganYorliq = useMemo(
    () => (tanlangan ? `${tanlangan.providerName} · ${tanlangan.name}` : null),
    [tanlangan],
  )

  return (
    <div className={`flex h-full flex-col ${pro ? '' : 'mx-auto w-full max-w-3xl'}`}>
      {/* Tanlangan loyiha — agent tool'lari qaysi papkada ishlayotgani
          har doim ko'rinib tursin */}
      {loyiha && (
        <div className="flex items-center gap-2 border-b border-line bg-panel px-4 py-1.5">
          <span className="font-mono text-[10px] tracking-widest text-faint uppercase">
            Loyiha
          </span>
          <span className="truncate font-mono text-[11px] text-lazur">{loyiha.name}</span>
          <span className="truncate font-mono text-[10px] text-faint">{loyiha.papka}</span>
        </div>
      )}

      {/* Fondagi boshqa suhbatlar — bu oynada ularning javobi ko'rinmaydi,
          lekin ishlayotgani (ayniqsa ruxsat kutayotgani) bilinib tursin */}
      {fondagilar.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-4 py-1.5">
          <span className="font-mono text-[10px] tracking-widest text-faint uppercase">
            Fonda
          </span>
          {fondagilar.map(([id, holat]) => (
            <span key={id} className="flex min-w-0 items-center gap-1.5">
              <OqimIndikatori holat={holat} />
              <span className="truncate font-mono text-[11px] text-muted">
                {sarlavhalar[id] ?? 'Nomsiz suhbat'}
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="thin-scroll flex-1 overflow-y-auto px-4 pt-6 pb-4">
        {empty && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="font-display text-3xl font-semibold tracking-tight">
              Nima quramiz<span className="text-lazur">?</span>
            </div>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
              Suhbatni boshlashdan oldin model tanlang. Model kompyuteringizdagi sozlangan
              providerlardan olinadi — mahalliy Ollama ham, obuna orqali ishlaydiganlari ham.
            </p>
          </div>
        )}

        <div className="mx-auto max-w-3xl space-y-5">
          {msgs.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="rise-in flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-panel2 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={m.id} className="rise-in">
                {m.toolCards?.map((t) => (
                  <ToolKartasi key={t.id} tool={t} />
                ))}
                {m.text && (
                  <>
                    <Markdown matn={m.text} />
                    {m.oqmoqda && (
                      <span className="cursor-blink -mt-1 inline-block text-lazur">▍</span>
                    )}
                  </>
                )}
                {!m.text && m.oqmoqda && (
                  <p className="text-[15px] text-faint">
                    <span className="cursor-blink text-lazur">▍</span>
                  </p>
                )}
                {m.xato && (
                  <div className="mt-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-coral">
                    {m.xato}
                  </div>
                )}
                {/* Ruxsat so'rovlari oxirgi javob ostida turadi */}
                {m.oqmoqda &&
                  ruxsatlar.map((sorov) => (
                    <RuxsatKartasi
                      key={sorov.id}
                      sorov={sorov}
                      berilganJavob={ruxsatJavoblari[sorov.id]}
                      onJavob={(javob) => void ruxsatBer(sorov, javob)}
                    />
                  ))}
              </div>
            ),
          )}

          {/* Auto o'z-o'zidan o'chgan bo'lsa sabab va qayta yoqish tugmasi */}
          {rejim.rejim === 'tasdiq' && rejim.sabab && (
            <RejimKartasi sabab={rejim.sabab} onQaytaYoq={() => void rejimniOzgart('auto')} />
          )}

          <div ref={endRef} />
        </div>
      </div>

      <div className="px-4 pb-5">
        <div className="mx-auto max-w-3xl">
          {empty && !modelYuklanmoqda && modellar.length > 0 && (
            <div className="mb-3 flex flex-wrap justify-center gap-2">
              {takliflar.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  className="rounded-full border border-line bg-panel px-3.5 py-1.5 text-[13px] text-muted transition hover:border-lazur-dim hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
            className="flex items-end gap-2 rounded-2xl border border-line bg-panel px-4 py-2 transition focus-within:border-lazur-dim"
          >
            <textarea
              ref={kiritishRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter yuboradi, Shift+Enter yangi qator. IME (masalan xitoycha
                // klaviatura) hali so'zni tasdiqlamagan bo'lsa aralashmaymiz.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={1}
              placeholder={tanlangan ? 'Xabaringizni yozing…' : 'Avval model tanlang…'}
              aria-label="Xabar"
              disabled={!tanlangan}
              // `fokus-tashqarida`: halqani form o'rami chizadi (focus-within)
              className="thin-scroll fokus-tashqarida flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed outline-none placeholder:text-faint disabled:cursor-not-allowed"
            />
            {busy ? (
              <button
                type="button"
                onClick={() => void toxtat()}
                className="mb-0.5 shrink-0 rounded-xl border border-line px-4 py-1.5 text-sm text-muted transition hover:border-coral hover:text-coral"
              >
                To'xtatish
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() || !tanlangan}
                className="mb-0.5 shrink-0 rounded-xl bg-lazur-dim px-4 py-1.5 text-sm font-semibold text-bg transition enabled:hover:brightness-110 disabled:opacity-40"
              >
                Yuborish
              </button>
            )}
          </form>

          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <ModelTanlagich
                modellar={modellar}
                tanlangan={tanlangan}
                onTanla={setTanlangan}
                qulflangan={qulflangan}
                yuklanmoqda={modelYuklanmoqda}
                xato={modelXato}
              />
              <RejimAlmashtirgich
                holat={rejim}
                onOzgart={(r) => void rejimniOzgart(r)}
                bandmi={busy}
              />
              <LoyihaTanlagich
                loyihalar={loyihalar}
                tanlangan={loyiha}
                onTanla={setLoyiha}
                onYarat={loyihaYarat}
                qulflangan={qulflangan}
              />
            </div>
            {qulflangan && (
              <button
                onClick={() => {
                  setSessionId(null)
                  setMsgs([])
                  setRuxsatlar([])
                  setRuxsatJavoblari({})
                  // Rejim tanlovi saqlanadi, lekin "o'chdi" sababi tozalanadi
                  setRejim((r) => ({ rejim: r.rejim }))
                  // LOYIHA TANLOVI ATAYLAB SAQLANADI: "loyiha ichida yangi
                  // chat ochish" eng ko'p kerak bo'ladigan yo'l. Boshqa
                  // loyihaga o'tish uchun tanlagich endi qulfsiz.
                  kutilayotgan.current = null
                  setBusy(false)
                }}
                className="shrink-0 font-mono text-[11px] text-faint transition hover:text-lazur"
              >
                + yangi suhbat
              </button>
            )}
            {!qulflangan && tanlanganYorliq && (
              <span className="shrink-0 font-mono text-[11px] text-faint">
                provider suhbat boshlangach qulflanadi
              </span>
            )}
          </div>
        </div>
      </div>

      {toast && (
        <div className="rise-in fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-panel2 px-4 py-2 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  )
}
