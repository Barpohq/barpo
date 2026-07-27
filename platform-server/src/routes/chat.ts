// Chat sessiyalari va xabarlari.
//
// POST /api/chat/send hozircha 501 qaytaradi — orchestrator keyingi bosqichda
// ulanadi. Route strukturasi tayyor turibdi: o'sha agent faqat shu handler
// ichini to'ldiradi, boshqa fayllarni o'zgartirmaydi. Javob oqimi (streaming)
// WS orqali ketadi: chat.delta → chat.toolcard → chat.done.

import { Hono } from 'hono'
import { sessiyaOqi, sessiyaYarat, sessiyalarOqi, xabarlarOqi } from '../repo.ts'

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

// TODO(orchestrator): bu yerda foydalanuvchi xabari saqlanadi, LLM oqimi
// boshlanadi va natija WS orqali chat.delta/chat.done bilan yuboriladi.
chatRoutes.post('/chat/send', (c) => {
  return c.json(
    {
      error: 'Orchestrator hali ulanmagan',
      detail: "Chat oqimi keyingi bosqichda qo'shiladi (POST /api/chat/send).",
    },
    501,
  )
})
