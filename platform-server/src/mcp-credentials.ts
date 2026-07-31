// MCP server credentials — secret setting values (tokens, API keys).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY NOT IN THE DATABASE.                                             │
// │                                                                      │
// │ The SQLite file gets backed up, copied around, sometimes exported;   │
// │ the result of `SELECT * FROM mcp_installs` can end up in a           │
// │ diagnostic log. A token must not escape along any of those routes.   │
// │                                                                      │
// │ Hence the same decision as `FileCredentialStore` in                  │
// │ `credentials.ts`: a separate file, `chmod 600`, readable only by the │
// │ platform process. What stays in the database is the NON-SECRET       │
// │ values (`mcp_installs.setting_values`) — `BASE_URL`, for example.    │
// └──────────────────────────────────────────────────────────────────────┘
//
// WHY WE DID NOT REUSE `FileCredentialStore`. It implements pi-ai's
// `CredentialStore` interface: it is provider-centric (`read(providerId)`),
// its `Credential` type splits into `oauth`/`api_key`, and `modify` is meant
// for the OAuth refresh flow. For MCP a plain `Record<string, string>` (env
// name → value) per install is enough — the interface does not fit. The
// PATTERN, though, is reproduced exactly: a single JSON file, an `enqueue()`
// serialisation chain, `chmod 600`.
//
// THE KEY IS THE INSTALL ID, not the server id. One MCP server can be
// installed in several places (globally plus a number of projects) and each
// of them needs its own token: two projects might use the same GitHub MCP
// server with tokens granting access to different repositories.

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The on-disk shape: install id → { env name → value } */
type FileShape = Record<string, Record<string, string>>

/**
 * Path to the credentials file — overridable through `PLATFORM_MCP_CREDENTIALS`.
 *
 * The tests point it at a temporary directory through that env var (the same
 * pattern as `PLATFORM_SKILLS` and `PLATFORM_SSH`) — otherwise a test run
 * would overwrite the user's real credentials file.
 */
export function mcpCredentialsPath(): string {
  const env = process.env.PLATFORM_MCP_CREDENTIALS?.trim()
  if (env) return env
  return join(homedir(), '.platforma', 'mcp-credentials.json')
}

export interface McpCredentialStore {
  /** The secret values of a single install. An empty object when there are none. */
  get(installId: string): Promise<Record<string, string>>
  /**
   * Saves the values.
   *
   * AN EMPTY VALUE MEANS DELETE-NOTHING: when the user leaves a secret field
   * blank, it is not written. The reason: the UI NEVER shows a secret value
   * back (the input appears empty), so "I did not change it" also arrives as
   * an empty string. If we stored empty strings, the existing token would be
   * wiped every time the form was opened — which is why `save` only updates
   * the keys it was GIVEN and leaves the blank ones untouched.
   */
  save(installId: string, values: Record<string, string>): Promise<void>
  remove(installId: string): Promise<void>
}

export class FileMcpCredentialStore implements McpCredentialStore {
  /** A sequential execution queue — save/remove attach to this chain */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private path: string = mcpCredentialsPath()) {}

  async get(installId: string): Promise<Record<string, string>> {
    const file = await this.readFile()
    return file[installId] ?? {}
  }

  async save(installId: string, values: Record<string, string>): Promise<void> {
    await this.enqueue(async () => {
      const file = await this.readFile()
      const existing = file[installId] ?? {}
      for (const [name, value] of Object.entries(values)) {
        // An empty value means "I did not change it" (see the comment above)
        if (!value) continue
        existing[name] = value
      }
      if (Object.keys(existing).length === 0) return
      file[installId] = existing
      await this.writeFile(file)
    })
  }

  async remove(installId: string): Promise<void> {
    await this.enqueue(async () => {
      const file = await this.readFile()
      if (!(installId in file)) return
      delete file[installId]
      await this.writeFile(file)
    })
  }

  /** Puts the operation on the queue — an error does not break the chain */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async readFile(): Promise<FileShape> {
    try {
      const text = await Bun.file(this.path).text()
      const value = JSON.parse(text) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
      return value as FileShape
    } catch {
      // The file is missing or corrupt — we start from an empty store
      return {}
    }
  }

  private async writeFile(file: FileShape): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true })
    await Bun.write(this.path, JSON.stringify(file, null, 2))
    // Tokens are secret: only the owner may read them
    try {
      await Bun.$`chmod 600 ${this.path}`.quiet()
    } catch {
      // If chmod does not work (on Windows, say) — not critical
    }
  }
}

/** An in-memory store — for the tests */
export class MemoryMcpCredentialStore implements McpCredentialStore {
  private stored = new Map<string, Record<string, string>>()

  async get(installId: string): Promise<Record<string, string>> {
    return { ...(this.stored.get(installId) ?? {}) }
  }

  async save(installId: string, values: Record<string, string>): Promise<void> {
    const existing = this.stored.get(installId) ?? {}
    for (const [name, value] of Object.entries(values)) {
      if (!value) continue
      existing[name] = value
    }
    if (Object.keys(existing).length > 0) this.stored.set(installId, existing)
  }

  async remove(installId: string): Promise<void> {
    this.stored.delete(installId)
  }
}

/**
 * The global store — the same pattern as `db()`: a single instance, swapped
 * out in the tests with `setMcpCredentialStore()`.
 */
let store: McpCredentialStore | null = null

export function mcpCredentialStore(): McpCredentialStore {
  if (!store) store = new FileMcpCredentialStore()
  return store
}

/** For the tests: replace the store (`null` restores the default) */
export function setMcpCredentialStore(next: McpCredentialStore | null): void {
  store = next
}
