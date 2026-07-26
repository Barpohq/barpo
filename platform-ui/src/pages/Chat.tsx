import { useEffect, useRef, useState } from 'react'
import {
  buildPlans,
  cannedReplies,
  fallbackReply,
  genericBuildWords,
  pendingPost,
  type AppManifest,
  type BuildPlan,
  type ToolCard,
  type Widget,
} from '../data/mock'
import { Card } from '../ui'

interface Msg {
  id: number
  role: 'user' | 'assistant'
  text: string
  toolCard?: ToolCard
  approval?: boolean
  planId?: string
  done?: boolean
}

const suggestions = [
  'Botim bugun nima qildi?',
  'Tasdiq kutayotgan postlar bormi?',
  'Menga xarajat kuzatuvchi bot yasab ber',
  'Portfolio uchun landing sayt yasab ber',
  "GitHub'dagi loyihamni deploy qilib ber",
]

let nextId = 1

function Stream({ text, done, onDone }: { text: string; done?: boolean; onDone: () => void }) {
  const [n, setN] = useState(done ? text.length : 0)
  useEffect(() => {
    if (done) return
    if (n >= text.length) {
      onDone()
      return
    }
    const t = setTimeout(() => setN((v) => Math.min(v + 3, text.length)), 18)
    return () => clearTimeout(t)
  }, [n, text, done, onDone])
  return (
    <p className="whitespace-pre-wrap text-[15px] leading-relaxed">
      {text.slice(0, n)}
      {!done && n < text.length && <span className="cursor-blink text-lazur">▍</span>}
    </p>
  )
}

function ToolCardView({ card }: { card: ToolCard }) {
  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-line bg-bg font-mono text-xs">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-muted">
        <span className="inline-block size-1.5 rounded-full bg-lazur" aria-hidden />
        <span className="text-lazur">{card.tool}</span>
        <span className="text-faint">{card.args}</span>
      </div>
      <div className="px-3 py-2 text-muted">⎿ {card.result}</div>
    </div>
  )
}

function ApprovalCard({ onDecision }: { onDecision: (d: string) => void }) {
  const [state, setState] = useState<'pending' | 'published' | 'rejected'>('pending')

  return (
    <Card className="mt-3 overflow-hidden">
      <div className="border-b border-line px-4 py-2.5 font-mono text-xs text-muted">
        {pendingPost.cluster} · tasdiq kutmoqda
      </div>
      <div className="px-4 py-3">
        <div className="font-display text-[15px] font-semibold">{pendingPost.title}</div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted">{pendingPost.body}</p>
      </div>
      <div className="border-t border-line px-4 py-3">
        {state === 'pending' && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => { setState('published'); onDecision("Post kanalga chiqarildi — audit log'ga yozildi") }}
              className="rounded-lg bg-lazur-dim px-3.5 py-1.5 text-sm font-semibold text-bg transition hover:brightness-110"
            >
              ✅ Nashr qilish
            </button>
            <button
              onClick={() => onDecision('Tahrir rejimi demo versiyada mavjud emas')}
              className="rounded-lg border border-line px-3.5 py-1.5 text-sm text-muted transition hover:border-faint hover:text-ink"
            >
              ✏️ Tahrirlash
            </button>
            <button
              onClick={() => { setState('rejected'); onDecision('Post rad etildi — sabab rank promptini yaxshilashda ishlatiladi') }}
              className="rounded-lg border border-line px-3.5 py-1.5 text-sm text-muted transition hover:border-coral hover:text-coral"
            >
              ❌ Rad etish
            </button>
          </div>
        )}
        {state === 'published' && (
          <div className="text-sm text-mint">✓ Kanalga chiqdi — <span className="font-mono text-xs">t.me/kanal/7</span></div>
        )}
        {state === 'rejected' && <div className="text-sm text-coral">Rad etildi — klaster arxivga o'tdi</div>}
      </div>
    </Card>
  )
}

const buildKindStyle: Record<string, string> = {
  info: 'text-muted',
  tool: 'text-lazur',
  out: 'text-faint',
  done: 'text-mint',
}

// Deploy vidjetini stats'dan keyin joylaydi — manifest data bo'lgani uchun
// uni qurilish natijasiga qarab boyitish shunchaki massiv amali.
function withDeployWidget(m: AppManifest, w: Widget): AppManifest {
  const widgets = [...m.widgets]
  widgets.splice(1, 0, w)
  return { ...m, widgets }
}

// Qurilish kartasi: qadamlar oqadi → (kerak bo'lsa) deploy nishoni so'raladi →
// tugagach manifest platformaga ro'yxatdan o'tadi.
function BuildCard({
  plan,
  onInstalled,
  openApp,
}: {
  plan: BuildPlan
  onInstalled: (m: AppManifest) => void
  openApp: (id: string) => void
}) {
  const [n, setN] = useState(1)
  const [choiceIdx, setChoiceIdx] = useState<number | null>(null)
  const [m, setM] = useState(0)
  const installedRef = useRef(false)

  const baseDone = n >= plan.steps.length
  const opt = plan.choice && choiceIdx !== null ? plan.choice.options[choiceIdx] : null
  const needChoice = baseDone && !!plan.choice && choiceIdx === null
  const finished = baseDone && (plan.choice ? opt !== null && m >= opt.steps.length : true)

  useEffect(() => {
    if (!baseDone) {
      const t = setTimeout(() => setN((v) => v + 1), 1100)
      return () => clearTimeout(t)
    }
    if (opt && m < opt.steps.length) {
      const t = setTimeout(() => setM((v) => v + 1), 1100)
      return () => clearTimeout(t)
    }
    if (finished && !installedRef.current) {
      installedRef.current = true
      onInstalled(opt ? withDeployWidget(plan.manifest, opt.widget) : plan.manifest)
    }
  }, [n, m, baseDone, opt, finished, plan, onInstalled])

  return (
    <Card className="mt-3 overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5 font-mono text-xs text-muted">
        <span>builder · {plan.manifest.name}</span>
        <span className={finished ? 'text-mint' : needChoice ? 'text-gold' : 'pulse-dot text-gold'}>
          {finished ? 'tayyor' : needChoice ? 'sizni kutmoqda' : 'qurilmoqda…'}
        </span>
      </div>
      <div className="bg-bg px-4 py-3 font-mono text-xs leading-relaxed">
        {plan.steps.slice(0, n).map((s, i) => (
          <div key={i} className={buildKindStyle[s.kind]}>{s.text}</div>
        ))}
        {opt && opt.steps.slice(0, m).map((s, i) => (
          <div key={`o${i}`} className={buildKindStyle[s.kind]}>{s.text}</div>
        ))}
        {!finished && !needChoice && <span className="cursor-blink text-lazur">▍</span>}
      </div>

      {needChoice && plan.choice && (
        <div className="border-t border-line px-4 py-3">
          <div className="mb-2 text-sm font-semibold">{plan.choice.question}</div>
          <div className="flex flex-wrap gap-2">
            {plan.choice.options.map((o, i) => (
              <button
                key={o.label}
                onClick={() => { setChoiceIdx(i); setM(1) }}
                className="rounded-lg border border-lazur-dim px-3.5 py-1.5 text-sm text-lazur transition hover:bg-lazur-dim hover:text-bg"
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {finished && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
          <span className="text-sm text-mint">✓ Ilova sidebar'dagi "Ilovalar" bo'limiga qo'shildi</span>
          <button
            onClick={() => openApp(plan.manifest.id)}
            className="rounded-lg bg-lazur-dim px-3.5 py-1.5 text-sm font-semibold text-bg transition hover:brightness-110"
          >
            {plan.manifest.icon} Dashboardini ochish
          </button>
        </div>
      )}
    </Card>
  )
}

interface ChatProps {
  pro: boolean
  onInstallApp: (m: AppManifest) => void
  openApp: (id: string) => void
}

export default function Chat({ pro, onInstallApp, openApp }: ChatProps) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [msgs])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  function send(raw?: string) {
    const text = (raw ?? input).trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    setMsgs((m) => [...m, { id: nextId++, role: 'user', text, done: true }])

    const low = text.toLowerCase()
    const plan =
      buildPlans.find((p) => p.keywords.some((k) => low.includes(k))) ??
      (genericBuildWords.some((k) => low.includes(k))
        ? buildPlans.find((p) => p.id === 'xarajat-bot')
        : undefined)
    const reply = plan ? undefined : cannedReplies.find((r) => r.match.some((k) => low.includes(k)))

    setTimeout(() => {
      setMsgs((m) => [
        ...m,
        plan
          ? { id: nextId++, role: 'assistant', text: plan.intro, toolCard: plan.toolCard, planId: plan.id }
          : reply
            ? { id: nextId++, role: 'assistant', text: reply.text, toolCard: reply.toolCard, approval: reply.approval }
            : { id: nextId++, role: 'assistant', text: fallbackReply },
      ])
    }, 600)
  }

  function markDone(id: number) {
    setMsgs((m) => m.map((x) => (x.id === id ? { ...x, done: true } : x)))
    setBusy(false)
  }

  function handleInstalled(m: AppManifest) {
    onInstallApp(m)
    setToast(`${m.icon} ${m.name} o'rnatildi — dashboardi Ilovalar bo'limida`)
  }

  const empty = msgs.length === 0

  return (
    <div className={`flex h-full flex-col ${pro ? '' : 'mx-auto w-full max-w-3xl'}`}>
      <div className="thin-scroll flex-1 overflow-y-auto px-4 pt-6 pb-4">
        {empty && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="font-display text-3xl font-semibold tracking-tight">
              Nima quramiz<span className="text-lazur">?</span>
            </div>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
              Bu dastur yaratadigan platforma: bot, sayt yoki to'liq loyiha — oddiy tilda ayting.
              Orqa fonda quriladi, git'da versiyalanadi, deploy qilinadi va dashboardi o'zi
              platformaga qo'shiladi.
            </p>
          </div>
        )}

        <div className="mx-auto max-w-3xl space-y-5">
          {msgs.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="rise-in flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-panel2 px-4 py-2.5 text-[15px]">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={m.id} className="rise-in">
                {m.toolCard && <ToolCardView card={m.toolCard} />}
                <Stream text={m.text} done={m.done} onDone={() => markDone(m.id)} />
                {m.approval && m.done && <ApprovalCard onDecision={(d) => setToast(d)} />}
                {m.planId && m.done && (
                  <BuildCard
                    plan={buildPlans.find((p) => p.id === m.planId)!}
                    onInstalled={handleInstalled}
                    openApp={openApp}
                  />
                )}
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="px-4 pb-5">
        <div className="mx-auto max-w-3xl">
          {empty && (
            <div className="mb-3 flex flex-wrap justify-center gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full border border-line bg-panel px-3.5 py-1.5 text-[13px] text-muted transition hover:border-lazur-dim hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => { e.preventDefault(); send() }}
            className="flex items-center gap-2 rounded-2xl border border-line bg-panel px-4 py-2 transition focus-within:border-lazur-dim"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Nima yaratay? Bot, sayt, servis — yoki mavjudlarini so'rang…"
              aria-label="Xabar"
              className="flex-1 bg-transparent py-1.5 text-[15px] outline-none placeholder:text-faint"
            />
            <button
              type="submit"
              disabled={!input.trim() || busy}
              className="rounded-xl bg-lazur-dim px-4 py-1.5 text-sm font-semibold text-bg transition enabled:hover:brightness-110 disabled:opacity-40"
            >
              Yuborish
            </button>
          </form>
          <p className="mt-2 text-center font-mono text-[11px] text-faint">
            demo rejim · mock data · orchestrator ulanmagan
          </p>
        </div>
      </div>

      {toast && (
        <div className="rise-in fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-panel2 px-4 py-2 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  )
}
