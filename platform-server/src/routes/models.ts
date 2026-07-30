// Mavjud AI modellari — chat boshlanishida model tanlagich shu ro'yxatni oladi.
//
// Ro'yxat foydalanuvchi PC'sida aniqlangan providerlardan yig'iladi:
// muhit o'zgaruvchilari, mahalliy Ollama va ~/.claude / ~/.codex obunalari.
// Aniqlash natijasi keshlanadi — /models/refresh uni qayta yuklaydi.

import { modellarniAniqla } from '@platforma/ai'
import { Hono } from 'hono'
import { auditYoz } from '../audit.ts'

export const modelsRoutes = new Hono()

modelsRoutes.get('/models', async (c) => {
  const natija = await modellarniAniqla()
  return c.json({
    models: natija.models,
    providers: natija.providers,
    ogohlantirishlar: natija.ogohlantirishlar,
    vaqt: natija.vaqt,
  })
})

modelsRoutes.post('/models/refresh', async (c) => {
  const natija = await modellarniAniqla({ majburiy: true })
  auditYoz(
    'platform',
    'AI providers re-detected',
    `${natija.providers.length} provider · ${natija.models.length} model`,
    "o'qish",
    'OK',
  )
  return c.json({
    models: natija.models,
    providers: natija.providers,
    ogohlantirishlar: natija.ogohlantirishlar,
    vaqt: natija.vaqt,
  })
})
