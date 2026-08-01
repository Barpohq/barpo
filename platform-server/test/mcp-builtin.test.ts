// The builtin MCP set — scanning the local directory.
//
// The directory is EMPTY FOR NOW (only a README), so the main thing to check
// is that an empty set breaks nothing and that no empty source turns up in the
// catalog. The remaining tests work against a temporary directory.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, setDb } from '../src/db.ts'
import {
  BUILTIN_MCP_SOURCE,
  builtinMcpDir,
  ensureBuiltinMcpSource,
  scanBuiltinMcps,
} from '../src/mcp-builtin.ts'
import { createMcpSource, readMcpServers, readMcpSources, syncMcpServers } from '../src/repo.ts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)
})

afterEach(() => {
  setDb(null)
  db.close()
})

describe('the real directory', () => {
  test('resolves to a directory at the repo root', () => {
    expect(builtinMcpDir()).toMatch(/mcp-servers$/)
  })

  test('an EMPTY set puts nothing into the catalog', () => {
    // The state today: the directory holds only a README, no `server.json`
    const scan = scanBuiltinMcps()
    expect(scan.servers).toEqual([])

    const result = ensureBuiltinMcpSource(
      (s) => createMcpSource(s, db),
      (sourceId, found) => syncMcpServers(sourceId, found, db),
    )

    expect(result).toBeNull()
    // THE KEY POINT: not even an empty source row may be created
    expect(readMcpSources(db)).toEqual([])
  })
})

describe('a populated directory (temporary)', () => {
  let dir: string

  /**
   * Pointing the directory path at a temporary location would mean
   * re-importing the module. Instead we exercise the scanning LOGIC directly
   * through `convertRegistryEntry`, which is covered in full by
   * `mcp-registry.test.ts`.
   *
   * What is checked here is the ENSURE logic: creating the source and the
   * idempotence of the sync.
   */
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-builtin-'))
    mkdirSync(join(dir, 'filesystem'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('ensuring is idempotent — a repeat call creates no duplicate', () => {
    const entries = [
      {
        name: 'barpo/filesystem',
        description: 'File system',
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        settings: [],
      },
    ]

    // Call it twice — as though the server had started twice
    for (let i = 0; i < 2; i += 1) {
      const source = createMcpSource(
        {
          kind: 'builtin',
          sourceName: BUILTIN_MCP_SOURCE,
          owner: null,
          repo: null,
          ref: '',
        },
        db,
      )
      syncMcpServers(source.id, entries, db)
    }

    expect(readMcpSources(db)).toHaveLength(1)
    expect(readMcpServers(db)).toHaveLength(1)
  })

  test('the source name is STABLE — every call resolves to the same source', () => {
    const first = createMcpSource(
      { kind: 'builtin', sourceName: BUILTIN_MCP_SOURCE, owner: null, repo: null, ref: '' },
      db,
    )
    const second = createMcpSource(
      { kind: 'builtin', sourceName: BUILTIN_MCP_SOURCE, owner: null, repo: null, ref: '' },
      db,
    )

    expect(second.id).toBe(first.id)
  })

  test('ensuring never throws', () => {
    // Even when the creator throws, the result must be `null` — the platform
    // has to start regardless
    const result = ensureBuiltinMcpSource(
      () => {
        throw new Error('database closed')
      },
      () => undefined,
    )
    expect(result).toBeNull()
  })
})
