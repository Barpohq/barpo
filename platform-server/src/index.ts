// Entry point: a Hono REST app plus the WebSocket hub inside a single Bun.serve.
//
// Why a single port? The UI dev server (vite) proxies both `/api` and `/ws` to
// one address, and in production it is one process too — so there is no CORS
// problem and no second port to manage.

import { killAllMcpProcesses, liveProcessCount } from '@platforma/ai'
import { app } from './app.ts'
import { auditWrite } from './audit.ts'
import { db } from './db.ts'
import { ensureBuiltinMcpSource } from './mcp-builtin.ts'
import {
  createSkillSource,
  createMcpSource,
  syncMcpServers,
  syncSkills,
} from './repo.ts'
import { ensureBuiltinSource } from './builtin-skills.ts'
import { chatSendHandler } from './ws/chat-handler.ts'
import { applySeed } from './seed.ts'
import { hub, newConnectionState, type ConnectionState } from './ws/hub.ts'

const PORT = Number(process.env.PORT ?? 8787)

// 1) Database: open + migrations (automatic inside db()) + seed
const database = db()
const seed = applySeed(database)
if (seed.audit || seed.apps) {
  console.log(
    `[seed] initial data written: ${seed.audit} audit · ${seed.apps} apps`,
  )
}

// 1b) The builtin skills that ship with the platform — into the catalog.
//
// UNLIKE the seed, this runs on every startup: when the platform is updated
// the skills have to be updated too (new ones added, descriptions changed).
// The operation is idempotent — existing installs are preserved.
const builtin = ensureBuiltinSource(
  (s) => createSkillSource(s, database),
  (sourceId, found, sha) => syncSkills(sourceId, found, sha, database),
)
if (builtin) {
  console.log(`[skill] builtin skills in the catalog: ${builtin.count}`)
}

// 1c) The builtin MCP servers that ship with the platform — into the catalog.
//
// The same rule as for skills (idempotent, on every startup). For now the
// `mcp-servers/` directory is empty, which means this returns `null` and
// nothing shows up in the catalog — the plumbing is waiting for the first
// `server.json` to be added (see the comment in `mcp-builtin.ts`).
const builtinMcp = ensureBuiltinMcpSource(
  (s) => createMcpSource(s, database),
  (sourceId, found) => syncMcpServers(sourceId, found, database),
)
if (builtinMcp) {
  console.log(`[mcp] builtin servers in the catalog: ${builtinMcp.count}`)
}

// 2) Wire the chat.send events arriving over WS into the orchestrator.
//    (REST /api/chat/send takes the very same path — the two give an identical
//    result, and the client picks whichever is more convenient.)
hub.addHandler(chatSendHandler)

// 3) The server: HTTP requests go to Hono, /ws gets upgraded
//
// The second generic parameter is the `routes` paths (a union of string
// literals). We do not use `routes`: every path reaches Hono through `fetch`.
// That is why `never` is passed — it means "there are no routes".
const server = Bun.serve<ConnectionState, never>({
  port: PORT,

  fetch(req, srv) {
    const url = new URL(req.url)

    if (url.pathname === '/ws') {
      const ok = srv.upgrade(req, { data: newConnectionState() })
      if (ok) return undefined // the upgrade succeeded — the WS layer replies
      return new Response('WebSocket upgrade required', { status: 426 })
    }

    return app.fetch(req)
  },

  websocket: {
    open(ws) {
      hub.connected(ws)
    },
    message(ws, message) {
      hub.messageReceived(ws, typeof message === 'string' ? message : message.toString())
    },
    close(ws) {
      hub.disconnected(ws)
    },
  },
})

console.log(`[platform] http://localhost:${server.port}  ·  ws://localhost:${server.port}/ws`)

auditWrite('platform', 'Server started', `port ${server.port}`, 'read', 'OK')

// A clean shutdown: close the database so the WAL gets checkpointed
function stop(signal: string) {
  console.log(`\n[platform] ${signal} — shutting down...`)
  server.stop()
  // MCP processes — THE LAST LINE OF DEFENCE. `process.exit()` does not kill
  // child processes: they would be orphaned and keep running in the
  // background (see the registry comment in `mcp-transport.ts`).
  const mcpCount = liveProcessCount()
  if (mcpCount > 0) {
    console.log(`[mcp] stopping ${mcpCount} process(es)`)
    killAllMcpProcesses()
  }
  database.close()
  process.exit(0)
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
