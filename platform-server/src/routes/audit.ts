// Reading the audit log — the filters on the Audit.tsx page map onto these
// query parameters. There is DELIBERATELY no write endpoint: the audit log is
// only ever filled from inside the backend via `auditWrite(...)`, never from
// the outside.

import { Hono } from 'hono'
import { auditRead, auditCount, auditActors } from '../audit.ts'

export const auditRoutes = new Hono()

auditRoutes.get('/audit', (c) => {
  const { level, actor, limit, offset } = c.req.query()

  const filter = {
    level: level || undefined,
    actor: actor || undefined,
    limit: limit ? Number.parseInt(limit, 10) : undefined,
    offset: offset ? Number.parseInt(offset, 10) : undefined,
  }

  if (filter.limit !== undefined && Number.isNaN(filter.limit)) {
    return c.json({ error: 'limit must be an integer' }, 400)
  }
  if (filter.offset !== undefined && Number.isNaN(filter.offset)) {
    return c.json({ error: 'offset must be an integer' }, 400)
  }

  return c.json({
    entries: auditRead(filter),
    total: auditCount({ level: filter.level, actor: filter.actor }),
    // The full actor list travels with every response: the dropdown has to
    // offer actors the current filter excludes, otherwise a filter could never
    // be widened back out.
    actors: auditActors(),
  })
})
