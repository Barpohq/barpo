// GET /api/health — servis tirikmi, baza qaysi sxema versiyasida, nechta WS
// mijoz ulangan. Monitoring va daemon handshake shu endpointni so'raydi.

import { Hono } from 'hono'
import { db, sxemaVersiyasi } from '../db.ts'
import { hub } from '../ws/hub.ts'
import { PROTOCOL_VERSION } from '@platforma/shared'

export const healthRoutes = new Hono()

const boshlanganVaqt = Date.now()

healthRoutes.get('/health', (c) => {
  return c.json({
    ok: true,
    version: PROTOCOL_VERSION,
    schema: sxemaVersiyasi(db()),
    wsClients: hub.soni,
    uptimeMs: Date.now() - boshlanganVaqt,
    time: new Date().toISOString(),
  })
})
