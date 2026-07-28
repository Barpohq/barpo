// Skilllar API — manba ulash, katalog skanerlash, o'rnatish.
//
// Model: manba (GitHub repo) → skill (katalog yozuvi) → o'rnatish (qamrov).
// Batafsil: migrations/006-skilllar.ts va skill-ombor.ts.
//
// TARMOQ SO'ROVLARI shu qatlamda: GitHub API va tarball yuklash. Ular
// sekin bo'lishi mumkin (repo katta), shuning uchun har biriga timeout
// qo'yilgan (`github.ts`).

import { Hono } from 'hono'
import { auditYoz } from '../audit.ts'
import { manzilniAjrat } from '../github.ts'
import {
  loyihaOqi,
  manbaOchir,
  manbalarOqi,
  manbaOqi,
  manbaYarat,
  skillOqi,
  skillOrnat,
  skillOrnatishniOchir,
  skilllarniSinxronla,
  skilllarOqi,
} from '../repo.ts'
import {
  manbaniOmbordanOchir,
  manbaniSkanerla,
  skillniOmborga,
  skillniOmbordanOchir,
} from '../skill-ombor.ts'
export const skillsRoutes = new Hono()

// ---------------------------------------------------------------------------
// Katalog
// ---------------------------------------------------------------------------

skillsRoutes.get('/skills', (c) => {
  return c.json({ skills: skilllarOqi(), manbalar: manbalarOqi() })
})

// ---------------------------------------------------------------------------
// Manbalar
// ---------------------------------------------------------------------------

skillsRoutes.get('/skills/manbalar', (c) => {
  return c.json({ manbalar: manbalarOqi() })
})

/**
 * Yangi manba ulash — repo skanerlanadi va katalogga yoziladi.
 *
 * O'RNATMAYDI: skilllar faqat katalogda paydo bo'ladi. Diskka yuklash
 * alohida qadam (`/skills/:id/ornat`), chunki foydalanuvchi qaysi skillni
 * qayerda ishlatishini o'zi tanlaydi.
 */
skillsRoutes.post('/skills/manba', async (c) => {
  let url: unknown
  try {
    const tana = (await c.req.json()) as { url?: unknown }
    url = tana?.url
  } catch {
    return c.json({ error: "So'rov tanasi JSON bo'lishi kerak" }, 400)
  }

  if (typeof url !== 'string' || !url.trim()) {
    return c.json({ error: 'Repo manzili majburiy' }, 400)
  }

  const manzil = manzilniAjrat(url)
  if (!manzil) {
    return c.json(
      {
        error: "Manzilni tanib bo'lmadi",
        detail: 'Masalan: https://github.com/anthropics/skills yoki anthropics/skills',
      },
      400,
    )
  }

  let skaner: Awaited<ReturnType<typeof manbaniSkanerla>>
  try {
    skaner = await manbaniSkanerla(manzil)
  } catch (xato) {
    return c.json({ error: xato instanceof Error ? xato.message : 'Skanerlash muvaffaqiyatsiz' }, 502)
  }

  const manba = manbaYarat({
    tur: 'github',
    url: url.trim(),
    owner: manzil.owner,
    repo: manzil.repo,
    ref: skaner.ref,
  })

  const natija = skilllarniSinxronla(manba.id, skaner.skilllar, skaner.sha)

  auditYoz(
    'foydalanuvchi',
    'Skill manbasi ulandi',
    `${manzil.owner}/${manzil.repo} — ${natija.qoshildi} skill`,
    "o'zgartirish",
  )

  return c.json({ manba, ...natija, ogohlantirishlar: skaner.ogohlantirishlar }, 201)
})

/** Qayta skanerlash — repo'da yangi skill paydo bo'lgan bo'lsa katalogga tushadi */
skillsRoutes.post('/skills/manba/:id/sinxron', async (c) => {
  const manba = manbaOqi(c.req.param('id'))
  if (!manba) return c.json({ error: 'Manba topilmadi' }, 404)

  let skaner: Awaited<ReturnType<typeof manbaniSkanerla>>
  try {
    skaner = await manbaniSkanerla({ owner: manba.owner, repo: manba.repo, ref: manba.ref })
  } catch (xato) {
    return c.json({ error: xato instanceof Error ? xato.message : 'Skanerlash muvaffaqiyatsiz' }, 502)
  }

  const natija = skilllarniSinxronla(manba.id, skaner.skilllar, skaner.sha)

  auditYoz(
    'foydalanuvchi',
    'Skill manbasi sinxronlandi',
    `${manba.owner}/${manba.repo} — +${natija.qoshildi} / -${natija.ochirildi}`,
    "o'zgartirish",
  )

  return c.json({ ...natija, ogohlantirishlar: skaner.ogohlantirishlar })
})

/** Manba, uning skilllari (CASCADE) va ombor papkasi o'chadi */
skillsRoutes.delete('/skills/manba/:id', (c) => {
  const id = c.req.param('id')
  const manba = manbaOqi(id)
  if (!manba) return c.json({ error: 'Manba topilmadi' }, 404)

  manbaOchir(id)
  manbaniOmbordanOchir(id)

  auditYoz(
    'foydalanuvchi',
    "Skill manbasi o'chirildi",
    `${manba.owner}/${manba.repo}`,
    "o'zgartirish",
  )

  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// O'rnatish
// ---------------------------------------------------------------------------

interface OrnatTana {
  /** `global` — hamma joyda; `loyiha` — faqat `projectIds` dagi loyihalarda */
  qamrov?: unknown
  projectIds?: unknown
}

/**
 * Skillni o'rnatadi: fayllar ombor ga tushadi, qamrov bazaga yoziladi.
 *
 * Bir chaqiruvda BIR NECHA loyihaga o'rnatish mumkin — fayllar baribir
 * bitta nusxada yotadi, faqat `skill_ornatish` qatorlari ko'payadi.
 * Loyiha papkalariga nusxa sessiya boshida tushadi (`loyihagaSinxronla`).
 */
skillsRoutes.post('/skills/:id/ornat', async (c) => {
  const skill = skillOqi(c.req.param('id'))
  if (!skill) return c.json({ error: 'Skill topilmadi' }, 404)

  const manba = manbaOqi(skill.manbaId)
  if (!manba) return c.json({ error: 'Skill manbasi topilmadi' }, 404)

  let tana: OrnatTana
  try {
    tana = (await c.req.json()) as OrnatTana
  } catch {
    return c.json({ error: "So'rov tanasi JSON bo'lishi kerak" }, 400)
  }

  const qamrov = tana.qamrov
  if (qamrov !== 'global' && qamrov !== 'loyiha') {
    return c.json({ error: "qamrov 'global' yoki 'loyiha' bo'lishi kerak" }, 400)
  }

  let loyihalar: string[] = []
  if (qamrov === 'loyiha') {
    if (!Array.isArray(tana.projectIds) || tana.projectIds.length === 0) {
      return c.json({ error: "Loyiha qamrovida kamida bitta loyiha tanlanishi kerak" }, 400)
    }
    loyihalar = tana.projectIds.filter((x): x is string => typeof x === 'string')
    for (const id of loyihalar) {
      if (!loyihaOqi(id)) return c.json({ error: `Loyiha topilmadi: ${id}` }, 404)
    }
  }

  // Fayllarni ombor ga tushiramiz. Allaqachon o'rnatilgan bo'lsa ham qayta
  // yuklaymiz — repo yangilangan bo'lishi mumkin.
  try {
    await skillniOmborga(
      { owner: manba.owner, repo: manba.repo, ref: manba.ref },
      manba.ref,
      skill.yol,
      manba.id,
      skill.id,
    )
  } catch (xato) {
    return c.json(
      { error: xato instanceof Error ? xato.message : "Yuklab bo'lmadi" },
      502,
    )
  }

  if (qamrov === 'global') {
    skillOrnat(skill.id, 'global', null)
  } else {
    for (const projectId of loyihalar) skillOrnat(skill.id, 'loyiha', projectId)
  }

  auditYoz(
    'foydalanuvchi',
    "Skill o'rnatildi",
    `${skill.nom} — ${qamrov === 'global' ? 'global' : `${loyihalar.length} loyiha`}`,
    "o'zgartirish",
  )

  return c.json({ skill: skillOqi(skill.id) })
})

/**
 * O'rnatishni bekor qiladi.
 *
 * Oxirgi o'rnatish olib tashlanganda ombordagi fayllar ham o'chiriladi —
 * hech qayerda ishlatilmaydigan skill diskda joy egallab yotmasin. Katalog
 * yozuvi qoladi, ya'ni qayta o'rnatish bir bosishda.
 */
skillsRoutes.delete('/skills/:id/ornat', async (c) => {
  const skill = skillOqi(c.req.param('id'))
  if (!skill) return c.json({ error: 'Skill topilmadi' }, 404)

  let tana: OrnatTana
  try {
    tana = (await c.req.json()) as OrnatTana
  } catch {
    return c.json({ error: "So'rov tanasi JSON bo'lishi kerak" }, 400)
  }

  const qamrov = tana.qamrov
  if (qamrov !== 'global' && qamrov !== 'loyiha') {
    return c.json({ error: "qamrov 'global' yoki 'loyiha' bo'lishi kerak" }, 400)
  }

  const projectIds = Array.isArray(tana.projectIds)
    ? tana.projectIds.filter((x): x is string => typeof x === 'string')
    : []

  if (qamrov === 'global') {
    skillOrnatishniOchir(skill.id, 'global', null)
  } else {
    if (projectIds.length === 0) {
      return c.json({ error: 'Loyiha tanlanmadi' }, 400)
    }
    for (const projectId of projectIds) skillOrnatishniOchir(skill.id, 'loyiha', projectId)
  }

  // Hech qayerda qolmagan bo'lsa fayllarni ham tozalaymiz
  const yangilangan = skillOqi(skill.id)
  if (yangilangan && yangilangan.ornatilgan.length === 0) {
    skillniOmbordanOchir(skill.manbaId, skill.id)
  }

  auditYoz('foydalanuvchi', "Skill o'rnatishi bekor qilindi", skill.nom, "o'zgartirish")

  return c.json({ skill: yangilangan })
})
