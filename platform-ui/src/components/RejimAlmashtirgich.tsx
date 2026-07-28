// Ruxsat rejimi almashtirgichi — chat pastida, model tanlagich yonida.
//
// Ikki holat:
//   ⏸ tasdiq — har xavfli amal so'raladi (standart)
//   ⏵⏵ auto  — klassifikator hal qiladi
//
// Auto o'z-o'zidan o'chgan bo'lsa tugma gold rangda va sabab tooltipda
// ko'rinadi — foydalanuvchi nima bo'lganini bilishi kerak.

import type { RejimHolati } from '@platforma/shared'

interface Props {
  holat: RejimHolati
  onOzgart: (rejim: 'tasdiq' | 'auto') => void
  /** Javob oqayotganda rejim almashtirilmaydi */
  bandmi?: boolean
}

export default function RejimAlmashtirgich({ holat, onOzgart, bandmi }: Props) {
  const auto = holat.rejim === 'auto'
  // Sabab bor, lekin rejim tasdiq — ya'ni auto o'z-o'zidan o'chgan
  const ozidanOchgan = !auto && Boolean(holat.sabab)

  const yorliq = auto ? '⏵⏵ auto' : '⏸ tasdiq'
  const tavsif = auto
    ? `Klassifikator hal qiladi${holat.klassifikatorModeli ? ` · ${holat.klassifikatorModeli}` : ''}`
    : holat.sabab
      ? `Auto o'chdi: ${holat.sabab}`
      : 'Har xavfli amal so\'raladi'

  return (
    <button
      type="button"
      onClick={() => onOzgart(auto ? 'tasdiq' : 'auto')}
      disabled={bandmi}
      title={tavsif}
      aria-label={`Ruxsat rejimi: ${auto ? 'auto' : 'tasdiq'}. ${tavsif}`}
      className={`shrink-0 rounded-lg border px-2.5 py-1 font-mono text-[11px] transition disabled:opacity-40 ${
        auto
          ? 'border-lazur-dim text-lazur hover:brightness-110'
          : ozidanOchgan
            ? 'border-gold/50 text-gold hover:border-gold'
            : 'border-transparent text-faint hover:bg-panel2/60 hover:text-muted'
      }`}
    >
      {yorliq}
    </button>
  )
}
