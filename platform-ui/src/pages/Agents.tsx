// Agentlar sahifasi — fonda ishlayotgan haqiqiy agent oqimlari.
//
// "Agent" bu yerda = oqim ketayotgan chat sessiyasi. Server tomonida oqim
// allaqachon fon rejimida ishlaydi (orchestrator fire-and-forget), bu sahifa
// esa uning ko'rinish qatlami: kim ishlayapti, kim ruxsat kutmoqda va
// to'xtatish tugmasi.
//
// Ma'lumot manbai — `useIshlayotganlar()`: boshlang'ich ro'yxat REST'dan,
// keyingi o'zgarishlar `chat.status` WS eventlaridan.

import { useState } from 'react'
import OqimIndikatori from '../components/OqimIndikatori'
import { oqimniToxtat } from '../lib/api'
import { useIshlayotganlar } from '../lib/ishlayotganlar'
import { Card, PageHead } from '../ui'

export default function Agents() {
  const { ishlayotganlar, sarlavhalar, yuklanmoqda } = useIshlayotganlar()
  /** To'xtatish so'rovi yuborilgan, lekin hali status kelmagan sessiyalar */
  const [toxtatilayotgan, setToxtatilayotgan] = useState<Record<string, true>>({})

  const royxat = Object.entries(ishlayotganlar)

  async function toxtat(sessionId: string) {
    setToxtatilayotgan((t) => ({ ...t, [sessionId]: true }))
    try {
      await oqimniToxtat(sessionId)
      // Ro'yxatdan o'chirmaymiz — server yakuniy `chat.status` yuboradi va
      // hook o'zi olib tashlaydi. Shunday qilib UI server bilan sinxron
      // qoladi: to'xtatish ishlamasa sessiya ro'yxatda ko'rinib turaveradi.
    } catch {
      // Xato bo'lsa tugmani qaytaramiz — foydalanuvchi qayta urina olsin
      setToxtatilayotgan((t) => {
        const { [sessionId]: _olib, ...qolgan } = t
        return qolgan
      })
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="Agents"
        sub="Agent streams running in the background — each one belongs to a single chat"
      />

      {yuklanmoqda && royxat.length === 0 && (
        <p className="text-sm text-faint">Loading…</p>
      )}

      {!yuklanmoqda && royxat.length === 0 && (
        <Card className="px-6 py-10 text-center">
          <p className="text-sm text-muted">No agents are running right now.</p>
          <p className="mt-1.5 text-xs text-faint">
            Send a message in chat — the stream shows up here live.
          </p>
        </Card>
      )}

      {royxat.length > 0 && (
        <div className="space-y-3">
          {royxat.map(([sessionId, holat]) => (
            <Card key={sessionId} className="flex items-center gap-4 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <h2 className="truncate font-mono text-sm font-semibold text-lazur">
                    {sarlavhalar[sessionId] ?? 'Untitled chat'}
                  </h2>
                  <OqimIndikatori holat={holat} matnBilan />
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-faint">{sessionId}</p>
              </div>

              <button
                onClick={() => void toxtat(sessionId)}
                disabled={toxtatilayotgan[sessionId]}
                className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-muted transition enabled:hover:border-coral enabled:hover:text-coral disabled:opacity-40"
              >
                {toxtatilayotgan[sessionId] ? 'Stopping…' : 'Stop'}
              </button>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
