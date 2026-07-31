// Toast context and hook — a file SEPARATE from the components.
//
// Why it is split out: Vite fast refresh only works in a file that exports
// components. If `useToast` sat next to `ToastProvider`, changing the hook
// would reload the whole tree.
//
// The view and the Provider live in `components/Toast.tsx`.

import { createContext, useContext } from 'react'

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export type ToastFn = (message: string, kind?: ToastKind) => void

/** Visible duration (ms). Errors stay longer — they need to be read. */
export const DURATION: Record<ToastKind, number> = {
  info: 3500,
  success: 3500,
  warning: 5000,
  error: 6000,
}

/**
 * Exit animation duration (ms) — must MATCH `.toast-exit` in `index.css`. Any
 * shorter and the toast disappears mid-flight; any longer and it hangs around
 * invisibly.
 */
export const EXIT_DURATION = 250

export const ToastContext = createContext<ToastFn | null>(null)

const noop: ToastFn = () => undefined

/**
 * Returns the function that raises a toast.
 *
 * Used without a Provider it silently returns `noop` — not being able to show
 * a message is not worth breaking the page over.
 */
export function useToast(): ToastFn {
  return useContext(ToastContext) ?? noop
}
