// Scanning MCP server entries out of a GitHub repository.
//
// The same pattern as `scanSource` in `skill-store.ts`, but with NO TARBALL:
// an MCP server has no files that land on disk. All we need is the METADATA
// (`server.json`) — the process later downloads its own package with
// `npx`/`uvx`. In other words there is no store layer here at all.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ `server.json` IS THE OFFICIAL PUBLISH FORMAT and is IDENTICAL to the │
// │ registry schema. That is why `convertRegistryEntry()` is reused:     │
// │ two sources, one converter.                                          │
// │                                                                      │
// │ We search THE WHOLE TREE, not just the root. Verified: in            │
// │ `github/github-mcp-server` and `cloudflare/mcp-server-cloudflare`    │
// │ the file sits at the root, but in monorepos                          │
// │ (`modelcontextprotocol/servers`) it is NOT at the root — it may live │
// │ in a nested directory.                                               │
// └──────────────────────────────────────────────────────────────────────┘

import type { McpCatalogEntry } from '@platforma/shared'
import { findFiles, type GithubRef, readBlob, repoInfo } from './github.ts'
import { convertRegistryEntry, type RegistryServerEntry } from './mcp-registry.ts'

/** A `server.json` inside a directory or at the root (case-insensitive) */
const SERVER_JSON_PATTERN = /(^|\/)server\.json$/i

/**
 * The largest number of files read from a single repository.
 *
 * The same reason as `MAX_SCAN_FILES` in `skill-store.ts`: every file costs
 * one blob request and the rate limit is 60/hour (unauthenticated). The MCP
 * limit is LOWER — there is usually only one or two `server.json` files, and
 * more than ten means this is not an MCP repository but something else (a
 * collection of configuration files that happen to be named `server.json`,
 * say).
 */
export const MAX_MCP_SCAN_FILES = 10

export interface McpScanResult {
  ref: string
  sha: string
  servers: Omit<McpCatalogEntry, 'id' | 'sourceId' | 'createdAt'>[]
  warnings: string[]
}

/**
 * Reads the `server.json` files in a repository and turns them into catalog
 * entries.
 *
 * THROWS only when the repository cannot be reached at all (404, rate limit).
 * A single broken file does not cost us the rest — a warning is added instead
 * (the same rule as in `skill-store.ts`).
 */
export async function scanMcpSource(r: GithubRef): Promise<McpScanResult> {
  const warnings: string[] = []
  const { ref, sha } = await repoInfo(r)
  const { files, truncated } = await findFiles(r, ref, SERVER_JSON_PATTERN)

  if (truncated) {
    warnings.push('Repository too large — the file list is incomplete')
  }

  let list = files
  if (list.length > MAX_MCP_SCAN_FILES) {
    warnings.push(
      `Found ${list.length} server.json files, read the first ${MAX_MCP_SCAN_FILES}`,
    )
    list = list.slice(0, MAX_MCP_SCAN_FILES)
  }

  const servers: McpScanResult['servers'] = []
  const seenNames = new Set<string>()

  for (const file of list) {
    let raw: string
    try {
      raw = await readBlob(r, file.sha)
    } catch {
      // One unreadable file does not cost us the rest
      warnings.push(`${file.path}: could not be read`)
      continue
    }

    let data: RegistryServerEntry
    try {
      data = JSON.parse(raw) as RegistryServerEntry
    } catch {
      warnings.push(`${file.path}: not JSON — skipped`)
      continue
    }

    // A file named `server.json` can be all sorts of things (an old MCP
    // configuration, or a file belonging to an entirely different project).
    // The MCP publish format requires `name` and either `packages` or
    // `remotes` — without them this is not our file.
    if (!data.name) {
      warnings.push(`${file.path}: no "name" — not an MCP server descriptor`)
      continue
    }

    const entry = convertRegistryEntry(data)
    if (!entry) {
      warnings.push(
        `${file.path}: no launch method could be determined (missing packages/remotes or unknown type)`,
      )
      continue
    }

    // When the same name appears twice in one repository (duplicated inside a
    // monorepo, say) the first one stays — the UNIQUE index in the database
    // would reject the second anyway, but here we can say so out loud.
    if (seenNames.has(entry.name)) {
      warnings.push(`${file.path}: duplicate name "${entry.name}" — skipped`)
      continue
    }
    seenNames.add(entry.name)
    servers.push(entry)
  }

  if (servers.length === 0 && warnings.length === 0) {
    warnings.push('No `server.json` found in the repository')
  }

  return { ref, sha, servers, warnings }
}
