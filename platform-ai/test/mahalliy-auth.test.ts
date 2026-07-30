// Mahalliy OAuth fayllarini o'qish — asosiy talab: HECH QACHON throw qilmaslik.
// Bu fayllar boshqa dasturlarniki, formati istalgan payt o'zgarishi mumkin.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeAuth, codexAuth } from '../src/mahalliy-auth.ts'

let uy: string

beforeEach(() => {
  uy = mkdtempSync(join(tmpdir(), 'platforma-auth-'))
})

afterEach(() => {
  rmSync(uy, { recursive: true, force: true })
})

function claudeFayliYoz(mazmun: string): void {
  mkdirSync(join(uy, '.claude'), { recursive: true })
  writeFileSync(join(uy, '.claude', '.credentials.json'), mazmun)
}

function codexFayliYoz(mazmun: string): void {
  mkdirSync(join(uy, '.codex'), { recursive: true })
  writeFileSync(join(uy, '.codex', 'auth.json'), mazmun)
}

describe('claudeCodeAuth', () => {
  test('fayl yo\'q bo\'lsa sabab bilan qaytadi, throw qilmaydi', async () => {
    const natija = await claudeCodeAuth(uy)
    expect(natija.topilma).toBeUndefined()
    expect(natija.sabab).toContain('not found')
  })

  test('buzuq JSON throw qilmaydi', async () => {
    claudeFayliYoz('{bu json emas')
    const natija = await claudeCodeAuth(uy)
    expect(natija.topilma).toBeUndefined()
    expect(natija.sabab).toBeTruthy()
  })

  test('bo\'sh obyekt — token shakli tanilmaydi', async () => {
    claudeFayliYoz('{}')
    const natija = await claudeCodeAuth(uy)
    expect(natija.topilma).toBeUndefined()
    expect(natija.sabab).toContain('tanilmadi')
  })

  test('tekis snake_case shakli o\'qiladi', async () => {
    claudeFayliYoz(
      JSON.stringify({ access_token: 'a1', refresh_token: 'r1', expires_at: 4000000000000 }),
    )
    const natija = await claudeCodeAuth(uy)
    expect(natija.topilma?.providerId).toBe('anthropic')
    expect(natija.topilma?.credential.access).toBe('a1')
    expect(natija.topilma?.credential.refresh).toBe('r1')
    expect(natija.topilma?.credential.expires).toBe(4000000000000)
  })

  test('ichma-ich camelCase shakli ham o\'qiladi', async () => {
    claudeFayliYoz(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'a2', refreshToken: 'r2', expiresAt: 4000000000000 },
      }),
    )
    const natija = await claudeCodeAuth(uy)
    expect(natija.topilma?.credential.access).toBe('a2')
    expect(natija.topilma?.credential.type).toBe('oauth')
  })

  test('faqat access bo\'lsa (refresh yo\'q) qabul qilinmaydi', async () => {
    claudeFayliYoz(JSON.stringify({ access_token: 'a3' }))
    const natija = await claudeCodeAuth(uy)
    expect(natija.topilma).toBeUndefined()
  })

  test('sekundli muddat millisekundga aylantiriladi', async () => {
    // 4_000_000_000 sekund = 2096-yil, ya'ni 1e9 dan katta lekin 1e12 dan kichik
    claudeFayliYoz(JSON.stringify({ access: 'a', refresh: 'r', expires: 4_000_000_000 }))
    const natija = await claudeCodeAuth(uy)
    expect(natija.topilma?.credential.expires).toBe(4_000_000_000_000)
  })

  test('muddat yo\'q bo\'lsa 0 — pi-ai darhol yangilaydi', async () => {
    claudeFayliYoz(JSON.stringify({ access: 'a', refresh: 'r' }))
    const natija = await claudeCodeAuth(uy)
    expect(natija.topilma?.credential.expires).toBe(0)
  })

  test('massiv berilsa ham yiqilmaydi', async () => {
    claudeFayliYoz('[1, 2, 3]')
    const natija = await claudeCodeAuth(uy)
    expect(natija.topilma).toBeUndefined()
    expect(natija.sabab).toBeTruthy()
  })
})

describe('codexAuth', () => {
  test('fayl yo\'q bo\'lsa sabab qaytadi', async () => {
    const natija = await codexAuth(uy)
    expect(natija.topilma).toBeUndefined()
    expect(natija.sabab).toContain('not found')
  })

  test('topilganda openai-codex provideriga bog\'lanadi', async () => {
    codexFayliYoz(
      JSON.stringify({ tokens: { access_token: 'c1', refresh_token: 'c2', expires_at: 4000000000000 } }),
    )
    const natija = await codexAuth(uy)
    expect(natija.topilma?.providerId).toBe('openai-codex')
    expect(natija.topilma?.credential.access).toBe('c1')
  })
})

// Codex `auth.json` da muddat alohida maydonda YO'Q — u faqat JWT ichida.
// Buni o'qimasak muddat 0 bo'lib qoladi va pi-ai hali yaroqli tokenni
// har ishga tushishda yangilaydi (OpenAI esa rotatsiya qilib eskisini o'ldiradi).
describe('JWT exp orqali muddat', () => {
  /** Imzosi yaroqsiz, lekin payload'i haqiqiy JWT tuzadi (test uchun yetarli) */
  function jwtYasa(dava: Record<string, unknown>): string {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(dava)}.imzo`
  }

  test('ochiq maydon bo\'lmasa access_token JWT dan o\'qiladi', async () => {
    const exp = Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60 // 10 kun
    codexFayliYoz(
      JSON.stringify({
        tokens: { access_token: jwtYasa({ exp }), refresh_token: 'r', id_token: 'x' },
      }),
    )
    const natija = await codexAuth(uy)
    expect(natija.topilma?.credential.expires).toBe(exp * 1000)
  })

  test('ochiq expires_at maydoni JWT dan ustun turadi', async () => {
    const jwtExp = Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60
    codexFayliYoz(
      JSON.stringify({
        tokens: {
          access_token: jwtYasa({ exp: jwtExp }),
          refresh_token: 'r',
          expires_at: 4_000_000_000_000,
        },
      }),
    )
    const natija = await codexAuth(uy)
    expect(natija.topilma?.credential.expires).toBe(4_000_000_000_000)
  })

  test('muddati o\'tgan JWT o\'tgan vaqtni qaytaradi (pi-ai yangilaydi)', async () => {
    const exp = Math.floor(Date.now() / 1000) - 3600 // bir soat oldin
    codexFayliYoz(
      JSON.stringify({ tokens: { access_token: jwtYasa({ exp }), refresh_token: 'r' } }),
    )
    const natija = await codexAuth(uy)
    expect(natija.topilma?.credential.expires).toBe(exp * 1000)
    expect(natija.topilma?.credential.expires).toBeLessThan(Date.now())
  })

  test('JWT bo\'lmagan token — muddat 0, throw yo\'q', async () => {
    codexFayliYoz(
      JSON.stringify({ tokens: { access_token: 'oddiy-satr', refresh_token: 'r' } }),
    )
    const natija = await codexAuth(uy)
    expect(natija.topilma?.credential.expires).toBe(0)
  })

  test('buzuq JWT payload — muddat 0, throw yo\'q', async () => {
    codexFayliYoz(
      JSON.stringify({ tokens: { access_token: 'aaa.!!!buzuq!!!.ccc', refresh_token: 'r' } }),
    )
    const natija = await codexAuth(uy)
    expect(natija.topilma?.credential.expires).toBe(0)
  })

  test('exp maydoni yo\'q JWT — muddat 0', async () => {
    codexFayliYoz(
      JSON.stringify({ tokens: { access_token: jwtYasa({ sub: 'kimdir' }), refresh_token: 'r' } }),
    )
    const natija = await codexAuth(uy)
    expect(natija.topilma?.credential.expires).toBe(0)
  })
})
