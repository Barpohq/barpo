// AI yozgan ko'rinish kodini HOST React daraxtida bajaradi.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NEGA IFRAME EMAS. Avval bu kod `sandbox="allow-scripts"` li          │
// │ iframe'da ishlardi. U xavfsiz edi, lekin ikki narxi bor edi:         │
// │                                                                      │
// │  1) VIZUAL. Iframe o'z hujjati, o'z skrolli va o'z o'lchami bilan    │
// │     keladi — sahifa ichida sahifa bo'lib ko'rinardi. Balandlikni     │
// │     `postMessage` bilan sozlash ham buni to'liq yashira olmasdi.     │
// │                                                                      │
// │  2) USLUB. Iframe ichida Tailwind ham, platforma komponentlari ham   │
// │     yo'q edi — AI inline `style` bilan yozishga majbur bo'lardi va   │
// │     dashboard qolgan UI'dan ajralib turardi.                         │
// │                                                                      │
// │ Endi kod host daraxtida ishlaydi: `Card`, `StatTile` va Tailwind     │
// │ klasslari unga ochiq, natija esa platformaning bir qismidek          │
// │ ko'rinadi.                                                           │
// └──────────────────────────────────────────────────────────────────────┘
//
// ⚠️ ISHONCH DARAJASI. Bu kod host sahifada, ya'ni platformaning huquqi
// bilan ishlaydi. Bu ONGLI qaror va `states` qatlami bilan bir xil
// darajada (`state-bajar.ts` ga q.): u yerda ham AI kodi serverda to'liq
// huquq bilan bajariladi. Ikkalasini ham keyingi bosqichda bir xil
// klassifikator tekshiradi (prompt injection himoyasi) — ulanish
// nuqtalari `state-bajar.ts` dagi `kodniTekshir()` va
// `view-qurish.ts` dagi `taqiqlanganlarniTop()`.
//
// XATO IZOLYATSIYASI SAQLANADI: kod yiqilsa `KorinishChegarasi` uni
// ushlaydi va faqat shu blok o'chadi — vidjetlar va butun platforma
// ishlashda davom etadi.

import { Component, useMemo, type ErrorInfo, type ReactNode } from 'react'
import * as React from 'react'
import { Card, StatTile, StatusDot } from '../ui'

/**
 * AI kodiga beriladigan komponentlar.
 *
 * `ui.Card` shaklida ishlatiladi — global nomlar bilan to'qnashmasin va
 * AI nima mavjudligini bir joydan ko'rsin.
 */
const UI_KOMPONENTLARI = { Card, StatTile, StatusDot } as const

/**
 * Kodga beriladigan React hooklari.
 *
 * Import taqiqlangan (`view-qurish.ts`), shuning uchun hooklar argument
 * sifatida uzatiladi — kod ularni oddiy global kabi ishlatadi.
 */
const HOOKLAR = {
  useState: React.useState,
  useEffect: React.useEffect,
  useMemo: React.useMemo,
  useCallback: React.useCallback,
  useRef: React.useRef,
  useReducer: React.useReducer,
  useLayoutEffect: React.useLayoutEffect,
  useId: React.useId,
} as const

type Komponent = (props: { data: Record<string, unknown>; ui: typeof UI_KOMPONENTLARI }) => ReactNode

/**
 * Kompilyatsiya qilingan koddan komponent yasaydi.
 *
 * Kod `let __natija__; ...; return __natija__;` shaklida keladi
 * (`view-qurish.ts`), shuning uchun uni `new Function` bevosita
 * bajaradi va komponentni qaytaradi.
 *
 * XATO TASHLAMAYDI — muvaffaqiyatsiz bo'lsa `{ xato }` qaytadi.
 */
function komponentYasa(kod: string): { komponent?: Komponent; xato?: string } {
  try {
    const nomlar = ['React', ...Object.keys(HOOKLAR)]
    const qiymatlar = [React, ...Object.values(HOOKLAR)]

    const fabrika = new Function(...nomlar, kod)
    const natija = fabrika(...qiymatlar)

    if (typeof natija !== 'function') {
      return { xato: "Kod `export default function View({ data }) {...}` bermadi" }
    }
    return { komponent: natija as Komponent }
  } catch (xato) {
    return { xato: xato instanceof Error ? xato.message : String(xato) }
  }
}

interface ChegaraProps {
  children: ReactNode
  /** Kod o'zgarganda chegarani qayta tiklash uchun */
  kalit: string
  onXato: (xabar: string) => void
}

/**
 * Render xatosini ushlaydigan chegara.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ BU FOYDALANUVCHI TALABINING BEVOSITA BAJARILISHI: "uning yozgan    │
 * │ kodida xato bo'lsa faqat dashboard ishlamasin, butun dastur emas". │
 * │                                                                    │
 * │ React'da ushlanmagan render xatosi BUTUN DARAXTNI yiqitadi —       │
 * │ ya'ni chegara bo'lmasa platforma oq ekranga aylanardi.             │
 * └────────────────────────────────────────────────────────────────────┘
 */
class KorinishChegarasi extends Component<ChegaraProps, { xato: string | null }> {
  state = { xato: null as string | null }

  static getDerivedStateFromError(xato: unknown) {
    return { xato: xato instanceof Error ? xato.message : String(xato) }
  }

  componentDidCatch(xato: Error, _info: ErrorInfo) {
    this.props.onXato(xato.message)
  }

  componentDidUpdate(oldingi: ChegaraProps) {
    // Yangi kod kelganda eski xato holati tozalanadi — aks holda
    // tuzatilgan versiya ham "xato" bo'lib qolardi.
    if (oldingi.kalit !== this.props.kalit && this.state.xato) {
      this.setState({ xato: null })
    }
  }

  render() {
    if (this.state.xato) return null
    return this.props.children
  }
}

interface Props {
  /** Kompilyatsiya qilingan JS (`view-qurish.ts` chiqishi) */
  kod: string
  /** Ko'rinishga beriladigan ma'lumot (`data` + jonli statelar) */
  data: Record<string, unknown>
}

/** Xato bo'lganda ko'rsatiladigan blok */
function XatoBloki({ xabar }: { xabar: string }) {
  return (
    <Card className="p-5">
      <div className="text-xs font-medium uppercase tracking-wider text-gold">
        Dashboard ko'rinishi ishlamadi
      </div>
      <p className="mt-2 text-sm text-muted">
        Ilovaning maxsus ko'rinishi xato berdi. Platformaning qolgan qismi normal ishlayapti —
        quyidagi vidjetlar (agar bo'lsa) o'z holicha ko'rsatilgan.
      </p>
      <pre className="thin-scroll mt-3 max-h-32 overflow-auto rounded-lg bg-bg px-3 py-2 font-mono text-[11px] text-faint">
        {xabar}
      </pre>
    </Card>
  )
}

/**
 * AI ko'rinishini render qiladi.
 *
 * Ikki bosqichda yiqilishi mumkin va IKKALASI ham ushlanadi:
 *   1. Kod bajarilmasa (`komponentYasa`) — sintaksis yoki shakl xatosi
 *   2. Render paytida (`KorinishChegarasi`) — masalan `undefined.map()`
 */
export default function AiKorinish({ kod, data }: Props) {
  // Kod o'zgarmaguncha komponent QAYTA YASALMAYDI: har renderda
  // `new Function` chaqirilsa komponent identifikatori o'zgarib, React
  // uni har safar noldan mount qilardi (ichki holat yo'qolardi).
  const { komponent, xato } = useMemo(() => komponentYasa(kod), [kod])

  // Render xatosi KOD BILAN BIRGA saqlanadi.
  //
  // ┌────────────────────────────────────────────────────────────────┐
  // │ NEGA `useEffect` BILAN TOZALAMAYMIZ. Avval shunday edi:        │
  // │     useEffect(() => setRenderXatosi(null), [kod])              │
  // │ Effekt BIRINCHI mount'da ham ishlaydi va xatoni darhol         │
  // │ o'chirardi — natijada blok hech qachon ko'rinmasdi (brauzerda  │
  // │ amalda shunday bo'ldi: xato konsolda bor, ekranda yo'q).       │
  // │                                                                │
  // │ Xatoni kod bilan birga saqlash bu poygani butunlay yopadi:     │
  // │ yangi kod kelsa `xatoKodi` mos kelmaydi va xato o'z-o'zidan    │
  // │ e'tiborsiz qoladi.                                             │
  // └────────────────────────────────────────────────────────────────┘
  const [renderXatosi, setRenderXatosi] = React.useState<{
    kod: string
    xabar: string
  } | null>(null)

  const faolXato = renderXatosi?.kod === kod ? renderXatosi.xabar : null

  if (xato) return <XatoBloki xabar={xato} />
  if (faolXato) return <XatoBloki xabar={faolXato} />
  if (!komponent) return null

  const Korinish = komponent
  return (
    <KorinishChegarasi
      kalit={kod}
      onXato={(xabar) => setRenderXatosi({ kod, xabar })}
    >
      <Korinish data={data} ui={UI_KOMPONENTLARI} />
    </KorinishChegarasi>
  )
}
