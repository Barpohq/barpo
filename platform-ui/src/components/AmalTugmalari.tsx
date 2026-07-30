// Ilova amallari — foydalanuvchi bosadigan tugmalar (restart, stop, ...).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ TASDIQ — TASODIFIY BOSISHGA QARSHI, HUJUMGA QARSHI EMAS.             │
// │                                                                      │
// │ `tasdiq: true` bo'lgan amal modal ko'rsatadi, lekin server bu         │
// │ bayroqni TEKSHIRMAYDI (`routes/apps.ts`) — API'ni to'g'ridan          │
// │ chaqirgan kod uni o'tkazib yuboradi. Bu ONGLI chegara: haqiqiy        │
// │ himoya kod bajarilish darajasida bo'lishi kerak, UI'da emas.          │
// └──────────────────────────────────────────────────────────────────────┘
//
// QULF IKKI JOYDA. UI tugmani o'chiradi, server esa `amalBandmi` bilan
// ikkinchi chaqiruvni mavjud natijaga bog'laydi. Ikkalasi kerak: UI qulfi
// foydalanuvchiga darhol javob beradi, server qulfi esa ikki brauzer oynasi
// holatini yopadi.

import { useState } from 'react'
import type { AppAmali } from '@platforma/shared'
import { ApiXatosi, ilovaAmaliniBajar, type AmalJavobi } from '../lib/api'
import { useToast } from '../lib/toast'
import { Card, LevelBadge } from '../ui'

function TasdiqModali({
  amal,
  bandmi,
  bekor,
  tasdiq,
}: {
  amal: AppAmali
  bandmi: boolean
  bekor: () => void
  tasdiq: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4"
      onClick={bekor}
      role="presentation"
    >
      <div
        className="w-full max-w-sm rounded-xl border border-line bg-panel p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h3 className="font-display text-sm font-semibold">{amal.yorliq}</h3>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {amal.izoh || 'Do you want to run this action?'}
        </p>

        {amal.xavf === 'xavfli' && (
          <p className="mt-3 rounded-lg border border-dashed border-gold/50 px-3 py-2 text-[11px] leading-relaxed text-gold">
            This action is marked dangerous — its result may not be reversible.
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={bekor}
            className="rounded-lg px-3 py-1.5 text-xs text-muted transition-colors hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={tasdiq}
            disabled={bandmi}
            className={`rounded-lg px-4 py-1.5 text-xs font-medium text-bg transition-opacity disabled:opacity-40 ${
              amal.xavf === 'xavfli' ? 'bg-gold' : 'bg-lazur'
            }`}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AmalTugmalari({
  appId,
  amallar,
  onBajarildi,
}: {
  appId: string
  amallar: AppAmali[]
  /**
   * Amaldan keyin — chaqiruvchi yangi state qiymatlarini qo'llaydi.
   *
   * Server `yangila` da ko'rsatilgan statelarni MAJBURIY qayta hisoblab
   * javobda qaytaradi, ya'ni bu yerda qayta so'rov kerak emas.
   */
  onBajarildi?: (javob: AmalJavobi) => void
}) {
  const toast = useToast()
  /** Bajarilib turgan amal nomlari */
  const [ketmoqda, setKetmoqda] = useState<Set<string>>(new Set())
  const [tasdiqKutayotgan, setTasdiqKutayotgan] = useState<AppAmali | null>(null)

  async function bajar(amal: AppAmali) {
    if (ketmoqda.has(amal.nom)) return

    setKetmoqda((o) => new Set(o).add(amal.nom))
    try {
      const javob = await ilovaAmaliniBajar(appId, amal.nom)

      if (javob.ok) {
        toast(javob.xabar || `${amal.yorliq} — done`, 'success')
      } else {
        // Amal ichidagi xato — bu server xatosi emas, ilova xatosi.
        toast(javob.xato || 'The action did not run', 'error')
      }

      onBajarildi?.(javob)
    } catch (x) {
      toast(x instanceof ApiXatosi ? x.message : 'Could not run the action', 'error')
    } finally {
      setKetmoqda((o) => {
        const yangi = new Set(o)
        yangi.delete(amal.nom)
        return yangi
      })
    }
  }

  function bosildi(amal: AppAmali) {
    if (amal.tasdiq) setTasdiqKutayotgan(amal)
    else void bajar(amal)
  }

  return (
    <>
      <Card className="overflow-hidden">
        <h2 className="border-b border-line px-5 py-3 font-display text-sm font-semibold">
          Controls
        </h2>

        <div className="flex flex-wrap gap-2 px-5 py-4">
          {amallar.map((amal) => {
            const bandmi = ketmoqda.has(amal.nom)

            return (
              <button
                key={amal.nom}
                type="button"
                onClick={() => bosildi(amal)}
                disabled={bandmi}
                title={amal.izoh}
                className={`group flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors disabled:opacity-50 ${
                  amal.xavf === 'xavfli'
                    ? 'border-gold/40 hover:border-gold hover:bg-gold/10'
                    : 'border-line hover:border-lazur/60 hover:bg-panel2'
                }`}
              >
                {bandmi && (
                  <span className="size-3 animate-spin rounded-full border border-lazur border-t-transparent" />
                )}
                <span>{amal.yorliq}</span>
                {amal.xavf === 'xavfli' && <LevelBadge level="xavfli" />}
              </button>
            )
          })}
        </div>
      </Card>

      {tasdiqKutayotgan && (
        <TasdiqModali
          amal={tasdiqKutayotgan}
          bandmi={ketmoqda.has(tasdiqKutayotgan.nom)}
          bekor={() => setTasdiqKutayotgan(null)}
          tasdiq={() => {
            const amal = tasdiqKutayotgan
            setTasdiqKutayotgan(null)
            void bajar(amal)
          }}
        />
      )}
    </>
  )
}
