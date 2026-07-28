// Sessiya yonidagi jonli indikator — fonda agent ishlayotganini ko'rsatadi.
//
// Ikki holat ataylab turlicha ko'rinadi:
//   ishlayapti      — jimgina miltillovchi nuqta, e'tibor talab qilmaydi;
//   ruxsat-kutmoqda — SARIQ badge, chunki bu foydalanuvchi aralashuvisiz
//                     hech qachon o'tmaydi (agent to'xtab kutib turibdi).

interface Props {
  holat: 'ishlayapti' | 'ruxsat-kutmoqda'
  /** Badge yonida matn ham chiqsinmi (Agentlar sahifasi uchun) */
  matnBilan?: boolean
}

export default function OqimIndikatori({ holat, matnBilan = false }: Props) {
  if (holat === 'ruxsat-kutmoqda') {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px]"
        style={{
          background: 'color-mix(in oklab, var(--color-gold) 18%, transparent)',
          color: 'var(--color-gold)',
        }}
        title="Agent ruxsat kutmoqda"
      >
        <span className="pulse-dot inline-block size-1.5 rounded-full bg-gold" aria-hidden />
        {matnBilan ? 'ruxsat kutmoqda' : 'ruxsat'}
      </span>
    )
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-muted"
      title="Agent ishlamoqda"
    >
      <span
        className="pulse-dot inline-block size-1.5 rounded-full"
        style={{ background: 'var(--color-mint)' }}
        aria-hidden
      />
      {matnBilan && 'ishlayapti'}
    </span>
  )
}
