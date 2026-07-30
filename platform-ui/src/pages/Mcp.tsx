// MCP serverlar sahifasi — qo'shish, sozlash, o'rnatish.
//
// `Skills.tsx` bilan bir xil uch qatlam (manba → katalog → qamrov), lekin
// IKKI QO'SHIMCHA narsa bor:
//
//   1) TO'RT XIL MANBA. Registry qidiruvi, GitHub repo, qo'lda kiritish va
//      platforma standart to'plami. Har biri o'z modalida.
//
//   2) SOZLAMA QIYMATLARI. Skill o'rnatishda faqat qamrov tanlanadi; MCP
//      serverga esa ko'pincha token kerak. Maxfiy maydonlar `type="password"`
//      bilan ko'rsatiladi va HECH QACHON qaytarib ko'rsatilmaydi — bo'sh
//      input "o'zgartirmadim" degani (`Servers.tsx` parol naqshi).

import { useEffect, useMemo, useState } from 'react'
import type {
  McpManba,
  McpServer,
  McpSozlamaMaydoni,
  McpTransportTuri,
  Project,
} from '@platforma/shared'
import {
  ApiXatosi,
  loyihalarOl,
  mcpGithubUlash,
  mcpManbaOchir,
  mcpManbaSinxronla,
  mcpOrnat,
  mcpOrnatishniBekor,
  mcpQoldaQosh,
  mcpRegistryQidir,
  mcpRegistryQosh,
  mcpServerlarniOl,
  type McpRegistryNatija,
} from '../lib/api'
import { useToast } from '../lib/toast'
import { Card, PageHead } from '../ui'

/** Transport belgisi — kartada va modalda bir xil ko'rinsin */
const transportBelgisi: Record<McpTransportTuri, string> = {
  stdio: 'local',
  http: 'remote',
}

// ---------------------------------------------------------------------------
// Modal asosi
// ---------------------------------------------------------------------------

function Modal({
  sarlavha,
  onClose,
  children,
  kenglik = 'max-w-md',
}: {
  sarlavha: string
  onClose: () => void
  children: React.ReactNode
  kenglik?: string
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={sarlavha}
    >
      <Card className={`rise-in w-full ${kenglik} p-6`}>
        <div onClick={(e) => e.stopPropagation()}>{children}</div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Registry qidiruv modali
// ---------------------------------------------------------------------------

/**
 * Rasmiy registry'da qidirish.
 *
 * IKKI BOSQICHLI: qidiruv natijasi HECH NARSA SAQLAMAYDI, foydalanuvchi
 * bittasini tanlagach u katalogga tushadi. Skilllardagi GitHub oqimidan
 * farqi shu — u yerda bir repo = bir necha skill va hammasi katalogga
 * tushardi.
 */
function RegistryModal({
  onClose,
  onQoshildi,
}: {
  onClose: () => void
  onQoshildi: () => Promise<unknown>
}) {
  const [soz, setSoz] = useState('')
  const [natijalar, setNatijalar] = useState<McpRegistryNatija[] | null>(null)
  const [qidirilmoqda, setQidirilmoqda] = useState(false)
  const [bandNom, setBandNom] = useState<string | null>(null)
  const [xato, setXato] = useState<string | null>(null)
  const toast = useToast()

  const qidir = async () => {
    setQidirilmoqda(true)
    setXato(null)
    try {
      setNatijalar(await mcpRegistryQidir(soz))
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : 'Could not search')
      setNatijalar(null)
    } finally {
      setQidirilmoqda(false)
    }
  }

  const qosh = async (nom: string) => {
    setBandNom(nom)
    setXato(null)
    try {
      await mcpRegistryQosh(nom)
      await onQoshildi()
      toast(`${nom} added to the catalog`)
      onClose()
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : 'Could not add')
    } finally {
      setBandNom(null)
    }
  }

  return (
    <Modal sarlavha="Official registry" onClose={onClose} kenglik="max-w-2xl">
      <h2 className="font-display text-lg font-semibold">Official registry</h2>
      <p className="mt-1.5 text-sm text-muted">
        registry.modelcontextprotocol.io — open MCP servers from the ecosystem
      </p>

      <div className="mt-4 flex gap-2">
        <input
          value={soz}
          onChange={(e) => setSoz(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void qidir()
          }}
          placeholder="github, postgres, slack…"
          aria-label="Search the registry"
          className="flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
        />
        <button
          onClick={qidir}
          disabled={qidirilmoqda}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {qidirilmoqda ? 'Searching…' : 'Search'}
        </button>
      </div>

      {xato && <p className="mt-3 text-sm text-coral">{xato}</p>}

      {natijalar !== null && (
        <div className="mt-4 max-h-96 space-y-2 overflow-y-auto">
          {natijalar.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">Nothing found.</p>
          ) : (
            natijalar.map((n) => (
              <div
                key={n.nom}
                className="flex items-start justify-between gap-3 rounded-lg border border-line bg-bg p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-[13px] text-ink">{n.nom}</span>
                    <span className="shrink-0 rounded-md bg-panel2 px-1.5 py-0.5 text-[10px] text-faint">
                      {transportBelgisi[n.transport]}
                    </span>
                    {n.versiya && (
                      <span className="shrink-0 text-[11px] text-faint">v{n.versiya}</span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">
                    {n.tavsif || '(no description)'}
                  </p>
                  {n.sozlamalar.length > 0 && (
                    <p className="mt-1 text-[11px] text-faint">
                      {n.sozlamalar.length} settings required
                      {n.sozlamalar.some((s) => s.maxfiy) && ' (including a key)'}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => void qosh(n.nom)}
                  disabled={bandNom !== null}
                  className="shrink-0 rounded-lg border border-lazur-dim px-3 py-1.5 text-xs text-lazur transition hover:bg-lazur-dim hover:text-bg disabled:opacity-50"
                >
                  {bandNom === n.nom ? '…' : 'Add'}
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <div className="mt-5 flex justify-end">
        <button
          onClick={onClose}
          className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
        >
          Close
        </button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// GitHub ulash modali
// ---------------------------------------------------------------------------

function GithubModal({
  onClose,
  onQoshildi,
}: {
  onClose: () => void
  onQoshildi: () => Promise<unknown>
}) {
  const [url, setUrl] = useState('')
  const [ishlayapti, setIshlayapti] = useState(false)
  const [xato, setXato] = useState<string | null>(null)
  const toast = useToast()

  const ula = async () => {
    setIshlayapti(true)
    setXato(null)
    try {
      const natija = await mcpGithubUlash(url)
      await onQoshildi()
      const ogoh = natija.ogohlantirishlar?.length ?? 0
      toast(
        `${natija.qoshildi} servers added${ogoh > 0 ? ` · ${ogoh} warnings` : ''}`,
      )
      onClose()
    } catch (x) {
      setXato(x instanceof ApiXatosi ? (x.detail ?? x.message) : 'Could not connect')
      setIshlayapti(false)
    }
  }

  return (
    <Modal sarlavha="GitHub repo" onClose={onClose}>
      <h2 className="font-display text-lg font-semibold">GitHub repo</h2>
      <p className="mt-1.5 text-sm text-muted">
        The repo is scanned for <code className="font-mono text-xs text-ink">server.json</code> files —
        the official declaration format for MCP servers.
      </p>

      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && url.trim()) void ula()
        }}
        placeholder="github/github-mcp-server"
        aria-label="Repo address"
        className="mt-4 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
      />

      {xato && <p className="mt-3 text-sm text-coral">{xato}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={ula}
          disabled={ishlayapti || !url.trim()}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {ishlayapti ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Qo'lda qo'shish modali
// ---------------------------------------------------------------------------

/** Foydalanuvchi qo'lda qo'shadigan sozlama qatori */
interface SozlamaQatori {
  nom: string
  maxfiy: boolean
  majburiy: boolean
}

function QoldaModal({
  onClose,
  onQoshildi,
}: {
  onClose: () => void
  onQoshildi: () => Promise<unknown>
}) {
  const [nom, setNom] = useState('')
  const [tavsif, setTavsif] = useState('')
  const [transport, setTransport] = useState<McpTransportTuri>('stdio')
  const [buyruq, setBuyruq] = useState('npx')
  const [argumentlar, setArgumentlar] = useState('')
  const [url, setUrl] = useState('')
  const [sozlamalar, setSozlamalar] = useState<SozlamaQatori[]>([])
  const [ishlayapti, setIshlayapti] = useState(false)
  const [xato, setXato] = useState<string | null>(null)
  const toast = useToast()

  const tayyor =
    nom.trim() !== '' && (transport === 'stdio' ? buyruq.trim() !== '' : url.trim() !== '')

  const qosh = async () => {
    setIshlayapti(true)
    setXato(null)
    try {
      await mcpQoldaQosh({
        nom: nom.trim(),
        tavsif: tavsif.trim() || undefined,
        transport,
        ...(transport === 'stdio'
          ? {
              buyruq: buyruq.trim(),
              // Argumentlar BO'SHLIQ bo'yicha ajratiladi. Bu oddiy qoida:
              // MCP argumentlarida bo'shliq bo'lgan qiymat kam uchraydi
              // (ular odatda paket nomi va bayroqlar).
              argumentlar: argumentlar.trim() ? argumentlar.trim().split(/\s+/) : [],
            }
          : { url: url.trim() }),
        sozlamalar: sozlamalar
          .filter((s) => s.nom.trim())
          .map((s) => ({ nom: s.nom.trim(), majburiy: s.majburiy, maxfiy: s.maxfiy })),
      })
      await onQoshildi()
      toast(`${nom.trim()} added`)
      onClose()
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : 'Could not add')
      setIshlayapti(false)
    }
  }

  const qatorYangila = (indeks: number, ozgarish: Partial<SozlamaQatori>) => {
    setSozlamalar((eski) =>
      eski.map((s, i) => (i === indeks ? { ...s, ...ozgarish } : s)),
    )
  }

  return (
    <Modal sarlavha="Add manually" onClose={onClose} kenglik="max-w-lg">
      <h2 className="font-display text-lg font-semibold">Add manually</h2>
      <p className="mt-1.5 text-sm text-muted">
        You enter the start command or the remote address yourself.
      </p>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wider text-faint">Name</span>
          <input
            value={nom}
            onChange={(e) => setNom(e.target.value)}
            placeholder="github"
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wider text-faint">
            Description (optional)
          </span>
          <input
            value={tavsif}
            onChange={(e) => setTavsif(e.target.value)}
            placeholder="What it does — the agent reads this text"
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
          />
        </label>

        <div>
          <span className="text-xs font-medium uppercase tracking-wider text-faint">Transport</span>
          <div className="mt-1.5 flex gap-4">
            {(['stdio', 'http'] as const).map((t) => (
              <label key={t} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="transport"
                  checked={transport === t}
                  onChange={() => setTransport(t)}
                />
                <span className="text-muted">
                  {t === 'stdio' ? 'Local process (stdio)' : 'Remote (http)'}
                </span>
              </label>
            ))}
          </div>
        </div>

        {transport === 'stdio' ? (
          <>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wider text-faint">
                Command
              </span>
              <input
                value={buyruq}
                onChange={(e) => setBuyruq(e.target.value)}
                placeholder="npx"
                className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wider text-faint">
                Arguments
              </span>
              <input
                value={argumentlar}
                onChange={(e) => setArgumentlar(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-everything"
                className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
              />
              <span className="mt-1 block text-[11px] text-faint">
                Separated by spaces. The command runs directly, not through a shell.
              </span>
            </label>
          </>
        ) : (
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wider text-faint">URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com/mcp"
              className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
            />
          </label>
        )}

        {/* Sozlama maydonlari — server so'raydigan env/sarlavhalar */}
        <div className="rounded-lg border border-line bg-bg p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-faint">
              Settings {transport === 'stdio' ? '(env)' : '(headers)'}
            </span>
            <button
              onClick={() =>
                setSozlamalar((e) => [...e, { nom: '', maxfiy: true, majburiy: true }])
              }
              className="text-xs text-lazur transition hover:brightness-125"
            >
              + add
            </button>
          </div>

          {sozlamalar.length === 0 ? (
            <p className="mt-2 text-[11px] text-faint">
              If the server asks for a token or an address, add it here.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {sozlamalar.map((s, i) => (
                // eslint-disable-next-line react/no-array-index-key -- qatorlar tartibi barqaror
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={s.nom}
                    onChange={(e) => qatorYangila(i, { nom: e.target.value })}
                    placeholder={transport === 'stdio' ? 'GITHUB_TOKEN' : 'Authorization'}
                    className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-2 py-1.5 font-mono text-xs outline-none placeholder:text-faint focus:border-lazur-dim"
                  />
                  <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted">
                    <input
                      type="checkbox"
                      checked={s.maxfiy}
                      onChange={(e) => qatorYangila(i, { maxfiy: e.target.checked })}
                    />
                    secret
                  </label>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted">
                    <input
                      type="checkbox"
                      checked={s.majburiy}
                      onChange={(e) => qatorYangila(i, { majburiy: e.target.checked })}
                    />
                    required
                  </label>
                  <button
                    onClick={() => setSozlamalar((e) => e.filter((_, j) => j !== i))}
                    aria-label="Delete row"
                    className="shrink-0 text-sm text-faint transition hover:text-coral"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {xato && <p className="mt-3 text-sm text-coral">{xato}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={qosh}
          disabled={ishlayapti || !tayyor}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {ishlayapti ? 'Adding…' : 'Add'}
        </button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// O'rnatish modali
// ---------------------------------------------------------------------------

/**
 * Qamrov + sozlama qiymatlari.
 *
 * MAXFIY QIYMATLAR HECH QACHON KO'RSATILMAYDI. Server ularni javobda
 * qaytarmaydi, ya'ni bu yerda faqat bo'sh input bo'ladi. Bo'sh qoldirilsa
 * saqlangan qiymat o'z joyida qoladi — buni foydalanuvchiga ochiq aytamiz,
 * aks holda u "tokenim o'chib ketdimi?" degan savolga qolardi.
 */
function OrnatishModal({
  server,
  loyihalar,
  onClose,
  onSaqla,
}: {
  server: McpServer
  loyihalar: Project[]
  onClose: () => void
  onSaqla: (
    global: boolean,
    projectIds: string[],
    qiymatlar: Record<string, string>,
  ) => Promise<void>
}) {
  const [global, setGlobal] = useState(server.ornatilgan.some((o) => o.qamrov === 'global'))
  const [tanlangan, setTanlangan] = useState<Set<string>>(
    new Set(
      server.ornatilgan
        .filter((o) => o.qamrov === 'loyiha' && o.projectId)
        .map((o) => o.projectId!),
    ),
  )
  // Ochiq qiymatlar mavjud o'rnatishdan olinadi; maxfiylar HAR DOIM bo'sh
  const [qiymatlar, setQiymatlar] = useState<Record<string, string>>(() => {
    const boshlangich: Record<string, string> = {}
    const ornatish = server.ornatilgan[0]
    for (const maydon of server.sozlamalar) {
      if (maydon.maxfiy) continue
      boshlangich[maydon.nom] =
        ornatish?.sozlamaQiymatlari[maydon.nom] ?? maydon.standart ?? ''
    }
    return boshlangich
  })
  const [ishlayapti, setIshlayapti] = useState(false)
  const [xato, setXato] = useState<string | null>(null)

  const hechnima = !global && tanlangan.size === 0
  const ornatilganmi = server.ornatilgan.length > 0

  const saqla = async () => {
    setIshlayapti(true)
    setXato(null)
    try {
      await onSaqla(global, [...tanlangan], qiymatlar)
      onClose()
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : 'Could not save')
      setIshlayapti(false)
    }
  }

  return (
    <Modal sarlavha={`${server.nom} settings`} onClose={onClose} kenglik="max-w-lg">
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">{server.nom}</h2>
        <span className="shrink-0 rounded-md bg-panel2 px-2 py-0.5 text-[10px] text-faint">
          {transportBelgisi[server.transport]}
        </span>
      </div>
      {server.tavsif && <p className="mt-1.5 text-sm text-muted">{server.tavsif}</p>}

      {/* Ishga tushirish tafsiloti — foydalanuvchi NIMA ishga tushishini bilsin */}
      <div className="mt-4 rounded-lg border border-line bg-bg p-3">
        <div className="text-xs font-medium uppercase tracking-wider text-faint">
          {server.transport === 'stdio' ? 'Runs' : 'Connects to'}
        </div>
        <code className="mt-1.5 block break-all font-mono text-[11px] leading-relaxed text-ink">
          {server.transport === 'stdio'
            ? [server.buyruq, ...(server.argumentlar ?? [])].join(' ')
            : server.url}
        </code>
      </div>

      {/* Sozlama qiymatlari */}
      {server.sozlamalar.length > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-bg p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-faint">
            Settings
          </div>
          <div className="mt-3 space-y-3">
            {server.sozlamalar.map((maydon) => (
              <SozlamaKirishi
                key={maydon.nom}
                maydon={maydon}
                qiymat={qiymatlar[maydon.nom] ?? ''}
                ornatilganmi={ornatilganmi}
                onChange={(q) => setQiymatlar((eski) => ({ ...eski, [maydon.nom]: q }))}
              />
            ))}
          </div>
          {server.sozlamalar.some((s) => s.maxfiy) && (
            <p className="mt-3 text-[11px] leading-relaxed text-faint">
              Secret values are not written to the database — they are kept in a separate
              file and never shown back. Leave a field empty to keep the stored value.
            </p>
          )}
        </div>
      )}

      {/* Qamrov */}
      <div className="mt-3 rounded-lg border border-line bg-bg p-4">
        <div className="text-xs font-medium uppercase tracking-wider text-faint">
          Where it should work
        </div>

        <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={global}
            onChange={(e) => setGlobal(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="text-ink">Everywhere (global)</span>
            <span className="block text-xs text-faint">
              Available in all chats and projects
            </span>
          </span>
        </label>

        {loyihalar.length > 0 && (
          <>
            <div className="mt-4 text-xs font-medium uppercase tracking-wider text-faint">
              Or in selected projects
            </div>
            <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
              {loyihalar.map((l) => (
                <label key={l.id} className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={tanlangan.has(l.id)}
                    onChange={(e) => {
                      const yangi = new Set(tanlangan)
                      if (e.target.checked) yangi.add(l.id)
                      else yangi.delete(l.id)
                      setTanlangan(yangi)
                    }}
                  />
                  <span className="text-muted">{l.name}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-faint">
        The server starts at the beginning of every chat and exposes its tools to the agent.
        Every call asks for permission — just like running a command.
      </p>

      {xato && <p className="mt-3 text-sm text-coral">{xato}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={saqla}
          disabled={ishlayapti}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {ishlayapti ? 'Saving…' : hechnima ? 'Uninstall' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}

/** Bitta sozlama maydoni — maxfiy bo'lsa parol inputi */
function SozlamaKirishi({
  maydon,
  qiymat,
  ornatilganmi,
  onChange,
}: {
  maydon: McpSozlamaMaydoni
  qiymat: string
  ornatilganmi: boolean
  onChange: (q: string) => void
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-xs text-ink">{maydon.nom}</span>
        {maydon.majburiy && <span className="text-[10px] text-coral">required</span>}
        {maydon.maxfiy && <span className="text-[10px] text-gold">secret</span>}
      </span>
      {maydon.izoh && (
        <span className="mt-0.5 block text-[11px] leading-relaxed text-faint">{maydon.izoh}</span>
      )}
      <input
        // Maxfiy qiymatlar brauzer parol menejeriga tushmasligi kerak —
        // ular platformaning o'z ombori bilan boshqariladi
        type={maydon.maxfiy ? 'password' : 'text'}
        autoComplete="off"
        value={qiymat}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          maydon.maxfiy && ornatilganmi
            ? '(stored — type to change it)'
            : (maydon.standart ?? '')
        }
        className="mt-1 w-full rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-faint focus:border-lazur-dim"
      />
    </label>
  )
}

// ---------------------------------------------------------------------------
// Manbalar bo'limi
// ---------------------------------------------------------------------------

function Manbalar({
  manbalar,
  onYangilandi,
}: {
  manbalar: McpManba[]
  onYangilandi: () => Promise<unknown>
}) {
  const [bandId, setBandId] = useState<string | null>(null)
  const [xato, setXato] = useState<string | null>(null)
  const toast = useToast()

  const sinxronla = async (id: string) => {
    setBandId(id)
    setXato(null)
    try {
      const natija = await mcpManbaSinxronla(id)
      await onYangilandi()
      toast(`+${natija.qoshildi} / -${natija.ochirildi}`)
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : 'Could not sync')
    } finally {
      setBandId(null)
    }
  }

  const ochir = async (m: McpManba) => {
    if (!confirm(`Delete ${m.manbaNomi}? Its servers and keys go with it.`)) return
    setBandId(m.id)
    setXato(null)
    try {
      await mcpManbaOchir(m.id)
      await onYangilandi()
      toast('Source deleted')
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : 'Could not delete')
    } finally {
      setBandId(null)
    }
  }

  if (manbalar.length === 0) return null

  return (
    <Card className="mb-6 p-5">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">Sources</div>
      {xato && <p className="mt-2 text-sm text-coral">{xato}</p>}
      <div className="mt-3 space-y-2">
        {manbalar.map((m) => {
          // `qolda` va `standart` manbalarni sinxronlab bo'lmaydi —
          // ular tashqi manbadan kelmaydi
          const sinxronBormi = m.tur === 'github' || m.tur === 'registry'
          return (
            <div
              key={m.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[13px] text-ink">{m.manbaNomi}</span>
                  <span className="shrink-0 rounded-md bg-panel2 px-1.5 py-0.5 text-[10px] text-faint">
                    {m.tur}
                  </span>
                </div>
                {m.oxirgiSinxron && (
                  <span className="text-[11px] text-faint">
                    {new Date(m.oxirgiSinxron).toLocaleDateString()}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {sinxronBormi && (
                  <button
                    onClick={() => void sinxronla(m.id)}
                    disabled={bandId !== null}
                    className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted transition hover:text-ink disabled:opacity-50"
                  >
                    {bandId === m.id ? '…' : 'Sync'}
                  </button>
                )}
                {m.tur !== 'standart' && (
                  <button
                    onClick={() => void ochir(m)}
                    disabled={bandId !== null}
                    className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted transition hover:border-coral/40 hover:text-coral disabled:opacity-50"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Asosiy sahifa
// ---------------------------------------------------------------------------

export default function Mcp() {
  const [serverlar, setServerlar] = useState<McpServer[]>([])
  const [manbalar, setManbalar] = useState<McpManba[]>([])
  const [loyihalar, setLoyihalar] = useState<Project[]>([])
  const [yuklanmoqda, setYuklanmoqda] = useState(true)
  const [xato, setXato] = useState<string | null>(null)
  const [modal, setModal] = useState<McpServer | null>(null)
  const [qoshishModali, setQoshishModali] = useState<'registry' | 'github' | 'qolda' | null>(null)
  const [qidiruv, setQidiruv] = useState('')

  /** Yangi ro'yxatni QAYTARADI — ochiq modal eskirmasin (`Skills.tsx` naqshi) */
  const yukla = async (): Promise<McpServer[] | null> => {
    try {
      const [katalog, loyiha] = await Promise.all([mcpServerlarniOl(), loyihalarOl()])
      setServerlar(katalog.serverlar)
      setManbalar(katalog.manbalar)
      setLoyihalar(loyiha)
      setXato(null)
      return katalog.serverlar
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : 'Could not load the data')
      return null
    } finally {
      setYuklanmoqda(false)
    }
  }

  useEffect(() => {
    void yukla()
  }, [])

  /**
   * Qamrov va sozlamalarni saqlaydi.
   *
   * `Skills.tsx` dagi `qamrovniSaqla` bilan bir xil diff mantig'i, lekin
   * qo'shimcha: sozlama qiymatlari HAR o'rnatishga yuboriladi (ular
   * o'rnatish qatoriga bog'langan).
   */
  const saqla = async (
    server: McpServer,
    global: boolean,
    projectIds: string[],
    qiymatlar: Record<string, string>,
  ) => {
    const eskiGlobal = server.ornatilgan.some((o) => o.qamrov === 'global')
    const eskiLoyihalar = new Set(
      server.ornatilgan
        .filter((o) => o.qamrov === 'loyiha' && o.projectId)
        .map((o) => o.projectId!),
    )
    const yangiLoyihalar = new Set(projectIds)
    const ochiriladigan = [...eskiLoyihalar].filter((id) => !yangiLoyihalar.has(id))

    // O'rnatish idempotent va sozlamani yangilaydi, shuning uchun mavjud
    // qamrovlar uchun ham qayta chaqiramiz — qiymatlar o'zgargan bo'lishi
    // mumkin (`mcpServerOrnat` UPDATE qiladi).
    if (global) await mcpOrnat(server.id, 'global', qiymatlar)
    if (projectIds.length > 0) await mcpOrnat(server.id, 'loyiha', qiymatlar, projectIds)
    if (!global && eskiGlobal) await mcpOrnatishniBekor(server.id, 'global')
    if (ochiriladigan.length > 0) {
      await mcpOrnatishniBekor(server.id, 'loyiha', ochiriladigan)
    }

    await yukla()
  }

  const qamrovMatni = (server: McpServer): string => {
    const global = server.ornatilgan.some((o) => o.qamrov === 'global')
    const loyihaSoni = server.ornatilgan.filter((o) => o.qamrov === 'loyiha').length
    if (global && loyihaSoni > 0) return `Global + ${loyihaSoni} projects`
    if (global) return 'Global'
    if (loyihaSoni > 0) return `${loyihaSoni} projects`
    return ''
  }

  const korinadigan = useMemo(() => {
    const sozlar = qidiruv.toLowerCase().split(/\s+/).filter(Boolean)
    if (sozlar.length === 0) return serverlar
    return serverlar.filter((s) => {
      const matn = `${s.nom} ${s.tavsif}`.toLowerCase()
      return sozlar.every((soz) => matn.includes(soz))
    })
  }, [serverlar, qidiruv])

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="MCP servers"
        sub="Connect external tools to the agent: registry, GitHub or manually"
      />

      {/* Ways to add a server */}
      <Card className="mb-6 p-5">
        <div className="text-xs font-medium uppercase tracking-wider text-faint">
          Add server
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => setQoshishModali('registry')}
            className="rounded-lg border border-lazur-dim px-3 py-2 text-sm text-lazur transition hover:bg-lazur-dim hover:text-bg"
          >
            Official registry
          </button>
          <button
            onClick={() => setQoshishModali('github')}
            className="rounded-lg border border-line px-3 py-2 text-sm text-muted transition hover:text-ink"
          >
            GitHub repo
          </button>
          <button
            onClick={() => setQoshishModali('qolda')}
            className="rounded-lg border border-line px-3 py-2 text-sm text-muted transition hover:text-ink"
          >
            Manually
          </button>
        </div>
      </Card>

      <Manbalar manbalar={manbalar} onYangilandi={yukla} />

      {xato && (
        <Card className="mb-6 border-coral/40 p-4">
          <p className="text-sm text-coral">{xato}</p>
        </Card>
      )}

      {!yuklanmoqda && serverlar.length > 3 && (
        <div className="mb-5">
          <input
            value={qidiruv}
            onChange={(e) => setQidiruv(e.target.value)}
            placeholder="Search…"
            aria-label="Search MCP servers"
            className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
          />
        </div>
      )}

      {yuklanmoqda ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : serverlar.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">
            The catalog is empty. Add a server using one of the buttons above.
          </p>
          <p className="mt-2 text-xs text-faint">
            MCP is the standard for connecting external tools to an AI. Once a server is
            installed, its tools show up in the chat.
          </p>
        </Card>
      ) : korinadigan.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">Nothing found.</p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {korinadigan.map((s) => {
            const qamrov = qamrovMatni(s)
            const kalitKerak = s.sozlamalar.some((x) => x.majburiy && x.maxfiy)
            return (
              <Card key={s.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="min-w-0 truncate font-display text-[15px] font-semibold" title={s.nom}>
                    {s.nom}
                  </h2>
                  <span className="shrink-0 rounded-md bg-panel2 px-2 py-0.5 text-[10px] text-faint">
                    {transportBelgisi[s.transport]}
                  </span>
                </div>

                <div className="mt-2 flex-1">
                  <p className="line-clamp-3 text-sm leading-relaxed text-muted">
                    {s.tavsif || '(no description)'}
                  </p>
                  {kalitKerak && (
                    <p className="mt-1.5 text-[11px] text-gold">requires a key</p>
                  )}
                </div>

                <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
                  {qamrov ? (
                    <span className="truncate text-sm text-mint" title={qamrov}>
                      ✓ {qamrov}
                    </span>
                  ) : (
                    <span className="text-xs text-faint">not installed</span>
                  )}
                  <button
                    onClick={() => setModal(s)}
                    className={
                      qamrov
                        ? 'shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition hover:text-ink'
                        : 'shrink-0 rounded-lg border border-lazur-dim px-3 py-1.5 text-sm text-lazur transition hover:bg-lazur-dim hover:text-bg'
                    }
                  >
                    {qamrov ? 'Configure' : 'Install'}
                  </button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {qoshishModali === 'registry' && (
        <RegistryModal onClose={() => setQoshishModali(null)} onQoshildi={yukla} />
      )}
      {qoshishModali === 'github' && (
        <GithubModal onClose={() => setQoshishModali(null)} onQoshildi={yukla} />
      )}
      {qoshishModali === 'qolda' && (
        <QoldaModal onClose={() => setQoshishModali(null)} onQoshildi={yukla} />
      )}

      {modal && (
        <OrnatishModal
          server={modal}
          loyihalar={loyihalar}
          onClose={() => setModal(null)}
          onSaqla={(global, ids, qiymatlar) => saqla(modal, global, ids, qiymatlar)}
        />
      )}
    </div>
  )
}
