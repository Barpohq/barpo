// App actions — the buttons the user presses (restart, stop, ...).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ CONFIRMATION GUARDS AGAINST MISCLICKS, NOT AGAINST ATTACKS.          │
// │                                                                      │
// │ An action with `confirm: true` shows a modal, but the server does    │
// │ NOT CHECK that flag (`routes/apps.ts`) — code calling the API        │
// │ directly skips it. This is a DELIBERATE boundary: real protection    │
// │ belongs at the code-execution level, not in the UI.                  │
// └──────────────────────────────────────────────────────────────────────┘
//
// THE LOCK LIVES IN TWO PLACES. The UI disables the button while the server
// ties a second call to the existing result via `isActionBusy`. Both are
// needed: the UI lock answers the user instantly, the server lock covers the
// two-browser-windows case.

import { useState } from 'react'
import type { AppAction } from '@platforma/shared'
import { ApiError, runAppAction, type ActionResponse } from '../lib/api'
import { useToast } from '../lib/toast'
import { Card, LevelBadge } from '../ui'

function ConfirmModal({
  action,
  busy,
  cancel,
  confirm,
}: {
  action: AppAction
  busy: boolean
  cancel: () => void
  confirm: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4"
      onClick={cancel}
      role="presentation"
    >
      <div
        className="w-full max-w-sm rounded-xl border border-line bg-panel p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h3 className="font-display text-sm font-semibold">{action.label}</h3>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {action.hint || 'Do you want to run this action?'}
        </p>

        {action.risk === 'dangerous' && (
          <p className="mt-3 rounded-lg border border-dashed border-gold/50 px-3 py-2 text-[11px] leading-relaxed text-gold">
            This action is marked dangerous — its result may not be reversible.
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            className="rounded-lg px-3 py-1.5 text-xs text-muted transition-colors hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className={`rounded-lg px-4 py-1.5 text-xs font-medium text-bg transition-opacity disabled:opacity-40 ${
              action.risk === 'dangerous' ? 'bg-gold' : 'bg-lazur'
            }`}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ActionButtons({
  appId,
  actions,
  onCompleted,
}: {
  appId: string
  actions: AppAction[]
  /**
   * After the action — the caller applies the new state values.
   *
   * The server ALWAYS recomputes the states listed in `refresh` and returns
   * them in the response, so no follow-up request is needed here.
   */
  onCompleted?: (response: ActionResponse) => void
}) {
  const toast = useToast()
  /** Names of the actions currently running */
  const [inFlight, setInFlight] = useState<Set<string>>(new Set())
  const [awaitingConfirm, setAwaitingConfirm] = useState<AppAction | null>(null)

  async function run(action: AppAction) {
    if (inFlight.has(action.name)) return

    setInFlight((s) => new Set(s).add(action.name))
    try {
      const response = await runAppAction(appId, action.name)

      if (response.ok) {
        toast(response.message || `${action.label} — done`, 'success')
      } else {
        // An error inside the action — an app error, not a server error.
        toast(response.error || 'The action did not run', 'error')
      }

      onCompleted?.(response)
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not run the action', 'error')
    } finally {
      setInFlight((s) => {
        const next = new Set(s)
        next.delete(action.name)
        return next
      })
    }
  }

  function clicked(action: AppAction) {
    if (action.confirm) setAwaitingConfirm(action)
    else void run(action)
  }

  return (
    <>
      <Card className="overflow-hidden">
        <h2 className="border-b border-line px-5 py-3 font-display text-sm font-semibold">
          Controls
        </h2>

        <div className="flex flex-wrap gap-2 px-5 py-4">
          {actions.map((action) => {
            const busy = inFlight.has(action.name)

            return (
              <button
                key={action.name}
                type="button"
                onClick={() => clicked(action)}
                disabled={busy}
                title={action.hint}
                className={`group flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors disabled:opacity-50 ${
                  action.risk === 'dangerous'
                    ? 'border-gold/40 hover:border-gold hover:bg-gold/10'
                    : 'border-line hover:border-lazur/60 hover:bg-panel2'
                }`}
              >
                {busy && (
                  <span className="size-3 animate-spin rounded-full border border-lazur border-t-transparent" />
                )}
                <span>{action.label}</span>
                {action.risk === 'dangerous' && <LevelBadge level="dangerous" />}
              </button>
            )
          })}
        </div>
      </Card>

      {awaitingConfirm && (
        <ConfirmModal
          action={awaitingConfirm}
          busy={inFlight.has(awaitingConfirm.name)}
          cancel={() => setAwaitingConfirm(null)}
          confirm={() => {
            const action = awaitingConfirm
            setAwaitingConfirm(null)
            void run(action)
          }}
        />
      )}
    </>
  )
}
