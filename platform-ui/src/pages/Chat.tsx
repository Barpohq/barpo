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

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppManifest,
  ChatMessage,
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
  rejimOl,
  rejimOrnat as rejimOrnatSorov,
  ruxsatJavobiYubor,
  sessiyaOl,
  sessiyaYarat,
  xabarlarOl,
  xabarYubor,
} from '../lib/api'
import { useIshlayotganlar } from '../lib/ishlayotganlar'
import { saqlangandanOqi } from '../lib/model-saqlash'
import { useToast } from '../lib/toast'
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

/**
 * Bazadagi xabarni UI shakliga o'tkazadi (URL'dan tiklashda).
 *
 * `oqmoqda` qo'yilmaydi: tarixdan kelgan xabar allaqachon tugagan. Sahifa
 * yopilganda oqim davom etayotgan bo'lsa ham, qayta ochilganda uni kuzatib
 * bo'lmaydi — matn esa bazada saqlangan.
 */
function xabarniMoslash(x: ChatMessage): Msg {
  return {
    id: x.id,
    role: x.role,
    text: x.text,
    toolCards: x.toolCards,
  }
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
  /**
   * Tashqaridan (sidebar) "yangi suhbat" signali. Har oshganda oyna
   * tozalanadi. Hisoblagich, chunki bir xil qiymat qayta yuborilsa
   * effekt ishlamas edi.
   */
  yangiSuhbatSignali?: number
  /**
   * Ochilishi kerak bo'lgan suhbat — App boshqaradi (URL yoki sidebar
   * tanlovi). O'zgarganda shu suhbat bazadan tiklanadi.
   *
   * `null` — yangi, hali saqlanmagan suhbat.
   */
  ochiqSessiya?: string | null
  /** Sessiya yaratilganda yoki tozalanganda — App hash'ni yangilaydi */
  onSessiyaOzgardi?: (sessionId: string | null) => void
}

export default function Chat({
  pro,
  yangiSuhbatSignali,
  ochiqSessiya,
  onSessiyaOzgardi,
}: ChatProps) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const [modellar, setModellar] = useState<ModelInfo[]>([])
  /**
   * `modellar` ning ref nusxasi — suhbat tiklash effekti uchun.
   *
   * Effekt `ochiqSessiya` ga bog'langan, ya'ni modellar ro'yxati o'zgarganda
   * qayta ishlamaydi va o'zi yaratilgan paytdagi ro'yxatni yopib qoladi.
   * Ref bu muammoni bog'liqlik qo'shmasdan hal qiladi.
   */
  const modellarRef = useRef<ModelInfo[]>([])
  modellarRef.current = modellar
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
  /**
   * URL'dan tiklanayotgan sessiyaning provider/modeli.
   *
   * Ref, chunki modellar yuklash effekti bilan poyga bor: ikkalasi parallel
   * ketadi va qaysi biri oldin tugashi noma'lum. State bo'lsa model effekti
   * eski qiymatni ko'rishi mumkin edi.
   */
  const tiklanganSessiya = useRef<{ provider?: string; model?: string } | null>(null)
  /**
   * `onSessiyaOzgardi` ning barqaror nusxasi. App uni har renderda qayta
   * yaratadi — to'g'ridan-to'g'ri bog'lansa `send` ham har renderda qayta
   * quriladi va uni ishlatuvchi effektlar keraksiz qayta ishga tushardi.
   */
  const sessiyaXabarchi = useRef(onSessiyaOzgardi)
  sessiyaXabarchi.current = onSessiyaOzgardi
  /** Tiklash tugadimi — bo'lmasa "bo'sh chat" ekrani ko'rsatilmaydi */
  const [tiklanmoqda, setTiklanmoqda] = useState(Boolean(ochiqSessiya))

  // --- Ochiladigan suhbatni tiklash ---
  //
  // Ikki holatda ishga tushadi:
  //   1) sahifa `#chat/<uuid>` bilan ochilgan;
  //   2) foydalanuvchi sidebar yoki Suhbatlar sahifasidan boshqa suhbatni
  //      tanladi — `ochiqSessiya` o'zgaradi va shu suhbat qayta yuklanadi.
  //
  // O'ZIMIZ yaratgan sessiya bu yerga kirmaydi: `send()` ichida `sessionId`
  // allaqachon o'rnatilgan bo'ladi va quyidagi tenglik tekshiruvi effektni
  // to'xtatadi — aks holda yangi suhbat darhol bazadan qayta o'qilardi.
  useEffect(() => {
    // Bo'sh chat — tozalash `yangiSuhbat()` da bo'lib bo'lgan
    if (!ochiqSessiya) {
      setTiklanmoqda(false)
      return
    }
    // Allaqachon shu suhbat ochiq (masalan biz yaratgan) — qayta yuklamaymiz
    if (ochiqSessiya === sessionIdRef.current) {
      setTiklanmoqda(false)
      return
    }

    let bekor = false
    setTiklanmoqda(true)
    // Eski suhbat qoldiqlari yangisiga aralashmasin. Ayniqsa `ruxsatlar`:
    // boshqa suhbatning javob kutayotgan kartasi bu yerda ko'rinib qolardi.
    setMsgs([])
    setRuxsatlar([])
    setRuxsatJavoblari({})
    kutilayotgan.current = null
    setBusy(false)

    void (async () => {
      const sessiya = await sessiyaOl(ochiqSessiya)
      if (bekor) return

      // URL eskirgan yoki sessiya o'chirilgan — jimgina bo'sh chatga tushamiz
      if (!sessiya) {
        sessiyaXabarchi.current?.(null)
        setTiklanmoqda(false)
        return
      }

      // Model tanlash effekti shu qiymatni kutadi
      tiklanganSessiya.current = { provider: sessiya.provider, model: sessiya.model }
      // Modellar allaqachon yuklangan bo'lsa (suhbatlar orasida o'tayotganda
      // shunday bo'ladi) model effekti qayta ishlamaydi — bu yerda tanlaymiz.
      // Ro'yxat ref'dan olinadi: state bu closure uchun eskirgan bo'lishi
      // mumkin, ref esa har doim joriy qiymatni beradi.
      const mos = modellarRef.current.find(
        (m) => m.provider === sessiya.provider && m.id === sessiya.model,
      )
      if (mos) setTanlangan(mos)

      try {
        const [xabarlar, rejimHolati] = await Promise.all([
          xabarlarOl(ochiqSessiya),
          rejimOl(ochiqSessiya).catch(() => null),
        ])
        if (bekor) return
        setMsgs(xabarlar.map(xabarniMoslash))
        setRejim(rejimHolati ?? { rejim: 'tasdiq' })
      } catch {
        // Xabarlar yuklanmasa ham sessiyani ochamiz — foydalanuvchi davom
        // ettira oladi, tarix esa keyingi yangilashda kelishi mumkin
      }

      if (bekor) return
      setSessionId(ochiqSessiya)
      setTiklanmoqda(false)
    })()

    return () => {
      bekor = true
    }
  }, [ochiqSessiya])

  // --- Modellarni yuklash ---
  useEffect(() => {
    let bekor = false
    modellarOl()
      .then((javob) => {
        if (bekor) return
        setModellar(javob.models)

        // URL'dan tiklanayotgan suhbat bo'lsa — uning modeli ustun. Sessiya
        // provideri qulflangan, boshqa model bilan davom ettirib bo'lmaydi.
        const tiklanayotgan = tiklanganSessiya.current
        const sessiyaModeli =
          tiklanayotgan &&
          javob.models.find(
            (m) => m.provider === tiklanayotgan.provider && m.id === tiklanayotgan.model,
          )

        // Oldin tanlangani hali mavjudmi — bo'lmasa birinchisini olamiz
        const saqlangan = saqlangandanOqi()
        const topilgan =
          sessiyaModeli ||
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
          // URL'ga yozamiz — endi sahifa yangilansa suhbat tiklanadi
          sessiyaXabarchi.current?.(sid)
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
      toast(
        xato instanceof ApiXatosi
          ? `Javob yuborilmadi: ${xato.message}`
          : "Ruxsat javobi yuborilmadi",
        'error',
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
      toast(
        xato instanceof ApiXatosi ? `Rejim o'zgarmadi: ${xato.message}` : "Rejim o'zgarmadi",
        'error',
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

  // Tiklash paytida "Nima quramiz?" ko'rsatilmaydi — aks holda saqlangan
  // suhbat yuklanguncha bo'sh ekran miltillab o'tadi
  const empty = msgs.length === 0 && !tiklanmoqda
  const qulflangan = sessionId !== null
  /** Shu oyna kuzatmayotgan, lekin fonda ishlayotgan sessiyalar */
  const fondagilar = Object.entries(ishlayotganlar).filter(([id]) => id !== sessionId)

  /**
   * Oynani yangi suhbatga tayyorlaydi.
   *
   * Fondagi sessiya TO'XTATILMAYDI — u ishlashda davom etadi va "Jonli
   * oqimlar" ro'yxatidan qaytib ochish mumkin. Bu yerda faqat shu oyna
   * tozalanadi.
   */
  function yangiSuhbat() {
    setSessionId(null)
    sessiyaXabarchi.current?.(null)
    setMsgs([])
    setRuxsatlar([])
    setRuxsatJavoblari({})
    // Rejim tanlovi saqlanadi, lekin "o'chdi" sababi tozalanadi
    setRejim((r) => ({ rejim: r.rejim }))
    // LOYIHA TANLOVI ATAYLAB SAQLANADI: "loyiha ichida yangi chat ochish"
    // eng ko'p kerak bo'ladigan yo'l. Boshqa loyihaga o'tish uchun
    // tanlagich endi qulfsiz.
    kutilayotgan.current = null
    setBusy(false)
  }

  // Sidebar'dagi "Yangi suhbat" tugmasi. Boshlang'ich qiymatda (0) ishlamasin
  // — faqat haqiqiy bosishlarda.
  const oldingiSignal = useRef(yangiSuhbatSignali)
  useEffect(() => {
    if (yangiSuhbatSignali === undefined) return
    if (oldingiSignal.current === yangiSuhbatSignali) return
    oldingiSignal.current = yangiSuhbatSignali
    yangiSuhbat()
    // yangiSuhbat har renderda qayta yaratiladi — signalgagina bog'lanamiz
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yangiSuhbatSignali])

  return (
    <div className={`flex h-full flex-col ${pro ? '' : 'mx-auto w-full max-w-3xl'}`}>
      {/* Chat tepasida sarlavha qatori yo'q — suhbat mazmuni o'zi ko'rinib
          turadi. "Yangi suhbat" sidebar'da (pro) va pastdagi boshqaruv
          panelida (ikkala rejimda). Loyiha nomi ham pastdagi panelda,
          to'liq papka yo'li esa uning hover popup'ida. */}

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
            {/* Uchala tanlagich bitta kapsulada — qator yaxlit ko'rinadi,
                ular bir-biriga bog'liq sozlamalar ekani seziladi */}
            <div className="flex min-w-0 items-center gap-1 rounded-xl border border-line/60 bg-panel/40 p-1">
              <ModelTanlagich
                modellar={modellar}
                tanlangan={tanlangan}
                onTanla={setTanlangan}
                qulflangan={qulflangan}
                yuklanmoqda={modelYuklanmoqda}
                xato={modelXato}
              />
              <span className="h-4 w-px shrink-0 bg-line/60" aria-hidden />
              <RejimAlmashtirgich
                holat={rejim}
                onOzgart={(r) => void rejimniOzgart(r)}
                bandmi={busy}
              />
              <span className="h-4 w-px shrink-0 bg-line/60" aria-hidden />
              <LoyihaTanlagich
                loyihalar={loyihalar}
                tanlangan={loyiha}
                onTanla={setLoyiha}
                onYarat={loyihaYarat}
                qulflangan={qulflangan}
              />
            </div>
            {/* Suhbat boshlangach — yangisiga o'tish. Oddiy rejimda bu yagona
                yo'l (sidebar faqat pro'da bor). Joriy sessiya to'xtatilmaydi:
                fonda ishlashda davom etadi. */}
            {qulflangan && (
              <button
                onClick={yangiSuhbat}
                title="Joriy suhbat fonda ishlashda davom etadi"
                className="shrink-0 font-mono text-[11px] text-faint transition hover:text-lazur"
              >
                + yangi suhbat
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
