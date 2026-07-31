// Permission mode toggle — at the bottom of the chat, next to the model
// picker.
//
// Two states:
//   ⏸ confirm — every dangerous action is asked about (the default)
//   ⏵⏵ auto   — the classifier decides
//
// If auto turned itself off the button is gold and the reason appears in the
// tooltip — the user needs to know what happened.

import type { ModeState } from '@platforma/shared'

interface Props {
  state: ModeState
  onChange: (mode: 'confirm' | 'auto') => void
  /** The mode cannot be switched while a reply is streaming */
  busy?: boolean
}

export default function ModeToggle({ state, onChange, busy }: Props) {
  const auto = state.mode === 'auto'
  // There is a reason but the mode is confirm — i.e. auto turned itself off
  const turnedItselfOff = !auto && Boolean(state.reason)

  const label = auto ? '⏵⏵ auto' : '⏸ confirm'
  const description = auto
    ? `The classifier decides${state.classifierModel ? ` · ${state.classifierModel}` : ''}`
    : state.reason
      ? `Auto turned off: ${state.reason}`
      : 'Every dangerous action is asked about'

  return (
    <button
      type="button"
      onClick={() => onChange(auto ? 'confirm' : 'auto')}
      disabled={busy}
      title={description}
      aria-label={`Permission mode: ${auto ? 'auto' : 'confirm'}. ${description}`}
      className={`shrink-0 rounded-lg border px-2.5 py-1 font-mono text-[11px] transition disabled:opacity-40 ${
        auto
          ? 'border-lazur-dim text-lazur hover:brightness-110'
          : turnedItselfOff
            ? 'border-gold/50 text-gold hover:border-gold'
            : 'border-transparent text-faint hover:bg-panel2/60 hover:text-muted'
      }`}
    >
      {label}
    </button>
  )
}
