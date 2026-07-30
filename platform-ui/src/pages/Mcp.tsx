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
  stdio: 'mahalliy',
  http: 'masofaviy',
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
      setXato(x instanceof ApiXatosi ? x.message : "Qidirib bo'lmadi")
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
      toast(`${nom} katalogga qo'shildi`)
      onClose()
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : "Qo'shib bo'lmadi")
    } finally {
      setBandNom(null)
    }
  }

  return (
    <Modal sarlavha="Rasmiy registry" onClose={onClose} kenglik="max-w-2xl">
      <h2 className="font-display text-lg font-semibold">Rasmiy registry</h2>
      <p className="mt-1.5 text-sm text-muted">
        registry.modelcontextprotocol.io — ekotizimdagi ochiq MCP serverlar
      </p>

      <div className="mt-4 flex gap-2">
        <input
          value={soz}
          onChange={(e) => setSoz(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void qidir()
          }}
          placeholder="github, postgres, slack…"
          aria-label="Registry'da qidirish"
          className="flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
        />
        <button
          onClick={qidir}
          disabled={qidirilmoqda}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {qidirilmoqda ? 'Qidirilmoqda…' : 'Qidirish'}
        </button>
      </div>

      {xato && <p className="mt-3 text-sm text-coral">{xato}</p>}

      {natijalar !== null && (
        <div className="mt-4 max-h-96 space-y-2 overflow-y-auto">
          {natijalar.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">Hech narsa topilmadi.</p>
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
                    {n.tavsif || '(tavsif yo\'q)'}
                  </p>
                  {n.sozlamalar.length > 0 && (
                    <p className="mt-1 text-[11px] text-faint">
                      {n.sozlamalar.length} sozlama kerak
                      {n.sozlamalar.some((s) => s.maxfiy) && ' (kalit bilan)'}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => void qosh(n.nom)}
                  disabled={bandNom !== null}
                  className="shrink-0 rounded-lg border border-lazur-dim px-3 py-1.5 text-xs text-lazur transition hover:bg-lazur-dim hover:text-bg disabled:opacity-50"
                >
                  {bandNom === n.nom ? '…' : "Qo'shish"}
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
          Yopish
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
        `${natija.qoshildi} server qo'shildi${ogoh > 0 ? ` · ${ogoh} ogohlantirish` : ''}`,
      )
      onClose()
    } catch (x) {
      setXato(x instanceof ApiXatosi ? (x.detail ?? x.message) : "Ulab bo'lmadi")
      setIshlayapti(false)
    }
  }

  return (
    <Modal sarlavha="GitHub repo" onClose={onClose}>
      <h2 className="font-display text-lg font-semibold">GitHub repo</h2>
      <p className="mt-1.5 text-sm text-muted">
        Repo'da <code className="font-mono text-xs text-ink">server.json</code> fayllari
        qidiriladi — bu MCP serverlarning rasmiy e'lon formati.
      </p>

      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && url.trim()) void ula()
        }}
        placeholder="github/github-mcp-server"
        aria-label="Repo manzili"
        className="mt-4 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
      />

      {xato && <p className="mt-3 text-sm text-coral">{xato}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
        >
          Bekor qilish
        </button>
        <button
          onClick={ula}
          disabled={ishlayapti || !url.trim()}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {ishlayapti ? 'Ulanmoqda…' : 'Ulash'}
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
      toast(`${nom.trim()} qo'shildi`)
      onClose()
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : "Qo'shib bo'lmadi")
      setIshlayapti(false)
    }
  }

  const qatorYangila = (indeks: number, ozgarish: Partial<SozlamaQatori>) => {
    setSozlamalar((eski) =>
      eski.map((s, i) => (i === indeks ? { ...s, ...ozgarish } : s)),
    )
  }

  return (
    <Modal sarlavha="Qo'lda qo'shish" onClose={onClose} kenglik="max-w-lg">
      <h2 className="font-display text-lg font-semibold">Qo'lda qo'shish</h2>
      <p className="mt-1.5 text-sm text-muted">
        Ishga tushirish buyrug'ini yoki masofaviy manzilni o'zingiz kiritasiz.
      </p>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wider text-faint">Nom</span>
          <input
            value={nom}
            onChange={(e) => setNom(e.target.value)}
            placeholder="github"
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wider text-faint">
            Tavsif (ixtiyoriy)
          </span>
          <input
            value={tavsif}
            onChange={(e) => setTavsif(e.target.value)}
            placeholder="Nima qiladi — agent shu matnni o'qiydi"
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
                  {t === 'stdio' ? 'Mahalliy jarayon (stdio)' : 'Masofaviy (http)'}
                </span>
              </label>
            ))}
          </div>
        </div>

        {transport === 'stdio' ? (
          <>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wider text-faint">
                Buyruq
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
                Argumentlar
              </span>
              <input
                value={argumentlar}
                onChange={(e) => setArgumentlar(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-everything"
                className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
              />
              <span className="mt-1 block text-[11px] text-faint">
                Bo'shliq bilan ajratiladi. Buyruq shell orqali emas, to'g'ridan-to'g'ri
                ishga tushadi.
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
              Sozlamalar {transport === 'stdio' ? '(env)' : '(sarlavhalar)'}
            </span>
            <button
              onClick={() =>
                setSozlamalar((e) => [...e, { nom: '', maxfiy: true, majburiy: true }])
              }
              className="text-xs text-lazur transition hover:brightness-125"
            >
              + qo'shish
            </button>
          </div>

          {sozlamalar.length === 0 ? (
            <p className="mt-2 text-[11px] text-faint">
              Server token yoki manzil so'raydigan bo'lsa shu yerga qo'shing.
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
                    maxfiy
                  </label>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted">
                    <input
                      type="checkbox"
                      checked={s.majburiy}
                      onChange={(e) => qatorYangila(i, { majburiy: e.target.checked })}
                    />
                    majburiy
                  </label>
                  <button
                    onClick={() => setSozlamalar((e) => e.filter((_, j) => j !== i))}
                    aria-label="Qatorni o'chirish"
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
          Bekor qilish
        </button>
        <button
          onClick={qosh}
          disabled={ishlayapti || !tayyor}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {ishlayapti ? "Qo'shilmoqda…" : "Qo'shish"}
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
      setXato(x instanceof ApiXatosi ? x.message : "Saqlab bo'lmadi")
      setIshlayapti(false)
    }
  }

  return (
    <Modal sarlavha={`${server.nom} sozlamalari`} onClose={onClose} kenglik="max-w-lg">
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
          {server.transport === 'stdio' ? 'Ishga tushadi' : 'Ulanadi'}
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
            Sozlamalar
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
              Maxfiy qiymatlar bazaga yozilmaydi — alohida faylda saqlanadi va
              qaytarib ko'rsatilmaydi. Bo'sh qoldirilsa saqlangani o'z joyida qoladi.
            </p>
          )}
        </div>
      )}

      {/* Qamrov */}
      <div className="mt-3 rounded-lg border border-line bg-bg p-4">
        <div className="text-xs font-medium uppercase tracking-wider text-faint">
          Qayerda ishlasin
        </div>

        <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={global}
            onChange={(e) => setGlobal(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="text-ink">Hamma joyda (global)</span>
            <span className="block text-xs text-faint">
              Barcha suhbatlar va loyihalarda mavjud bo'ladi
            </span>
          </span>
        </label>

        {loyihalar.length > 0 && (
          <>
            <div className="mt-4 text-xs font-medium uppercase tracking-wider text-faint">
              Yoki tanlangan loyihalarda
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
        Server har suhbat boshida ishga tushadi va agentga o'z vositalarini beradi.
        Har chaqiruv ruxsat so'raydi — xuddi buyruq bajarish kabi.
      </p>

      {xato && <p className="mt-3 text-sm text-coral">{xato}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
        >
          Bekor qilish
        </button>
        <button
          onClick={saqla}
          disabled={ishlayapti}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {ishlayapti ? 'Saqlanmoqda…' : hechnima ? "O'chirish" : 'Saqlash'}
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
        {maydon.majburiy && <span className="text-[10px] text-coral">majburiy</span>}
        {maydon.maxfiy && <span className="text-[10px] text-gold">maxfiy</span>}
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
            ? "(saqlangan — o'zgartirish uchun yozing)"
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
      setXato(x instanceof ApiXatosi ? x.message : "Sinxronlab bo'lmadi")
    } finally {
      setBandId(null)
    }
  }

  const ochir = async (m: McpManba) => {
    if (!confirm(`${m.manbaNomi} o'chirilsinmi? Serverlari va kalitlari ham ketadi.`)) return
    setBandId(m.id)
    setXato(null)
    try {
      await mcpManbaOchir(m.id)
      await onYangilandi()
      toast("Manba o'chirildi")
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : "O'chirib bo'lmadi")
    } finally {
      setBandId(null)
    }
  }

  if (manbalar.length === 0) return null

  return (
    <Card className="mb-6 p-5">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">Manbalar</div>
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
                    {bandId === m.id ? '…' : 'Sinxron'}
                  </button>
                )}
                {m.tur !== 'standart' && (
                  <button
                    onClick={() => void ochir(m)}
                    disabled={bandId !== null}
                    className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted transition hover:border-coral/40 hover:text-coral disabled:opacity-50"
                  >
                    O'chirish
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
      setXato(x instanceof ApiXatosi ? x.message : "Ma'lumotni olib bo'lmadi")
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
    if (global && loyihaSoni > 0) return `Global + ${loyihaSoni} loyiha`
    if (global) return 'Global'
    if (loyihaSoni > 0) return `${loyihaSoni} loyiha`
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
        title="MCP serverlar"
        sub="Tashqi vositalarni agentga ulash: registry, GitHub yoki qo'lda"
      />

      {/* Qo'shish yo'llari */}
      <Card className="mb-6 p-5">
        <div className="text-xs font-medium uppercase tracking-wider text-faint">
          Server qo'shish
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => setQoshishModali('registry')}
            className="rounded-lg border border-lazur-dim px-3 py-2 text-sm text-lazur transition hover:bg-lazur-dim hover:text-bg"
          >
            Rasmiy registry
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
            Qo'lda
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
            placeholder="Qidirish…"
            aria-label="MCP serverlar ichida qidirish"
            className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
          />
        </div>
      )}

      {yuklanmoqda ? (
        <p className="text-sm text-muted">Yuklanmoqda…</p>
      ) : serverlar.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">
            Katalog bo'sh. Yuqoridagi tugmalardan biri bilan server qo'shing.
          </p>
          <p className="mt-2 text-xs text-faint">
            MCP — tashqi vositalarni AI'ga ulash standarti. Server o'rnatilgach
            uning vositalari suhbatda paydo bo'ladi.
          </p>
        </Card>
      ) : korinadigan.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">Hech narsa topilmadi.</p>
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
                    {s.tavsif || '(tavsif yo\'q)'}
                  </p>
                  {kalitKerak && (
                    <p className="mt-1.5 text-[11px] text-gold">kalit talab qiladi</p>
                  )}
                </div>

                <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
                  {qamrov ? (
                    <span className="truncate text-sm text-mint" title={qamrov}>
                      ✓ {qamrov}
                    </span>
                  ) : (
                    <span className="text-xs text-faint">o'rnatilmagan</span>
                  )}
                  <button
                    onClick={() => setModal(s)}
                    className={
                      qamrov
                        ? 'shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition hover:text-ink'
                        : 'shrink-0 rounded-lg border border-lazur-dim px-3 py-1.5 text-sm text-lazur transition hover:bg-lazur-dim hover:text-bg'
                    }
                  >
                    {qamrov ? 'Sozlash' : "O'rnatish"}
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
