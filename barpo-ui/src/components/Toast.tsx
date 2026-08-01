// Toast — a temporary notification that appears at the bottom of the screen.
//
// Why a Provider and not state on every page: there are many places that raise
// a message (Chat, Conversations, Skills…) but only one appearance. If every
// page kept its own state and timer, three things would be duplicated —
// markup, timer and z-index. The Provider gathers them in one place.
//
// Usage:
//   const toast = useToast()              // from lib/toast
//   toast('Synced: +3 new', 'success')
//   toast('Could not connect', 'error')

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DURATION,
  EXIT_DURATION,
  ToastContext,
  type ToastFn,
  type ToastKind,
} from '../lib/toast'

type ToastEntry = {
  id: number
  message: string
  kind: ToastKind
  /** `true` while the exit animation runs — it is still in the DOM */
  exiting?: boolean
}

const style: Record<
  ToastKind,
  { border: string; text: string; icon: string; glow: string }
> = {
  info: {
    border: 'border-line',
    text: 'text-ink',
    icon: '',
    glow: 'transparent',
  },
  success: {
    border: 'border-mint/45',
    text: 'text-mint',
    icon: '✓',
    glow: 'var(--color-mint)',
  },
  warning: {
    border: 'border-gold/45',
    text: 'text-gold',
    icon: '!',
    glow: 'var(--color-gold)',
  },
  error: {
    border: 'border-coral/45',
    text: 'text-coral',
    icon: '✕',
    glow: 'var(--color-coral)',
  },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ToastEntry[]>([])
  const nextId = useRef(0)
  // Timers are kept in a ref so they can all be cleared on unmount. Each toast
  // has up to two timers — the start of its exit and its removal from the DOM.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>[]>())

  const addTimer = (id: number, t: ReturnType<typeof setTimeout>) => {
    const existing = timers.current.get(id)
    if (existing) existing.push(t)
    else timers.current.set(id, [t])
  }

  const clear = (id: number) => {
    for (const t of timers.current.get(id) ?? []) clearTimeout(t)
    timers.current.delete(id)
  }

  /**
   * Two-step dismissal: first the `exiting` flag is set (which starts the CSS
   * animation), then once the animation finishes the entry leaves the DOM.
   *
   * Removing it at once would make the toast "blink out" — jarring to the eye.
   */
  const dismiss = useCallback((id: number) => {
    setList((l) => l.map((t) => (t.id === id ? { ...t, exiting: true } : t)))
    addTimer(
      id,
      setTimeout(() => {
        setList((l) => l.filter((t) => t.id !== id))
        timers.current.delete(id)
      }, EXIT_DURATION),
    )
  }, [])

  const toast = useCallback<ToastFn>(
    (message, kind = 'info') => {
      const id = nextId.current++
      setList((l) => [...l, { id, message, kind }])
      addTimer(
        id,
        setTimeout(() => dismiss(id), DURATION[kind]),
      )
    },
    [dismiss],
  )

  /** Dismissing by click cancels the pending timers */
  const dismissByClick = useCallback(
    (id: number) => {
      clear(id)
      dismiss(id)
    },
    [dismiss],
  )

  useEffect(() => {
    const current = timers.current
    return () => {
      for (const entry of current.values()) for (const t of entry) clearTimeout(t)
      current.clear()
    }
  }, [])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastLayer list={list} onDismiss={dismissByClick} />
    </ToastContext.Provider>
  )
}

/**
 * The presentation layer.
 *
 * `pointer-events-none` on the container, `auto` on each toast: buttons under
 * a toast must stay clickable, but the toast itself must be clickable to
 * dismiss.
 *
 * `z-100` — above the modals too (z-50, z-60): an error raised from inside a
 * modal must still be visible.
 *
 * `aria-live="polite"` — the screen reader reads the message but does not
 * interrupt the user's typing. `polite` for errors as well: `assertive` would
 * steal focus on every error.
 */
function ToastLayer({
  list,
  onDismiss,
}: {
  list: ToastEntry[]
  onDismiss: (id: number) => void
}) {
  if (list.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed bottom-6 left-1/2 z-100 flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-4"
      aria-live="polite"
      aria-atomic="false"
    >
      {list.map((t) => {
        const s = style[t.kind]
        return (
          <button
            key={t.id}
            onClick={() => onDismiss(t.id)}
            title="Click to dismiss"
            // `origin-bottom`: the scale grows from below — the toast looks as
            // if it rises from its own place in the row
            className={`${t.exiting ? 'toast-exit' : 'toast-enter'} pointer-events-auto flex w-full origin-bottom items-start gap-2.5 rounded-xl border ${s.border} bg-panel2/95 px-4 py-2.5 text-left text-sm ${s.text} shadow-2xl backdrop-blur-sm transition-[filter,border-color] duration-200 hover:brightness-115`}
            style={
              // A soft glow matching the kind — it echoes the border colour,
              // but is absent for `info` (a neutral toast must not draw the eye)
              s.glow === 'transparent'
                ? undefined
                : {
                    boxShadow: `0 8px 28px -6px color-mix(in oklab, ${s.glow} 28%, transparent), 0 2px 8px -2px rgb(0 0 0 / 0.5)`,
                  }
            }
          >
            {s.icon && (
              <span
                className="mt-px grid size-4 shrink-0 place-items-center rounded-full font-mono text-[10px] leading-none"
                style={{
                  background: `color-mix(in oklab, ${s.glow} 20%, transparent)`,
                }}
                aria-hidden
              >
                {s.icon}
              </span>
            )}
            <span className="min-w-0 flex-1 leading-relaxed">{t.message}</span>
          </button>
        )
      })}
    </div>
  )
}
