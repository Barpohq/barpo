// The MCP credential store — secret values are kept OUTSIDE the database.
//
// The most important behaviour: AN EMPTY VALUE DELETES NOTHING. The UI never
// shows a secret value back, so "I did not change it" arrives as an empty
// input — if we saved the empty string, the token would be wiped every time
// the form was opened.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileMcpCredentialStore,
  mcpCredentialStore,
  mcpCredentialsPath,
  MemoryMcpCredentialStore,
  setMcpCredentialStore,
} from '../src/mcp-credentials.ts'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-cred-'))
  path = join(dir, 'credentials.json')
  process.env.PLATFORM_MCP_CREDENTIALS = path
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.PLATFORM_MCP_CREDENTIALS
  setMcpCredentialStore(null)
})

describe('credentials path', () => {
  test('uses the env var when one is set', () => {
    expect(mcpCredentialsPath()).toBe(path)
  })

  test('falls back to the home directory when the env var is absent', () => {
    delete process.env.PLATFORM_MCP_CREDENTIALS
    expect(mcpCredentialsPath()).toContain('.platforma')
    expect(mcpCredentialsPath()).toContain('mcp-kredensiallar.json')
  })
})

describe('FileMcpCredentialStore', () => {
  test('reads back a value it saved', async () => {
    const store = new FileMcpCredentialStore(path)
    await store.save('install-1', { TOKEN: 'secret-value' })
    expect(await store.get('install-1')).toEqual({ TOKEN: 'secret-value' })
  })

  test('returns an empty object for an unknown install', async () => {
    const store = new FileMcpCredentialStore(path)
    expect(await store.get('missing')).toEqual({})
  })

  test('keeps separate installs isolated from each other', async () => {
    const store = new FileMcpCredentialStore(path)
    await store.save('a', { TOKEN: 'first' })
    await store.save('b', { TOKEN: 'second' })

    expect(await store.get('a')).toEqual({ TOKEN: 'first' })
    expect(await store.get('b')).toEqual({ TOKEN: 'second' })
  })

  test('AN EMPTY VALUE does not wipe the stored one', async () => {
    const store = new FileMcpCredentialStore(path)
    await store.save('a', { TOKEN: 'original' })
    // The user resubmitted the form without touching the secret field
    await store.save('a', { TOKEN: '' })
    expect(await store.get('a')).toEqual({ TOKEN: 'original' })
  })

  test('a partial update leaves the other keys in place', async () => {
    const store = new FileMcpCredentialStore(path)
    await store.save('a', { TOKEN: 'one', PASSWORD: 'two' })
    await store.save('a', { TOKEN: 'new' })

    expect(await store.get('a')).toEqual({ TOKEN: 'new', PASSWORD: 'two' })
  })

  test('saving only empty values does not create the file at all', async () => {
    const store = new FileMcpCredentialStore(path)
    await store.save('a', { TOKEN: '' })
    expect(existsSync(path)).toBe(false)
  })

  test('removing an install only takes out its own entry', async () => {
    const store = new FileMcpCredentialStore(path)
    await store.save('a', { TOKEN: 'one' })
    await store.save('b', { TOKEN: 'two' })

    await store.remove('a')
    expect(await store.get('a')).toEqual({})
    expect(await store.get('b')).toEqual({ TOKEN: 'two' })
  })

  test('removing an entry that does not exist is not an error', async () => {
    const store = new FileMcpCredentialStore(path)
    await store.remove('missing')
    expect(await store.get('missing')).toEqual({})
  })

  test('the file is readable by its owner only (600)', async () => {
    const store = new FileMcpCredentialStore(path)
    await store.save('a', { TOKEN: 'secret' })

    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('a corrupt file opens as an empty store', async () => {
    await Bun.write(path, 'this is not JSON {{{')
    const store = new FileMcpCredentialStore(path)
    expect(await store.get('a')).toEqual({})

    // Writing over it keeps working
    await store.save('a', { TOKEN: 'new' })
    expect(await store.get('a')).toEqual({ TOKEN: 'new' })
  })

  test('a file holding an array is also treated as an empty store', async () => {
    await Bun.write(path, '[1,2,3]')
    const store = new FileMcpCredentialStore(path)
    expect(await store.get('a')).toEqual({})
  })

  test('concurrent saves are queued — no write is lost', async () => {
    const store = new FileMcpCredentialStore(path)
    // Without the queue these writes would overwrite one another:
    // both would read the old file and write their own copy over it.
    await Promise.all([
      store.save('a', { TOKEN: 'one' }),
      store.save('b', { TOKEN: 'two' }),
      store.save('c', { TOKEN: 'three' }),
    ])

    expect(await store.get('a')).toEqual({ TOKEN: 'one' })
    expect(await store.get('b')).toEqual({ TOKEN: 'two' })
    expect(await store.get('c')).toEqual({ TOKEN: 'three' })
  })
})

describe('MemoryMcpCredentialStore', () => {
  test('behaves the same way as the file store', async () => {
    const store = new MemoryMcpCredentialStore()
    await store.save('a', { TOKEN: 'one' })
    expect(await store.get('a')).toEqual({ TOKEN: 'one' })

    await store.save('a', { TOKEN: '' })
    expect(await store.get('a')).toEqual({ TOKEN: 'one' })

    await store.remove('a')
    expect(await store.get('a')).toEqual({})
  })

  test('returns a copy — mutating it does not change what is stored', async () => {
    const store = new MemoryMcpCredentialStore()
    await store.save('a', { TOKEN: 'one' })

    const values = await store.get('a')
    values.TOKEN = 'corrupted'
    expect(await store.get('a')).toEqual({ TOKEN: 'one' })
  })
})

describe('the global store', () => {
  test('returns the store it was given, and the default once reset', async () => {
    const fake = new MemoryMcpCredentialStore()
    setMcpCredentialStore(fake)
    expect(mcpCredentialStore()).toBe(fake)

    setMcpCredentialStore(null)
    expect(mcpCredentialStore()).not.toBe(fake)
  })
})
