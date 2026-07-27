// Audit log o'qish — Audit.tsx sahifasidagi filtrlar shu query parametrlariga
// mos keladi. Yozish endpointi ATAYLAB yo'q: audit faqat backend ichidan
// `auditYoz(...)` orqali to'ldiriladi, tashqaridan yozib bo'lmaydi.

import { Hono } from 'hono'
import { auditOqi, auditSoni } from '../audit.ts'

export const auditRoutes = new Hono()

auditRoutes.get('/audit', (c) => {
  const { level, actor, limit, offset } = c.req.query()

  const filtr = {
    level: level || undefined,
    actor: actor || undefined,
    limit: limit ? Number.parseInt(limit, 10) : undefined,
    offset: offset ? Number.parseInt(offset, 10) : undefined,
  }

  if (filtr.limit !== undefined && Number.isNaN(filtr.limit)) {
    return c.json({ error: "limit butun son bo'lishi kerak" }, 400)
  }
  if (filtr.offset !== undefined && Number.isNaN(filtr.offset)) {
    return c.json({ error: "offset butun son bo'lishi kerak" }, 400)
  }

  return c.json({
    entries: auditOqi(filtr),
    total: auditSoni({ level: filtr.level, actor: filtr.actor }),
  })
})
