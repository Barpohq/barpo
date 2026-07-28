// Agent bajargan tool chaqiruvi — chat ichidagi karta.
//
// Uch holat ko'rinishi bor: ishlamoqda (miltillovchi nuqta), tugadi (✓),
// xato yoki rad etildi (coral). Natija uzun bo'lsa yopiq turadi va bosilganda
// ochiladi — chat oqimi uzun bash chiqishlari bilan to'lib ketmasin.
//
// `edit` uchun diff alohida ko'rsatiladi: qo'shilgan qatorlar mint, o'chgani
// coral rangda.

import { useState } from 'react'
import type { ToolChaqiruv } from '@platforma/shared'

/** Yopiq holatda ko'rsatiladigan maksimal qator */
const QISQA_QATOR = 6

const nomBelgisi: Record<string, string> = {
  read: '📖',
  write: '✍️',
  edit: '✏️',
  bash: '⌘',
}

function holatUslubi(holat: ToolChaqiruv['holat']): { rang: string; belgi: string; matn: string } {
  switch (holat) {
    case 'ishlamoqda':
      return { rang: 'text-gold', belgi: '', matn: 'ishlamoqda…' }
    case 'tugadi':
      return { rang: 'text-mint', belgi: '✓', matn: '' }
    case 'rad etildi':
      return { rang: 'text-gold', belgi: '⊘', matn: 'ruxsat berilmadi' }
    case 'xato':
      return { rang: 'text-coral', belgi: '✕', matn: 'xato' }
  }
}

function DiffKorinishi({ diff }: { diff: string }) {
  const qatorlar = diff.split('\n')
  return (
    <pre className="thin-scroll overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
      {qatorlar.map((q, i) => {
        const rang = q.startsWith('+')
          ? 'text-mint'
          : q.startsWith('-')
            ? 'text-coral'
            : q.startsWith('@')
              ? 'text-lazur'
              : 'text-muted'
        return (
          <div key={i} className={rang}>
            {q || ' '}
          </div>
        )
      })}
    </pre>
  )
}

export default function ToolKartasi({ tool }: { tool: ToolChaqiruv }) {
  const [ochiq, setOchiq] = useState(false)
  const uslub = holatUslubi(tool.holat)

  const natija = tool.natija ?? ''
  const qatorlar = natija ? natija.split('\n') : []
  const uzunmi = qatorlar.length > QISQA_QATOR
  const korinadigan = ochiq || !uzunmi ? natija : qatorlar.slice(0, QISQA_QATOR).join('\n')

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-line bg-bg font-mono text-xs">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span aria-hidden>{nomBelgisi[tool.nom] ?? '•'}</span>
        <span className="text-lazur">{tool.nom}</span>
        <span className="min-w-0 flex-1 truncate text-faint" title={tool.args}>
          {tool.args}
        </span>
        <span className={`flex shrink-0 items-center gap-1.5 ${uslub.rang}`}>
          {tool.holat === 'ishlamoqda' && (
            <span className="pulse-dot inline-block size-1.5 rounded-full bg-gold" aria-hidden />
          )}
          {uslub.belgi && <span aria-hidden>{uslub.belgi}</span>}
          {uslub.matn && <span>{uslub.matn}</span>}
        </span>
      </div>

      {tool.tafsilot?.diff ? (
        <DiffKorinishi diff={tool.tafsilot.diff} />
      ) : (
        korinadigan && (
          <div className="px-3 py-2 text-muted">
            <pre className="thin-scroll overflow-x-auto whitespace-pre-wrap break-words">
              {korinadigan}
            </pre>
            {tool.tafsilot?.qisqartirilgan && (
              <div className="mt-1 text-faint">[chiqish qisqartirildi]</div>
            )}
          </div>
        )
      )}

      {uzunmi && !tool.tafsilot?.diff && (
        <button
          onClick={() => setOchiq((v) => !v)}
          className="w-full border-t border-line px-3 py-1.5 text-left text-faint transition hover:text-lazur"
        >
          {ochiq ? '▴ yopish' : `▾ yana ${qatorlar.length - QISQA_QATOR} qator`}
        </button>
      )}

      {tool.klassifikator && (
        <div
          className={`flex items-start gap-1.5 border-t border-line px-3 py-1.5 text-[11px] ${
            tool.klassifikator.qaror === 'ruxsat' ? 'text-faint' : 'text-gold'
          }`}
        >
          <span aria-hidden>{tool.klassifikator.qaror === 'ruxsat' ? '✓' : '⊘'}</span>
          <span className="min-w-0 flex-1">{tool.klassifikator.izoh}</span>
        </div>
      )}
    </div>
  )
}
