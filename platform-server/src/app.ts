// The Hono application — every REST route is assembled here.
//
// ADDING A NEW ROUTE (for the agents that come next):
//   1) in `src/routes/<name>.ts` put `export const <name>Routes = new Hono()`,
//   2) one import line in this file,
//   3) an `api.route('/', <name>Routes)` line in the list below.
// Nothing else needs changing. Every route sits under the `/api` prefix — the
// vite proxy forwards that same prefix to the server.

import { Hono } from 'hono'
import { appsRoutes } from './routes/apps.ts'
import { auditRoutes } from './routes/audit.ts'
import { chatRoutes } from './routes/chat.ts'
import { healthRoutes } from './routes/health.ts'
import { mcpRoutes } from './routes/mcp.ts'
import { modelsRoutes } from './routes/models.ts'
import { projectsRoutes } from './routes/projects.ts'
import { serversRoutes } from './routes/servers.ts'
import { skillsRoutes } from './routes/skills.ts'

export function createApp(): Hono {
  const app = new Hono()
  const api = new Hono()

  api.route('/', healthRoutes)
  api.route('/', appsRoutes)
  api.route('/', serversRoutes)
  api.route('/', skillsRoutes)
  api.route('/', mcpRoutes)
  api.route('/', auditRoutes)
  api.route('/', chatRoutes)
  api.route('/', modelsRoutes)
  api.route('/', projectsRoutes)
  // ↑ new route modules are added here

  app.route('/api', api)

  app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404))

  app.onError((error, c) => {
    console.error('[error]', c.req.method, c.req.path, error)
    return c.json({ error: 'Internal server error', detail: String(error) }, 500)
  })

  return app
}

export const app = createApp()
