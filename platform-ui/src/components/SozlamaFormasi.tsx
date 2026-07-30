// Ilova sozlamalari formasi — sxemadan render qilinadi.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NEGA SXEMA, AI JSX EMAS. `widgets` bilan bir xil falsafa: forma —    │
// │ foydalanuvchi KIRISHI, ya'ni validatsiya, maskalash va "bo'sh sir =   │
// │ o'zgartirmadim" qoidasi ishonchli bajarilishi kerak. Bu mantiqni AI   │
// │ qo'liga bersak, har ilovada boshqacha (va ba'zan buzuq) bo'lardi.     │
// │                                                                      │
// │ Murakkab holatlar uchun `view` yo'li ochiq (`ui.saqla`), lekin        │
// │ ODDIY yo'l — shu forma.                                              │
// └──────────────────────────────────────────────────────────────────────┘
//
// SIR MAYDONLAR. Ular BO'SH ochiladi va yonida "o'rnatilgan" belgisi turadi.
// Sabab: joriy token serverda va u brauzerga HECH QACHON kelmaydi
// (`types.ts` dagi boshqaruv qatlami izohiga q.). Foydalanuvchi joriy
// qiymatni ko'rmaydi — faqat yangisini yozadi.

import { useEffect, useMemo, useState } from 'react'
import type { SozlamaMaydoni } from '@platforma/shared'
import {
  ApiXatosi,
  ilovaSozlamalariniOl,
  ilovaSozlamalariniSaqla,
  type SozlamaHolati,
} from '../lib/api'
import { useToast } from '../lib/toast'
import { Card } from '../ui'

/**
 * Bitta maydonni tekshiradi. Xato bo'lsa matn, aks holda `null`.
 *
 * Server ham AYNAN shu tekshiruvlarni qayta bajaradi (`routes/apps.ts`) —
 * bu takrorlash ATAYLAB: mijoz tomoni tez javob beradi (foydalanuvchi
 * "Saqlash" bosishini kutmasin), server tomoni esa ishonch chegarasi.
 */
function maydonniTekshir(maydon: SozlamaMaydoni, qiymat: string): string | null {
  const bosh = qiymat.trim().length === 0

  // Sir uchun bo'sh — "o'zgartirmadim", ya'ni xato EMAS
  if (bosh && maydon.turi === 'sir') return null

  if (bosh && maydon.majburiy) return 'required'

  if (bosh) return null

  if (maydon.turi === 'raqam' && !Number.isFinite(Number(qiymat))) return 'number expected'

  if (maydon.naqsh) {
    try {
      if (!new RegExp(maydon.naqsh).test(qiymat)) {
        return maydon.naqshIzohi || 'format does not match'
      }
    } catch {
      // Naqsh yaroqsiz — server tomoni ham o'tkazib yuboradi
    }
  }

  return null
}

function MaydonKirishi({
  maydon,
  qiymat,
  ornatilgan,
  xato,
  ozgardi,
}: {
  maydon: SozlamaMaydoni
  qiymat: string
  ornatilgan: boolean
  xato: string | null
  ozgardi: (yangi: string) => void
}) {
  const asosiy =
    'w-full rounded-lg border bg-bg px-3 py-2 text-sm outline-none transition-colors ' +
    (xato ? 'border-gold/60 focus:border-gold' : 'border-line focus:border-lazur/60')

  if (maydon.turi === 'kalit') {
    // Switch — o'z yorlig'i bilan keladi, `label` tashqarida takrorlanmaydi
    const yoqilgan = qiymat === 'true' || qiymat === '1'
    return (
      <button
        type="button"
        onClick={() => ozgardi(yoqilgan ? 'false' : 'true')}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          yoqilgan ? 'bg-lazur' : 'bg-panel2'
        }`}
        role="switch"
        aria-checked={yoqilgan}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white transition-transform ${
            yoqilgan ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    )
  }

  if (maydon.turi === 'tanlov') {
    return (
      <select value={qiymat} onChange={(e) => ozgardi(e.target.value)} className={asosiy}>
        <option value="">— not selected —</option>
        {(maydon.variantlar ?? []).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    )
  }

  if (maydon.turi === 'kopMatn') {
    return (
      <textarea
        value={qiymat}
        onChange={(e) => ozgardi(e.target.value)}
        rows={4}
        className={`${asosiy} thin-scroll resize-y font-mono text-xs`}
      />
    )
  }

  return (
    <input
      type={maydon.turi === 'sir' ? 'password' : maydon.turi === 'raqam' ? 'text' : 'text'}
      inputMode={maydon.turi === 'raqam' ? 'numeric' : undefined}
      value={qiymat}
      onChange={(e) => ozgardi(e.target.value)}
      // Sir maydonda joriy qiymat KO'RSATILMAYDI — u brauzerga kelmaydi
      placeholder={
        maydon.turi === 'sir'
          ? ornatilgan
            ? 'enter a new value to change it'
            : 'not set yet'
          : maydon.standart
            ? `default: ${maydon.standart}`
            : ''
      }
      autoComplete={maydon.turi === 'sir' ? 'new-password' : 'off'}
      className={asosiy}
    />
  )
}

export default function SozlamaFormasi({
  appId,
  onSaqlandi,
}: {
  appId: string
  /** Saqlangandan keyin — chaqiruvchi statelarni yangilaydi */
  onSaqlandi?: () => void
}) {
  const toast = useToast()
  const [holat, setHolat] = useState<SozlamaHolati | null>(null)
  const [yuklanmoqda, setYuklanmoqda] = useState(true)
  const [oqishXatosi, setOqishXatosi] = useState<string | null>(null)
  const [saqlanmoqda, setSaqlanmoqda] = useState(false)
  /** Foydalanuvchi kiritgan qiymatlar — serverdan kelganidan ALOHIDA */
  const [kiritilgan, setKiritilgan] = useState<Record<string, string>>({})

  useEffect(() => {
    let bekor = false
    setYuklanmoqda(true)
    setOqishXatosi(null)

    ilovaSozlamalariniOl(appId)
      .then((h) => {
        if (bekor) return
        setHolat(h)
        // Kiritilganlarni tozalaymiz: boshqa ilovaga o'tilgan bo'lishi mumkin
        setKiritilgan({})
      })
      .catch((x: unknown) => {
        if (bekor) return
        setOqishXatosi(x instanceof ApiXatosi ? x.message : 'Could not load the settings')
      })
      .finally(() => {
        if (!bekor) setYuklanmoqda(false)
      })

    return () => {
      bekor = true
    }
  }, [appId])

  /** Ko'rsatiladigan qiymat: kiritilgani bo'lsa u, yo'q bo'lsa serverdan */
  function qiymatOl(maydon: SozlamaMaydoni): string {
    if (maydon.kalit in kiritilgan) return kiritilgan[maydon.kalit]!
    // Sir HECH QACHON serverdan kelmaydi — bo'sh qoladi
    if (maydon.turi === 'sir') return ''
    return holat?.qiymatlar[maydon.kalit] ?? maydon.standart ?? ''
  }

  const xatolar = useMemo(() => {
    if (!holat) return {}
    const n: Record<string, string> = {}
    for (const maydon of holat.maydonlar) {
      // Faqat TEGILGAN maydonlarni tekshiramiz: forma ochilganda hamma
      // majburiy maydon qizil bo'lib chiqsa foydalanuvchi cho'chiydi.
      if (!(maydon.kalit in kiritilgan)) continue
      const x = maydonniTekshir(maydon, qiymatOl(maydon))
      if (x) n[maydon.kalit] = x
    }
    return n
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holat, kiritilgan])

  const ozgargan = Object.keys(kiritilgan).length > 0
  const xatoBor = Object.keys(xatolar).length > 0

  async function saqla() {
    if (!holat || !ozgargan || xatoBor || saqlanmoqda) return

    // Faqat O'ZGARGANLARINI yuboramiz: tegilmagan maydon serverdagi
    // qiymatini saqlab qoladi.
    const yuboriladigan: Record<string, string> = {}
    for (const [kalit, qiymat] of Object.entries(kiritilgan)) {
      const maydon = holat.maydonlar.find((m) => m.kalit === kalit)
      if (!maydon) continue
      // Bo'sh sir — "o'zgartirmadim", yubormaymiz
      if (maydon.turi === 'sir' && qiymat.length === 0) continue
      yuboriladigan[kalit] = qiymat
    }

    if (Object.keys(yuboriladigan).length === 0) {
      setKiritilgan({})
      return
    }

    setSaqlanmoqda(true)
    try {
      const javob = await ilovaSozlamalariniSaqla(appId, yuboriladigan)
      toast(javob.xabar || 'Settings saved', 'success')
      setKiritilgan({})

      // Serverdan qayta o'qiymiz: `oqi` yangi holatni ko'rsatadi va sir
      // maydonlarning "o'rnatilgan" belgisi yangilanadi.
      ilovaSozlamalariniOl(appId)
        .then(setHolat)
        .catch(() => undefined)

      onSaqlandi?.()
    } catch (x) {
      if (x instanceof ApiXatosi) {
        // Server validatsiya xatolari (400) — ular mijoz tekshiruvidan
        // o'tib ketgan holatlar (masalan naqsh serverda qat'iyroq).
        toast(x.detail ? `${x.message}: ${x.detail}` : x.message, 'error')
      } else {
        toast('Could not save', 'error')
      }
    } finally {
      setSaqlanmoqda(false)
    }
  }

  if (yuklanmoqda) {
    return (
      <Card className="p-5">
        <div className="text-xs text-faint">Loading settings…</div>
      </Card>
    )
  }

  if (oqishXatosi || !holat) {
    return (
      <Card className="p-5">
        <div className="text-xs font-medium uppercase tracking-wider text-gold">Settings</div>
        <p className="mt-2 text-xs text-muted">{oqishXatosi ?? 'No settings found'}</p>
      </Card>
    )
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h2 className="font-display text-sm font-semibold">Settings</h2>
        {holat.ogohlantirish && (
          // O'qish yiqilgan — forma baribir ishlaydi, foydalanuvchi yangi
          // qiymat yozib tuzatishi mumkin.
          <span className="font-mono text-[11px] text-gold" title={holat.ogohlantirish}>
            current values could not be read
          </span>
        )}
      </div>

      <div className="space-y-4 px-5 py-4">
        {holat.maydonlar.map((maydon) => {
          const xato = xatolar[maydon.kalit]
          const ornatilgan = holat.ornatilgan[maydon.kalit] === true

          return (
            <div key={maydon.kalit}>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                <label className="text-xs font-medium">
                  {maydon.yorliq}
                  {maydon.majburiy && <span className="ml-1 text-gold">*</span>}
                </label>

                {/* Sir uchun joriy qiymat emas, HOLAT ko'rsatiladi */}
                {maydon.turi === 'sir' && (
                  <span
                    className={`font-mono text-[11px] ${ornatilgan ? 'text-lazur' : 'text-faint'}`}
                  >
                    {ornatilgan ? '✓ set' : 'not set'}
                  </span>
                )}

                {xato && <span className="font-mono text-[11px] text-gold">{xato}</span>}
              </div>

              <MaydonKirishi
                maydon={maydon}
                qiymat={qiymatOl(maydon)}
                ornatilgan={ornatilgan}
                xato={xato ?? null}
                ozgardi={(yangi) => setKiritilgan((o) => ({ ...o, [maydon.kalit]: yangi }))}
              />

              {maydon.izoh && (
                <p className="mt-1 text-[11px] leading-relaxed text-faint">{maydon.izoh}</p>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
        <span className="text-[11px] text-faint">
          Values are written to the app on the server
        </span>
        <div className="flex items-center gap-2">
          {ozgargan && (
            <button
              type="button"
              onClick={() => setKiritilgan({})}
              disabled={saqlanmoqda}
              className="rounded-lg px-3 py-1.5 text-xs text-muted transition-colors hover:text-fg disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={saqla}
            disabled={!ozgargan || xatoBor || saqlanmoqda}
            className="rounded-lg bg-lazur px-4 py-1.5 text-xs font-medium text-bg transition-opacity disabled:opacity-40"
          >
            {saqlanmoqda ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Card>
  )
}
