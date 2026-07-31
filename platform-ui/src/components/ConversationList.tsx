// The "Chat" section in the sidebar — an expandable list (accordion).
//
// It holds the last N conversations REGARDLESS OF STATUS: ones running in the
// background as well as ones already finished. The running ones carry a live
// indicator next to them — which is what made the old "Live streams" section
// redundant.
//
// The list arrives ready-made from App (`useConversations` is called there
// once) — so the sidebar and the Conversations page show the same source.

import type { ChatSession } from '@platforma/shared'
import type { RunningMap } from '../lib/running'
import StreamIndicator from './StreamIndicator'

/** How many conversations show in the sidebar — the rest live on the "All" page */
export const SIDEBAR_CONVERSATIONS = 5

interface Props {
  conversations: ChatSession[]
  running: RunningMap
  /** The conversation currently open — highlighted in the list */
  openSession: string | null
  /** Is the list expanded (accordion state) */
  open: boolean
  onToggle: () => void
  /** The word "Chat" itself was clicked — go to the chat page */
  onChatPage: () => void
  onOpenConversation: (sessionId: string) => void
  onShowAll: () => void
  /** Is the chat page currently open — the header is highlighted accordingly */
  active: boolean
  loading: boolean
  tabIndex: number
}

export default function ConversationList({
  conversations,
  running,
  openSession,
  open,
  onToggle,
  onChatPage,
  onOpenConversation,
  onShowAll,
  active,
  loading,
  tabIndex,
}: Props) {
  const visible = conversations.slice(0, SIDEBAR_CONVERSATIONS)
  // Are there conversations running in the background that fell outside the
  // list — if so a warning dot appears next to "All"
  const hiddenRunning = Object.keys(running).filter(
    (id) => !visible.some((s) => s.id === id),
  ).length

  return (
    <div>
      {/* The row has two parts: the "Chat" text navigates to the page, the
          arrow at the right edge expands the list. It cannot be a single
          button — the user would be forced to switch pages just to open the
          list. */}
      <div
        className={`flex w-full items-center rounded-lg transition ${
          active ? 'bg-panel2 text-lazur' : 'text-muted hover:bg-panel2/60'
        }`}
      >
        <button
          onClick={onChatPage}
          tabIndex={tabIndex}
          className={`flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 text-left text-[13px] transition ${
            active ? 'font-semibold' : 'hover:text-ink'
          }`}
        >
          <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8l-4 3v-3H5a2 2 0 0 1-2-2V5Z" />
          </svg>
          Chat
        </button>

        <button
          onClick={onToggle}
          tabIndex={tabIndex}
          aria-expanded={open}
          aria-label={open ? 'Collapse chat list' : 'Expand chat list'}
          className="grid shrink-0 place-items-center px-2.5 py-2 text-faint transition hover:text-ink"
        >
          {/* While collapsed, keep background activity visible */}
          {!open && Object.keys(running).length > 0 && (
            <span
              className="pulse-dot mr-1 inline-block size-1.5 shrink-0 rounded-full"
              style={{ background: 'var(--color-mint)' }}
              aria-hidden
            />
          )}
          <svg
            viewBox="0 0 20 20"
            className={`size-3.5 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m7 5 5 5-5 5" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="mt-0.5 space-y-0.5 pl-3">
          {loading && visible.length === 0 && (
            <p className="px-3 py-1.5 font-mono text-[11px] text-faint">Loading…</p>
          )}

          {!loading && visible.length === 0 && (
            <p className="px-3 py-1.5 text-[11px] leading-relaxed text-faint">
              No chats yet — start typing below
            </p>
          )}

          {visible.map((s) => {
            const status = running[s.id]
            const selected = s.id === openSession
            return (
              <button
                key={s.id}
                onClick={() => onOpenConversation(s.id)}
                tabIndex={tabIndex}
                title={s.title}
                className={`flex w-full items-center gap-2 rounded-lg border-l-2 py-1.5 pr-2 pl-2.5 text-left text-[12px] transition ${
                  selected
                    ? 'border-lazur-dim bg-panel2/70 text-ink'
                    : 'border-transparent text-muted hover:bg-panel2/50 hover:text-ink'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                {status && <StreamIndicator status={status} />}
              </button>
            )
          })}

          <button
            onClick={onShowAll}
            tabIndex={tabIndex}
            className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 pl-2.5 text-left font-mono text-[11px] text-faint transition hover:text-lazur"
          >
            All chats
            {hiddenRunning > 0 && (
              <span
                className="pulse-dot inline-block size-1.5 rounded-full"
                style={{ background: 'var(--color-mint)' }}
                title={`${hiddenRunning} agents running outside this list`}
                aria-hidden
              />
            )}
            <span className="ml-auto" aria-hidden>
              →
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
