// Hono ilovasi — barcha REST route'lar shu yerda yig'iladi.
//
// YANGI ROUTE QO'SHISH (keyingi agentlar uchun):
//   1) `src/routes/<nom>.ts` faylida `export const <nom>Routes = new Hono()`,
//   2) shu faylga bitta import qatori,
//   3) pastdagi ro'yxatga `api.route('/', <nom>Routes)` qatori.
// Boshqa hech narsani o'zgartirish shart emas. Hamma route `/api` prefiksi
// ostida turadi — vite proxy ham shu prefiksni serverga uzatadi.

import { Hono } from 'hono'
import { appsRoutes } from './routes/apps.ts'
import { auditRoutes } from './routes/audit.ts'
import { chatRoutes } from './routes/chat.ts'
import { healthRoutes } from './routes/health.ts'
import { modelsRoutes } from './routes/models.ts'
import { projectsRoutes } from './routes/projects.ts'
import { serversRoutes } from './routes/servers.ts'
import { skillsRoutes } from './routes/skills.ts'

export function appYarat(): Hono {
  const app = new Hono()
  const api = new Hono()

  api.route('/', healthRoutes)
  api.route('/', appsRoutes)
  api.route('/', serversRoutes)
  api.route('/', skillsRoutes)
  api.route('/', auditRoutes)
  api.route('/', chatRoutes)
  api.route('/', modelsRoutes)
  api.route('/', projectsRoutes)
  // ↑ yangi route modullari shu yerga qo'shiladi

  app.route('/api', api)

  app.notFound((c) => c.json({ error: 'Topilmadi', path: c.req.path }, 404))

  app.onError((xato, c) => {
    console.error('[xato]', c.req.method, c.req.path, xato)
    return c.json({ error: 'Ichki server xatosi', detail: String(xato) }, 500)
  })

  return app
}

export const app = appYarat()
