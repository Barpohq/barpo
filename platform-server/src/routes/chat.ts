// Chat sessiyalari va xabarlari.
//
// POST /api/chat/send foydalanuvchi xabarini saqlaydi, sessiya modelini
// qulflaydi va javob oqimini FONDA boshlaydi — javob WS orqali keladi
// (chat.delta → chat.done yoki chat.error). Shuning uchun 202 qaytadi:
// so'rov qabul qilindi, natija keyinroq.

import { Hono } from 'hono'
import {
  javobOqizi,
  oqimBormi,
  oqimniToxtat,
  rejimHolati,
  rejimOrnat,
  ruxsatJavobi,
} from '../orchestrator.ts'
import {
  sessiyaModelniOzgart,
  sessiyaModelQulfla,
  sessiyaOqi,
  sessiyaYarat,
  sessiyalarOqi,
  xabarlarOqi,
  xabarYoz,
} from '../repo.ts'

export const chatRoutes = new Hono()

chatRoutes.get('/chat/sessions', (c) => {
  return c.json({ sessions: sessiyalarOqi() })
})

chatRoutes.post('/chat/sessions', async (c) => {
  let title: string | undefined
  try {
    const tana = (await c.req.json()) as { title?: unknown }
    if (typeof tana?.title === 'string') title = tana.title
  } catch {
    // tana bo'sh bo'lishi mumkin — sarlavha avtomatik qo'yiladi
  }
  return c.json({ session: sessiyaYarat(title) }, 201)
})

chatRoutes.get('/chat/sessions/:id/messages', (c) => {
  const id = c.req.param('id')
  if (!sessiyaOqi(id)) return c.json({ error: 'Sessiya topilmadi' }, 404)
  return c.json({ messages: xabarlarOqi(id) })
})

interface YuborishTanasi {
  sessionId?: unknown
  text?: unknown
  model?: { provider?: unknown; model?: unknown }
}

chatRoutes.post('/chat/send', async (c) => {
  let tana: YuborishTanasi
  try {
    tana = (await c.req.json()) as YuborishTanasi
  } catch {
    return c.json({ error: "So'rov tanasi JSON bo'lishi kerak" }, 400)
  }

  if (typeof tana.sessionId !== 'string' || tana.sessionId.length === 0) {
    return c.json({ error: 'sessionId majburiy' }, 400)
  }
  if (typeof tana.text !== 'string' || tana.text.trim().length === 0) {
    return c.json({ error: "Xabar matni bo'sh bo'lmasligi kerak" }, 400)
  }

  const sessionId = tana.sessionId
  const matn = tana.text.trim()
  const sessiya = sessiyaOqi(sessionId)
  if (!sessiya) return c.json({ error: 'Sessiya topilmadi' }, 404)

  if (oqimBormi(sessionId)) {
    return c.json({ error: 'Bu sessiyada javob hali oqmoqda', detail: 'Avval kutib turing yoki to\'xtating' }, 409)
  }

  // --- Model tanlovi va provider qulfi ---
  const sorovProvider = matnMi(tana.model?.provider)
  const sorovModel = matnMi(tana.model?.model)

  if (!sessiya.provider) {
    // Birinchi xabar — model tanlangan bo'lishi shart
    if (!sorovProvider || !sorovModel) {
      return c.json(
        {
          error: 'Model tanlanmagan',
          detail: "Sessiyaning birinchi xabarida model: { provider, model } yuborilishi kerak",
        },
        400,
      )
    }
    sessiyaModelQulfla(sessionId, sorovProvider, sorovModel)
  } else if (sorovProvider && sorovProvider !== sessiya.provider) {
    return c.json(
      {
        error: "Sessiya provideri o'zgartirib bo'lmaydi",
        detail: `Sessiya "${sessiya.provider}" provideriga bog'langan. Boshqa provider uchun yangi suhbat boshlang.`,
      },
      409,
    )
  } else if (sorovModel && sorovModel !== sessiya.model) {
    // Bir provider ichida modelni almashtirish mumkin
    sessiyaModelniOzgart(sessionId, sorovModel)
  }

  const yangilangan = sessiyaOqi(sessionId)
  if (!yangilangan?.provider || !yangilangan.model) {
    return c.json({ error: 'Sessiya modeli aniqlanmadi' }, 500)
  }

  // Foydalanuvchi xabarini saqlaymiz — javob oqimi tarixdan shu xabarni oladi
  xabarYoz({ sessionId, role: 'user', text: matn })

  const messageId = crypto.randomUUID()
  const tanlov = { provider: yangilangan.provider, model: yangilangan.model }

  // Fonda oqizamiz — javobni kutmaymiz, u WS orqali boradi
  void javobOqizi(sessionId, messageId, tanlov)

  return c.json({ messageId, model: tanlov }, 202)
})

/**
 * Ruxsat so'roviga javob. WS `chat.permission.reply` bilan bir xil ish
 * qiladi — mijoz qaysi biri qulay bo'lsa shuni ishlatadi.
 */
chatRoutes.post('/chat/permission', async (c) => {
  let tana: { sessionId?: unknown; sorovId?: unknown; javob?: unknown }
  try {
    tana = (await c.req.json()) as typeof tana
  } catch {
    return c.json({ error: "So'rov tanasi JSON bo'lishi kerak" }, 400)
  }

  const sessionId = matnMi(tana.sessionId)
  const sorovId = matnMi(tana.sorovId)
  const javob = tana.javob
  if (!sessionId || !sorovId) {
    return c.json({ error: 'sessionId va sorovId majburiy' }, 400)
  }
  if (javob !== 'ruxsat' && javob !== 'rad' && javob !== 'hardoim') {
    return c.json({ error: "javob 'ruxsat', 'rad' yoki 'hardoim' bo'lishi kerak" }, 400)
  }

  const berildi = ruxsatJavobi(sessionId, sorovId, javob)
  if (!berildi) {
    return c.json(
      { error: "So'rov topilmadi", detail: 'Muddati tugagan yoki allaqachon javob berilgan' },
      404,
    )
  }
  return c.json({ qabulQilindi: true })
})

/** Sessiyaning hozirgi ruxsat rejimi */
chatRoutes.get('/chat/sessions/:id/rejim', (c) => {
  const id = c.req.param('id')
  if (!sessiyaOqi(id)) return c.json({ error: 'Sessiya topilmadi' }, 404)
  return c.json({ holat: rejimHolati(id) })
})

/**
 * Ruxsat rejimini o'zgartirish. Auto o'z-o'zidan o'chgan bo'lsa
 * ("Qayta yoqish") ham shu marshrut ishlatiladi.
 */
chatRoutes.post('/chat/sessions/:id/rejim', async (c) => {
  const id = c.req.param('id')
  if (!sessiyaOqi(id)) return c.json({ error: 'Sessiya topilmadi' }, 404)

  let rejim: unknown
  try {
    const tana = (await c.req.json()) as { rejim?: unknown }
    rejim = tana?.rejim
  } catch {
    return c.json({ error: "So'rov tanasi JSON bo'lishi kerak" }, 400)
  }

  if (rejim !== 'tasdiq' && rejim !== 'auto') {
    return c.json({ error: "rejim 'tasdiq' yoki 'auto' bo'lishi kerak" }, 400)
  }
  return c.json({ holat: await rejimOrnat(id, rejim) })
})

/** Javob oqimini to'xtatish */
chatRoutes.post('/chat/stop', async (c) => {
  let sessionId: string | undefined
  try {
    const tana = (await c.req.json()) as { sessionId?: unknown }
    sessionId = matnMi(tana?.sessionId)
  } catch {
    // pastda tekshiriladi
  }
  if (!sessionId) return c.json({ error: 'sessionId majburiy' }, 400)
  return c.json({ toxtatildi: oqimniToxtat(sessionId) })
})

function matnMi(qiymat: unknown): string | undefined {
  return typeof qiymat === 'string' && qiymat.length > 0 ? qiymat : undefined
}
