// MCP servers: the database layer.
//
// Network requests (registry, GitHub) are NOT EXERCISED — they depend on an
// external service. What is checked here is the logic that runs AFTER they
// return: the catalog UPSERT, the scope, and the install ids (the credential
// key is built from them).
//
// The same pattern as `skills.test.ts` — the MCP model has the same shape.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { McpCatalogEntry } from '@platforma/shared'
import { openDb, setDb } from '../src/db.ts'
import {
  activeMcpServers,
  createProject,
  deleteMcpSource,
  readMcpSources,
  createMcpSource,
  syncMcpServers,
  readMcpServers,
  readMcpServer,
  installMcpServer,
  uninstallMcpServer,
} from '../src/repo.ts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)
})

afterEach(() => {
  setDb(null)
  db.close()
})

type RawEntry = Omit<McpCatalogEntry, 'id' | 'sourceId' | 'createdAt'>

/** A stdio server entry — the shape used most often in the tests */
function stdioEntry(name = 'github', extra: Partial<RawEntry> = {}): RawEntry {
  return {
    name,
    description: `${name} tools`,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', `@example/${name}`],
    settings: [],
    ...extra,
  }
}

/** Creates a source plus one server, returning the server id */
function sourceAndServer(name = 'github') {
  const source = createMcpSource({
    kind: 'manual',
    sourceName: name,
    owner: null,
    repo: null,
    ref: '',
  })
  syncMcpServers(source.id, [stdioEntry(name)])
  const server = readMcpServers().find((s) => s.name === name)
  if (!server) throw new Error('the server was not created')
  return { source, server }
}

describe('sources', () => {
  test('connecting twice returns the existing one', () => {
    const a = createMcpSource({ kind: 'github', sourceName: 'o/r', owner: 'o', repo: 'r', ref: '' })
    const b = createMcpSource({ kind: 'github', sourceName: 'o/r', owner: 'o', repo: 'r', ref: '' })
    expect(b.id).toBe(a.id)
    expect(readMcpSources()).toHaveLength(1)
  })

  test('a different kind means a separate source', () => {
    createMcpSource({ kind: 'github', sourceName: 'x', owner: 'o', repo: 'r', ref: '' })
    createMcpSource({ kind: 'manual', sourceName: 'x', owner: null, repo: null, ref: '' })
    expect(readMcpSources()).toHaveLength(2)
  })

  test('a different ref means a separate source', () => {
    createMcpSource({ kind: 'github', sourceName: 'o/r', owner: 'o', repo: 'r', ref: '' })
    createMcpSource({ kind: 'github', sourceName: 'o/r', owner: 'o', repo: 'r', ref: 'dev' })
    expect(readMcpSources()).toHaveLength(2)
  })

  test('removing a source removes its servers too (CASCADE)', () => {
    const { source } = sourceAndServer()
    expect(readMcpServers()).toHaveLength(1)
    expect(deleteMcpSource(source.id)).toBe(true)
    expect(readMcpServers()).toHaveLength(0)
  })
})

describe('syncing', () => {
  test('added / updated / deleted are counted', () => {
    const source = createMcpSource({
      kind: 'github',
      sourceName: 'o/r',
      owner: 'o',
      repo: 'r',
      ref: '',
    })

    const first = syncMcpServers(source.id, [stdioEntry('a'), stdioEntry('b')])
    expect(first).toEqual({ added: 2, updated: 0, deleted: 0 })

    // 'a' stayed (updated), 'b' vanished, 'c' was added
    const second = syncMcpServers(source.id, [stdioEntry('a'), stdioEntry('c')])
    expect(second).toEqual({ added: 1, updated: 1, deleted: 1 })
    expect(readMcpServers().map((s) => s.name)).toEqual(['a', 'c'])
  })

  test('the UPSERT keeps the id — the install is not lost', () => {
    const { source, server } = sourceAndServer()
    installMcpServer(server.id, 'global', null, {})

    // Re-sync with a changed description
    syncMcpServers(source.id, [stdioEntry('github', { description: 'new description' })])

    const after = readMcpServer(server.id)
    expect(after?.id).toBe(server.id)
    expect(after?.description).toBe('new description')
    expect(after?.installs).toHaveLength(1)
  })

  test('the last sync time is recorded', () => {
    const { source } = sourceAndServer()
    const updated = readMcpSources().find((s) => s.id === source.id)
    expect(updated?.lastSync).toBeTruthy()
  })

  test('args and settings round-trip through JSON', () => {
    const source = createMcpSource({ kind: 'manual', sourceName: 'x', owner: null, repo: null, ref: '' })
    syncMcpServers(source.id, [
      stdioEntry('x', {
        args: ['-y', '@a/b', '--flag'],
        settings: [
          { name: 'TOKEN', required: true, secret: true, hint: 'access token' },
          { name: 'BASE_URL', required: false, secret: false, default: 'https://a.b' },
        ],
      }),
    ])

    const server = readMcpServers()[0]
    expect(server?.args).toEqual(['-y', '@a/b', '--flag'])
    expect(server?.settings).toHaveLength(2)
    expect(server?.settings[0]).toMatchObject({ name: 'TOKEN', secret: true, required: true })
  })

  test('an http transport is stored with its url', () => {
    const source = createMcpSource({ kind: 'manual', sourceName: 'h', owner: null, repo: null, ref: '' })
    syncMcpServers(source.id, [
      {
        name: 'remote',
        description: '',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        settings: [],
      },
    ])
    const server = readMcpServers()[0]
    expect(server?.transport).toBe('http')
    expect(server?.url).toBe('https://mcp.example.com/mcp')
    expect(server?.command).toBeUndefined()
  })

  test('stdio without a command does not reach the database (CHECK)', () => {
    const source = createMcpSource({ kind: 'manual', sourceName: 'b', owner: null, repo: null, ref: '' })
    expect(() =>
      syncMcpServers(source.id, [
        { name: 'broken', description: '', transport: 'stdio', settings: [] },
      ]),
    ).toThrow()
  })

  test('http without a url does not reach the database (CHECK)', () => {
    const source = createMcpSource({ kind: 'manual', sourceName: 'b', owner: null, repo: null, ref: '' })
    expect(() =>
      syncMcpServers(source.id, [
        { name: 'broken', description: '', transport: 'http', settings: [] },
      ]),
    ).toThrow()
  })
})

describe('installing', () => {
  test('a global install returns an id and is not duplicated', () => {
    const { server } = sourceAndServer()
    const id1 = installMcpServer(server.id, 'global', null, {})
    const id2 = installMcpServer(server.id, 'global', null, {})
    expect(id2).toBe(id1)
    expect(readMcpServer(server.id)?.installs).toHaveLength(1)
  })

  test('re-installing updates the setting values', () => {
    const { server } = sourceAndServer()
    const id = installMcpServer(server.id, 'global', null, { BASE_URL: 'https://a' })
    const newId = installMcpServer(server.id, 'global', null, { BASE_URL: 'https://b' })

    expect(newId).toBe(id)
    const install = readMcpServer(server.id)?.installs[0]
    expect(install?.settingValues).toEqual({ BASE_URL: 'https://b' })
  })

  test('one server installs separately at global and project scope', () => {
    const { server } = sourceAndServer()
    const project = createProject('test', '/tmp/test-project')

    const globalId = installMcpServer(server.id, 'global', null, {})
    const projectId = installMcpServer(server.id, 'project', project.id, { BASE_URL: 'https://p' })

    expect(projectId).not.toBe(globalId)
    expect(readMcpServer(server.id)?.installs).toHaveLength(2)
  })

  test('uninstalling returns the id', () => {
    const { server } = sourceAndServer()
    const id = installMcpServer(server.id, 'global', null, {})

    expect(uninstallMcpServer(server.id, 'global', null)).toBe(id)
    expect(uninstallMcpServer(server.id, 'global', null)).toBeNull()
    expect(readMcpServer(server.id)?.installs).toHaveLength(0)
  })
})

describe('activeMcpServers', () => {
  test('global only — a session without a project', () => {
    const { server } = sourceAndServer('a')
    const { server: b } = sourceAndServer('b')
    installMcpServer(server.id, 'global', null, {})

    const active = activeMcpServers(null)
    expect(active.map((s) => s.name)).toEqual(['a'])
    expect(active.find((s) => s.id === b.id)).toBeUndefined()
  })

  test('global + project are merged, without duplicates', () => {
    const { server: a } = sourceAndServer('a')
    const { server: b } = sourceAndServer('b')
    const project = createProject('test', '/tmp/test-project-2')

    installMcpServer(a.id, 'global', null, {})
    // `a` is installed in both places — it must appear ONCE in the list
    installMcpServer(a.id, 'project', project.id, {})
    installMcpServer(b.id, 'project', project.id, {})

    const active = activeMcpServers(project.id)
    expect(active.map((s) => s.name)).toEqual(['a', 'b'])
  })

  test("another project's server is not included", () => {
    const { server } = sourceAndServer('a')
    const p1 = createProject('one', '/tmp/p1')
    const p2 = createProject('two', '/tmp/p2')
    installMcpServer(server.id, 'project', p1.id, {})

    expect(activeMcpServers(p2.id)).toHaveLength(0)
    expect(activeMcpServers(p1.id)).toHaveLength(1)
  })

  test('a server that is not installed is not active', () => {
    sourceAndServer('a')
    expect(activeMcpServers(null)).toHaveLength(0)
    expect(readMcpServers()).toHaveLength(1)
  })
})
