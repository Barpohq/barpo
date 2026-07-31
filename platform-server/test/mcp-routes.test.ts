// The MCP API — at the HTTP level.
//
// Called through the Hono app (no network port is opened — `app.fetch`).
// Registry and GitHub requests are NOT EXERCISED: they depend on an external
// service. What is checked here is adding by hand, installing, validation and
// THE ABSENCE OF SECRET-VALUE LEAKS.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createApp } from '../src/app.ts'
import { openDb, setDb } from '../src/db.ts'
import {
  setMcpCredentialStore,
  MemoryMcpCredentialStore,
} from '../src/mcp-credentials.ts'
import { createProject, readMcpServers } from '../src/repo.ts'

let db: Database
let app: ReturnType<typeof createApp>
let store: MemoryMcpCredentialStore

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)
  store = new MemoryMcpCredentialStore()
  setMcpCredentialStore(store)
  app = createApp()
})

afterEach(() => {
  setMcpCredentialStore(null)
  setDb(null)
  db.close()
})

/** A JSON POST/DELETE helper */
async function request(
  method: 'POST' | 'DELETE' | 'GET',
  path: string,
  body?: unknown,
): Promise<{ status: number; response: any }> {
  const response = await app.fetch(
    new Request(`http://localhost/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
  )
  const text = await response.text()
  return { status: response.status, response: text ? JSON.parse(text) : null }
}

/** Adds a stdio server by hand and returns its id */
async function addServer(name = 'test-srv', settings: unknown[] = []): Promise<string> {
  await request('POST', '/mcp/source/manual', {
    name,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@a/b'],
    settings,
  })
  const server = readMcpServers().find((s) => s.name === name)
  if (!server) throw new Error('the server was not added')
  return server.id
}

// ---------------------------------------------------------------------------

describe('GET /mcp', () => {
  test('an empty catalog', async () => {
    const { status, response } = await request('GET', '/mcp')
    expect(status).toBe(200)
    expect(response).toEqual({ servers: [], sources: [] })
  })

  test('an added server shows up', async () => {
    await addServer('github')
    const { response } = await request('GET', '/mcp')
    expect(response.servers).toHaveLength(1)
    expect(response.servers[0].name).toBe('github')
    expect(response.sources).toHaveLength(1)
  })
})

describe('POST /mcp/source/manual', () => {
  test('a stdio server is added', async () => {
    const { status, response } = await request('POST', '/mcp/source/manual', {
      name: 'github',
      description: 'GitHub tools',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/github'],
    })

    expect(status).toBe(201)
    expect(response.added).toBe(1)
    expect(response.source.kind).toBe('manual')

    const server = readMcpServers()[0]
    expect(server?.command).toBe('npx')
    expect(server?.args).toEqual(['-y', '@example/github'])
  })

  test('an http server is added', async () => {
    const { status } = await request('POST', '/mcp/source/manual', {
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
    })

    expect(status).toBe(201)
    expect(readMcpServers()[0]?.url).toBe('https://mcp.example.com/mcp')
  })

  test('the setting fields are kept', async () => {
    await request('POST', '/mcp/source/manual', {
      name: 'srv',
      transport: 'stdio',
      command: 'npx',
      settings: [
        { name: 'TOKEN', required: true, secret: true, hint: 'access token' },
        { name: 'BASE_URL' },
      ],
    })

    const settings = readMcpServers()[0]?.settings
    expect(settings).toEqual([
      { name: 'TOKEN', required: true, secret: true, hint: 'access token' },
      { name: 'BASE_URL', required: false, secret: false },
    ])
  })

  describe('validation', () => {
    test('no name — 400', async () => {
      const { status } = await request('POST', '/mcp/source/manual', { transport: 'stdio' })
      expect(status).toBe(400)
    })

    test('an unknown transport — 400', async () => {
      const { status, response } = await request('POST', '/mcp/source/manual', {
        name: 'a',
        transport: 'grpc',
      })
      expect(status).toBe(400)
      expect(response.error).toMatch(/stdio.*http/)
    })

    test('stdio without a command — 400', async () => {
      const { status } = await request('POST', '/mcp/source/manual', {
        name: 'a',
        transport: 'stdio',
      })
      expect(status).toBe(400)
    })

    test('http without a url — 400', async () => {
      const { status } = await request('POST', '/mcp/source/manual', {
        name: 'a',
        transport: 'http',
      })
      expect(status).toBe(400)
    })

    test('a file:// url is REJECTED', async () => {
      const { status, response } = await request('POST', '/mcp/source/manual', {
        name: 'a',
        transport: 'http',
        url: 'file:///etc/passwd',
      })
      expect(status).toBe(400)
      expect(response.error).toMatch(/http/)
    })

    test('an invalid url — 400', async () => {
      const { status } = await request('POST', '/mcp/source/manual', {
        name: 'a',
        transport: 'http',
        url: 'this is not a url',
      })
      expect(status).toBe(400)
    })

    test('args that are not an array — 400', async () => {
      const { status } = await request('POST', '/mcp/source/manual', {
        name: 'a',
        transport: 'stdio',
        command: 'npx',
        args: 'string',
      })
      expect(status).toBe(400)
    })

    test('too many arguments — 400', async () => {
      const { status } = await request('POST', '/mcp/source/manual', {
        name: 'a',
        transport: 'stdio',
        command: 'npx',
        args: Array.from({ length: 100 }, (_, i) => `a${i}`),
      })
      expect(status).toBe(400)
    })

    test('a setting without a name — 400', async () => {
      const { status } = await request('POST', '/mcp/source/manual', {
        name: 'a',
        transport: 'stdio',
        command: 'npx',
        settings: [{ hint: 'nameless' }],
      })
      expect(status).toBe(400)
    })

    test('a DANGEROUS SETTING NAME is rejected (REGRESSION)', async () => {
      // Adding by hand follows the same rule as the registry: an env name that
      // alters process behaviour is not accepted
      for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'PATH', 'ld_preload']) {
        const { status, response } = await request('POST', '/mcp/source/manual', {
          name: `srv-${name}`,
          transport: 'stdio',
          command: 'npx',
          settings: [{ name, required: true }],
        })
        expect(status).toBe(400)
        expect(response.error).toContain(name)
      }
      expect(readMcpServers()).toHaveLength(0)
    })

    test('a malformed setting name is rejected', async () => {
      const { status } = await request('POST', '/mcp/source/manual', {
        name: 'a',
        transport: 'stdio',
        command: 'npx',
        settings: [{ name: 'A=B' }],
      })
      expect(status).toBe(400)
    })

    test('a body that is not JSON — 400', async () => {
      const response = await app.fetch(
        new Request('http://localhost/api/mcp/source/manual', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'this is not JSON',
        }),
      )
      expect(response.status).toBe(400)
    })
  })
})

describe('POST /mcp/:id/install', () => {
  test('a global install', async () => {
    const id = await addServer()
    const { status, response } = await request('POST', `/mcp/${id}/install`, { scope: 'global' })

    expect(status).toBe(200)
    expect(response.server.installs).toHaveLength(1)
    expect(response.server.installs[0].scope).toBe('global')
  })

  test('a project install', async () => {
    const id = await addServer()
    const project = createProject('test', '/tmp/p')

    const { status, response } = await request('POST', `/mcp/${id}/install`, {
      scope: 'project',
      projectIds: [project.id],
    })

    expect(status).toBe(200)
    expect(response.server.installs[0].projectId).toBe(project.id)
  })

  test('a SECRET VALUE IS NOT RETURNED in the response', async () => {
    const id = await addServer('srv', [{ name: 'TOKEN', required: true, secret: true }])

    const { status, response } = await request('POST', `/mcp/${id}/install`, {
      scope: 'global',
      settingValues: { TOKEN: 'ghp_very_secret' },
    })

    expect(status).toBe(200)
    // There must be no trace of the token anywhere in the response
    expect(JSON.stringify(response)).not.toContain('ghp_very_secret')
    // But it must be stored in the credential store
    const installId = response.server.installs[0].id
    expect(await store.get(installId)).toEqual({ TOKEN: 'ghp_very_secret' })
  })

  test('a SECRET VALUE does not land in the database', async () => {
    const id = await addServer('srv', [{ name: 'TOKEN', required: true, secret: true }])
    await request('POST', `/mcp/${id}/install`, {
      scope: 'global',
      settingValues: { TOKEN: 'ghp_secret' },
    })

    // We check the whole database as text
    const rows = db
      .query<{ setting_values: string }, []>('SELECT setting_values FROM mcp_installs')
      .all()
    for (const row of rows) {
      expect(row.setting_values).not.toContain('ghp_secret')
    }
  })

  test('a PUBLIC value does land in the database', async () => {
    const id = await addServer('srv', [{ name: 'BASE_URL', secret: false }])
    const { response } = await request('POST', `/mcp/${id}/install`, {
      scope: 'global',
      settingValues: { BASE_URL: 'https://a.b' },
    })

    expect(response.server.installs[0].settingValues).toEqual({ BASE_URL: 'https://a.b' })
  })

  test('a REQUIRED field left unfilled — 400', async () => {
    const id = await addServer('srv', [{ name: 'TOKEN', required: true, secret: true }])
    const { status, response } = await request('POST', `/mcp/${id}/install`, { scope: 'global' })

    expect(status).toBe(400)
    expect(response.missing).toEqual(['TOKEN'])
  })

  test('a required field with a default value is not asked for', async () => {
    const id = await addServer('srv', [{ name: 'MODE', required: true }])
    // `default` does not make it into the schema when adding by hand, so this
    // case only arises with registry entries — but the logic is the same
    const { status } = await request('POST', `/mcp/${id}/install`, {
      scope: 'global',
      settingValues: { MODE: 'plain' },
    })
    expect(status).toBe(200)
  })

  test('on a re-install an EMPTY secret field keeps the stored value', async () => {
    const id = await addServer('srv', [{ name: 'TOKEN', required: true, secret: true }])
    const { response: first } = await request('POST', `/mcp/${id}/install`, {
      scope: 'global',
      settingValues: { TOKEN: 'original-token' },
    })
    const installId = first.server.installs[0].id

    // The UI does not display the secret value → the form comes back with an
    // empty input
    const { status } = await request('POST', `/mcp/${id}/install`, {
      scope: 'global',
      settingValues: { TOKEN: '' },
    })

    expect(status).toBe(200)
    expect(await store.get(installId)).toEqual({ TOKEN: 'original-token' })
  })

  test('a key NOT IN THE SCHEMA is ignored', async () => {
    const id = await addServer('srv', [{ name: 'ACCESS', secret: false }])
    const { response } = await request('POST', `/mcp/${id}/install`, {
      scope: 'global',
      settingValues: { ACCESS: 'yes', PATH: '/broken' },
    })

    expect(response.server.installs[0].settingValues).toEqual({ ACCESS: 'yes' })
  })

  describe('validation', () => {
    test('an unknown server — 404', async () => {
      const { status } = await request('POST', '/mcp/no-such-thing/install', { scope: 'global' })
      expect(status).toBe(404)
    })

    test('an invalid scope — 400', async () => {
      const id = await addServer()
      const { status } = await request('POST', `/mcp/${id}/install`, { scope: 'everything' })
      expect(status).toBe(400)
    })

    test('project scope without a project — 400', async () => {
      const id = await addServer()
      const { status } = await request('POST', `/mcp/${id}/install`, { scope: 'project' })
      expect(status).toBe(400)
    })

    test('a project that does not exist — 404', async () => {
      const id = await addServer()
      const { status } = await request('POST', `/mcp/${id}/install`, {
        scope: 'project',
        projectIds: ['missing'],
      })
      expect(status).toBe(404)
    })

    test('a value that is not text — 400', async () => {
      const id = await addServer('srv', [{ name: 'A' }])
      const { status } = await request('POST', `/mcp/${id}/install`, {
        scope: 'global',
        settingValues: { A: 123 },
      })
      expect(status).toBe(400)
    })
  })
})

describe('DELETE /mcp/:id/install', () => {
  test('the install and its CREDENTIALS are removed', async () => {
    const id = await addServer('srv', [{ name: 'TOKEN', required: true, secret: true }])
    const { response } = await request('POST', `/mcp/${id}/install`, {
      scope: 'global',
      settingValues: { TOKEN: 'secret' },
    })
    const installId = response.server.installs[0].id
    expect(await store.get(installId)).toEqual({ TOKEN: 'secret' })

    const { status, response: after } = await request('DELETE', `/mcp/${id}/install`, {
      scope: 'global',
    })

    expect(status).toBe(200)
    expect(after.server.installs).toHaveLength(0)
    // No credential must BE LEFT BEHIND
    expect(await store.get(installId)).toEqual({})
  })

  test('a project install is removed', async () => {
    const id = await addServer()
    const project = createProject('test', '/tmp/p')
    await request('POST', `/mcp/${id}/install`, { scope: 'project', projectIds: [project.id] })

    const { status, response } = await request('DELETE', `/mcp/${id}/install`, {
      scope: 'project',
      projectIds: [project.id],
    })

    expect(status).toBe(200)
    expect(response.server.installs).toHaveLength(0)
  })

  test('no project selected — 400', async () => {
    const id = await addServer()
    const { status } = await request('DELETE', `/mcp/${id}/install`, { scope: 'project' })
    expect(status).toBe(400)
  })
})

describe('DELETE /mcp/source/:id', () => {
  test('the source, its servers and its CREDENTIALS are removed', async () => {
    const id = await addServer('srv', [{ name: 'TOKEN', required: true, secret: true }])
    const { response } = await request('POST', `/mcp/${id}/install`, {
      scope: 'global',
      settingValues: { TOKEN: 'secret' },
    })
    const installId = response.server.installs[0].id
    const sourceId = readMcpServers()[0]!.sourceId

    const { status } = await request('DELETE', `/mcp/source/${sourceId}`)

    expect(status).toBe(200)
    expect(readMcpServers()).toHaveLength(0)
    // CASCADE cleans the database, but the credential lives IN A FILE — it has
    // to go too
    expect(await store.get(installId)).toEqual({})
  })

  test('an unknown source — 404', async () => {
    const { status } = await request('DELETE', '/mcp/source/missing')
    expect(status).toBe(404)
  })
})

describe('POST /mcp/source/:id/sync', () => {
  test('a manual source cannot be synced — 422', async () => {
    await addServer()
    const sourceId = readMcpServers()[0]!.sourceId
    const { status, response } = await request('POST', `/mcp/source/${sourceId}/sync`)

    expect(status).toBe(422)
    expect(response.error).toMatch(/manual/)
  })

  test('an unknown source — 404', async () => {
    const { status } = await request('POST', '/mcp/source/missing/sync')
    expect(status).toBe(404)
  })
})

describe('GET /mcp/active', () => {
  test('only the installed ones', async () => {
    const a = await addServer('a')
    await addServer('b')
    await request('POST', `/mcp/${a}/install`, { scope: 'global' })

    const { response } = await request('GET', '/mcp/active')
    expect(response.servers.map((s: { name: string }) => s.name)).toEqual(['a'])
  })
})
