// Writing the refreshed token back to ~/.codex/auth.json.
//
// This is another program's file — the main requirements: keep the foreign
// fields, never leave the file half-written and never throw.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { writeToCodex } from '../src/source-sync.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'platforma-sync-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const path = () => join(home, '.codex', 'auth.json')

function writeCodexFile(value: unknown): void {
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(path(), JSON.stringify(value, null, 2), { mode: 0o600 })
}

function read(): Record<string, any> {
  return JSON.parse(readFileSync(path(), 'utf8'))
}

const freshToken: OAuthCredential = {
  type: 'oauth',
  access: 'new-access',
  refresh: 'new-refresh',
  expires: Date.now() + 86_400_000,
}

describe('writeToCodex', () => {
  test('access and refresh are updated', () => {
    writeCodexFile({ tokens: { access_token: 'old-a', refresh_token: 'old-r' } })

    const result = writeToCodex(freshToken, home)

    expect(result.written).toBe(true)
    expect(read().tokens.access_token).toBe('new-access')
    expect(read().tokens.refresh_token).toBe('new-refresh')
  })

  test('id_token and account_id are kept — they do not come in the refresh response', () => {
    writeCodexFile({
      tokens: {
        access_token: 'old-a',
        refresh_token: 'old-r',
        id_token: 'must-be-kept',
        account_id: 'acc-123',
      },
    })

    writeToCodex(freshToken, home)

    expect(read().tokens.id_token).toBe('must-be-kept')
    expect(read().tokens.account_id).toBe('acc-123')
  })

  test('the fields outside tokens are not touched', () => {
    writeCodexFile({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      future_field: { deep: true },
      tokens: { access_token: 'old-a', refresh_token: 'old-r' },
    })

    writeToCodex(freshToken, home)

    const result = read()
    expect(result.auth_mode).toBe('chatgpt')
    expect(result.OPENAI_API_KEY).toBeNull()
    expect(result.future_field).toEqual({ deep: true })
  })

  test('last_refresh is updated with an ISO time', () => {
    writeCodexFile({ tokens: { access_token: 'a', refresh_token: 'r' }, last_refresh: null })

    writeToCodex(freshToken, home)

    const value = read().last_refresh
    expect(typeof value).toBe('string')
    expect(Number.isNaN(Date.parse(value))).toBe(false)
  })

  test('the file permissions stay at 600', () => {
    writeCodexFile({ tokens: { access_token: 'a', refresh_token: 'r' } })

    writeToCodex(freshToken, home)

    expect(statSync(path()).mode & 0o777).toBe(0o600)
  })

  test('if the token has not changed it is not rewritten', () => {
    writeCodexFile({
      tokens: { access_token: freshToken.access, refresh_token: freshToken.refresh },
    })

    const result = writeToCodex(freshToken, home)

    expect(result.written).toBe(false)
    expect(result.reason).toContain('no change')
  })

  test('if the file is missing it IS NOT CREATED — codex is not installed', () => {
    const result = writeToCodex(freshToken, home)

    expect(result.written).toBe(false)
    expect(result.reason).toContain('not found')
    expect(() => statSync(path())).toThrow()
  })

  test('broken JSON — no throw, the file is not touched', () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(path(), '{this is not json')

    const result = writeToCodex(freshToken, home)

    expect(result.written).toBe(false)
    expect(result.reason).toBeTruthy()
    expect(readFileSync(path(), 'utf8')).toBe('{this is not json')
  })

  test('it does not fall over even when given an array', () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(path(), '[1,2,3]')

    const result = writeToCodex(freshToken, home)

    expect(result.written).toBe(false)
    expect(result.reason).toContain('unexpected shape')
  })

  test('if the tokens field is missing it is created', () => {
    writeCodexFile({ auth_mode: 'chatgpt' })

    const result = writeToCodex(freshToken, home)

    expect(result.written).toBe(true)
    expect(read().tokens.access_token).toBe('new-access')
    expect(read().auth_mode).toBe('chatgpt')
  })

  test('the written file is real JSON — no half state is left', () => {
    writeCodexFile({ tokens: { access_token: 'a', refresh_token: 'r' } })

    writeToCodex(freshToken, home)

    expect(() => read()).not.toThrow()
  })
})
