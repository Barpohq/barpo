// Skilllar sahifasi — manba ulash, katalog, o'rnatish.
//
// Uch qatlam foydalanuvchi uchun ham ko'rinadi:
//   MANBA   — ulangan GitHub repo (yuqorida)
//   KATALOG — repo'lardan topilgan skilllar (pastda)
//   QAMROV  — har skill qayerda ishlaydi (global / tanlangan loyihalar)
//
// O'rnatish modalida qamrov tanlanadi. O'rnatilgan skillda ham o'sha modal
// ochiladi — qamrovni keyin o'zgartirish uchun alohida oqim kerak emas.

import { useEffect, useMemo, useState } from 'react'
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
import { useToast } from '../lib/toast'
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
      setXato(x instanceof ApiXatosi ? x.message : 'Could not save')
      setIshlayapti(false)
    }
  }

  return (
    // z-60: tafsilot modali ustida ochilsin (u z-50 da)
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${skill.nom} scope`}
    >
      <Card className="rise-in w-full max-w-md p-6">
        <div onClick={(e) => e.stopPropagation()}>
          <h2 className="font-display text-lg font-semibold">{skill.nom}</h2>
          <p className="mt-1.5 text-sm text-muted">{skill.tavsif}</p>

          {skill.allowedTools && skill.allowedTools.length > 0 && (
            <div className="mt-4 rounded-lg border border-line bg-bg p-3">
              <div className="text-xs font-medium uppercase tracking-wider text-faint">
                Tools requested by the skill
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
                This list is informational. The actual limit is the platform's
                permission system: dangerous actions still ask for approval.
              </p>
            </div>
          )}

          <div className="mt-4 rounded-lg border border-line bg-bg p-4">
            <div className="text-xs font-medium uppercase tracking-wider text-faint">
              Where it should work
            </div>

            <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={global}
                onChange={(e) => setGlobal(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="text-ink">Everywhere (global)</span>
                <span className="block text-xs text-faint">
                  Available in all chats and projects
                </span>
              </span>
            </label>

            {loyihalar.length > 0 && (
              <>
                <div className="mt-4 text-xs font-medium uppercase tracking-wider text-faint">
                  Or in selected projects
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
            Skill files are copied into the working folder when the session starts.
            The agent only reads them — skill text cannot override the platform's
            security rules.
          </p>

          {xato && <p className="mt-3 text-sm text-coral">{xato}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
            >
              Cancel
            </button>
            <button
              onClick={saqla}
              disabled={ishlayapti}
              className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
            >
              {ishlayapti ? 'Saving…' : hechnima ? 'Uninstall' : 'Save'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tafsilot modali
// ---------------------------------------------------------------------------

/**
 * Skillning TO'LIQ ma'lumoti.
 *
 * Kartada tavsif ataylab qisqartiriladi (kartalar bir xil balandlikda
 * qolsin), shuning uchun to'liq matnni ko'rishning yo'li kerak. `docx`
 * kabi skilllarda tavsif 900+ belgi bo'ladi.
 */
function TafsilotModal({
  skill,
  manbaNomi,
  loyihaNomi,
  onClose,
  onQamrov,
}: {
  skill: Skill
  manbaNomi: string
  loyihaNomi: (id: string) => string
  onClose: () => void
  onQamrov: () => void
}) {
  const global = skill.ornatilgan.some((o) => o.qamrov === 'global')
  const loyihalar = skill.ornatilgan.filter((o) => o.qamrov === 'loyiha' && o.projectId)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${skill.nom} details`}
    >
      {/* `Card` onClick qabul qilmaydi (umumiy komponent), shuning uchun
          tashqi div bilan o'raymiz — modal ichiga bosilganda yopilmasin */}
      <div
        className="rise-in flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-line bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold">{skill.nom}</h2>
            <p className="mt-0.5 font-mono text-xs text-faint">{manbaNomi}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-line px-2 py-1 text-sm text-muted transition hover:text-ink"
          >
            ✕
          </button>
        </div>

        {/* Uzun tavsif shu yerda scroll bo'ladi — modal o'zi cho'zilmaydi */}
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{skill.tavsif}</p>

          <dl className="mt-5 space-y-3 border-t border-line pt-4 text-sm">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-faint">File</dt>
              <dd className="mt-1 break-all font-mono text-[12px] text-muted">{skill.yol}</dd>
            </div>

            {skill.litsenziya && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-faint">License</dt>
                <dd className="mt-1 text-muted">{skill.litsenziya}</dd>
              </div>
            )}

            {skill.allowedTools && skill.allowedTools.length > 0 && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-faint">
                  Requested tools
                </dt>
                <dd className="mt-1.5 flex flex-wrap gap-1.5">
                  {skill.allowedTools.map((t) => (
                    <span key={t} className="rounded-md bg-panel2 px-2 py-0.5 font-mono text-[11px] text-muted">
                      {t}
                    </span>
                  ))}
                </dd>
              </div>
            )}

            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-faint">Scope</dt>
              <dd className="mt-1 text-muted">
                {global && <div className="text-mint">✓ Global — everywhere</div>}
                {loyihalar.map((o) => (
                  <div key={o.projectId} className="text-mint">
                    ✓ {loyihaNomi(o.projectId!)}
                  </div>
                ))}
                {!global && loyihalar.length === 0 && <span className="text-faint">not installed</span>}
              </dd>
            </div>

            {skill.ogohlantirishlar.length > 0 && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-gold">
                  Warnings
                </dt>
                <dd className="mt-1.5">
                  <ul className="space-y-1 text-[13px] text-muted">
                    {skill.ogohlantirishlar.map((o, i) => (
                      <li key={i}>• {o}</li>
                    ))}
                  </ul>
                  {/* Ogohlantirish skill ishlashiga to'sqinlik qilmaydi —
                      buni ochiq aytamiz, aks holda foydalanuvchi xato deb o'ylaydi */}
                  <p className="mt-2 text-[11px] leading-relaxed text-faint">
                    These are mismatches with the spec. The skill still works.
                  </p>
                </dd>
              </div>
            )}
          </dl>
        </div>

        <div className="mt-5 flex shrink-0 justify-end gap-2 border-t border-line pt-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
          >
            Close
          </button>
          <button
            onClick={onQamrov}
            className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110"
          >
            {global || loyihalar.length > 0 ? 'Change scope' : 'Install'}
          </button>
        </div>
      </div>
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
  const [bandId, setBandId] = useState<string | null>(null)
  const toast = useToast()

  const qosh = async () => {
    if (!url.trim() || ishlayapti) return
    setIshlayapti(true)
    try {
      const natija = await manbaQosh(url.trim())
      setUrl('')
      const ogoh = natija.ogohlantirishlar.length
      toast(
        `${natija.manba.owner}/${natija.manba.repo}: ${natija.qoshildi} skills found` +
          (ogoh > 0 ? ` · ${ogoh} warnings` : ''),
        // Ogohlantirish bo'lsa sariq: skilllar baribir qo'shildi, lekin
        // foydalanuvchi ularni ko'rib chiqsin
        ogoh > 0 ? 'warning' : 'success',
      )
      onYangilandi()
    } catch (x) {
      toast(
        x instanceof ApiXatosi
          ? [x.message, x.detail].filter(Boolean).join(' — ')
          : 'Could not connect',
        'error',
      )
    } finally {
      setIshlayapti(false)
    }
  }

  const sinxronla = async (id: string) => {
    setBandId(id)
    try {
      const n = await manbaSinxronla(id)
      toast(
        `Synced: +${n.qoshildi} new, ${n.yangilandi} updated, -${n.ochirildi}`,
        'success',
      )
      onYangilandi()
    } catch (x) {
      toast(x instanceof ApiXatosi ? x.message : 'Could not sync', 'error')
    } finally {
      setBandId(null)
    }
  }

  const ochir = async (m: SkillManba) => {
    if (!confirm(`Delete the source ${m.owner}/${m.repo} and all of its skills?`)) return
    setBandId(m.id)
    try {
      await manbaOchir(m.id)
      toast(`${m.owner}/${m.repo} deleted`, 'success')
      onYangilandi()
    } catch (x) {
      toast(x instanceof ApiXatosi ? x.message : 'Could not delete', 'error')
    } finally {
      setBandId(null)
    }
  }

  return (
    <Card className="mb-6 p-5">
      <h2 className="font-display text-[15px] font-semibold">Sources</h2>
      <p className="mt-1 text-sm text-muted">
        Connect a GitHub repo — every <code className="font-mono text-xs">SKILL.md</code> file inside
        lands in the catalog. There is no registry; any repo works.
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
          {ishlayapti ? 'Scanning…' : 'Connect'}
        </button>
      </div>

      {manbalar.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-line pt-4">
          {manbalar.map((m) => {
            // Standart manba platforma bilan birga keladi va har ishga
            // tushishda qayta yaratiladi — uni o'chirish yoki sinxronlash
            // ma'nosiz bo'lardi (tugma bosilardi, natija o'zgarmasdi).
            const platformaniki = m.tur === 'platforma'
            return (
              <div key={m.id} className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <span className="font-mono text-[13px] text-ink">
                    {platformaniki ? 'platform' : `${m.owner}/${m.repo}`}
                  </span>
                  <span className="ml-2 text-xs text-faint">
                    {platformaniki ? 'built-in skills' : m.ref}
                    {!platformaniki &&
                      m.oxirgiSinxron &&
                      ` · ${new Date(m.oxirgiSinxron).toLocaleDateString('en-US')}`}
                  </span>
                </div>
                {!platformaniki && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => sinxronla(m.id)}
                      disabled={bandId === m.id}
                      className="rounded-md border border-line px-2.5 py-1 text-xs text-muted transition hover:text-ink disabled:opacity-50"
                    >
                      {bandId === m.id ? '…' : 'Sync'}
                    </button>
                    <button
                      onClick={() => ochir(m)}
                      disabled={bandId === m.id}
                      className="rounded-md border border-line px-2.5 py-1 text-xs text-muted transition hover:text-coral disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            )
          })}
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
  const [tafsilot, setTafsilot] = useState<Skill | null>(null)

  // Qidiruv va filtrlar. Bir necha repo ulansa katalog yuzlab skillga
  // yetadi — ro'yxatni ko'z bilan ko'rib chiqish imkonsiz bo'ladi.
  const [qidiruv, setQidiruv] = useState('')
  const [holatFiltri, setHolatFiltri] = useState<'hammasi' | 'ornatilgan' | 'ornatilmagan'>('hammasi')
  const [manbaFiltri, setManbaFiltri] = useState<string>('hammasi')

  /** Yangi ro'yxatni ham QAYTARADI — chaqiruvchi ochiq modalni yangilay olsin */
  const yukla = async (): Promise<Skill[] | null> => {
    try {
      const [katalog, loyiha] = await Promise.all([skilllarniOl(), loyihalarOl()])
      setSkilllar(katalog.skills)
      setManbalar(katalog.manbalar)
      setLoyihalar(loyiha)
      setXato(null)
      return katalog.skills
    } catch (x) {
      setXato(x instanceof ApiXatosi ? x.message : 'Could not load the data')
      return null
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

    const yangi = await yukla()

    // Tafsilot modali ochiq bo'lsa uni YANGI obyektga bog'laymiz — aks
    // holda u eski `ornatilgan` ro'yxatini ko'rsatib turardi
    setTafsilot((oldingi) =>
      oldingi ? (yangi?.find((s) => s.id === oldingi.id) ?? oldingi) : null,
    )
  }

  const qamrovMatni = (skill: Skill): string => {
    const global = skill.ornatilgan.some((o) => o.qamrov === 'global')
    const loyihaSoni = skill.ornatilgan.filter((o) => o.qamrov === 'loyiha').length
    if (global && loyihaSoni > 0) return `Global + ${loyihaSoni} projects`
    if (global) return 'Global'
    if (loyihaSoni > 0) return `${loyihaSoni} projects`
    return ''
  }

  const manbaNomi = (manbaId: string): string => {
    const m = manbalar.find((x) => x.id === manbaId)
    return m ? `${m.owner}/${m.repo}` : ''
  }

  const loyihaNomi = (id: string): string => loyihalar.find((l) => l.id === id)?.name ?? id

  /**
   * Qidiruv + filtrlar.
   *
   * Qidiruv NOM va TAVSIF bo'yicha: foydalanuvchi ko'pincha skill nomini
   * emas, vazifasini eslaydi ("word", "pdf", "prezentatsiya"). Tavsif
   * ingliz tilida bo'lgani uchun nom bo'yicha qidiruv yolg'iz yetarli emas.
   *
   * So'zlar ALOHIDA tekshiriladi (`AND`): "word doc" yozilsa ikkala so'z
   * ham bo'lgan skill topiladi, tartibi muhim emas.
   */
  const korinadigan = useMemo(() => {
    const sozlar = qidiruv.toLowerCase().split(/\s+/).filter(Boolean)

    return skilllar.filter((s) => {
      if (holatFiltri === 'ornatilgan' && s.ornatilgan.length === 0) return false
      if (holatFiltri === 'ornatilmagan' && s.ornatilgan.length > 0) return false
      if (manbaFiltri !== 'hammasi' && s.manbaId !== manbaFiltri) return false

      if (sozlar.length === 0) return true
      const matn = `${s.nom} ${s.tavsif}`.toLowerCase()
      return sozlar.every((soz) => matn.includes(soz))
    })
  }, [skilllar, qidiruv, holatFiltri, manbaFiltri])

  const filtrBor = qidiruv.trim() !== '' || holatFiltri !== 'hammasi' || manbaFiltri !== 'hammasi'

  const filtrlarniTozala = () => {
    setQidiruv('')
    setHolatFiltri('hammasi')
    setManbaFiltri('hammasi')
  }

  const ornatilganSoni = skilllar.filter((s) => s.ornatilgan.length > 0).length

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="Skills"
        sub="SKILL.md packages: connected from GitHub, running globally or in selected projects"
      />

      <Manbalar manbalar={manbalar} onYangilandi={yukla} />

      {xato && (
        <Card className="mb-6 border-coral/40 p-4">
          <p className="text-sm text-coral">{xato}</p>
        </Card>
      )}

      {/* Qidiruv paneli — katalog bo'sh bo'lmaganda ko'rinadi */}
      {!yuklanmoqda && skilllar.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <div className="relative min-w-55 flex-1">
            <input
              value={qidiruv}
              onChange={(e) => setQidiruv(e.target.value)}
              placeholder="Search: name or task (word, pdf, deploy…)"
              aria-label="Search skills"
              className="w-full rounded-lg border border-line bg-bg py-2 pl-9 pr-8 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
            />
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-faint" aria-hidden>
              ⌕
            </span>
            {qidiruv && (
              <button
                onClick={() => setQidiruv('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-faint transition hover:text-ink"
              >
                ✕
              </button>
            )}
          </div>

          <select
            value={holatFiltri}
            onChange={(e) => setHolatFiltri(e.target.value as typeof holatFiltri)}
            aria-label="Filter by status"
            className="rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted outline-none focus:border-lazur-dim"
          >
            <option value="hammasi">All ({skilllar.length})</option>
            <option value="ornatilgan">Installed ({ornatilganSoni})</option>
            <option value="ornatilmagan">Not installed ({skilllar.length - ornatilganSoni})</option>
          </select>

          {/* Manba filtri faqat bir nechta repo ulanganda ma'noli */}
          {manbalar.length > 1 && (
            <select
              value={manbaFiltri}
              onChange={(e) => setManbaFiltri(e.target.value)}
              aria-label="Filter by source"
              className="max-w-50 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted outline-none focus:border-lazur-dim"
            >
              <option value="hammasi">All sources</option>
              {manbalar.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.tur === 'platforma' ? 'platform (built-in)' : `${m.owner}/${m.repo}`}
                </option>
              ))}
            </select>
          )}

          {filtrBor && (
            <>
              <span className="text-sm text-faint">
                {korinadigan.length} / {skilllar.length}
              </span>
              <button
                onClick={filtrlarniTozala}
                className="rounded-lg border border-line px-3 py-2 text-sm text-muted transition hover:text-ink"
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {yuklanmoqda ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : skilllar.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">
            The catalog is empty. Connect a GitHub repo above — for example{' '}
            <code className="font-mono text-xs text-ink">anthropics/skills</code>.
          </p>
        </Card>
      ) : korinadigan.length === 0 ? (
        // Filtr hech narsa topmadi — bu bo'sh katalogdan BOSHQA holat,
        // shuning uchun xabar ham boshqacha
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">Nothing found.</p>
          <button
            onClick={filtrlarniTozala}
            className="mt-3 text-sm text-lazur transition hover:brightness-125"
          >
            Clear filters
          </button>
        </Card>
      ) : (
        // `items-start` YO'Q: grid hujayralari cho'zilib, bir qatordagi
        // kartalar bir xil balandlikda qoladi. Tavsif esa 4 qatorga
        // qisqartiriladi (`line-clamp-4`) — `docx` ning 900 belgilik matni
        // butun qatorni cho'zib yubormasin.
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {korinadigan.map((s) => {
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
                      {s.ogohlantirishlar.length} warn.
                    </span>
                  )}
                </div>

                {/* `flex-1` bo'sh joyni yeydi — pastki qator hamma kartada
                    bir xil balandlikda tursin */}
                <div className="mt-2 flex-1">
                  <p className="line-clamp-4 text-sm leading-relaxed text-muted">{s.tavsif}</p>
                  <button
                    onClick={() => setTafsilot(s)}
                    className="mt-1.5 text-xs text-lazur transition hover:brightness-125"
                  >
                    Details →
                  </button>
                </div>

                <div className="mt-3 font-mono text-[11px] text-faint">{manbaNomi(s.manbaId)}</div>

                <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
                  {qamrov ? (
                    <span className="truncate text-sm text-mint" title={qamrov}>
                      ✓ {qamrov}
                    </span>
                  ) : (
                    <span className="text-xs text-faint">not installed</span>
                  )}
                  <button
                    onClick={() => setModal(s)}
                    className={
                      qamrov
                        ? 'shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition hover:text-ink'
                        : 'shrink-0 rounded-lg border border-lazur-dim px-3 py-1.5 text-sm text-lazur transition hover:bg-lazur-dim hover:text-bg'
                    }
                  >
                    {qamrov ? 'Change' : 'Install'}
                  </button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* Tafsilot ostida turadi: undan "O'rnatish" bosilsa qamrov modali
          ustiga ochiladi va yopilgach tafsilot ko'rinib qoladi */}
      {tafsilot && (
        <TafsilotModal
          skill={tafsilot}
          manbaNomi={manbaNomi(tafsilot.manbaId)}
          loyihaNomi={loyihaNomi}
          onClose={() => setTafsilot(null)}
          onQamrov={() => setModal(tafsilot)}
        />
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
