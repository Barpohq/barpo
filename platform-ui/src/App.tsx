import { useCallback, useEffect, useState, type ReactNode } from 'react'
import ConversationList from './components/ConversationList'
import { BarpoMark } from './ui'
import { fetchProjects } from './lib/api'
import { buildHash, parseHash } from './lib/hash-path'
import { useApps } from './lib/apps'
import { useFleet } from './lib/fleet'
import { useRunning } from './lib/running'
import { storeConversationsOpen, isConversationsOpen } from './lib/sidebar-storage'
import { useConversations } from './lib/conversations'
import type { Project } from '@barpo/shared'
import Agents from './pages/Agents'
import Chat from './pages/Chat'
import Servers from './pages/Servers'
import Mcp from './pages/Mcp'
import Schedules from './pages/Schedules'
import Skills from './pages/Skills'
import Conversations from './pages/Conversations'
import Audit from './pages/Audit'
import Terminal from './pages/Terminal'
import AppView from './pages/AppView'

type StaticPage =
  | 'chat'
  | 'conversations'
  | 'agents'
  | 'servers'
  | 'skills'
  | 'mcp'
  | 'audit'
  | 'terminal'
  | 'schedules'
type Page = StaticPage | `app:${string}`

// The menu is deliberately short: the platform also runs on an ordinary PC,
// and when there are servers the "Servers" page is enough (so connecting and
// disconnecting stays easy).
//
// "Chat" is NOT in this list — it is a separate component
// (`ConversationList`), because it contains the expandable conversation list.
const nav: { id: StaticPage; label: string; icon: ReactNode }[] = [
  { id: 'agents', label: 'Agents', icon: <path d="M10 3a3 3 0 0 1 3 3v1h1a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1V6a3 3 0 0 1 3-3Zm-2 8h.01M12 11h.01" /> },
  { id: 'servers', label: 'Servers', icon: <path d="M3 4h14v4H3V4Zm0 8h14v4H3v-4Zm2-6h.01M5 14h.01" /> },
  { id: 'skills', label: 'Skill store', icon: <path d="M10 2 3 6v8l7 4 7-4V6l-7-4Zm0 4v12M3 6l7 4 7-4" /> },
  { id: 'mcp', label: 'MCP servers', icon: <path d="M7 4v5m6-5v5M4.5 9h11l-1.5 7h-8L4.5 9Z" /> },
  { id: 'schedules', label: 'Schedules', icon: <path d="M10 5v5l3 2M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z" /> },
  { id: 'audit', label: 'Audit log', icon: <path d="M5 3h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm2 4h6M7 10h6m-6 3h4" /> },
  { id: 'terminal', label: 'Terminal', icon: <path d="M3 4h14v12H3V4Zm3 3 3 3-3 3m5 0h4" /> },
]

const staticPages: StaticPage[] = [
  'chat',
  'conversations',
  'agents',
  'servers',
  'skills',
  'mcp',
  'audit',
  'terminal',
  'schedules',
]

/** Hash parsing lives in `lib/hash-path.ts` — a pure function, covered by tests */
function initFromHash(): { pro: boolean; page: Page; sessionId: string | null } {
  const { pro, path, sessionId } = parseHash(window.location.hash)
  const page: Page =
    staticPages.includes(path as StaticPage) || path.startsWith('app:') ? (path as Page) : 'chat'

  // Plain mode has only the chat, but a session URL still has to work
  return pro ? { pro: true, page, sessionId } : { pro: false, page: 'chat', sessionId }
}

function ProToggle({ pro, onToggle }: { pro: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      role="switch"
      aria-checked={pro}
      className={`group flex items-center gap-2.5 rounded-full border px-3 py-1.5 text-xs font-semibold tracking-wide transition-all duration-300 ${
        pro
          ? 'border-lazur-dim bg-lazur-dim/15 text-lazur'
          : 'border-line text-muted hover:border-faint hover:text-ink'
      }`}
    >
      <span
        className={`relative h-3.5 w-7 rounded-full transition-colors duration-300 ${pro ? 'bg-lazur-dim' : 'bg-panel2'}`}
        aria-hidden
      >
        <span
          className={`absolute top-0.5 size-2.5 rounded-full bg-ink transition-all duration-300 ${pro ? 'left-4' : 'left-0.5'}`}
        />
      </span>
      PRO MODE
    </button>
  )
}

/**
 * The header ticker — ONLY things that are actually measured.
 *
 * It used to carry a made-up cost ("today 0.084"), a fixed "5/5 servers
 * connected" and a "helsinki-1 disk 84%" for a server that need not even
 * exist. A number that looks authoritative and is invented is worse than no
 * number: it gets trusted. Cost is gone entirely — the platform does not
 * record LLM spend yet, so there is nothing honest to display.
 *
 * Each item disappears when it has nothing to say (no apps, no servers, no
 * disk over the line), so an empty ticker means an empty platform.
 */
function Ticker({ appCount, runningCount }: { appCount: number; runningCount: number }) {
  const fleet = useFleet()

  const items: { sym: string; text: string; warn?: boolean }[] = []
  if (appCount > 0) items.push({ sym: '▣', text: `${appCount} ${appCount === 1 ? 'app' : 'apps'}` })
  if (runningCount > 0) items.push({ sym: '◈', text: `${runningCount} running` })
  if (!fleet.loading && fleet.total > 0) {
    items.push({ sym: '⇅', text: `${fleet.connected}/${fleet.total} servers connected` })
  }
  if (fleet.diskWarning) {
    items.push({
      sym: '!',
      text: `${fleet.diskWarning.server} disk ${fleet.diskWarning.disk}%`,
      warn: true,
    })
  }

  // Nothing measured yet — the bar would be an empty stripe, so it is not drawn
  if (items.length === 0) return null

  return (
    <div className="flex items-center gap-6 overflow-x-auto border-b border-line bg-panel px-5 py-1.5 font-mono text-[11px] whitespace-nowrap text-muted [scrollbar-width:none]">
      {items.map((item) => (
        <span key={item.text} className="flex items-center gap-1.5">
          <span className={item.warn ? 'text-gold' : 'text-lazur'}>{item.sym}</span>
          {item.text}
        </span>
      ))}
    </div>
  )
}

export default function App() {
  const [init] = useState(initFromHash)
  const [pro, setPro] = useState(init.pro)
  const [page, setPageRaw] = useState<Page>(init.page)
  // Apps COME FROM THE SERVER (`/api/apps` plus the `app.installed` and
  // `app.updated` events) — and from nowhere else. There used to be a second,
  // local list here holding apps invented by a scripted build flow in the
  // chat; it meant the sidebar could show a dashboard that existed on no disk
  // and vanished on refresh.
  const { apps } = useApps()
  /** The sidebar's "New chat" — incremented on every press, watched by Chat */
  const [newConversationSignal, setNewConversationSignal] = useState(0)
  /**
   * The conversation open in the URL. Chat reports when it creates or clears a
   * session and we update the hash — so a page refresh restores it.
   */
  const [sessionId, setSessionId] = useState<string | null>(init.sessionId)
  // Agent streams running in the background — shown live in the sidebar. They
  // all appear even when a single conversation is open: `chat.status` is not
  // filtered by session (see protocol.ts).
  const { running } = useRunning()
  const runningList = Object.entries(running)
  const awaitingPermission = runningList.filter(
    ([, status]) => status === 'awaiting-permission',
  ).length

  // The conversation list is loaded HERE once and handed to both the sidebar
  // and the Conversations page. If each loaded it separately there would be
  // two requests, and a delete or rename would only show up in one of them.
  const {
    conversations,
    loading: conversationsLoading,
    error: conversationsError,
    refresh: refreshConversations,
    update: updateConversations,
  } = useConversations()
  /** Is the sidebar's Chat list expanded — remembered in the browser */
  const [conversationsOpen, setConversationsOpen] = useState(isConversationsOpen)

  // Projects — for the filter on the Conversations page. On error we stay
  // quiet: the filter simply does not appear and the list still works.
  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => {
    let cancelled = false
    fetchProjects()
      .then((list) => {
        if (!cancelled) setProjects(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * The hash is written from one place — the page, the mode and the open
   * conversation each change independently, and if each wrote its own hash the
   * session id would get lost.
   */
  function writeHash(p: boolean, target: Page, sid: string | null) {
    const next = buildHash(p, target, sid)
    if (window.location.hash.replace('#', '') !== next) window.location.hash = next
  }

  function setPage(p: Page) {
    setPageRaw(p)
    writeHash(true, p, sessionId)
  }

  function togglePro() {
    setPro((p) => {
      const nextPage = p ? 'chat' : page
      if (p) setPageRaw('chat')
      writeHash(!p, nextPage, sessionId)
      return !p
    })
  }

  /**
   * Called when Chat creates or clears a session.
   *
   * `useCallback` — Chat keeps it in a ref, but a stable instance is
   * preferable: it cuts down needless re-renders.
   */
  const sessionChanged = useCallback(
    (sid: string | null) => {
      setSessionId(sid)
      writeHash(pro, page, sid)
      // A new conversation was created — it should land in the list at once.
      // The server derives the title from the first message, so we re-request
      // instead of adding it locally.
      if (sid) refreshConversations()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pro, page, refreshConversations],
  )

  /** A conversation was picked in the sidebar or on the Conversations page */
  function openConversation(sid: string) {
    setPageRaw('chat')
    setSessionId(sid)
    writeHash(pro, 'chat', sid)
  }

  /** A new empty conversation — go to the chat page and clear the window */
  function startNewConversation() {
    setPageRaw('chat')
    setSessionId(null)
    writeHash(pro, 'chat', null)
    setNewConversationSignal((n) => n + 1)
  }

  function toggleConversations() {
    setConversationsOpen((open) => {
      storeConversationsOpen(!open)
      return !open
    })
  }

  const activeApp = page.startsWith('app:') ? apps.find((a) => `app:${a.id}` === page) : undefined

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
        <div className="flex items-center gap-2.5">
          <BarpoMark className="size-7 shrink-0" />
          <span className="font-display text-[15px] font-semibold tracking-tight">
            Barpo
            <span className="ml-2 hidden font-mono text-[10px] font-normal text-faint sm:inline">
              self-hosted · v{__APP_VERSION__}
            </span>
          </span>
        </div>
        <ProToggle pro={pro} onToggle={togglePro} />
      </header>

      {pro && <Ticker appCount={apps.length} runningCount={runningList.length} />}

      <div className="flex min-h-0 flex-1">
        {/* Pro sidebar — progressive disclosure: absent entirely in plain mode */}
        <nav
          className={`flex flex-col border-r border-line bg-panel transition-all duration-300 ${
            pro ? 'w-48 opacity-100' : 'w-0 overflow-hidden opacity-0'
          }`}
          aria-hidden={!pro}
        >
          <div className="thin-scroll flex-1 overflow-y-auto p-2">
            {/* The most frequent action — it sits above the list as well */}
            <button
              onClick={startNewConversation}
              tabIndex={pro ? 0 : -1}
              className="mb-2 flex w-full items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-left text-[13px] text-muted transition hover:border-lazur-dim hover:bg-panel2/60 hover:text-lazur"
            >
              <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                <path d="M10 4v12M4 10h12" />
              </svg>
              New chat
            </button>

            <div className="space-y-0.5">
              {/* Chat — with its expandable list. It holds the last 5
                  conversations regardless of status; the running ones carry an
                  indicator. */}
              <ConversationList
                conversations={conversations}
                running={running}
                openSession={sessionId}
                open={conversationsOpen}
                onToggle={toggleConversations}
                onChatPage={() => setPage('chat')}
                onOpenConversation={openConversation}
                onShowAll={() => setPage('conversations')}
                active={page === 'chat'}
                loading={conversationsLoading}
                tabIndex={pro ? 0 : -1}
              />

              {nav.map((n) => (
                <button
                  key={n.id}
                  onClick={() => setPage(n.id)}
                  tabIndex={pro ? 0 : -1}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition ${
                    page === n.id ? 'bg-panel2 font-semibold text-lazur' : 'text-muted hover:bg-panel2/60 hover:text-ink'
                  }`}
                >
                  <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    {n.icon}
                  </svg>
                  {n.label}
                  {/* The overall counter next to Agents: even with the page
                      closed, what runs in the background stays visible */}
                  {n.id === 'agents' && runningList.length > 0 && (
                    <span
                      className={`ml-auto rounded-md px-1.5 py-0.5 font-mono text-[10px] ${
                        awaitingPermission > 0 ? 'text-gold' : 'text-muted'
                      }`}
                      style={
                        awaitingPermission > 0
                          ? { background: 'color-mix(in oklab, var(--color-gold) 18%, transparent)' }
                          : { background: 'var(--color-panel2)' }
                      }
                    >
                      {runningList.length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* The old "Live streams" section was removed: conversations
                running in the background now show an indicator in the Chat
                list, and their total sits in the badge next to Agents. */}

            {/* Dynamic section — apps add themselves here with their manifest.
                With no app installed the section does not appear at all: an
                empty heading and a placeholder are not information either. */}
            {apps.length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <div className="px-3 pb-1.5 text-[10px] font-semibold tracking-widest text-faint uppercase">
                  Apps
                </div>
                <div className="space-y-0.5">
                  {apps.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setPage(`app:${a.id}`)}
                      tabIndex={pro ? 0 : -1}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition ${
                        page === `app:${a.id}` ? 'bg-panel2 font-semibold text-lazur' : 'text-muted hover:bg-panel2/60 hover:text-ink'
                      }`}
                    >
                      <span className="grid size-4 shrink-0 place-items-center text-[13px]" aria-hidden>
                        {a.icon}
                      </span>
                      <span className="truncate font-mono text-xs">{a.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </nav>

        <main className="thin-scroll min-w-0 flex-1 overflow-y-auto">
          {(!pro || page === 'chat') && (
            <Chat
              pro={pro}
              newConversationSignal={newConversationSignal}
              openSession={sessionId}
              onSessionChanged={sessionChanged}
              running={running}
            />
          )}
          {pro && page === 'conversations' && (
            <Conversations
              conversations={conversations}
              running={running}
              projects={projects}
              openSession={sessionId}
              loading={conversationsLoading}
              error={conversationsError}
              refresh={refreshConversations}
              update={updateConversations}
              onOpenConversation={openConversation}
              onNewConversation={startNewConversation}
            />
          )}
          {pro && page === 'agents' && <Agents />}
          {pro && page === 'servers' && <Servers />}
          {pro && page === 'skills' && <Skills />}
          {pro && page === 'mcp' && <Mcp />}
          {pro && page === 'schedules' && <Schedules onOpenConversation={openConversation} />}
          {pro && page === 'audit' && <Audit />}
          {pro && page === 'terminal' && <Terminal />}
          {pro && page.startsWith('app:') && activeApp && <AppView app={activeApp} />}
          {pro && page.startsWith('app:') && !activeApp && (
            <div className="grid h-full place-items-center text-sm text-faint">
              App not found — create it again through chat
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
