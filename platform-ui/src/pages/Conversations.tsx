// The all-conversations page — the full view of the last 5 shown in the
// sidebar.
//
// The list comes from App (`useConversations` is called there once), so it
// always shows the same data as the sidebar and a delete or rename is
// reflected in both at the same time.
//
// The filters (search, project) are LOCAL — they send no request to the
// server. The reason: a single user has hundreds of conversations, not
// thousands; a local filter is instant and does not depend on the network.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatSession, Project } from '@platforma/shared'
import StreamIndicator from '../components/StreamIndicator'
import { ApiError, deleteSession, renameSession } from '../lib/api'
import type { RunningMap } from '../lib/running'
import { GROUP_ORDER, shortTime, dateGroup, type DateGroup } from '../lib/date'
import { useToast } from '../lib/toast'
import { Card, PageHead } from '../ui'

interface Props {
  conversations: ChatSession[]
  running: RunningMap
  projects: Project[]
  openSession: string | null
  loading: boolean
  error: boolean
  /** Re-request the list from the server */
  refresh: () => void
  /** Local change — to display without waiting for the server response */
  update: (updater: (previous: ChatSession[]) => ChatSession[]) => void
  onOpenConversation: (sessionId: string) => void
  onNewConversation: () => void
}

/** Project filter: all | no project | <project id> */
type ProjectFilter = 'all' | 'none' | string

export default function Conversations({
  conversations,
  running,
  projects,
  openSession,
  loading,
  error,
  refresh,
  update,
  onOpenConversation,
  onNewConversation,
}: Props) {
  const [search, setSearch] = useState('')
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>('all')
  /** The conversation being edited and its new name */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  /** The conversation awaiting delete confirmation */
  const [toDelete, setToDelete] = useState<ChatSession | null>(null)
  const [actionInFlight, setActionInFlight] = useState(false)
  const toast = useToast()
  const editRef = useRef<HTMLInputElement>(null)

  // When editing starts the text is focused and selected — the user can type
  // the new name right away
  useEffect(() => {
    if (editing) editRef.current?.select()
  }, [editing])

  const projectNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const p of projects) map[p.id] = p.name
    return map
  }, [projects])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return conversations.filter((s) => {
      if (term && !s.title.toLowerCase().includes(term)) return false
      if (projectFilter === 'all') return true
      if (projectFilter === 'none') return !s.projectId
      return s.projectId === projectFilter
    })
  }, [conversations, search, projectFilter])

  // Grouping by date. `new Date()` is taken once inside the `useMemo` —
  // otherwise the top and the bottom of the list would be compared against
  // different "nows".
  const groups = useMemo(() => {
    const now = new Date()
    const map = new Map<DateGroup, ChatSession[]>()
    for (const s of filtered) {
      const group = dateGroup(s.updatedAt, now)
      const existing = map.get(group)
      if (existing) existing.push(s)
      else map.set(group, [s])
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
      name: g,
      conversations: map.get(g) ?? [],
    }))
  }, [filtered])

  async function saveName() {
    if (!editing) return
    const newName = editing.text.trim()
    const previous = conversations.find((s) => s.id === editing.id)

    // Unchanged or empty name — close quietly
    if (!newName || newName === previous?.title) {
      setEditing(null)
      return
    }

    const id = editing.id
    setEditing(null)
    // Show it at once, without waiting for the server
    update((list) => list.map((s) => (s.id === id ? { ...s, title: newName } : s)))

    try {
      await renameSession(id, newName)
    } catch (e) {
      // Re-request from the server to restore the old name — more reliable
      // than "rolling back" the local state
      refresh()
      toast(
        e instanceof ApiError ? `Rename failed: ${e.message}` : 'Rename failed',
        'error',
      )
    }
  }

  async function remove(s: ChatSession) {
    setActionInFlight(true)
    try {
      await deleteSession(s.id)
      update((list) => list.filter((x) => x.id !== s.id))
      setToDelete(null)
      // If the open conversation was deleted — fall back to an empty chat
      if (s.id === openSession) onNewConversation()
    } catch (e) {
      toast(
        e instanceof ApiError ? `Delete failed: ${e.message}` : 'Could not delete the chat',
        'error',
      )
      setToDelete(null)
    } finally {
      setActionInFlight(false)
    }
  }

  const empty = !loading && conversations.length === 0
  const filterEmpty = !loading && conversations.length > 0 && filtered.length === 0

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <PageHead
        title="Chats"
        sub="All chats — the ones running in the background are marked with a live indicator"
      />

      {/* Control row: search + project filter + new chat */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <svg
            viewBox="0 0 20 20"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
          >
            <circle cx="9" cy="9" r="5.5" />
            <path d="m13.5 13.5 3 3" strokeLinecap="round" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by chat name…"
            aria-label="Search"
            className="w-full rounded-xl border border-line bg-panel py-2 pr-3 pl-9 text-sm outline-none transition placeholder:text-faint focus:border-lazur-dim"
          />
        </div>

        {projects.length > 0 && (
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            aria-label="Filter by project"
            className="shrink-0 rounded-xl border border-line bg-panel px-3 py-2 text-sm text-muted outline-none transition focus:border-lazur-dim"
          >
            <option value="all">All projects</option>
            <option value="none">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}

        <button
          onClick={onNewConversation}
          className="shrink-0 rounded-xl bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110"
        >
          + New chat
        </button>
      </div>

      {loading && conversations.length === 0 && (
        <p className="text-sm text-faint">Loading…</p>
      )}

      {error && conversations.length === 0 && (
        <Card className="px-6 py-8 text-center">
          <p className="text-sm text-coral">Could not load the chat list.</p>
          <button
            onClick={refresh}
            className="mt-3 rounded-lg border border-line px-3 py-1.5 text-xs text-muted transition hover:border-lazur-dim hover:text-lazur"
          >
            Try again
          </button>
        </Card>
      )}

      {empty && !error && (
        <Card className="px-6 py-10 text-center">
          <p className="text-sm text-muted">No chats yet.</p>
          <p className="mt-1.5 text-xs text-faint">
            Send a message in chat — it gets saved here.
          </p>
        </Card>
      )}

      {filterEmpty && (
        <Card className="px-6 py-8 text-center">
          <p className="text-sm text-muted">No chats match these filters.</p>
        </Card>
      )}

      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.name}>
            <h2 className="mb-2 px-1 text-[10px] font-semibold tracking-widest text-faint uppercase">
              {group.name}
            </h2>
            <div className="space-y-1.5">
              {group.conversations.map((s) => {
                const status = running[s.id]
                const isEditing = editing?.id === s.id
                const projectName = s.projectId ? projectNames[s.projectId] : undefined

                return (
                  <Card
                    key={s.id}
                    className={`group flex items-center gap-3 px-4 py-3 transition ${
                      s.id === openSession ? 'border-lazur-dim' : 'hover:border-faint'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <input
                          ref={editRef}
                          value={editing.text}
                          onChange={(e) => setEditing({ id: s.id, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveName()
                            if (e.key === 'Escape') setEditing(null)
                          }}
                          onBlur={() => void saveName()}
                          aria-label="Chat name"
                          maxLength={200}
                          className="w-full rounded-md border border-lazur-dim bg-bg px-2 py-1 text-sm outline-none"
                        />
                      ) : (
                        <button
                          onClick={() => onOpenConversation(s.id)}
                          className="flex w-full min-w-0 items-center gap-2 text-left"
                        >
                          <span className="truncate text-sm font-medium">{s.title}</span>
                          {status && <StreamIndicator status={status} />}
                        </button>
                      )}

                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] text-faint">
                        <span>{shortTime(s.updatedAt)}</span>
                        {projectName && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="truncate text-muted">{projectName}</span>
                          </>
                        )}
                        {s.model && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="truncate">{s.model}</span>
                          </>
                        )}
                        {s.messageCount === 0 && (
                          <>
                            <span aria-hidden>·</span>
                            <span>empty</span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Actions — visible on hover or focus. `focus-within` is
                        essential: the buttons must not stay hidden when
                        navigating with the keyboard. */}
                    {!isEditing && (
                      <div className="flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          onClick={() => setEditing({ id: s.id, text: s.title })}
                          title="Rename"
                          aria-label={`Rename "${s.title}"`}
                          className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-muted transition hover:border-lazur-dim hover:text-lazur"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => setToDelete(s)}
                          title="Delete"
                          aria-label={`Delete chat "${s.title}"`}
                          className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-muted transition hover:border-coral hover:text-coral"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </Card>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      {/* Delete confirmation — an irreversible action, hence a modal */}
      {toDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
          onClick={() => !actionInFlight && setToDelete(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Delete chat"
        >
          <Card className="rise-in w-full max-w-sm p-6">
            <div onClick={(e) => e.stopPropagation()}>
              <h2 className="font-display text-lg font-semibold">Delete this chat?</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                <span className="text-ink">{toDelete.title}</span> — will be deleted along with
                all of its messages. This cannot be undone.
              </p>
              {running[toDelete.id] && (
                <p className="mt-2 text-xs text-gold">
                  An agent is currently running in this chat — it will be stopped too.
                </p>
              )}

              <div className="mt-5 flex justify-end gap-2">
                <button
                  onClick={() => setToDelete(null)}
                  disabled={actionInFlight}
                  className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void remove(toDelete)}
                  disabled={actionInFlight}
                  className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-40"
                >
                  {actionInFlight ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
