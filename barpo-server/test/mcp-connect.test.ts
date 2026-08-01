// Turning a database row into a connection config.
//
// THE KEY CHECKS:
//   1) secret values are added FROM THE CREDENTIAL STORE (not from the DB);
//   2) a project install WINS OVER a global one;
//   3) placeholders ({token}) are substituted;
//   4) keys NOT DECLARED IN THE SCHEMA never reach the env.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { McpServer } from '@barpo/shared'
import { openDb, setDb } from '../src/db.ts'
import {
  MemoryMcpCredentialStore,
  setMcpCredentialStore,
} from '../src/mcp-credentials.ts'
import { buildMcpConfig, connectableServers, pickInstall } from '../src/mcp-connect.ts'
import {
  createMcpSource,
  createProject,
  installMcpServer,
  readMcpServer,
  readMcpServers,
  syncMcpServers,
} from '../src/repo.ts'

let db: Database
let store: MemoryMcpCredentialStore

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)
  store = new MemoryMcpCredentialStore()
  setMcpCredentialStore(store)
})

afterEach(() => {
  setMcpCredentialStore(null)
  setDb(null)
  db.close()
})

/** Creates a stdio server (together with its settings schema) */
function makeServer(
  name = 'github',
  extra: Partial<Parameters<typeof syncMcpServers>[1][number]> = {},
): McpServer {
  const source = createMcpSource({
    kind: 'manual',
    sourceName: name,
    owner: null,
    repo: null,
    ref: '',
  })
  syncMcpServers(source.id, [
    {
      name,
      description: '',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/srv'],
      settings: [],
      ...extra,
    },
  ])
  const server = readMcpServers().find((s) => s.name === name)
  if (!server) throw new Error('the server was not created')
  return server
}

describe('pickInstall', () => {
  test('returns undefined for a server that is not installed', () => {
    const server = makeServer()
    expect(pickInstall(server, null)).toBeUndefined()
  })

  test('a session with no project gets the global install', () => {
    const server = makeServer()
    installMcpServer(server.id, 'global', null, {})
    const fresh = readMcpServer(server.id)!

    expect(pickInstall(fresh, null)?.scope).toBe('global')
  })

  test('a PROJECT install WINS OVER the global one', () => {
    const server = makeServer()
    const project = createProject('test', '/tmp/p1')
    installMcpServer(server.id, 'global', null, { BASE_URL: 'global-url' })
    installMcpServer(server.id, 'project', project.id, { BASE_URL: 'project-url' })
    const fresh = readMcpServer(server.id)!

    const picked = pickInstall(fresh, project.id)
    expect(picked?.scope).toBe('project')
    expect(picked?.settingValues).toEqual({ BASE_URL: 'project-url' })
  })

  test('a different project falls back to the global install', () => {
    const server = makeServer()
    const p1 = createProject('one', '/tmp/p1')
    const p2 = createProject('two', '/tmp/p2')
    installMcpServer(server.id, 'global', null, {})
    installMcpServer(server.id, 'project', p1.id, {})
    const fresh = readMcpServer(server.id)!

    expect(pickInstall(fresh, p2.id)?.scope).toBe('global')
  })
})

describe('buildMcpConfig — stdio', () => {
  test('a server that is not installed yields null', async () => {
    const server = makeServer()
    expect(await buildMcpConfig(server, null)).toBeNull()
  })

  test('the basic config is built', async () => {
    const server = makeServer()
    installMcpServer(server.id, 'global', null, {})
    const fresh = readMcpServer(server.id)!

    const config = await buildMcpConfig(fresh, null)
    expect(config).toEqual({
      id: server.id,
      name: 'github',
      config: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/srv'],
        env: {},
      },
    })
  })

  test('a SECRET value is added to the env from the credential store', async () => {
    const server = makeServer('github', {
      settings: [{ name: 'GITHUB_TOKEN', required: true, secret: true }],
    })
    const installId = installMcpServer(server.id, 'global', null, {})
    await store.save(installId, { GITHUB_TOKEN: 'ghp_secret' })
    const fresh = readMcpServer(server.id)!

    const config = await buildMcpConfig(fresh, null)
    expect(config?.config.env).toEqual({ GITHUB_TOKEN: 'ghp_secret' })
  })

  test('OPEN and SECRET values are merged', async () => {
    const server = makeServer('srv', {
      settings: [
        { name: 'BASE_URL', required: false, secret: false },
        { name: 'TOKEN', required: true, secret: true },
      ],
    })
    const installId = installMcpServer(server.id, 'global', null, { BASE_URL: 'https://a.b' })
    await store.save(installId, { TOKEN: 'secret' })
    const fresh = readMcpServer(server.id)!

    const config = await buildMcpConfig(fresh, null)
    expect(config?.config.env).toEqual({ BASE_URL: 'https://a.b', TOKEN: 'secret' })
  })

  test('a default value has the lowest precedence', async () => {
    const server = makeServer('srv', {
      settings: [{ name: 'MODE', required: false, secret: false, default: 'normal' }],
    })
    installMcpServer(server.id, 'global', null, {})
    let fresh = readMcpServer(server.id)!
    expect((await buildMcpConfig(fresh, null))?.config.env).toEqual({ MODE: 'normal' })

    // What the user typed wins
    installMcpServer(server.id, 'global', null, { MODE: 'fast' })
    fresh = readMcpServer(server.id)!
    expect((await buildMcpConfig(fresh, null))?.config.env).toEqual({ MODE: 'fast' })
  })

  test('a key NOT IN THE SCHEMA never reaches the env', async () => {
    const server = makeServer('srv', {
      settings: [{ name: 'ALLOWED', required: false, secret: false }],
    })
    // Even if a stray key was written into the database by hand (a leftover
    // from an older schema, say) it must not be handed to the process
    installMcpServer(server.id, 'global', null, {
      ALLOWED: 'yes',
      PATH: '/broken',
      LD_PRELOAD: '/dangerous.so',
    })
    const fresh = readMcpServer(server.id)!

    const env = (await buildMcpConfig(fresh, null))?.config.env
    expect(env).toEqual({ ALLOWED: 'yes' })
    expect(env).not.toHaveProperty('PATH')
    expect(env).not.toHaveProperty('LD_PRELOAD')
  })

  test('an empty value does not reach the env', async () => {
    const server = makeServer('srv', {
      settings: [{ name: 'OPTIONAL', required: false, secret: false }],
    })
    installMcpServer(server.id, 'global', null, { OPTIONAL: '' })
    const fresh = readMcpServer(server.id)!

    expect((await buildMcpConfig(fresh, null))?.config.env).toEqual({})
  })

  test('a PLACEHOLDER inside an argument is substituted', async () => {
    const server = makeServer('srv', {
      args: ['-y', '@example/srv', '--token', '{token}'],
      settings: [{ name: 'token', required: true, secret: true }],
    })
    const installId = installMcpServer(server.id, 'global', null, {})
    await store.save(installId, { token: 'secret-value' })
    const fresh = readMcpServer(server.id)!

    const config = await buildMcpConfig(fresh, null)
    expect(config?.config.args).toEqual(['-y', '@example/srv', '--token', 'secret-value'])
  })

  test('a stdio server with no command yields null', async () => {
    // The DB CHECK already blocks this, but the protection should be two-layered
    const server = makeServer()
    installMcpServer(server.id, 'global', null, {})
    const fresh = { ...readMcpServer(server.id)!, command: undefined }

    expect(await buildMcpConfig(fresh, null)).toBeNull()
  })
})

describe('buildMcpConfig — http', () => {
  function makeHttpServer(name = 'remote', settings: McpServer['settings'] = []) {
    const source = createMcpSource({
      kind: 'manual',
      sourceName: name,
      owner: null,
      repo: null,
      ref: '',
    })
    syncMcpServers(source.id, [
      {
        name,
        description: '',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        settings,
      },
    ])
    return readMcpServers().find((s) => s.name === name)!
  }

  test('the url and headers are built', async () => {
    const server = makeHttpServer('remote', [
      { name: 'Authorization', required: true, secret: true },
    ])
    const installId = installMcpServer(server.id, 'global', null, {})
    await store.save(installId, { Authorization: 'Bearer secret' })
    const fresh = readMcpServer(server.id)!

    const config = await buildMcpConfig(fresh, null)
    expect(config?.config).toEqual({
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer secret' },
    })
  })

  test('an http server with no headers works too', async () => {
    const server = makeHttpServer()
    installMcpServer(server.id, 'global', null, {})
    const fresh = readMcpServer(server.id)!

    expect((await buildMcpConfig(fresh, null))?.config.headers).toEqual({})
  })
})

describe('connectableServers', () => {
  test('only installed servers come back', async () => {
    const a = makeServer('a')
    makeServer('b') // not installed
    installMcpServer(a.id, 'global', null, {})

    const result = await connectableServers(readMcpServers(), null)
    expect(result.map((s) => s.name)).toEqual(['a'])
  })

  test('an empty list gives an empty result', async () => {
    expect(await connectableServers([], null)).toEqual([])
  })

  test('the list is filtered by project', async () => {
    const a = makeServer('a')
    const project = createProject('test', '/tmp/p')
    installMcpServer(a.id, 'project', project.id, {})

    // In a session with no project this server is not global, so no config is found
    expect(await connectableServers(readMcpServers(), null)).toEqual([])
    expect(await connectableServers(readMcpServers(), project.id)).toHaveLength(1)
  })
})
