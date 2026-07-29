// Serverlar sahifasi — haqiqiy SSH boshqaruvi.
//
// Server qo'shish = backend platforma kalitini serverga joylaydi, shundan
// keyin platformada HAM terminalda `ssh <nom>` parolsiz ishlaydi. Kartadagi
// metrikalar har ochilishda SSH orqali jonli o'qiladi (bazada saqlanmaydi),
// shuning uchun sekin serverda karta bir necha soniya "tekshirilmoqda"
// holatida turadi — bu xato emas.

import { useCallback, useEffect, useState } from 'react'
import type { Server, ServerMetrika } from '@platforma/shared'
import {
  ApiXatosi,
  serverMetrikaOl,
  serverOchir,
  serverQosh,
  serverlarOl,
} from '../lib/api'
import { useToast } from '../lib/toast'
import { Card, Meter, PageHead, StatusDot } from '../ui'

// ---------------------------------------------------------------------------
// Qo'shish modali
// ---------------------------------------------------------------------------

function QoshishModal({
  onClose,
  onQoshildi,
}: {
  onClose: () => void
  onQoshildi: (server: Server, ulanishXatosi?: string) => void
}) {
  const [nom, setNom] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('root')
  const [parol, setParol] = useState('')
  const [ishlayapti, setIshlayapti] = useState(false)
  const [xato, setXato] = useState<string | null>(null)

  const yubor = async (e: React.FormEvent) => {
    e.preventDefault()
    setIshlayapti(true)
    setXato(null)
    try {
      const { server, ulanishXatosi } = await serverQosh({
        name: nom.trim(),
        host: host.trim(),
        port: port.trim(),
        username: username.trim(),
        parol: parol || undefined,
      })
      onQoshildi(server, ulanishXatosi)
      onClose()
    } catch (x) {
      setXato(x instanceof ApiXatosi ? `${x.message}${x.detail ? ` — ${x.detail}` : ''}` : "Qo'shib bo'lmadi")
      setIshlayapti(false)
    }
  }

  const kiritish =
    'mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm ' +
    'outline-none focus:border-lazur-dim'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Server qo'shish"
    >
      <Card className="rise-in w-full max-w-md p-6">
        <form onClick={(e) => e.stopPropagation()} onSubmit={yubor}>
          <h2 className="font-display text-lg font-semibold">Server qo'shish</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            Platforma SSH kalitini serverga joylaydi — keyin terminalda ham{' '}
            <code className="font-mono text-lazur">ssh {nom.trim() || 'server-nomi'}</code>{' '}
            parolsiz ishlaydi.
          </p>

          <label className="mt-4 block text-xs font-medium uppercase tracking-wider text-faint">
            Nom (ssh alias)
            <input
              className={kiritish}
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              placeholder="frankfurt-1"
              autoFocus
              required
            />
          </label>

          <div className="mt-3 flex gap-3">
            <label className="block flex-1 text-xs font-medium uppercase tracking-wider text-faint">
              Host
              <input
                className={kiritish}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="203.0.113.10"
                required
              />
            </label>
            <label className="block w-24 text-xs font-medium uppercase tracking-wider text-faint">
              Port
              <input
                className={kiritish}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
              />
            </label>
          </div>

          <label className="mt-3 block text-xs font-medium uppercase tracking-wider text-faint">
            Foydalanuvchi
            <input className={kiritish} value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>

          <label className="mt-3 block text-xs font-medium uppercase tracking-wider text-faint">
            Parol (ixtiyoriy)
            <input
              className={kiritish}
              type="password"
              value={parol}
              onChange={(e) => setParol(e.target.value)}
              placeholder="kalitingiz serverga kira olsa — bo'sh qoldiring"
              autoComplete="off"
            />
          </label>
          <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
            Avval mavjud SSH kalitlaringiz bilan urinib ko'riladi. Parol faqat
            birinchi ulanish uchun ishlatiladi va hech qayerda saqlanmaydi.
          </p>

          {xato && (
            <p className="mt-3 rounded-lg bg-coral/10 px-3 py-2 text-xs leading-relaxed text-coral">
              {xato}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-panel2"
            >
              Bekor qilish
            </button>
            <button
              type="submit"
              disabled={ishlayapti}
              className="rounded-lg bg-lazur-dim px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-60"
            >
              {ishlayapti ? 'Kalit joylanmoqda…' : 'Ulash'}
            </button>
          </div>
        </form>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// O'chirish tasdig'i
// ---------------------------------------------------------------------------

function OchirishModal({
  server,
  onClose,
  onOchirildi,
}: {
  server: Server
  onClose: () => void
  onOchirildi: () => void
}) {
  const [ishlayapti, setIshlayapti] = useState(false)
  const [xato, setXato] = useState<string | null>(null)

  const ochir = async () => {
    setIshlayapti(true)
    setXato(null)
    try {
      await serverOchir(server.id)
      onOchirildi()
      onClose()
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : "O'chirib bo'lmadi")
      setIshlayapti(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Serverni o'chirish"
    >
      <Card className="rise-in w-full max-w-sm p-6">
        <div onClick={(e) => e.stopPropagation()}>
          <h2 className="font-display text-lg font-semibold">
            {server.name} o'chirilsinmi?
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Ro'yxatdan va ssh config'dan olib tashlanadi. Platforma kaliti
            serverning o'zida (<code className="font-mono">authorized_keys</code>)
            qoladi — xohlasangiz keyin qo'lda o'chirasiz.
          </p>

          {xato && (
            <p className="mt-3 rounded-lg bg-coral/10 px-3 py-2 text-xs text-coral">{xato}</p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-panel2"
            >
              Bekor qilish
            </button>
            <button
              onClick={ochir}
              disabled={ishlayapti}
              className="rounded-lg bg-coral/80 px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-60"
            >
              {ishlayapti ? "O'chirilmoqda…" : "O'chirish"}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Server kartasi
// ---------------------------------------------------------------------------

function ServerKartasi({
  server,
  onOchir,
}: {
  server: Server
  onOchir: (s: Server) => void
}) {
  // undefined = hali so'ralmoqda
  const [metrika, setMetrika] = useState<ServerMetrika | undefined>()

  useEffect(() => {
    let tirik = true
    setMetrika(undefined)
    serverMetrikaOl(server.id)
      .then((j) => tirik && setMetrika(j.metrika))
      .catch((x) => tirik && setMetrika({ holat: 'xato', xato: x instanceof Error ? x.message : String(x) }))
    return () => {
      tirik = false
    }
  }, [server.id])

  const ulangan = metrika?.holat === 'ulangan'

  return (
    <Card className={`p-5 ${metrika?.holat === 'xato' ? 'border-coral/40' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate font-mono text-[15px] font-semibold">{server.name}</h2>
          <div className="mt-0.5 truncate text-xs text-muted">
            {server.username}@{server.host}
            {server.port !== 22 && `:${server.port}`}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-faint">ssh {server.name}</div>
        </div>
        {metrika === undefined ? (
          <span className="text-xs text-faint">tekshirilmoqda…</span>
        ) : (
          <StatusDot status={ulangan ? 'healthy' : 'offline'} />
        )}
      </div>

      {ulangan && (
        <div className="mt-4 space-y-2.5">
          {(['cpu', 'ram', 'disk'] as const).map((k) => (
            <div key={k} className="flex items-center gap-3">
              <span className="w-8 font-mono text-[11px] uppercase text-faint">{k}</span>
              <div className="flex-1">
                <Meter value={metrika?.[k] ?? 0} />
              </div>
            </div>
          ))}
        </div>
      )}

      {metrika?.holat === 'xato' && (
        <p className="mt-3 rounded-lg bg-coral/10 px-3 py-2 font-mono text-[11px] leading-relaxed text-coral">
          {metrika.xato}
        </p>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-[11px] text-faint">
        <span className="font-mono">{ulangan && metrika?.uptime ? `uptime ${metrika.uptime}` : '—'}</span>
        <button
          onClick={() => onOchir(server)}
          className="rounded-md px-2 py-1 text-coral/80 hover:bg-coral/10"
        >
          o'chirish
        </button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Sahifa
// ---------------------------------------------------------------------------

export default function Servers() {
  const [serverlar, setServerlar] = useState<Server[]>([])
  const [yuklanmoqda, setYuklanmoqda] = useState(true)
  const [qoshishOchiq, setQoshishOchiq] = useState(false)
  const [ochirilayotgan, setOchirilayotgan] = useState<Server | null>(null)
  const toast = useToast()

  const yangila = useCallback(() => {
    serverlarOl()
      .then((j) => setServerlar(j.servers))
      .catch(() => toast("Serverlar ro'yxatini olib bo'lmadi", 'error'))
      .finally(() => setYuklanmoqda(false))
  }, [toast])

  useEffect(() => {
    yangila()
  }, [yangila])

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="Serverlar"
        sub="Platforma kaliti serverga bir marta joylanadi — keyin ulanish parolsiz, terminalda ham `ssh nom` ishlaydi"
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {serverlar.map((s) => (
          <ServerKartasi key={s.id} server={s} onOchir={setOchirilayotgan} />
        ))}

        <Card className="flex flex-col items-center justify-center border-dashed p-5 text-center">
          <div className="font-display text-sm font-semibold text-muted">
            {yuklanmoqda ? 'Yuklanmoqda…' : serverlar.length === 0 ? 'Hali server yo\'q' : 'Server qo\'shish'}
          </div>
          <p className="mt-2 max-w-52 text-xs leading-relaxed text-faint">
            Host va nom kiriting — SSH kalit avtomatik joylanadi, parol
            saqlanmaydi.
          </p>
          <button
            onClick={() => setQoshishOchiq(true)}
            className="mt-3 rounded-lg bg-lazur-dim px-4 py-1.5 text-sm font-medium text-bg"
          >
            Qo'shish
          </button>
        </Card>
      </div>

      {qoshishOchiq && (
        <QoshishModal
          onClose={() => setQoshishOchiq(false)}
          onQoshildi={(server, ulanishXatosi) => {
            yangila()
            if (ulanishXatosi) {
              toast(`${server.name} qo'shildi, lekin tekshiruv o'tmadi: ${ulanishXatosi}`, 'warning')
            } else {
              toast(`${server.name} ulandi — endi «ssh ${server.name}» parolsiz ishlaydi`, 'success')
            }
          }}
        />
      )}

      {ochirilayotgan && (
        <OchirishModal
          server={ochirilayotgan}
          onClose={() => setOchirilayotgan(null)}
          onOchirildi={() => {
            yangila()
            toast(`${ochirilayotgan.name} o'chirildi`, 'info')
          }}
        />
      )}
    </div>
  )
}
