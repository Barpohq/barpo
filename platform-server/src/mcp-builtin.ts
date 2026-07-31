// The builtin MCP servers that ship with the platform.
//
// THE SAME pattern and the same reasoning as `builtin-skills.ts`: the builtin
// set also passes through as an ordinary catalog entry, only its SOURCE is
// different — not GitHub, but the `mcp-servers/` directory inside the repo.
// The catalog, install and UI flows do not know the kind of the source.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ EMPTY FOR NOW — DELIBERATELY.                                        │
// │                                                                      │
// │ The infrastructure gets built, the content is filled in later:       │
// │ "which MCP server does the platform recommend" is a product          │
// │ question, not a technical one.                                       │
// │                                                                      │
// │ While the directory is empty `ensureBuiltinMcpSource()` returns      │
// │ `null` and nothing shows up in the catalog. On the day the first     │
// │ `server.json` is added it appears automatically — no code change is  │
// │ needed.                                                              │
// └──────────────────────────────────────────────────────────────────────┘
//
// THE DIFFERENCE FROM SKILLS: there is NO store layer. Installing a skill
// copies files onto disk; an MCP server has no files to copy — `server.json`
// is metadata only, it lands in the database, and the process fetches its own
// package with `npx`/`uvx`. Which is why no counterpart to `builtinToStore()`
// is needed.

import type { McpCatalogEntry } from '@platforma/shared'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { convertRegistryEntry, type RegistryServerEntry } from './mcp-registry.ts'

/**
 * The `sourceName` value of the source row.
 *
 * `createMcpSource` detects duplicates by `(kind, source_name, ref)`, so this
 * value MUST BE STABLE — otherwise a new source would be created on every
 * start-up.
 */
export const BUILTIN_MCP_SOURCE = 'platforma-builtin'

/**
 * The directory the builtin MCP servers live in (inside the repo).
 *
 * `platform-server/src/...` → two levels up → the monorepo root. It sits
 * alongside the `skills/` directory.
 */
export function builtinMcpDir(): string {
  return join(dirname(dirname(import.meta.dir)), 'mcp-servers')
}

export interface BuiltinMcpScanResult {
  servers: Omit<McpCatalogEntry, 'id' | 'sourceId' | 'createdAt'>[]
  warnings: string[]
}

/**
 * Scans the local `mcp-servers/` directory.
 *
 * Each directory is expected to hold one `server.json` (the official publish
 * format) — THE SAME schema as `mcp-github.ts` and the registry use, which is
 * why `convertRegistryEntry()` is reused.
 *
 * DOES NOT THROW: when the directory is missing or a file is corrupt it
 * returns an empty list. The platform works perfectly well without the
 * builtin set.
 */
export function scanBuiltinMcps(): BuiltinMcpScanResult {
  const root = builtinMcpDir()
  const warnings: string[] = []
  const servers: BuiltinMcpScanResult['servers'] = []

  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    // The directory has not been created yet — a normal state
    return { servers, warnings }
  }

  for (const dir of dirs.sort()) {
    const serverJson = join(root, dir, 'server.json')
    try {
      if (!statSync(join(root, dir)).isDirectory() || !existsSync(serverJson)) continue
    } catch {
      continue
    }

    let raw: string
    try {
      raw = readFileSync(serverJson, 'utf8')
    } catch {
      // One unreadable file does not cost us the rest
      continue
    }

    let data: RegistryServerEntry
    try {
      data = JSON.parse(raw) as RegistryServerEntry
    } catch {
      warnings.push(`${dir}: server.json is not JSON`)
      continue
    }

    const entry = convertRegistryEntry(data)
    if (!entry) {
      warnings.push(`${dir}: no launch method could be determined`)
      continue
    }

    servers.push(entry)
  }

  return { servers, warnings }
}

/**
 * Writes/updates the builtin MCP source in the catalog.
 *
 * Called ON EVERY START-UP (the same reason as `ensureBuiltinSource`: when
 * the platform is updated, the set is updated with it). The operation is
 * idempotent — `createMcpSource` finds the source by name, and
 * `syncMcpServers` performs an UPSERT that PRESERVES EXISTING INSTALLS.
 *
 * `null` for an empty set — DELIBERATELY: an empty source row would show up
 * in the catalog and create an empty group that displays nothing in the UI.
 *
 * DOES NOT THROW: if the catalog cannot be written, the platform still starts.
 */
export function ensureBuiltinMcpSource(
  createSource: (s: {
    kind: 'builtin'
    sourceName: string
    owner: null
    repo: null
    ref: string
  }) => { id: string },
  syncServers: (
    sourceId: string,
    found: Omit<McpCatalogEntry, 'id' | 'sourceId' | 'createdAt'>[],
  ) => unknown,
): { sourceId: string; count: number } | null {
  try {
    const scan = scanBuiltinMcps()
    if (scan.servers.length === 0) return null

    const source = createSource({
      kind: 'builtin',
      sourceName: BUILTIN_MCP_SOURCE,
      owner: null,
      repo: null,
      ref: '',
    })

    syncServers(source.id, scan.servers)

    return { sourceId: source.id, count: scan.servers.length }
  } catch {
    return null
  }
}
