// Skilllar sahifasi — manba ulash, katalog, o'rnatish.
//
// Uch qatlam foydalanuvchi uchun ham ko'rinadi:
//   MANBA   — ulangan GitHub repo (yuqorida)
//   KATALOG — repo'lardan topilgan skilllar (pastda)
//   QAMROV  — har skill qayerda ishlaydi (global / tanlangan loyihalar)
//
// O'rnatish modalida qamrov tanlanadi. O'rnatilgan skillda ham o'sha modal
// ochiladi — qamrovni keyin o'zgartirish uchun alohida oqim kerak emas.

import { useEffect, useState } from 'react'
import type { Project, Skill, SkillManba } from '@platforma/shared'
import {
  ApiXatosi,
  loyihalarOl,
  manbaOchir,
  manbaQosh,
  manbaSinxronla,
  skillOrnat,
  skillOrnatishniBekor,
  skilllarniOl,
} from '../lib/api'
import { Card, PageHead } from '../ui'

// ---------------------------------------------------------------------------
// Qamrov modali
// ---------------------------------------------------------------------------

function QamrovModal({
  skill,
  loyihalar,
  onClose,
  onSaqla,
}: {
  skill: Skill
  loyihalar: Project[]
  onClose: () => void
  onSaqla: (global: boolean, projectIds: string[]) => Promise<void>
}) {
  const [global, setGlobal] = useState(skill.ornatilgan.some((o) => o.qamrov === 'global'))
  const [tanlangan, setTanlangan] = useState<Set<string>>(
    new Set(
      skill.ornatilgan.filter((o) => o.qamrov === 'loyiha' && o.projectId).map((o) => o.projectId!),
    ),
  )
  const [ishlayapti, setIshlayapti] = useState(false)
  const [xato, setXato] = useState<string | null>(null)

  const hechnima = !global && tanlangan.size === 0

  const saqla = async () => {
    setIshlayapti(true)
    setXato(null)
    try {
      await onSaqla(global, [...tanlangan])
      onClose()
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : "Saqlab bo'lmadi")
      setIshlayapti(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${skill.nom} qamrovi`}
    >
      <Card className="rise-in w-full max-w-md p-6">
        <div onClick={(e) => e.stopPropagation()}>
          <h2 className="font-display text-lg font-semibold">{skill.nom}</h2>
          <p className="mt-1.5 text-sm text-muted">{skill.tavsif}</p>

          {skill.allowedTools && skill.allowedTools.length > 0 && (
            <div className="mt-4 rounded-lg border border-line bg-bg p-3">
              <div className="text-xs font-medium uppercase tracking-wider text-faint">
                Skill so'ragan tool'lar
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {skill.allowedTools.map((t) => (
                  <span key={t} className="rounded-md bg-panel2 px-2 py-0.5 font-mono text-[11px] text-muted">
                    {t}
                  </span>
                ))}
              </div>
              {/* Ochiq aytamiz: bu ro'yxat hozircha MAJBURLANMAYDI. Foydalanuvchi
                  uni haqiqiy cheklov deb o'ylab qolmasin. */}
              <p className="mt-2 text-[11px] leading-relaxed text-faint">
                Bu ro'yxat ma'lumot uchun. Amaldagi cheklov — platformaning
                ruxsat tizimi: xavfli amallar baribir tasdiq so'raydi.
              </p>
            </div>
          )}

          <div className="mt-4 rounded-lg border border-line bg-bg p-4">
            <div className="text-xs font-medium uppercase tracking-wider text-faint">
              Qayerda ishlasin
            </div>

            <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={global}
                onChange={(e) => setGlobal(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="text-ink">Hamma joyda (global)</span>
                <span className="block text-xs text-faint">
                  Barcha suhbatlar va loyihalarda mavjud bo'ladi
                </span>
              </span>
            </label>

            {loyihalar.length > 0 && (
              <>
                <div className="mt-4 text-xs font-medium uppercase tracking-wider text-faint">
                  Yoki tanlangan loyihalarda
                </div>
                <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
                  {loyihalar.map((l) => (
                    <label key={l.id} className="flex cursor-pointer items-center gap-2.5 text-sm">
                      <input
                        type="checkbox"
                        checked={tanlangan.has(l.id)}
                        onChange={(e) => {
                          const yangi = new Set(tanlangan)
                          if (e.target.checked) yangi.add(l.id)
                          else yangi.delete(l.id)
                          setTanlangan(yangi)
                        }}
                      />
                      <span className="text-muted">{l.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          <p className="mt-3 text-xs leading-relaxed text-faint">
            Skill fayllari sessiya boshlanganda ish papkasiga ko'chiriladi.
            Agent ularni faqat o'qiydi — skill matni platformaning xavfsizlik
            qoidalarini bekor qila olmaydi.
          </p>

          {xato && <p className="mt-3 text-sm text-coral">{xato}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
            >
              Bekor qilish
            </button>
            <button
              onClick={saqla}
              disabled={ishlayapti}
              className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
            >
              {ishlayapti ? 'Saqlanmoqda…' : hechnima ? "O'chirish" : 'Saqlash'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Manbalar bo'limi
// ---------------------------------------------------------------------------

function Manbalar({
  manbalar,
  onYangilandi,
}: {
  manbalar: SkillManba[]
  onYangilandi: () => void
}) {
  const [url, setUrl] = useState('')
  const [ishlayapti, setIshlayapti] = useState(false)
  const [xato, setXato] = useState<string | null>(null)
  const [xabar, setXabar] = useState<string | null>(null)
  const [bandId, setBandId] = useState<string | null>(null)

  const qosh = async () => {
    if (!url.trim() || ishlayapti) return
    setIshlayapti(true)
    setXato(null)
    setXabar(null)
    try {
      const natija = await manbaQosh(url.trim())
      setUrl('')
      setXabar(
        `${natija.manba.owner}/${natija.manba.repo}: ${natija.qoshildi} skill topildi` +
          (natija.ogohlantirishlar.length > 0 ? ` · ${natija.ogohlantirishlar.length} ogohlantirish` : ''),
      )
      onYangilandi()
    } catch (x) {
      setXato(x instanceof ApiXatosi ? [x.message, x.detail].filter(Boolean).join(' — ') : "Ulab bo'lmadi")
    } finally {
      setIshlayapti(false)
    }
  }

  const sinxronla = async (id: string) => {
    setBandId(id)
    setXato(null)
    setXabar(null)
    try {
      const n = await manbaSinxronla(id)
      setXabar(`Sinxronlandi: +${n.qoshildi} yangi, ${n.yangilandi} yangilandi, -${n.ochirildi}`)
      onYangilandi()
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : "Sinxronlab bo'lmadi")
    } finally {
      setBandId(null)
    }
  }

  const ochir = async (m: SkillManba) => {
    if (!confirm(`${m.owner}/${m.repo} manbasi va uning barcha skilllari o'chirilsinmi?`)) return
    setBandId(m.id)
    try {
      await manbaOchir(m.id)
      onYangilandi()
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : "O'chirib bo'lmadi")
    } finally {
      setBandId(null)
    }
  }

  return (
    <Card className="mb-6 p-5">
      <h2 className="font-display text-[15px] font-semibold">Manbalar</h2>
      <p className="mt-1 text-sm text-muted">
        GitHub repo ulang — ichidagi barcha <code className="font-mono text-xs">SKILL.md</code> fayllari
        katalogga tushadi. Registr yo'q, istalgan repo ishlaydi.
      </p>

      <div className="mt-4 flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && qosh()}
          placeholder="anthropics/skills yoki https://github.com/..."
          className="flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
        />
        <button
          onClick={qosh}
          disabled={ishlayapti || !url.trim()}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {ishlayapti ? 'Skanerlanmoqda…' : 'Ulash'}
        </button>
      </div>

      {xato && <p className="mt-3 text-sm text-coral">{xato}</p>}
      {xabar && <p className="mt-3 text-sm text-mint">{xabar}</p>}

      {manbalar.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-line pt-4">
          {manbalar.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3 text-sm">
              <div className="min-w-0">
                <span className="font-mono text-[13px] text-ink">
                  {m.owner}/{m.repo}
                </span>
                <span className="ml-2 text-xs text-faint">
                  {m.ref}
                  {m.oxirgiSinxron && ` · ${new Date(m.oxirgiSinxron).toLocaleDateString('uz-UZ')}`}
                </span>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => sinxronla(m.id)}
                  disabled={bandId === m.id}
                  className="rounded-md border border-line px-2.5 py-1 text-xs text-muted transition hover:text-ink disabled:opacity-50"
                >
                  {bandId === m.id ? '…' : 'Sinxron'}
                </button>
                <button
                  onClick={() => ochir(m)}
                  disabled={bandId === m.id}
                  className="rounded-md border border-line px-2.5 py-1 text-xs text-muted transition hover:text-coral disabled:opacity-50"
                >
                  O'chirish
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Sahifa
// ---------------------------------------------------------------------------

export default function Skills() {
  const [skilllar, setSkilllar] = useState<Skill[]>([])
  const [manbalar, setManbalar] = useState<SkillManba[]>([])
  const [loyihalar, setLoyihalar] = useState<Project[]>([])
  const [yuklanmoqda, setYuklanmoqda] = useState(true)
  const [xato, setXato] = useState<string | null>(null)
  const [modal, setModal] = useState<Skill | null>(null)

  const yukla = async () => {
    try {
      const [katalog, loyiha] = await Promise.all([skilllarniOl(), loyihalarOl()])
      setSkilllar(katalog.skills)
      setManbalar(katalog.manbalar)
      setLoyihalar(loyiha)
      setXato(null)
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : "Ma'lumotni olib bo'lmadi")
    } finally {
      setYuklanmoqda(false)
    }
  }

  useEffect(() => {
    void yukla()
  }, [])

  /**
   * Qamrovni saqlaydi: yangi holat bilan eskisi solishtirilib, faqat
   * FARQ yuboriladi. To'liq qayta yozish ham ishlardi, lekin u har
   * saqlashda faylni qayta yuklab olishga majbur qilardi.
   */
  const qamrovniSaqla = async (skill: Skill, global: boolean, projectIds: string[]) => {
    const eskiGlobal = skill.ornatilgan.some((o) => o.qamrov === 'global')
    const eskiLoyihalar = new Set(
      skill.ornatilgan.filter((o) => o.qamrov === 'loyiha' && o.projectId).map((o) => o.projectId!),
    )
    const yangiLoyihalar = new Set(projectIds)

    const qoshiladigan = projectIds.filter((id) => !eskiLoyihalar.has(id))
    const ochiriladigan = [...eskiLoyihalar].filter((id) => !yangiLoyihalar.has(id))

    if (global && !eskiGlobal) await skillOrnat(skill.id, 'global')
    if (qoshiladigan.length > 0) await skillOrnat(skill.id, 'loyiha', qoshiladigan)
    if (!global && eskiGlobal) await skillOrnatishniBekor(skill.id, 'global')
    if (ochiriladigan.length > 0) await skillOrnatishniBekor(skill.id, 'loyiha', ochiriladigan)

    await yukla()
  }

  const qamrovMatni = (skill: Skill): string => {
    const global = skill.ornatilgan.some((o) => o.qamrov === 'global')
    const loyihaSoni = skill.ornatilgan.filter((o) => o.qamrov === 'loyiha').length
    if (global && loyihaSoni > 0) return `Global + ${loyihaSoni} loyiha`
    if (global) return 'Global'
    if (loyihaSoni > 0) return `${loyihaSoni} loyiha`
    return ''
  }

  const manbaNomi = (manbaId: string): string => {
    const m = manbalar.find((x) => x.id === manbaId)
    return m ? `${m.owner}/${m.repo}` : ''
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="Skilllar"
        sub="SKILL.md paketlari: GitHub'dan ulanadi, global yoki tanlangan loyihalarda ishlaydi"
      />

      <Manbalar manbalar={manbalar} onYangilandi={yukla} />

      {xato && (
        <Card className="mb-6 border-coral/40 p-4">
          <p className="text-sm text-coral">{xato}</p>
        </Card>
      )}

      {yuklanmoqda ? (
        <p className="text-sm text-muted">Yuklanmoqda…</p>
      ) : skilllar.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">
            Hali skill yo'q. Yuqorida GitHub repo ulang — masalan{' '}
            <code className="font-mono text-xs text-ink">anthropics/skills</code>.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {skilllar.map((s) => {
            const qamrov = qamrovMatni(s)
            return (
              <Card key={s.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-display text-[15px] font-semibold">{s.nom}</h2>
                  {s.ogohlantirishlar.length > 0 && (
                    <span
                      className="shrink-0 rounded-md bg-panel2 px-2 py-0.5 text-[10px] text-gold"
                      title={s.ogohlantirishlar.join('\n')}
                    >
                      {s.ogohlantirishlar.length} ogoh.
                    </span>
                  )}
                </div>

                <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{s.tavsif}</p>

                <div className="mt-3 font-mono text-[11px] text-faint">{manbaNomi(s.manbaId)}</div>

                <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                  {qamrov ? (
                    <span className="text-sm text-mint">✓ {qamrov}</span>
                  ) : (
                    <span className="text-xs text-faint">o'rnatilmagan</span>
                  )}
                  <button
                    onClick={() => setModal(s)}
                    className={
                      qamrov
                        ? 'rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition hover:text-ink'
                        : 'rounded-lg border border-lazur-dim px-3 py-1.5 text-sm text-lazur transition hover:bg-lazur-dim hover:text-bg'
                    }
                  >
                    {qamrov ? "O'zgartirish" : "O'rnatish"}
                  </button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {modal && (
        <QamrovModal
          skill={modal}
          loyihalar={loyihalar}
          onClose={() => setModal(null)}
          onSaqla={(global, ids) => qamrovniSaqla(modal, global, ids)}
        />
      )}
    </div>
  )
}
