// Ilova manifestlari — UI sidebar'dagi "Ilovalar" bo'limi va AppView shu
// endpointlardan oziqlanadi.

import { Hono } from 'hono'
import { ilovaOqi, ilovalarOqi } from '../repo.ts'

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
