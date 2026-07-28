// Toast kontekst va hook — komponentlardan ALOHIDA fayl.
//
// Nega ajratilgan: Vite fast refresh faqat komponent eksport qiladigan
// faylda ishlaydi. `useToast` bilan `ToastProvider` bir joyda tursa,
// hook o'zgarganda butun daraxt qayta yuklanardi.
//
// Ko'rinish va Provider — `components/Toast.tsx` da.

import { createContext, useContext } from 'react'

export type ToastTuri = 'info' | 'success' | 'warning' | 'error'

export type ToastFn = (xabar: string, turi?: ToastTuri) => void

/** Ko'rinish vaqti (ms). Xato uzoqroq turadi — o'qib ulgurish kerak. */
export const DAVOMIYLIK: Record<ToastTuri, number> = {
  info: 3500,
  success: 3500,
  warning: 5000,
  error: 6000,
}

/**
 * Chiqish animatsiyasi davomiyligi (ms) — `index.css` dagi `.toast-chiqish`
 * bilan MOS bo'lishi shart. Kichikroq bo'lsa toast yarim yo'lda yo'qoladi,
 * kattaroq bo'lsa ko'rinmas holda osilib turadi.
 */
export const CHIQISH_VAQTI = 250

export const ToastContext = createContext<ToastFn | null>(null)

const noop: ToastFn = () => undefined

/**
 * Toast chaqiruvchi funksiyani qaytaradi.
 *
 * Provider'siz ishlatilsa jim `noop` qaytaradi — xabar ko'rsatolmaslik
 * sahifani buzib tashlashga arzimaydi.
 */
export function useToast(): ToastFn {
  return useContext(ToastContext) ?? noop
}
