// A file-backed CredentialStore — pi-ai reads and writes provider API keys
// and OAuth tokens through this interface.
//
// Why our own file? pi-ai refreshes an OAuth token automatically once it has
// expired and writes the result back through `modify`. We keep our state in
// our own file, and read the initial token from the local files
// (local-auth.ts).
//
// BUT: OpenAI rotates the refresh token — after a refresh the old one is
// revoked. If we stored the new token only on our side, the token in
// ~/.codex would die and `codex` in the terminal would stop working. That is
// why for the codex provider we also write the refreshed token back to the
// source file (source-sync.ts). This is a deliberate exception: since the
// two programs share one subscription, both must know the latest token.
//
// `modify` is the only write path and it is serialised: if two requests
// arrive at the same time, the second waits for the first. Otherwise both
// would try to refresh with the old refresh_token and one of them would end
// up with a revoked token.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { writeToCodex } from './source-sync.ts'

/** Providers that get written back to the source file */
const CODEX_ID = 'openai-codex'

/** The on-disk shape: provider id → credential */
type StoreFile = Record<string, Credential>

export class FileCredentialStore implements CredentialStore {
  private path: string
  /** The sequential execution queue — modify/delete chain onto it */
  private queue: Promise<unknown> = Promise.resolve()
  /** Disables syncing to the source file (for tests) */
  private syncToSource: boolean
  /** Home directory — tests pass a temporary directory */
  private home: string | undefined

  constructor(path: string, options?: { syncToSource?: boolean; home?: string }) {
    this.path = path
    this.syncToSource = options?.syncToSource ?? true
    this.home = options?.home
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const file = await this.readConfigFile()
    return file[providerId]
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const file = await this.readConfigFile()
    return Object.entries(file).map(([providerId, c]) => ({ providerId, type: c.type }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const file = await this.readConfigFile()
      const updated = await fn(file[providerId])
      if (updated === undefined) return file[providerId] // left unchanged
      file[providerId] = updated
      await this.writeFile(file)
      // Write it back to the source file too — otherwise the refresh_token in
      // ~/.codex is left dead after a rotation. Because we are inside the
      // queue, two writes never run at the same time.
      this.writeBackToSource(providerId, updated)
      return updated
    })
  }

  /**
   * Writes the refreshed token back to the source program's file.
   * Never throws — even if the sync fails, the token is stored in our own
   * store and the platform keeps working.
   */
  private writeBackToSource(providerId: string, credential: Credential): void {
    if (!this.syncToSource) return
    if (providerId !== CODEX_ID || credential.type !== 'oauth') return
    try {
      writeToCodex(credential, this.home)
    } catch {
      // writeToCodex does not throw either; this is an extra layer of defence
    }
  }

  async delete(providerId: string): Promise<void> {
    await this.enqueue(async () => {
      const file = await this.readConfigFile()
      if (!(providerId in file)) return
      delete file[providerId]
      await this.writeFile(file)
    })
  }

  /** Puts an action on the queue — the chain survives an error */
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async readConfigFile(): Promise<StoreFile> {
    try {
      const text = await Bun.file(this.path).text()
      const value = JSON.parse(text) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
      return value as StoreFile
    } catch {
      // the file is missing or corrupt — start from an empty store
      return {}
    }
  }

  private async writeFile(file: StoreFile): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true })
    await Bun.write(this.path, JSON.stringify(file, null, 2))
    // API keys are secret: only the owner may read them
    try {
      await Bun.$`chmod 600 ${this.path}`.quiet()
    } catch {
      // if chmod does not work (Windows, for instance) — not critical
    }
  }
}

/** An in-memory store — for tests */
export class MemoryCredentialStore implements CredentialStore {
  private stored = new Map<string, Credential>()
  private queue: Promise<unknown> = Promise.resolve()

  async read(providerId: string): Promise<Credential | undefined> {
    return this.stored.get(providerId)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Array.from(this.stored, ([providerId, c]) => ({ providerId, type: c.type }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const action = async () => {
      const updated = await fn(this.stored.get(providerId))
      if (updated === undefined) return this.stored.get(providerId)
      this.stored.set(providerId, updated)
      return updated
    }
    const result = this.queue.then(action, action)
    this.queue = result.catch(() => undefined)
    return result
  }

  async delete(providerId: string): Promise<void> {
    this.stored.delete(providerId)
  }
}
