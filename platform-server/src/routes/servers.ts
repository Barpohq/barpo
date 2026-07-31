// Servers — machines managed over SSH.
//
// Adding a server means SETTING UP passwordless access:
//   1) the platform key is placed into the server's authorized_keys
//      (using an existing key, or a one-off password if there is none — ssh.ts),
//   2) the record lands in the database,
//   3) the managed ssh config is rewritten + an Include in ~/.ssh/config —
//      after which `ssh <name>` works passwordless in the terminal as well.
//
// THE PASSWORD IS NOT STORED: it is handed to sshpass through the environment
// for the duration of this one request and is gone once the response returns.
// Only host/port/user go into the database.
//
// Live state (metrics) has its own endpoint and is read over SSH on every
// request — it is not stored, because a stale value would be a
// "trustworthy-looking lie".

import { Hono } from 'hono'
import { auditWrite } from '../audit.ts'
import {
  serverById,
  serverByName,
  deleteServer,
  createServer,
  readServers,
} from '../repo.ts'
import {
  writeManagedConfig,
  ensureInclude,
  installKey,
  fetchMetrics,
  checkConnection,
} from '../ssh.ts'

export const serversRoutes = new Hono()

// The name is an ssh alias: a strict allowlist, otherwise uncontrolled text
// ends up in a config file and on a command line. Lower case is not required,
// but no other character is allowed.
const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/
// Host — a domain name or an IP (including ':' for IPv6). No spaces or quotes.
const HOST_REGEX = /^[a-zA-Z0-9.:_-]{1,253}$/
// The Unix username rule
const USER_REGEX = /^[a-z_][a-z0-9_-]{0,31}$/

serversRoutes.get('/servers', (c) => {
  return c.json({ servers: readServers() })
})

serversRoutes.post('/servers', async (c) => {
  let body: {
    name?: unknown
    host?: unknown
    port?: unknown
    username?: unknown
    password?: unknown
  }
  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const username = typeof body.username === 'string' && body.username.trim() !== ''
    ? body.username.trim()
    : 'root'
  const port = body.port === undefined || body.port === '' ? 22 : Number(body.port)
  const password =
    typeof body.password === 'string' && body.password !== '' ? body.password : undefined

  if (!NAME_REGEX.test(name)) {
    return c.json(
      {
        error: 'Invalid server name',
        detail: "Must start with a letter or digit and contain only letters, digits, '-' and '_' (up to 40 characters)",
      },
      400,
    )
  }
  if (!HOST_REGEX.test(host)) {
    return c.json({ error: 'Invalid host', detail: 'Enter a domain name or IP address' }, 400)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return c.json({ error: 'Invalid port', detail: 'An integer between 1 and 65535' }, 400)
  }
  if (!USER_REGEX.test(username)) {
    return c.json({ error: 'Invalid username' }, 400)
  }

  if (serverByName(name)) {
    return c.json({ error: 'A server with this name already exists', detail: name }, 409)
  }

  // The key is installed first, the database record second: if the connection
  // cannot be made at all, no "server that does not work" row should be left
  // behind in the database.
  try {
    await installKey({ host, port, username }, password)
  } catch (error) {
    auditWrite('user', 'Server connection failed', `${username}@${host}`, 'write', 'denied')
    return c.json(
      { error: 'Could not connect to the server', detail: error instanceof Error ? error.message : String(error) },
      502,
    )
  }

  const server = createServer({ name, host, port, username })

  // The config is rebuilt from the FULL list in the database — a single source
  // of truth.
  writeManagedConfig(readServers())
  ensureInclude()

  // Final confirmation: now through the alias, using only the platform key.
  // Even if it fails the server stays saved — the user sees the state on the
  // card, and there is no need to undo the addition.
  let connectionError: string | undefined
  try {
    await checkConnection(name)
  } catch (error) {
    connectionError = error instanceof Error ? error.message : String(error)
  }

  auditWrite(
    'user',
    'Server connected — SSH key installed',
    `${name} (${username}@${host})`,
    'write',
    connectionError ? 'pending' : 'OK',
  )

  return c.json({ server, connectionError }, 201)
})

serversRoutes.delete('/servers/:id', (c) => {
  const id = c.req.param('id')
  const server = serverById(id)
  if (!server) {
    return c.json({ error: 'Server not found', detail: id }, 404)
  }

  deleteServer(id)
  writeManagedConfig(readServers())

  auditWrite('user', 'Server removed', server.name, 'write')

  // The key STAYS on the server itself — removing it would require connecting
  // to the server, and the server being deleted may be precisely the one that
  // is unreachable. The UI tells the user this.
  return c.json({ ok: true, note: `The platform key stays in authorized_keys on ${server.name}` })
})

serversRoutes.get('/servers/:id/metrics', async (c) => {
  const id = c.req.param('id')
  const server = serverById(id)
  if (!server) {
    return c.json({ error: 'Server not found', detail: id }, 404)
  }

  // fetchMetrics never throws — an error state is an ordinary response too
  const metrics = await fetchMetrics(server.name)
  return c.json({ metrics })
})
