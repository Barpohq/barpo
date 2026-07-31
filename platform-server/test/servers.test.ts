// The servers API flow — adding (with key installation), deleting, metrics.
// SSH commands go through a fake runner, files live in a temporary folder.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { Server, ServerMetrics } from '@platforma/shared'
import { app } from '../src/app.ts'
import { openDb, setDb } from '../src/db.ts'
import { readServers } from '../src/repo.ts'
import { setCommandRunner, managedConfigPath, type CommandResult } from '../src/ssh.ts'
import { hub } from '../src/ws/hub.ts'

let db: Database
let dir: string
let calls: string[][]

const OK: CommandResult = { code: 0, stdout: '', stderr: '' }
const DENIED: CommandResult = { code: 255, stdout: '', stderr: 'Permission denied (publickey).' }

/** The default fake runner: every ssh call succeeds */
function fakeRunner(reply: (argv: string[]) => CommandResult = () => OK) {
  setCommandRunner(async (argv) => {
    calls.push(argv)
    return reply(argv)
  })
}

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)
  dir = mkdtempSync(join(tmpdir(), 'platforma-srv-'))
  process.env.PLATFORM_SSH = join(dir, 'ssh')
  process.env.PLATFORM_USER_SSH_CONFIG = join(dir, 'user-config')
  mkdirSync(join(dir, 'ssh'), { recursive: true })
  writeFileSync(join(dir, 'ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAATEST platforma\n')
  calls = []
  fakeRunner()
})

afterEach(() => {
  setCommandRunner(null)
  delete process.env.PLATFORM_SSH
  delete process.env.PLATFORM_USER_SSH_CONFIG
  rmSync(dir, { recursive: true, force: true })
  setDb(null)
  hub.clear()
  db.close()
})

async function post(path: string, body: unknown) {
  const response = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('POST /api/servers', () => {
  test('the full flow: the key is installed and the database and config are written', async () => {
    const { status, body } = await post('/api/servers', {
      name: 'test-1',
      host: '203.0.113.10',
      port: 22,
      username: 'root',
    })

    expect(status).toBe(201)
    const server = body.server as Server
    expect(server.name).toBe('test-1')
    expect(body.connectionError).toBeUndefined()

    // The database
    expect(readServers(db)).toHaveLength(1)

    // The managed config and the Include
    const config = readFileSync(managedConfigPath(), 'utf-8')
    expect(config).toContain('Host test-1')
    expect(config).toContain('HostName 203.0.113.10')
    const userConfig = readFileSync(join(dir, 'user-config'), 'utf-8')
    expect(userConfig).toContain(`Include ${managedConfigPath()}`)
  })

  test('the port defaults to 22 and the username to root', async () => {
    const { status, body } = await post('/api/servers', { name: 's2', host: 'ex.uz' })
    expect(status).toBe(201)
    const server = body.server as Server
    expect(server.port).toBe(22)
    expect(server.username).toBe('root')
  })

  test('an invalid name gives a 400 and nothing reaches the config or the database', async () => {
    const { status } = await post('/api/servers', { name: 'bad name!', host: 'ex.uz' })
    expect(status).toBe(400)
    expect(readServers(db)).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('an invalid port gives a 400', async () => {
    const { status } = await post('/api/servers', { name: 's', host: 'ex.uz', port: 99999 })
    expect(status).toBe(400)
  })

  test('a duplicate name gives a 409', async () => {
    await post('/api/servers', { name: 'duplicate', host: 'ex.uz' })
    const { status } = await post('/api/servers', { name: 'duplicate', host: 'other.uz' })
    expect(status).toBe(409)
    expect(readServers(db)).toHaveLength(1)
  })

  test('when the connection fails it gives a 502 and NO row is left behind', async () => {
    fakeRunner(() => DENIED)
    const { status, body } = await post('/api/servers', { name: 'unreachable', host: 'far.uz' })
    expect(status).toBe(502)
    expect(String(body.detail)).toContain('Enter a password')
    expect(readServers(db)).toHaveLength(0)
  })
})

describe('DELETE /api/servers/:id', () => {
  test('it deletes the server and removes it from the config', async () => {
    const { body } = await post('/api/servers', { name: 'departing', host: 'ex.uz' })
    const server = body.server as Server

    const response = await app.request(`/api/servers/${server.id}`, { method: 'DELETE' })
    expect(response.status).toBe(200)

    expect(readServers(db)).toHaveLength(0)
    const config = readFileSync(managedConfigPath(), 'utf-8')
    expect(config).not.toContain('Host departing')
  })

  test('an unknown id gives a 404', async () => {
    const response = await app.request('/api/servers/no-such-id', { method: 'DELETE' })
    expect(response.status).toBe(404)
  })
})

describe('GET /api/servers/:id/metrics', () => {
  test('it returns live metrics', async () => {
    const { body } = await post('/api/servers', { name: 'metric', host: 'ex.uz' })
    const server = body.server as Server

    fakeRunner((argv) =>
      argv[0] === 'ssh'
        ? { code: 0, stdout: 'UPTIME=up 2 hours\nLOAD=0.5\nNPROC=2\nRAM=100 25\nDISK=200 100\n', stderr: '' }
        : OK,
    )

    const response = await app.request(`/api/servers/${server.id}/metrics`)
    expect(response.status).toBe(200)
    const { metrics } = (await response.json()) as { metrics: ServerMetrics }
    expect(metrics.status).toBe('connected')
    expect(metrics.uptime).toBe('2 hours')
    expect(metrics.cpu).toBe(25)
    expect(metrics.ram).toBe(25)
    expect(metrics.disk).toBe(50)
  })

  test('when the connection fails the status is error but the HTTP status is still 200', async () => {
    const { body } = await post('/api/servers', { name: 'offline', host: 'ex.uz' })
    const server = body.server as Server

    fakeRunner(() => ({ code: 255, stdout: '', stderr: 'Connection timed out' }))

    const response = await app.request(`/api/servers/${server.id}/metrics`)
    expect(response.status).toBe(200)
    const { metrics } = (await response.json()) as { metrics: ServerMetrics }
    expect(metrics.status).toBe('error')
    expect(metrics.error).toContain('timed out')
  })

  test('an unknown id gives a 404', async () => {
    const response = await app.request('/api/servers/no-such-id/metrics')
    expect(response.status).toBe(404)
  })
})
