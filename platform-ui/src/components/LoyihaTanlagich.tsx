// Loyiha tanlagich — chat pastida, model tanlagich yonida.
//
// Loyiha = nomlangan ish papkasi. Suhbat loyihaga ulansa agent tool'lari
// o'sha papkada ishlaydi va bir loyihaning hamma suhbatlari bitta fayllar
// to'plamini ko'radi. Tanlanmasa suhbat o'z vaqtinchalik papkasida qoladi.
//
// Tanlov FAQAT suhbat boshlanishidan oldin: sessiya yaratilgach ish papkasi
// qulflanadi (agent allaqachon o'sha papkada fayl yaratgan bo'lishi mumkin,
// o'rtada ko'chirish kontekstni buzardi). Qulflangan holatda tanlagich
// faqat tanlangan loyiha nomini ko'rsatadi.
//
// Ro'yxatni tepadagi Chat sahifasi yuklaydi va shu yerga uzatadi — bitta
// so'rov ikki komponentga yetadi.

import { useState } from 'react'
import type { Project } from '@platforma/shared'

interface Props {
  loyihalar: Project[]
  tanlangan: Project | null
  onTanla: (loyiha: Project | null) => void
  /** Yangi loyiha yaratadi va yaratilganini qaytaradi */
  onYarat: (nom: string) => Promise<Project>
  /** Sessiya boshlangan — endi loyiha o'zgarmaydi */
  qulflangan?: boolean
}

/**
 * Hover'da chiqadigan to'liq papka yo'li.
 *
 * Brauzerning `title` atributi o'rniga: u ~1 soniya kechikadi, uslubi
 * tizimniki va uzun yo'lni o'zicha kesadi. Yo'l esa aynan to'liq ko'rinishi
 * kerak — agent qaysi papkada fayl yaratayotganini bilish muhim.
 *
 * `pointer-events-none`: popup sichqonchani ushlab qolmasin, aks holda
 * ostidagi tugmani bosib bo'lmaydi.
 */
function PapkaPopup({ loyiha }: { loyiha: Project | null }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute bottom-full right-0 z-50 mb-1.5 hidden w-max max-w-[min(28rem,calc(100vw-3rem))] rounded-lg border border-line bg-panel px-2.5 py-1.5 shadow-xl group-hover:block"
    >
      {loyiha ? (
        <>
          <span className="block font-mono text-[10px] tracking-widest text-faint uppercase">
            Ish papkasi
          </span>
          {/* break-all: uzun yo'l kesilmasin, o'ralsin */}
          <span className="mt-0.5 block font-mono text-[11px] break-all text-lazur">
            {loyiha.papka}
          </span>
        </>
      ) : (
        <span className="block text-[11px] text-muted">
          Loyihaga ulanmagan — suhbat o'z vaqtinchalik papkasida ishlaydi
        </span>
      )}
    </span>
  )
}

export default function LoyihaTanlagich({
  loyihalar,
  tanlangan,
  onTanla,
  onYarat,
  qulflangan,
}: Props) {
  const [ochiq, setOchiq] = useState(false)
  const [yangiNom, setYangiNom] = useState('')
  const [yaratilmoqda, setYaratilmoqda] = useState(false)
  const [xato, setXato] = useState<string | null>(null)

  const yorliq = tanlangan ? `▣ ${tanlangan.name}` : '▢ loyihasiz'

  async function yarat() {
    const nom = yangiNom.trim()
    if (!nom || yaratilmoqda) return
    setYaratilmoqda(true)
    setXato(null)
    try {
      const loyiha = await onYarat(nom)
      onTanla(loyiha)
      setYangiNom('')
      setOchiq(false)
    } catch (e) {
      setXato(e instanceof Error ? e.message : "Loyiha yaratilmadi")
    } finally {
      setYaratilmoqda(false)
    }
  }

  // Qulflangan holatda ro'yxat ochilmaydi — faqat holat ko'rinadi.
  // To'liq papka yo'li hover popup'ida: yorliqda faqat nom turadi, lekin
  // agent qaysi papkada ishlayotganini bilish baribir kerak bo'ladi.
  if (qulflangan) {
    return (
      <span className="group relative shrink-0">
        <span className="block rounded-lg border border-transparent px-2.5 py-1 font-mono text-[11px] text-faint">
          {yorliq}
        </span>
        <PapkaPopup loyiha={tanlangan} />
      </span>
    )
  }

  return (
    <div className="group relative shrink-0">
      {/* Popup faqat ro'yxat yopiqligida — aks holda ikkisi ustma-ust tushadi */}
      {!ochiq && <PapkaPopup loyiha={tanlangan} />}
      <button
        type="button"
        onClick={() => setOchiq((o) => !o)}
        aria-expanded={ochiq}
        aria-label={`Loyiha: ${tanlangan?.name ?? 'tanlanmagan'}`}
        className={`rounded-lg border px-2.5 py-1 font-mono text-[11px] transition ${
          tanlangan
            ? 'border-lazur-dim text-lazur hover:brightness-110'
            : ochiq
              ? 'border-lazur-dim bg-panel2 text-muted'
              : 'border-transparent text-faint hover:bg-panel2/60 hover:text-muted'
        }`}
      >
        {yorliq}
      </button>

      {ochiq && (
        <div className="absolute bottom-full left-0 z-40 mb-2 w-72 rounded-xl border border-line bg-panel p-2 shadow-xl">
          <div className="px-2 pb-1.5 text-[10px] font-semibold tracking-widest text-faint uppercase">
            Loyiha
          </div>

          <button
            type="button"
            onClick={() => {
              onTanla(null)
              setOchiq(false)
            }}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition hover:bg-panel2/60 ${
              tanlangan ? 'text-muted' : 'text-lazur'
            }`}
          >
            ▢ loyihasiz
          </button>

          <div className="thin-scroll max-h-48 overflow-y-auto">
            {loyihalar.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => {
                  onTanla(l)
                  setOchiq(false)
                }}
                title={l.papka}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition hover:bg-panel2/60 ${
                  tanlangan?.id === l.id ? 'text-lazur' : 'text-muted'
                }`}
              >
                <span className="truncate">▣ {l.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-faint">
                  {l.chatlarSoni ?? 0} chat
                </span>
              </button>
            ))}
          </div>

          <div className="mt-1.5 border-t border-line pt-1.5">
            <div className="flex items-center gap-1.5">
              <input
                value={yangiNom}
                onChange={(e) => setYangiNom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void yarat()
                  }
                }}
                placeholder="yangi loyiha nomi…"
                aria-label="Yangi loyiha nomi"
                // `fokus-tashqarida`: fokusni maydonning o'z chegarasi
                // ko'rsatadi — global halqa ustiga tushsa ikki qavat bo'lardi
                className="fokus-tashqarida min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 py-1 text-[13px] outline-none placeholder:text-faint focus:border-lazur-dim"
              />
              <button
                type="button"
                onClick={() => void yarat()}
                disabled={!yangiNom.trim() || yaratilmoqda}
                className="shrink-0 rounded-lg bg-lazur-dim px-2.5 py-1 text-[12px] font-semibold text-bg transition enabled:hover:brightness-110 disabled:opacity-40"
              >
                {yaratilmoqda ? '…' : 'Yarat'}
              </button>
            </div>
            {xato && <div className="mt-1.5 px-1 text-[11px] text-coral">{xato}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
