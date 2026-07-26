import { useState } from 'react'
import { skills, type Skill } from '../data/mock'
import { Card, LevelBadge, PageHead } from '../ui'

function PermissionModal({ skill, onClose, onInstall }: { skill: Skill; onClose: () => void; onInstall: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${skill.name} ruxsatlari`}
    >
      <Card className="rise-in w-full max-w-md p-6" >
        <div onClick={(e) => e.stopPropagation()}>
          <h2 className="font-display text-lg font-semibold">{skill.name} <span className="ml-1 font-mono text-xs text-faint">{skill.version}</span></h2>
          <p className="mt-1.5 text-sm text-muted">{skill.desc}</p>

          <div className="mt-4 rounded-lg border border-line bg-bg p-4">
            <div className="text-xs font-medium uppercase tracking-wider text-faint">
              Bu skill quyidagi ruxsatlarni so'raydi
            </div>
            <ul className="mt-3 space-y-2.5">
              {skill.permissions.map((p, i) => (
                <li key={i} className="flex items-start gap-2.5 text-sm">
                  <LevelBadge level={p.level} />
                  <span className="text-muted">{p.text}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-3 text-xs leading-relaxed text-faint">
            Skill sandbox ichida ishlaydi va so'ramagan ruxsatiga hech qachon ega bo'lmaydi.
            "Xavfli" amallar har doim sizning tasdig'ingiz bilan bajariladi.
          </p>

          <div className="mt-5 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink">
              Bekor qilish
            </button>
            <button onClick={onInstall} className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110">
              Ruxsat berish va o'rnatish
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}

export default function Skills() {
  const [installed, setInstalled] = useState<Record<string, boolean>>(
    Object.fromEntries(skills.map((s) => [s.id, s.installed])),
  )
  const [modal, setModal] = useState<Skill | null>(null)

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="Skill do'koni"
        sub="Deklarativ paketlar: manifest + prompt + kod. O'rnatishda ruxsatlar ro'yxati ko'rsatiladi — Android modeli"
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {skills.map((s) => (
          <Card key={s.id} className="flex flex-col p-5">
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-display text-[15px] font-semibold">{s.name}</h2>
              <span className="rounded-md bg-panel2 px-2 py-0.5 text-[10px] text-muted">{s.category}</span>
            </div>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{s.desc}</p>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {s.permissions.map((p, i) => (
                <LevelBadge key={i} level={p.level} />
              ))}
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
              <span className="font-mono text-[11px] text-faint">{s.version}</span>
              {installed[s.id] ? (
                <span className="text-sm text-mint">✓ O'rnatilgan</span>
              ) : (
                <button
                  onClick={() => setModal(s)}
                  className="rounded-lg border border-lazur-dim px-3 py-1.5 text-sm text-lazur transition hover:bg-lazur-dim hover:text-bg"
                >
                  O'rnatish
                </button>
              )}
            </div>
          </Card>
        ))}
      </div>

      {modal && (
        <PermissionModal
          skill={modal}
          onClose={() => setModal(null)}
          onInstall={() => {
            setInstalled((m) => ({ ...m, [modal.id]: true }))
            setModal(null)
          }}
        />
      )}
    </div>
  )
}
