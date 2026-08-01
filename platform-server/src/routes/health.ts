// GET /api/health — is the service alive, which schema version is the database
// on, how many WS clients are connected. Monitoring and the daemon handshake
// both ask this endpoint.

import { Hono } from 'hono'
import { db, schemaVersion } from '../db.ts'
import { hub } from '../ws/hub.ts'
import { PROTOCOL_VERSION } from '@barpo/shared'

export const healthRoutes = new Hono()

const startedAt = Date.now()

healthRoutes.get('/health', (c) => {
  return c.json({
    ok: true,
    version: PROTOCOL_VERSION,
    schema: schemaVersion(db()),
    wsClients: hub.count,
    uptimeMs: Date.now() - startedAt,
    time: new Date().toISOString(),
  })
})
