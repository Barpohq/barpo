import { useState, type ReactNode } from 'react'
import OqimIndikatori from './components/OqimIndikatori'
import { installedApps, type AppManifest } from './data/mock'
import { hashQur, hashTahlil } from './lib/hash-yol'
import { useIshlayotganlar } from './lib/ishlayotganlar'
import Agents from './pages/Agents'
import Chat from './pages/Chat'
import Servers from './pages/Servers'
import Skills from './pages/Skills'
import Audit from './pages/Audit'
import Terminal from './pages/Terminal'
import AppView from './pages/AppView'

type StaticPage = 'chat' | 'agents' | 'servers' | 'skills' | 'audit' | 'terminal'
type Page = StaticPage | `app:${string}`

// Menyu ataylab qisqa: platforma oddiy PC'da ham ishlaydi, server bo'lsa
// "Serverlar" sahifasi yetadi (ulash/uzish oson bo'lishi uchun).
const nav: { id: StaticPage; label: string; icon: ReactNode }[] = [
  { id: 'chat', label: 'Chat', icon: <path d="M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8l-4 3v-3H5a2 2 0 0 1-2-2V5Z" /> },
  { id: 'agents', label: 'Agentlar', icon: <path d="M10 3a3 3 0 0 1 3 3v1h1a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1V6a3 3 0 0 1 3-3Zm-2 8h.01M12 11h.01" /> },
  { id: 'servers', label: 'Serverlar', icon: <path d="M3 4h14v4H3V4Zm0 8h14v4H3v-4Zm2-6h.01M5 14h.01" /> },
  { id: 'skills', label: "Skill do'koni", icon: <path d="M10 2 3 6v8l7 4 7-4V6l-7-4Zm0 4v12M3 6l7 4 7-4" /> },
  { id: 'audit', label: 'Audit log', icon: <path d="M5 3h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm2 4h6M7 10h6m-6 3h4" /> },
  { id: 'terminal', label: 'Terminal', icon: <path d="M3 4h14v12H3V4Zm3 3 3 3-3 3m5 0h4" /> },
]

const staticPages: StaticPage[] = ['chat', 'agents', 'servers', 'skills', 'audit', 'terminal']

/** Hash tahlili `lib/hash-yol.ts` da — sof funksiya, test bilan qoplangan */
function initFromHash(): { pro: boolean; page: Page; sessionId: string | null } {
  const { pro, yol, sessionId } = hashTahlil(window.location.hash)
  const page: Page =
    staticPages.includes(yol as StaticPage) || yol.startsWith('app:') ? (yol as Page) : 'chat'

  // Oddiy rejimda faqat chat bor, lekin sessiya URL'i baribir ishlashi kerak
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
      PRO REJIM
    </button>
  )
}

function Ticker({ appCount }: { appCount: number }) {
  const items = [
    ['▣', `${appCount} ilova ishlayapti`],
    ['$', 'bugun 0.084'],
    ['⇅', '5/5 server ulangan'],
    ['!', 'helsinki-1 disk 84%'],
  ]
  return (
    <div className="flex items-center gap-6 overflow-x-auto border-b border-line bg-panel px-5 py-1.5 font-mono text-[11px] whitespace-nowrap text-muted [scrollbar-width:none]">
      {items.map(([sym, text], i) => (
        <span key={i} className="flex items-center gap-1.5">
          <span className={i === 3 ? 'text-gold' : 'text-lazur'}>{sym}</span>
          {text}
        </span>
      ))}
      <span className="ml-auto text-faint">demo · 2026-07-27</span>
    </div>
  )
}

export default function App() {
  const [init] = useState(initFromHash)
  const [pro, setPro] = useState(init.pro)
  const [page, setPageRaw] = useState<Page>(init.page)
  const [apps, setApps] = useState<AppManifest[]>(installedApps)
  /** Sidebar'dagi "Yangi suhbat" — har bosishda oshadi, Chat kuzatadi */
  const [yangiSuhbatSignali, setYangiSuhbatSignali] = useState(0)
  /**
   * URL'dagi ochiq suhbat. Chat sessiya yaratganda/tozalaganda xabar beradi,
   * biz hash'ni yangilaymiz — shunda sahifa refresh'da o'sha suhbat tiklanadi.
   */
  const [sessionId, setSessionId] = useState<string | null>(init.sessionId)
  // Fonda ishlayotgan agent oqimlari — sidebar'da jonli ko'rsatiladi.
  // Bitta suhbatni ochgan bo'lsak ham hammasi ko'rinadi: `chat.status`
  // sessiya bo'yicha filtrlanmaydi (protocol.ts ga q.).
  const { ishlayotganlar, sarlavhalar } = useIshlayotganlar()
  const ishlayotganRoyxat = Object.entries(ishlayotganlar)
  const ruxsatKutayotganlar = ishlayotganRoyxat.filter(
    ([, holat]) => holat === 'ruxsat-kutmoqda',
  ).length

  /**
   * Hash'ni bitta joydan yozamiz — sahifa, rejim va ochiq suhbat uch xil
   * joydan o'zgaradi, har biri o'zicha yozsa sessiya id yo'qolib ketardi.
   */
  function hashYoz(p: boolean, sahifa: Page, sid: string | null) {
    const yangi = hashQur(p, sahifa, sid)
    if (window.location.hash.replace('#', '') !== yangi) window.location.hash = yangi
  }

  function setPage(p: Page) {
    setPageRaw(p)
    hashYoz(true, p, sessionId)
  }

  function togglePro() {
    setPro((p) => {
      const yangiSahifa = p ? 'chat' : page
      if (p) setPageRaw('chat')
      hashYoz(!p, yangiSahifa, sessionId)
      return !p
    })
  }

  /** Chat sessiya yaratganda/tozalaganda chaqiriladi */
  function sessiyaOzgardi(sid: string | null) {
    setSessionId(sid)
    hashYoz(pro, page, sid)
  }

  // Yangi ilova manifesti keladi — sidebar va routing'ga darhol qo'shiladi.
  // Real platformada bu orchestrator'dan WebSocket orqali keladi.
  function installApp(m: AppManifest) {
    setApps((a) => (a.some((x) => x.id === m.id) ? a : [...a, m]))
  }

  function openApp(id: string) {
    setPro(true)
    setPageRaw(`app:${id}`)
    window.location.hash = `pro/app:${id}`
  }

  const activeApp = page.startsWith('app:') ? apps.find((a) => `app:${a.id}` === page) : undefined

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-lazur-dim font-display text-sm font-bold text-bg" aria-hidden>
            ai
          </span>
          <span className="font-display text-[15px] font-semibold tracking-tight">
            platforma
            <span className="ml-2 hidden font-mono text-[10px] font-normal text-faint sm:inline">
              self-hosted · v0.1-demo
            </span>
          </span>
        </div>
        <ProToggle pro={pro} onToggle={togglePro} />
      </header>

      {pro && <Ticker appCount={apps.length} />}

      <div className="flex min-h-0 flex-1">
        {/* Pro sidebar — progressive disclosure: oddiy rejimda umuman yo'q */}
        <nav
          className={`flex flex-col border-r border-line bg-panel transition-all duration-300 ${
            pro ? 'w-48 opacity-100' : 'w-0 overflow-hidden opacity-0'
          }`}
          aria-hidden={!pro}
        >
          <div className="thin-scroll flex-1 overflow-y-auto p-2">
            {/* Eng ko'p bajariladigan amal — ro'yxatdan ham tepada turadi */}
            <button
              onClick={() => {
                setPage('chat')
                setYangiSuhbatSignali((n) => n + 1)
              }}
              tabIndex={pro ? 0 : -1}
              className="mb-2 flex w-full items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-left text-[13px] text-muted transition hover:border-lazur-dim hover:bg-panel2/60 hover:text-lazur"
            >
              <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                <path d="M10 4v12M4 10h12" />
              </svg>
              Yangi suhbat
            </button>

            <div className="space-y-0.5">
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
                  {/* Agentlar yonidagi umumiy hisoblagich: sahifa ochilmagan
                      bo'lsa ham fonda nima ketayotgani ko'rinib tursin */}
                  {n.id === 'agents' && ishlayotganRoyxat.length > 0 && (
                    <span
                      className={`ml-auto rounded-md px-1.5 py-0.5 font-mono text-[10px] ${
                        ruxsatKutayotganlar > 0 ? 'text-gold' : 'text-muted'
                      }`}
                      style={
                        ruxsatKutayotganlar > 0
                          ? { background: 'color-mix(in oklab, var(--color-gold) 18%, transparent)' }
                          : { background: 'var(--color-panel2)' }
                      }
                    >
                      {ishlayotganRoyxat.length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Jonli oqimlar — fonda ishlayotgan sessiyalar, real vaqtda */}
            {ishlayotganRoyxat.length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <div className="px-3 pb-1.5 text-[10px] font-semibold tracking-widest text-faint uppercase">
                  Jonli oqimlar
                </div>
                <div className="space-y-0.5">
                  {ishlayotganRoyxat.map(([sessionId, holat]) => (
                    <button
                      key={sessionId}
                      onClick={() => setPage('agents')}
                      tabIndex={pro ? 0 : -1}
                      title={sarlavhalar[sessionId] ?? sessionId}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] text-muted transition hover:bg-panel2/60 hover:text-ink"
                    >
                      <OqimIndikatori holat={holat} />
                      <span className="truncate font-mono text-xs">
                        {sarlavhalar[sessionId] ?? 'Nomsiz suhbat'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Dinamik bo'lim — ilovalar o'z manifesti bilan shu yerga qo'shiladi */}
            <div className="mt-4 border-t border-line pt-3">
              <div className="px-3 pb-1.5 text-[10px] font-semibold tracking-widest text-faint uppercase">
                Ilovalar
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
                <button
                  onClick={() => setPage('chat')}
                  tabIndex={pro ? 0 : -1}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-faint transition hover:text-muted"
                >
                  <span className="grid size-4 place-items-center" aria-hidden>+</span>
                  Yangi ilova — chatda ayting
                </button>
              </div>
            </div>
          </div>

          <div className="border-t border-line p-3 font-mono text-[10px] leading-relaxed text-faint">
            Hamma qatlam ochiq:
            <br />
            loglar · tmux · audit · xarajat
          </div>
        </nav>

        <main className="thin-scroll min-w-0 flex-1 overflow-y-auto">
          {(!pro || page === 'chat') && (
            <Chat
              pro={pro}
              onInstallApp={installApp}
              openApp={openApp}
              yangiSuhbatSignali={yangiSuhbatSignali}
              boshlangichSessiya={init.sessionId}
              onSessiyaOzgardi={sessiyaOzgardi}
            />
          )}
          {pro && page === 'agents' && <Agents />}
          {pro && page === 'servers' && <Servers />}
          {pro && page === 'skills' && <Skills />}
          {pro && page === 'audit' && <Audit />}
          {pro && page === 'terminal' && <Terminal />}
          {pro && page.startsWith('app:') && activeApp && <AppView app={activeApp} />}
          {pro && page.startsWith('app:') && !activeApp && (
            <div className="grid h-full place-items-center text-sm text-faint">
              Ilova topilmadi — chat orqali qaytadan yarating
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
