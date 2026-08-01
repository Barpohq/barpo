// Official MCP registry client — https://registry.modelcontextprotocol.io
//
// The same rules as `github.ts`: a timeout on every request, precise error
// messages, no trust in external data.
//
// THE DIFFERENCES:
//   - there is NO authentication and no published rate limit (open API);
//   - PAGINATION goes through `cursor`;
//   - the `isLatest` FILTER IS MANDATORY (see below).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THE SAME SCHEMA AS THE `server.json` CONVENTION.                     │
// │                                                                      │
// │ The `server` object the registry returns and the `server.json` file  │
// │ at a repo root have THE SAME JSON shape (the official publish        │
// │ format). That is why `convertRegistryEntry()` is used for both       │
// │ sources (`mcp-github.ts`) — the conversion logic lives in one place. │
// └──────────────────────────────────────────────────────────────────────┘

import type { McpCatalogEntry, McpSettingField } from '@barpo/shared'

const REGISTRY_API = 'https://registry.modelcontextprotocol.io/v0/servers'
const TIMEOUT_MS = 30_000

/** The largest number of entries a single search returns */
export const MAX_REGISTRY_RESULTS = 50

/** A hard cap on the pagination loop — so it can never spin forever */
const MAX_PAGES = 10

// ---------------------------------------------------------------------------
// The registry schema (the part we need)
// ---------------------------------------------------------------------------

/** `KeyValueInput` — the description of an env variable or an HTTP header */
export interface RegistryInput {
  name?: string
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  default?: string
  /** May be a template: `Bearer {api_key}` */
  value?: string
}

/** `Argument` — positional or named */
export interface RegistryArgument {
  type?: 'positional' | 'named'
  name?: string
  value?: string
  isRequired?: boolean
}

export interface RegistryPackage {
  registryType?: string
  registryBaseUrl?: string
  identifier?: string
  version?: string
  /** `npx` | `uvx` | `docker` — which launcher to use */
  runtimeHint?: string
  transport?: { type?: string }
  runtimeArguments?: RegistryArgument[]
  packageArguments?: RegistryArgument[]
  environmentVariables?: RegistryInput[]
}

export interface RegistryRemote {
  type?: string
  url?: string
  headers?: RegistryInput[]
}

export interface RegistryServerEntry {
  /** Reverse-DNS: `io.github.owner/repo` */
  name?: string
  description?: string
  title?: string
  version?: string
  packages?: RegistryPackage[]
  remotes?: RegistryRemote[]
}

interface RegistryResponse {
  servers?: {
    server?: RegistryServerEntry
    _meta?: {
      'io.modelcontextprotocol.registry/official'?: { isLatest?: boolean; status?: string }
    }
  }[]
  metadata?: { nextCursor?: string }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Searches the registry.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ THE `isLatest` FILTER IS MANDATORY — verified against the live API.  │
 * │                                                                      │
 * │ The registry returns a separate entry for EVERY VERSION of the same  │
 * │ server (`com.example/github` 1.0.3, 1.0.4, 1.0.5 …). Without the     │
 * │ filter the user would see the same name ten times in the list.       │
 * │                                                                      │
 * │ We test `isLatest !== false` (not `=== true`): when the field is     │
 * │ absent altogether we DO NOT DROP the entry — if the API changes the  │
 * │ shape of its metadata later, the catalog must not go empty.          │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * THROWS — the caller (the route) turns the error into a 502.
 */
export async function registrySearch(
  term: string,
  limit = 30,
): Promise<RegistryServerEntry[]> {
  const result: RegistryServerEntry[] = []
  const seenNames = new Set<string>()
  let cursor: string | undefined
  let page = 0

  do {
    const url = new URL(REGISTRY_API)
    if (term.trim()) url.searchParams.set('search', term.trim())
    url.searchParams.set('limit', String(Math.min(limit, MAX_REGISTRY_RESULTS)))
    if (cursor) url.searchParams.set('cursor', cursor)

    let response: Response
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      // A network error or a timeout — make the reason explicit
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Could not reach the MCP registry: ${reason}`)
    }

    if (!response.ok) {
      throw new Error(`MCP registry error: ${response.status} ${response.statusText}`)
    }

    let data: RegistryResponse
    try {
      data = (await response.json()) as RegistryResponse
    } catch {
      throw new Error('The MCP registry response is not JSON')
    }

    for (const entry of data.servers ?? []) {
      const server = entry.server
      if (!server?.name) continue
      const meta = entry._meta?.['io.modelcontextprotocol.registry/official']
      if (meta?.isLatest === false) continue
      // Do not let the same name arrive twice (a guard for entries with no metadata)
      if (seenNames.has(server.name)) continue
      seenNames.add(server.name)
      result.push(server)
      if (result.length >= limit) return result
    }

    cursor = data.metadata?.nextCursor
    page += 1
  } while (cursor && page < MAX_PAGES)

  return result
}

// ---------------------------------------------------------------------------
// Conversion into the catalog shape
// ---------------------------------------------------------------------------

type RawEntry = Omit<McpCatalogEntry, 'id' | 'sourceId' | 'createdAt'>

/**
 * Whether a setting name is acceptable.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ THE FIRST OF TWO PROTECTIVE LAYERS.                                  │
 * │                                                                      │
 * │ The entry is in THIRD-PARTY hands: it may put any name it likes into │
 * │ `environmentVariables[].name`. With a name such as `NODE_OPTIONS` or │
 * │ `LD_PRELOAD` it would take over the process of a TRUSTED package     │
 * │ (details: the `FORBIDDEN_ENV` comment in                             │
 * │ `barpo-ai/src/mcp-transport.ts`).                                 │
 * │                                                                      │
 * │ Such a field NEVER ENTERS THE CATALOG AT ALL — it must not show up   │
 * │ in the UI as an ordinary setting. The second layer (the transport)   │
 * │ checks it anyway, but not showing the user a bogus field matters     │
 * │ just as much.                                                        │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * The shape is checked too: plain characters are enough for an env name or
 * an HTTP header name. A name containing `=`, a space or a newline is never
 * legitimate under any circumstances.
 *
 * Exported — the tests and `routes/mcp.ts` (manual add) use it as well, so
 * the rule lives in a single place.
 */
export function isValidSettingName(name: string): boolean {
  if (!name || name.length > 200) return false
  // Letters, digits, `_` and `-` only (HTTP headers use `-`)
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return false
  return !DANGEROUS_SETTING_NAMES.has(name.toUpperCase())
}

/**
 * Names that are kept out of the catalog.
 *
 * This must STAY IN STEP with `FORBIDDEN_ENV` in `mcp-transport.ts`. The two
 * lists are deliberately separate: this package does not depend on
 * `barpo-ai` (a layer boundary), yet both serve the same purpose. The
 * transport layer is the final arbiter; here we make sure the entry never
 * reaches the catalog in the first place.
 */
const DANGEROUS_SETTING_NAMES = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'BUN_INSPECT',
  'BUN_INSPECT_CONNECT_TO',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PATH',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
  'SHELL',
  'IFS',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
])

/**
 * `KeyValueInput` → our own setting field.
 *
 * Returns `null` when the name is not acceptable — the caller skips it.
 */
function convertInput(k: RegistryInput): McpSettingField | null {
  if (!k.name) return null
  if (!isValidSettingName(k.name)) return null
  const field: McpSettingField = {
    name: k.name,
    required: k.isRequired === true,
    secret: k.isSecret === true,
  }
  if (k.description) field.hint = k.description
  if (k.default) field.default = k.default
  return field
}

/**
 * `Argument` → a piece of the command line.
 *
 * A named argument becomes two pieces (`--flag`, `value`) — `Bun.spawn`
 * works with an argv ARRAY, so they have to be separate elements. Joined
 * into one string (`--flag value`) the server would take it as a single
 * argument.
 */
function convertArgument(a: RegistryArgument): string[] {
  if (a.type === 'named' && a.name) {
    return a.value ? [a.name, a.value] : [a.name]
  }
  return a.value ? [a.value] : []
}

/**
 * Works out the launch command.
 *
 * When `runtimeHint` is present we trust it. Otherwise we infer it from the
 * package type — that is the convention in force across the ecosystem
 * (`npm` → `npx`, `pypi` → `uvx`, `oci` → `docker`).
 */
function detectCommand(pkg: RegistryPackage): string | null {
  if (pkg.runtimeHint) return pkg.runtimeHint
  switch (pkg.registryType) {
    case 'npm':
      return 'npx'
    case 'pypi':
      return 'uvx'
    case 'oci':
      return 'docker'
    default:
      // For `nuget`, `mcpb` and the rest the launcher is unknown — we skip
      // the entry rather than guess and create a broken one.
      return null
  }
}

/**
 * Converts a registry (or `server.json`) entry into the catalog shape.
 *
 * THE FIRST matching variant wins: a stdio package first, and a remote
 * connection if none is found. When a server advertises both, stdio is
 * preferred — a local process does not depend on an external service and is
 * faster.
 *
 * A `null` return means the entry is unusable (no package, no remote, or an
 * unknown launcher). The caller skips it and adds a warning.
 */
export function convertRegistryEntry(s: RegistryServerEntry): RawEntry | null {
  if (!s.name) return null

  const description = s.description ?? ''
  const settings = (inputs?: RegistryInput[]): McpSettingField[] =>
    (inputs ?? []).map(convertInput).filter((f): f is McpSettingField => f !== null)

  for (const pkg of s.packages ?? []) {
    // stdio only: other transport kinds do not appear inside a package, but
    // if they show up in future it would be wrong to silently treat them as
    // stdio.
    if (pkg.transport?.type && pkg.transport.type !== 'stdio') continue
    if (!pkg.identifier) continue

    const command = detectCommand(pkg)
    if (!command) continue

    const args = [
      ...(pkg.runtimeArguments ?? []).flatMap(convertArgument),
      // The package identifier: the `@a/b` in `npx -y @a/b`. For Docker this
      // is the image name (`ghcr.io/x/y:1.0`).
      pkg.identifier,
      ...(pkg.packageArguments ?? []).flatMap(convertArgument),
    ]

    return {
      name: s.name,
      description,
      transport: 'stdio',
      command,
      args,
      settings: settings(pkg.environmentVariables),
    }
  }

  for (const remote of s.remotes ?? []) {
    if (!remote.url) continue
    // `streamable-http` and `sse` — one transport handles both
    if (remote.type && remote.type !== 'streamable-http' && remote.type !== 'sse') {
      continue
    }
    return {
      name: s.name,
      description,
      transport: 'http',
      url: remote.url,
      settings: settings(remote.headers),
    }
  }

  return null
}

/**
 * Substitutes placeholders: `Bearer {api_key}` → `Bearer sk-…`.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ NO SHELL IS INVOLVED. The substitution is a plain text operation and │
 * │ the result becomes an element of the `Bun.spawn` argv ARRAY. That is,│
 * │ text such as `;rm -rf ~` inside a value is never executed as a       │
 * │ command.                                                             │
 * │                                                                      │
 * │ This is what the official MCP spec recommends (the warning in the    │
 * │ `Argument` definition).                                              │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Names inside `{...}` come in various shapes (`{api_key}`, `{API_KEY}`) —
 * the comparison ignores case and ignores `_`/`-`, because registry entries
 * are not consistent about them.
 */
export function substitutePlaceholders(
  text: string,
  values: Record<string, string>,
): string {
  if (!text.includes('{')) return text

  // Build a map with the keys normalised
  const map = new Map<string, string>()
  for (const [name, value] of Object.entries(values)) {
    map.set(name.toLowerCase().replace(/[_-]/g, ''), value)
  }

  return text.replace(/\{([\w.-]+)\}/g, (whole, name: string) => {
    const value = map.get(name.toLowerCase().replace(/[_-]/g, ''))
    // When nothing is found we leave it UNCHANGED: an empty string would
    // make the server read it as "the argument is empty" rather than "the
    // argument was not given", and its error message would mislead.
    return value ?? whole
  })
}
