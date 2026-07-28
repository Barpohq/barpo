// Auto rejim o'z-o'zidan o'chganda chatda chiqadigan karta.
//
// Uch sabab bo'lishi mumkin: klassifikator ishlamadi, ketma-ket 3 marta
// bloklandi, sessiyada jami 20 marta bloklandi. Har uchalasida ham agent
// ishlashda davom etadi — faqat endi har xavfli amal so'raladi.
//
// Avtomatik tiklanish yo'q: foydalanuvchi "Qayta yoqish" bosishi kerak.
// Sabab — rejimning o'z-o'zidan o'zgarishi chalkash bo'ladi.

import { useState } from 'react'
import { Card } from '../ui'

interface Props {
  sabab: string
  onQaytaYoq: () => void
}

export default function RejimKartasi({ sabab, onQaytaYoq }: Props) {
  const [bosildi, setBosildi] = useState(false)

  return (
    <Card className="mt-3 overflow-hidden border-gold/40">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-gold">
            <span aria-hidden>⚠︎</span>
            <span>Auto rejim o'chdi</span>
          </div>
          <p className="mt-1 text-sm text-muted">{sabab}</p>
          <p className="mt-1 text-xs text-faint">
            Agent ishlashda davom etadi — endi har xavfli amal so'raladi.
          </p>
        </div>
        <button
          onClick={() => {
            setBosildi(true)
            onQaytaYoq()
          }}
          disabled={bosildi}
          className="shrink-0 rounded-lg border border-line px-3.5 py-1.5 text-sm text-muted transition enabled:hover:border-lazur-dim enabled:hover:text-ink disabled:opacity-40"
        >
          {bosildi ? 'Yoqilmoqda…' : 'Qayta yoqish'}
        </button>
      </div>
    </Card>
  )
}
