// Does the credential store write the refreshed token back to the source file?
//
// This is the most important link: when pi-ai refreshes, it writes the result
// through `modify`, and from there we update ~/.codex/auth.json. If this does
// not work, `codex` in the terminal is left with a dead token after a
// rotation.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Credential } from '@earendil-works/pi-ai'
import { FileCredentialStore } from '../src/credentials.ts'

let home: string
let storePath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'barpo-store-'))
  storePath = join(home, 'store', 'ai-auth.json')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'old-a', refresh_token: 'old-r', id_token: 'old-id' },
    }),
    { mode: 0o600 },
  )
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function readCodex(): Record<string, any> {
  return JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8'))
}

const fresh: Credential = {
  type: 'oauth',
  access: 'rotated-a',
  refresh: 'rotated-r',
  expires: Date.now() + 86_400_000,
}

describe('FileCredentialStore source syncing', () => {
  test('when openai-codex is updated ~/.codex/auth.json is updated too', async () => {
    const store = new FileCredentialStore(storePath, { home })

    await store.modify('openai-codex', async () => fresh)

    expect(readCodex().tokens.refresh_token).toBe('rotated-r')
    expect(readCodex().tokens.access_token).toBe('rotated-a')
  })

  test('the sync does not break id_token or auth_mode', async () => {
    const store = new FileCredentialStore(storePath, { home })

    await store.modify('openai-codex', async () => fresh)

    expect(readCodex().tokens.id_token).toBe('old-id')
    expect(readCodex().auth_mode).toBe('chatgpt')
  })

  test('another provider does not touch the codex file', async () => {
    const store = new FileCredentialStore(storePath, { home })

    await store.modify('anthropic', async () => fresh)

    expect(readCodex().tokens.refresh_token).toBe('old-r')
  })

  test('an api_key credential is not written to the codex file', async () => {
    const store = new FileCredentialStore(storePath, { home })

    const key: Credential = { type: 'api_key', key: 'sk-test' }
    await store.modify('openai-codex', async () => key)

    expect(readCodex().tokens.refresh_token).toBe('old-r')
  })

  test('when it is left unchanged (undefined) nothing is written to the codex file', async () => {
    const store = new FileCredentialStore(storePath, { home })

    await store.modify('openai-codex', async () => undefined)

    expect(readCodex().tokens.refresh_token).toBe('old-r')
  })

  test('with syncToSource: false the codex file is not touched', async () => {
    const store = new FileCredentialStore(storePath, { home, syncToSource: false })

    await store.modify('openai-codex', async () => fresh)

    expect(readCodex().tokens.refresh_token).toBe('old-r')
  })

  test('the store keeps working even when the codex file is missing', async () => {
    rmSync(join(home, '.codex'), { recursive: true, force: true })
    const store = new FileCredentialStore(storePath, { home })

    const result = await store.modify('openai-codex', async () => fresh)

    expect(result).toEqual(fresh)
    expect(await store.read('openai-codex')).toEqual(fresh)
  })

  test('the store does its own job even when the codex file is broken', async () => {
    writeFileSync(join(home, '.codex', 'auth.json'), '{broken')
    const store = new FileCredentialStore(storePath, { home })

    const result = await store.modify('openai-codex', async () => fresh)

    expect(result).toEqual(fresh)
    expect(await store.read('openai-codex')).toEqual(fresh)
  })

  test('two refreshes in a row — the last token stays in the source', async () => {
    const store = new FileCredentialStore(storePath, { home })

    await store.modify('openai-codex', async () => fresh)
    const second: Credential = { ...fresh, access: 'second-a', refresh: 'second-r' }
    await store.modify('openai-codex', async () => second)

    expect(readCodex().tokens.refresh_token).toBe('second-r')
  })
})
