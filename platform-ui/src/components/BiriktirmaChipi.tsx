// Chatga biriktirilgan fayl yoki rasm — kichik chip.
//
// Uch holatda ko'rinadi:
//   yuklanmoqda — miltillovchi nuqta, o'chirish tugmasi yo'q (hali id yo'q);
//   yuklandi    — rasm bo'lsa kichik ko'rinish, fayl bo'lsa belgi + hajm;
//   xato        — coral matn, foydalanuvchi olib tashlab qayta urinsin.
//
// Yuborilgandan KEYIN ham shu chip ishlatiladi (suhbat tarixida), lekin
// o'chirish tugmasisiz: yuborilgan fayl suhbatning qismi va agent uni
// allaqachon ko'rgan — tarixni orqaga o'zgartirish yolg'on kontekst yaratardi.

import type { ChatBiriktirma } from '@platforma/shared'
import { biriktirmaManzili } from '../lib/api'

interface Props {
  /** Yuklanib bo'lgan yozuv. `undefined` — hali yuklanmoqda yoki xato. */
  biriktirma?: ChatBiriktirma
  /** Ko'rsatiladigan nom — yuklanmayotganda ham kerak */
  nom: string
  /** Yuklash xatosi */
  xato?: string
  /** Berilmasa o'chirish tugmasi ko'rinmaydi (tarixdagi chip) */
  onOchir?: () => void
}

/** Hajmni odam o'qiydigan shaklga o'tkazadi */
function hajmMatni(bayt: number): string {
  if (bayt < 1024) return `${bayt} B`
  if (bayt < 1024 * 1024) return `${Math.round(bayt / 1024)} KB`
  return `${(bayt / 1024 / 1024).toFixed(1)} MB`
}

export default function BiriktirmaChipi({ biriktirma, nom, xato, onOchir }: Props) {
  const rasmmi = biriktirma?.tur === 'rasm'
  const yuklanmoqda = !biriktirma && !xato

  return (
    <div
      className={`flex max-w-[240px] items-center gap-2 rounded-lg border bg-panel px-2 py-1.5 ${
        xato ? 'border-coral/50' : 'border-line'
      }`}
      title={xato ? `${nom} — ${xato}` : nom}
    >
      {rasmmi ? (
        <img
          src={biriktirmaManzili(biriktirma.id)}
          alt={biriktirma.aslNom}
          loading="lazy"
          className="size-8 shrink-0 rounded object-cover"
        />
      ) : (
        <span className="shrink-0 text-sm" aria-hidden>
          {xato ? '⚠' : yuklanmoqda ? '' : '📄'}
        </span>
      )}

      {yuklanmoqda && (
        <span className="pulse-dot inline-block size-1.5 shrink-0 rounded-full bg-gold" aria-hidden />
      )}

      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-ink">{nom}</div>
        <div className={`text-[10px] ${xato ? 'text-coral' : 'text-faint'}`}>
          {xato ?? (biriktirma ? hajmMatni(biriktirma.hajm) : 'uploading…')}
        </div>
      </div>

      {onOchir && (
        <button
          type="button"
          onClick={onOchir}
          aria-label={`${nom} — remove attachment`}
          className="shrink-0 text-faint transition hover:text-coral"
        >
          ×
        </button>
      )}
    </div>
  )
}
