// Reading the local OAuth files — the main requirement: NEVER throw.
// These files belong to other programs and their format may change at any
// moment.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeAuth, codexAuth } from '../src/local-auth.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'platforma-auth-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function writeClaudeFile(content: string): void {
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', '.credentials.json'), content)
}

function writeCodexFile(content: string): void {
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'auth.json'), content)
}

describe('claudeCodeAuth', () => {
  test('when the file is missing it comes back with a reason, it does not throw', async () => {
    const result = await claudeCodeAuth(home)
    expect(result.found).toBeUndefined()
    expect(result.reason).toContain('not found')
  })

  test('broken JSON does not throw', async () => {
    writeClaudeFile('{this is not json')
    const result = await claudeCodeAuth(home)
    expect(result.found).toBeUndefined()
    expect(result.reason).toBeTruthy()
  })

  test('an empty object — the token shape is not recognised', async () => {
    writeClaudeFile('{}')
    const result = await claudeCodeAuth(home)
    expect(result.found).toBeUndefined()
    expect(result.reason).toContain('not recognised')
  })

  test('the flat snake_case shape is read', async () => {
    writeClaudeFile(
      JSON.stringify({ access_token: 'a1', refresh_token: 'r1', expires_at: 4000000000000 }),
    )
    const result = await claudeCodeAuth(home)
    expect(result.found?.providerId).toBe('anthropic')
    expect(result.found?.credential.access).toBe('a1')
    expect(result.found?.credential.refresh).toBe('r1')
    expect(result.found?.credential.expires).toBe(4000000000000)
  })

  test('the nested camelCase shape is read too', async () => {
    writeClaudeFile(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'a2', refreshToken: 'r2', expiresAt: 4000000000000 },
      }),
    )
    const result = await claudeCodeAuth(home)
    expect(result.found?.credential.access).toBe('a2')
    expect(result.found?.credential.type).toBe('oauth')
  })

  test('with access only (no refresh) it is not accepted', async () => {
    writeClaudeFile(JSON.stringify({ access_token: 'a3' }))
    const result = await claudeCodeAuth(home)
    expect(result.found).toBeUndefined()
  })

  test('an expiry in seconds is converted to milliseconds', async () => {
    // 4_000_000_000 seconds = the year 2096, i.e. greater than 1e9 but smaller
    // than 1e12
    writeClaudeFile(JSON.stringify({ access: 'a', refresh: 'r', expires: 4_000_000_000 }))
    const result = await claudeCodeAuth(home)
    expect(result.found?.credential.expires).toBe(4_000_000_000_000)
  })

  test('with no expiry it is 0 — pi-ai refreshes right away', async () => {
    writeClaudeFile(JSON.stringify({ access: 'a', refresh: 'r' }))
    const result = await claudeCodeAuth(home)
    expect(result.found?.credential.expires).toBe(0)
  })

  test('it does not fall over even when given an array', async () => {
    writeClaudeFile('[1, 2, 3]')
    const result = await claudeCodeAuth(home)
    expect(result.found).toBeUndefined()
    expect(result.reason).toBeTruthy()
  })
})

describe('codexAuth', () => {
  test('when the file is missing a reason comes back', async () => {
    const result = await codexAuth(home)
    expect(result.found).toBeUndefined()
    expect(result.reason).toContain('not found')
  })

  test('when found it is bound to the openai-codex provider', async () => {
    writeCodexFile(
      JSON.stringify({
        tokens: { access_token: 'c1', refresh_token: 'c2', expires_at: 4000000000000 },
      }),
    )
    const result = await codexAuth(home)
    expect(result.found?.providerId).toBe('openai-codex')
    expect(result.found?.credential.access).toBe('c1')
  })
})

// In the Codex `auth.json` the expiry is NOT in a separate field — it only
// sits inside the JWT. Without reading it the expiry would stay 0 and pi-ai
// would refresh a token that is still valid on every startup (while OpenAI
// rotates it and kills the old one).
describe('the expiry through the JWT exp claim', () => {
  /** Builds a JWT with an invalid signature but a real payload (enough for a test) */
  function makeJwt(claims: Record<string, unknown>): string {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.signature`
  }

  test('with no explicit field it is read from the access_token JWT', async () => {
    const exp = Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60 // 10 days
    writeCodexFile(
      JSON.stringify({
        tokens: { access_token: makeJwt({ exp }), refresh_token: 'r', id_token: 'x' },
      }),
    )
    const result = await codexAuth(home)
    expect(result.found?.credential.expires).toBe(exp * 1000)
  })

  test('an explicit expires_at field wins over the JWT', async () => {
    const jwtExp = Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60
    writeCodexFile(
      JSON.stringify({
        tokens: {
          access_token: makeJwt({ exp: jwtExp }),
          refresh_token: 'r',
          expires_at: 4_000_000_000_000,
        },
      }),
    )
    const result = await codexAuth(home)
    expect(result.found?.credential.expires).toBe(4_000_000_000_000)
  })

  test('an expired JWT returns the past time (pi-ai refreshes it)', async () => {
    const exp = Math.floor(Date.now() / 1000) - 3600 // an hour ago
    writeCodexFile(JSON.stringify({ tokens: { access_token: makeJwt({ exp }), refresh_token: 'r' } }))
    const result = await codexAuth(home)
    expect(result.found?.credential.expires).toBe(exp * 1000)
    expect(result.found?.credential.expires).toBeLessThan(Date.now())
  })

  test('a token that is not a JWT — the expiry is 0, no throw', async () => {
    writeCodexFile(JSON.stringify({ tokens: { access_token: 'plain-string', refresh_token: 'r' } }))
    const result = await codexAuth(home)
    expect(result.found?.credential.expires).toBe(0)
  })

  test('a broken JWT payload — the expiry is 0, no throw', async () => {
    writeCodexFile(
      JSON.stringify({ tokens: { access_token: 'aaa.!!!broken!!!.ccc', refresh_token: 'r' } }),
    )
    const result = await codexAuth(home)
    expect(result.found?.credential.expires).toBe(0)
  })

  test('a JWT with no exp field — the expiry is 0', async () => {
    writeCodexFile(
      JSON.stringify({ tokens: { access_token: makeJwt({ sub: 'someone' }), refresh_token: 'r' } }),
    )
    const result = await codexAuth(home)
    expect(result.found?.credential.expires).toBe(0)
  })
})
