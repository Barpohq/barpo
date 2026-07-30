// Toast — ekran pastida chiqadigan vaqtinchalik bildirishnoma.
//
// Nega Provider, nega har sahifada state emas: xabar chiqaradigan joy
// ko'p (Chat, Suhbatlar, Skills…), lekin ko'rinishi bitta. Har sahifa
// o'z state'i va taymerini yuritsa uchta narsa takrorlanardi — markup,
// taymer va z-index. Provider ularni bir joyga yig'adi.
//
// Ishlatish:
//   const toast = useToast()              // lib/toast dan
//   toast("Sinxronlandi: +3 yangi", 'success')
//   toast("Ulab bo'lmadi", 'error')

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  CHIQISH_VAQTI,
  DAVOMIYLIK,
  ToastContext,
  type ToastFn,
  type ToastTuri,
} from '../lib/toast'

type ToastYozuv = {
  id: number
  xabar: string
  turi: ToastTuri
  /** Chiqish animatsiyasi ketayotgan bo'lsa `true` — DOM'da hali turadi */
  chiqmoqda?: boolean
}

const uslub: Record<
  ToastTuri,
  { chegara: string; matn: string; belgi: string; nur: string }
> = {
  info: {
    chegara: 'border-line',
    matn: 'text-ink',
    belgi: '',
    nur: 'transparent',
  },
  success: {
    chegara: 'border-mint/45',
    matn: 'text-mint',
    belgi: '✓',
    nur: 'var(--color-mint)',
  },
  warning: {
    chegara: 'border-gold/45',
    matn: 'text-gold',
    belgi: '!',
    nur: 'var(--color-gold)',
  },
  error: {
    chegara: 'border-coral/45',
    matn: 'text-coral',
    belgi: '✕',
    nur: 'var(--color-coral)',
  },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [royxat, setRoyxat] = useState<ToastYozuv[]>([])
  const keyingiId = useRef(0)
  // Taymerlarni ref'da saqlaymiz: unmount'da hammasini tozalash uchun.
  // Har toastda ikkitagacha taymer bo'ladi — ketish boshlanishi va
  // DOM'dan olinishi.
  const taymerlar = useRef(new Map<number, ReturnType<typeof setTimeout>[]>())

  const taymerQosh = (id: number, t: ReturnType<typeof setTimeout>) => {
    const bor = taymerlar.current.get(id)
    if (bor) bor.push(t)
    else taymerlar.current.set(id, [t])
  }

  const tozala = (id: number) => {
    for (const t of taymerlar.current.get(id) ?? []) clearTimeout(t)
    taymerlar.current.delete(id)
  }

  /**
   * Ikki bosqichli yopish: avval `chiqmoqda` bayrog'i qo'yiladi (CSS
   * animatsiyani boshlaydi), animatsiya tugagach yozuv DOM'dan olinadi.
   *
   * Birdaniga o'chirsak toast "yo'q bo'lib qolar" edi — ko'z uchun keskin.
   */
  const ochir = useCallback((id: number) => {
    setRoyxat((r) => r.map((t) => (t.id === id ? { ...t, chiqmoqda: true } : t)))
    taymerQosh(
      id,
      setTimeout(() => {
        setRoyxat((r) => r.filter((t) => t.id !== id))
        taymerlar.current.delete(id)
      }, CHIQISH_VAQTI),
    )
  }, [])

  const toast = useCallback<ToastFn>(
    (xabar, turi = 'info') => {
      const id = keyingiId.current++
      setRoyxat((r) => [...r, { id, xabar, turi }])
      taymerQosh(
        id,
        setTimeout(() => ochir(id), DAVOMIYLIK[turi]),
      )
    },
    [ochir],
  )

  /** Bosib yopishda kutib turgan taymerlar bekor qilinadi */
  const qolYopish = useCallback(
    (id: number) => {
      tozala(id)
      ochir(id)
    },
    [ochir],
  )

  useEffect(() => {
    const joriy = taymerlar.current
    return () => {
      for (const royxat of joriy.values()) for (const t of royxat) clearTimeout(t)
      joriy.clear()
    }
  }, [])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastQatlami royxat={royxat} onOchir={qolYopish} />
    </ToastContext.Provider>
  )
}

/**
 * Ko'rsatuvchi qatlam.
 *
 * `pointer-events-none` konteynerda, `auto` esa har toastda: toast ostidagi
 * tugmalar bosilaverishi kerak, lekin toastning o'zi bosilib yopilsin.
 *
 * `z-100` — modallardan (z-50, z-60) ham tepada: modal ichidan chiqqan xato
 * ham ko'rinishi kerak.
 *
 * `aria-live="polite"` — screen reader xabarni o'qiydi, lekin foydalanuvchi
 * yozayotganini bo'lmaydi. Xato uchun ham `polite`: `assertive` har xatoda
 * fokusni uzardi.
 */
function ToastQatlami({
  royxat,
  onOchir,
}: {
  royxat: ToastYozuv[]
  onOchir: (id: number) => void
}) {
  if (royxat.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed bottom-6 left-1/2 z-100 flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-4"
      aria-live="polite"
      aria-atomic="false"
    >
      {royxat.map((t) => {
        const u = uslub[t.turi]
        return (
          <button
            key={t.id}
            onClick={() => onOchir(t.id)}
            title="Click to dismiss"
            // `origin-bottom`: scale pastdan o'sadi — toast qatordagi
            // o'z joyidan ko'tarilayotgandek ko'rinadi
            className={`${t.chiqmoqda ? 'toast-chiqish' : 'toast-kirish'} pointer-events-auto flex w-full origin-bottom items-start gap-2.5 rounded-xl border ${u.chegara} bg-panel2/95 px-4 py-2.5 text-left text-sm ${u.matn} shadow-2xl backdrop-blur-sm transition-[filter,border-color] duration-200 hover:brightness-115`}
            style={
              // Turga mos yumshoq nur — chekka rangini takrorlaydi, lekin
              // `info` da umuman yo'q (neytral toast e'tibor tortmasin)
              u.nur === 'transparent'
                ? undefined
                : {
                    boxShadow: `0 8px 28px -6px color-mix(in oklab, ${u.nur} 28%, transparent), 0 2px 8px -2px rgb(0 0 0 / 0.5)`,
                  }
            }
          >
            {u.belgi && (
              <span
                className="mt-px grid size-4 shrink-0 place-items-center rounded-full font-mono text-[10px] leading-none"
                style={{
                  background: `color-mix(in oklab, ${u.nur} 20%, transparent)`,
                }}
                aria-hidden
              >
                {u.belgi}
              </span>
            )}
            <span className="min-w-0 flex-1 leading-relaxed">{t.xabar}</span>
          </button>
        )
      })}
    </div>
  )
}
