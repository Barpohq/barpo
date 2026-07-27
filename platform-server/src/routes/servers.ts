// Serverlar ro'yxati — Servers.tsx sahifasi uchun.
// Keyingi bosqichda qiymatlar daemon telemetriyasidan real vaqtda yangilanadi.

import { Hono } from 'hono'
import { serverlarOqi } from '../repo.ts'

export const serversRoutes = new Hono()

serversRoutes.get('/servers', (c) => {
  return c.json({ servers: serverlarOqi() })
})
