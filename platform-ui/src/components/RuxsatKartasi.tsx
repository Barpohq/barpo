// Ruxsat so'rovi — agent xavfli amalga urinsa chatda chiqadi.
//
// Uch tanlov: bir martalik ruxsat, doimiy ruxsat (sessiya davomida) va rad.
// Javob berilmasa server 5 daqiqada o'zi rad etadi — shuning uchun karta
// javobsiz qolishi ham xavfsiz.
//
// "Har doim" tugmasi naqshni ko'rsatadi (`rm`, `git push`, yoki fayl yo'li),
// foydalanuvchi aynan nimaga ruxsat berayotganini bilsin.

import { useState } from 'react'
import type { RuxsatJavobi, RuxsatSorovi } from '@platforma/shared'
import { Card } from '../ui'

interface Props {
  sorov: RuxsatSorovi
  onJavob: (javob: RuxsatJavobi) => void
}

const turBelgisi: Record<RuxsatSorovi['tur'], string> = {
  fayl: '📁',
  buyruq: '⌘',
  mcp: '🔌',
}

/**
 * Tugma yorlig'i uchun naqshni qisqartiradi. Fayl naqshlari to'liq yo'lni
 * o'z ichiga oladi (`read:/home/ms/.ssh/config`) — tugmaga sig'maydi.
 * To'liq matn `title` da qoladi.
 */
function naqshYorligi(naqsh: string): string {
  const yolMi = naqsh.includes('/')
  if (!yolMi) return naqsh
  const [amal, ...qolgan] = naqsh.split(':')
  const yol = qolgan.join(':') || naqsh
  const nom = yol.split('/').filter(Boolean).pop() ?? yol
  return qolgan.length > 0 ? `${amal}: …/${nom}` : `…/${nom}`
}

export default function RuxsatKartasi({ sorov, onJavob }: Props) {
  // Javob berilgach karta chatdan olib tashlanadi (Chat.tsx). Bu flag esa
  // olib tashlanish oralig'ida ikkinchi bosishning oldini oladi.
  const [yuborilmoqda, setYuborilmoqda] = useState(false)

  function javobBer(javob: RuxsatJavobi) {
    if (yuborilmoqda) return
    setYuborilmoqda(true)
    onJavob(javob)
  }

  return (
    <Card className="mt-3 overflow-hidden border-gold/40">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-xs">
        <span className="pulse-dot inline-block size-1.5 rounded-full bg-gold" aria-hidden />
        <span className="text-gold">ruxsat so'ralmoqda</span>
        <span className="text-faint">· {sorov.amal}</span>
      </div>

      <div className="px-4 py-3">
        <div className="flex items-start gap-2">
          <span className="shrink-0" aria-hidden>
            {turBelgisi[sorov.tur]}
          </span>
          <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-ink">
            {sorov.nishon}
          </code>
        </div>
        <p className="mt-2 text-sm text-muted">{sorov.sabab}</p>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
        <button
          onClick={() => javobBer('ruxsat')}
          disabled={yuborilmoqda}
          className="rounded-lg bg-lazur-dim px-3.5 py-1.5 text-sm font-semibold text-bg transition enabled:hover:brightness-110 disabled:opacity-40"
        >
          Ruxsat berish
        </button>
        {sorov.naqsh && (
          <button
            onClick={() => javobBer('hardoim')}
            disabled={yuborilmoqda}
            className="max-w-[16rem] truncate rounded-lg border border-line px-3.5 py-1.5 text-sm text-muted transition enabled:hover:border-lazur-dim enabled:hover:text-ink disabled:opacity-40"
            title={`«${sorov.naqsh}» uchun bu suhbatda boshqa so'ralmaydi`}
          >
            Har doim ({naqshYorligi(sorov.naqsh)})
          </button>
        )}
        <button
          onClick={() => javobBer('rad')}
          disabled={yuborilmoqda}
          className="rounded-lg border border-line px-3.5 py-1.5 text-sm text-muted transition enabled:hover:border-coral enabled:hover:text-coral disabled:opacity-40"
        >
          Rad etish
        </button>
      </div>
    </Card>
  )
}
