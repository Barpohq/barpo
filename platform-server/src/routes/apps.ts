// Ilova manifestlari — UI sidebar'dagi "Ilovalar" bo'limi va AppView shu
// endpointlardan oziqlanadi.

import { Hono } from 'hono'
import { ilovaOqi, ilovalarOqi } from '../repo.ts'
import { intervalniTogrila } from '../state-bajar.ts'
import { stateniOl } from '../state-kesh.ts'

export const appsRoutes = new Hono()

// Manifestlar ro'yxati — UI faqat manifestlarni kutadi, DB metadata emas
appsRoutes.get('/apps', (c) => {
  return c.json({ apps: ilovalarOqi().map((a) => a.manifest) })
})

appsRoutes.get('/apps/:id', (c) => {
  const record = ilovaOqi(c.req.param('id'))
  if (!record) return c.json({ error: 'Ilova topilmadi' }, 404)
  return c.json({
    manifest: record.manifest,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  })
})

// ---------------------------------------------------------------------------
// Jonli statelar
// ---------------------------------------------------------------------------
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ BU — AI YOZMAYDIGAN, OLDINDAN TAYYOR API.                            │
// │                                                                      │
// │ Agent hech qachon yangi endpoint qo'shmaydi. U faqat state KODINI    │
// │ yozadi (`manifest.states`), quyidagi ikki marshrut esa o'zgarmaydi.  │
// │ Frontend shularni polling qiladi va yangi qiymatlarni oladi.         │
// └──────────────────────────────────────────────────────────────────────┘

/**
 * Bitta state qiymati.
 *
 * Kesh interval bo'yicha ishlaydi: interval ichida kelgan so'rovlar
 * saqlangan natijani oladi, kod qayta bajarilmaydi (`state-kesh.ts`).
 * `?majburiy=1` — keshni chetlab o'tadi ("yangilash" tugmasi uchun).
 */
appsRoutes.get('/apps/:id/state/:nom', async (c) => {
  const appId = c.req.param('id')
  const nom = c.req.param('nom')

  const record = ilovaOqi(appId)
  if (!record) return c.json({ error: 'Ilova topilmadi' }, 404)

  const state = record.manifest.states?.find((s) => s.nom === nom)
  if (!state) return c.json({ error: `State topilmadi: ${nom}` }, 404)

  const natija = await stateniOl(
    appId,
    state.nom,
    state.kod,
    intervalniTogrila(state.interval),
    c.req.query('majburiy') === '1',
  )

  // Kod yiqilsa ham HTTP 200: bu server xatosi emas, ma'lumot xatosi.
  // Frontend `ok: false` ni ko'rib eski qiymatni saqlab qoladi va
  // dashboardni yiqitmaydi.
  return c.json(natija)
})

/**
 * Hamma statelar bir so'rovda.
 *
 * Sahifa OCHILGANDA ishlatiladi: 6 ta state uchun 6 ta so'rov o'rniga
 * bitta. Keyingi yangilanishlar har state uchun alohida boradi, chunki
 * ularning intervallari har xil (CPU 5s, disk 30s).
 */
appsRoutes.get('/apps/:id/state', async (c) => {
  const appId = c.req.param('id')
  const record = ilovaOqi(appId)
  if (!record) return c.json({ error: 'Ilova topilmadi' }, 404)

  const statelar = record.manifest.states ?? []
  // Parallel: sekin state (masalan `ssh`) qolganlarini kutdirmasin.
  const natijalar = await Promise.all(
    statelar.map(async (s) => ({
      nom: s.nom,
      natija: await stateniOl(appId, s.nom, s.kod, intervalniTogrila(s.interval)),
    })),
  )

  const javob: Record<string, unknown> = {}
  for (const { nom, natija } of natijalar) javob[nom] = natija
  return c.json({ statelar: javob })
})
