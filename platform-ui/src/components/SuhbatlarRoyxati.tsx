// Sidebar'dagi "Chat" bo'limi — ochiladigan ro'yxat (accordion).
//
// Ichida oxirgi N suhbat turadi, HOLATIDAN QAT'I NAZAR: fonda ishlayotgani
// ham, allaqachon tugagani ham. Ishlayotganlari yonida jonli indikator
// bo'ladi — shu bilan eski "Jonli oqimlar" bo'limi ortiqcha bo'lib qoldi.
//
// Ro'yxat App'dan tayyor holda keladi (`useSuhbatlar` u yerda bir marta
// chaqiriladi) — sidebar va Suhbatlar sahifasi bitta manbani ko'rsin.

import type { ChatSession } from '@platforma/shared'
import type { IshlayotganlarXaritasi } from '../lib/ishlayotganlar'
import OqimIndikatori from './OqimIndikatori'

/** Sidebar'da nechta suhbat ko'rinadi — qolgani "Barchasi" sahifasida */
export const SIDEBAR_SUHBATLAR = 5

interface Props {
  suhbatlar: ChatSession[]
  ishlayotganlar: IshlayotganlarXaritasi
  /** Hozir ochiq suhbat — ro'yxatda ajratib ko'rsatiladi */
  ochiqSessiya: string | null
  /** Ro'yxat ochiqmi (accordion holati) */
  ochiq: boolean
  onToggle: () => void
  /** "Chat" so'zining o'zi bosildi — chat sahifasiga o'tamiz */
  onChatSahifasi: () => void
  onSuhbatOch: (sessionId: string) => void
  onBarchasi: () => void
  /** Chat sahifasi hozir ochiqmi — sarlavha shunga qarab ajratiladi */
  faol: boolean
  yuklanmoqda: boolean
  tabIndex: number
}

export default function SuhbatlarRoyxati({
  suhbatlar,
  ishlayotganlar,
  ochiqSessiya,
  ochiq,
  onToggle,
  onChatSahifasi,
  onSuhbatOch,
  onBarchasi,
  faol,
  yuklanmoqda,
  tabIndex,
}: Props) {
  const korinadigan = suhbatlar.slice(0, SIDEBAR_SUHBATLAR)
  // Ro'yxatdan tashqarida qolgan, lekin fonda ishlayotgan suhbatlar bormi —
  // bo'lsa "Barchasi" yonida ogohlantiruvchi nuqta chiqadi
  const korinmaydiganIshlayotgan = Object.keys(ishlayotganlar).filter(
    (id) => !korinadigan.some((s) => s.id === id),
  ).length

  return (
    <div>
      {/* Qator ikki qismli: "Chat" matni sahifaga o'tadi, o'ng chekkadagi
          strelka ro'yxatni ochadi. Bitta tugma qilib bo'lmaydi — foydalanuvchi
          ro'yxatni ochish uchun sahifani almashtirishga majbur bo'lardi. */}
      <div
        className={`flex w-full items-center rounded-lg transition ${
          faol ? 'bg-panel2 text-lazur' : 'text-muted hover:bg-panel2/60'
        }`}
      >
        <button
          onClick={onChatSahifasi}
          tabIndex={tabIndex}
          className={`flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 text-left text-[13px] transition ${
            faol ? 'font-semibold' : 'hover:text-ink'
          }`}
        >
          <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8l-4 3v-3H5a2 2 0 0 1-2-2V5Z" />
          </svg>
          Chat
        </button>

        <button
          onClick={onToggle}
          tabIndex={tabIndex}
          aria-expanded={ochiq}
          aria-label={ochiq ? "Suhbatlar ro'yxatini yopish" : "Suhbatlar ro'yxatini ochish"}
          className="grid shrink-0 place-items-center px-2.5 py-2 text-faint transition hover:text-ink"
        >
          {/* Yopiq holatda fonda ish ketayotgani bilinib tursin */}
          {!ochiq && Object.keys(ishlayotganlar).length > 0 && (
            <span
              className="pulse-dot mr-1 inline-block size-1.5 shrink-0 rounded-full"
              style={{ background: 'var(--color-mint)' }}
              aria-hidden
            />
          )}
          <svg
            viewBox="0 0 20 20"
            className={`size-3.5 transition-transform duration-200 ${ochiq ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m7 5 5 5-5 5" />
          </svg>
        </button>
      </div>

      {ochiq && (
        <div className="mt-0.5 space-y-0.5 pl-3">
          {yuklanmoqda && korinadigan.length === 0 && (
            <p className="px-3 py-1.5 font-mono text-[11px] text-faint">Yuklanmoqda…</p>
          )}

          {!yuklanmoqda && korinadigan.length === 0 && (
            <p className="px-3 py-1.5 text-[11px] leading-relaxed text-faint">
              Hali suhbat yo'q — pastdan yozib boshlang
            </p>
          )}

          {korinadigan.map((s) => {
            const holat = ishlayotganlar[s.id]
            const tanlangan = s.id === ochiqSessiya
            return (
              <button
                key={s.id}
                onClick={() => onSuhbatOch(s.id)}
                tabIndex={tabIndex}
                title={s.title}
                className={`flex w-full items-center gap-2 rounded-lg border-l-2 py-1.5 pr-2 pl-2.5 text-left text-[12px] transition ${
                  tanlangan
                    ? 'border-lazur-dim bg-panel2/70 text-ink'
                    : 'border-transparent text-muted hover:bg-panel2/50 hover:text-ink'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                {holat && <OqimIndikatori holat={holat} />}
              </button>
            )
          })}

          <button
            onClick={onBarchasi}
            tabIndex={tabIndex}
            className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 pl-2.5 text-left font-mono text-[11px] text-faint transition hover:text-lazur"
          >
            Barchasi
            {korinmaydiganIshlayotgan > 0 && (
              <span
                className="pulse-dot inline-block size-1.5 rounded-full"
                style={{ background: 'var(--color-mint)' }}
                title={`Ro'yxatdan tashqarida ${korinmaydiganIshlayotgan} ta agent ishlayapti`}
                aria-hidden
              />
            )}
            <span className="ml-auto" aria-hidden>
              →
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
