// Loyihalar (project / workspace) — nomlangan ish papkasi.
//
// Loyiha = nom + platforma yaratadigan papka. Chat sessiyasi loyihaga
// ulansa, agent tool'lari o'sha papkada ishlaydi va bir loyihaning hamma
// suhbatlari bitta fayllar to'plamini ko'radi.
//
// FOYDALANUVCHI YO'L BERMAYDI — faqat nom. Yo'l qabul qilinsa, agent
// tool'larining chegarasi `/` yoki `~` ga ham qo'yilishi mumkin bo'lardi;
// platforma o'zi `~/.platforma/loyihalar/<slug>/` ni yaratadi.
//
// Papkani O'CHIRISH hozircha yo'q: papkani ham o'chirish kerakmi degan savol
// (va uning tasdiq oqimi) alohida bosqichda hal qilinadi.

import { Hono } from 'hono'
import { loyihaPapkasiniYarat, loyihaSlugi } from '../ish-papkasi.ts'
import { loyihalarOqi, loyihaNomBoyicha, loyihaYarat } from '../repo.ts'

export const projectsRoutes = new Hono()

/** Nom uzunligi chegarasi — UI'da ham, papka nomida ham amaliy chegara */
const NOM_MAX = 80

projectsRoutes.get('/projects', (c) => {
  return c.json({ projects: loyihalarOqi() })
})

projectsRoutes.post('/projects', async (c) => {
  let nom: unknown
  try {
    const tana = (await c.req.json()) as { name?: unknown }
    nom = tana?.name
  } catch {
    return c.json({ error: "So'rov tanasi JSON bo'lishi kerak" }, 400)
  }

  if (typeof nom !== 'string' || nom.trim().length === 0) {
    return c.json({ error: 'Loyiha nomi majburiy' }, 400)
  }
  const toza = nom.trim()
  if (toza.length > NOM_MAX) {
    return c.json({ error: `Loyiha nomi ${NOM_MAX} belgidan uzun bo'lmasin` }, 400)
  }

  // Papka nomi faqat xavfsiz belgilardan quriladi. Bo'sh qolsa — nom
  // butunlay papka nomiga yaramaydigan belgilardan iborat (masalan faqat
  // emoji yoki kirill). Zaxira nom bermaymiz: ikkita boshqa loyiha bitta
  // papkani bo'lishib qolardi.
  const slug = loyihaSlugi(toza)
  if (!slug) {
    return c.json(
      {
        error: "Loyiha nomidan papka nomi hosil bo'lmadi",
        detail: 'Nomda kamida bitta lotin harfi yoki raqam bo\'lsin',
      },
      400,
    )
  }

  if (loyihaNomBoyicha(toza)) {
    return c.json(
      { error: 'Bunday nomli loyiha allaqachon bor', detail: toza },
      409,
    )
  }

  // Papka avval yaratiladi: fayl tizimi xato bersa (ruxsat yo'q, disk to'la)
  // bazada "papkasi yo'q loyiha" yozuvi qolib ketmasin.
  let papka: string
  try {
    papka = loyihaPapkasiniYarat(slug)
  } catch (xato) {
    return c.json(
      {
        error: "Loyiha papkasini yaratib bo'lmadi",
        detail: xato instanceof Error ? xato.message : String(xato),
      },
      500,
    )
  }

  // UNIQUE indeks — `loyihaNomBoyicha` tekshiruvidan keyin ham poyga holati
  // bo'lishi mumkin (ikkita so'rov bir vaqtda). Baza qatlamidagi kafolat
  // asosiy, yuqoridagi tekshiruv faqat chiroyliroq xato uchun.
  try {
    return c.json({ project: loyihaYarat(toza, papka) }, 201)
  } catch (xato) {
    const xabar = xato instanceof Error ? xato.message : String(xato)
    if (xabar.includes('UNIQUE')) {
      return c.json({ error: 'Bunday nomli loyiha allaqachon bor', detail: toza }, 409)
    }
    throw xato
  }
})
