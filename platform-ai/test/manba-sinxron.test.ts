// Yangilangan tokenni ~/.codex/auth.json ga qaytarish.
//
// Bu boshqa dasturning fayli — asosiy talab: begona maydonlarni saqlash,
// faylni yarim holatda qoldirmaslik va hech qachon throw qilmaslik.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { codexGaYoz } from '../src/manba-sinxron.ts'

let uy: string

beforeEach(() => {
  uy = mkdtempSync(join(tmpdir(), 'platforma-sinxron-'))
})

afterEach(() => {
  rmSync(uy, { recursive: true, force: true })
})

const yoli = () => join(uy, '.codex', 'auth.json')

function codexFayliYoz(qiymat: unknown): void {
  mkdirSync(join(uy, '.codex'), { recursive: true })
  writeFileSync(yoli(), JSON.stringify(qiymat, null, 2), { mode: 0o600 })
}

function oqi(): Record<string, any> {
  return JSON.parse(readFileSync(yoli(), 'utf8'))
}

const yangiToken: OAuthCredential = {
  type: 'oauth',
  access: 'yangi-access',
  refresh: 'yangi-refresh',
  expires: Date.now() + 86_400_000,
}

describe('codexGaYoz', () => {
  test('access va refresh yangilanadi', () => {
    codexFayliYoz({ tokens: { access_token: 'eski-a', refresh_token: 'eski-r' } })

    const natija = codexGaYoz(yangiToken, uy)

    expect(natija.yozildi).toBe(true)
    expect(oqi().tokens.access_token).toBe('yangi-access')
    expect(oqi().tokens.refresh_token).toBe('yangi-refresh')
  })

  test('id_token va account_id saqlanadi — refresh javobida ular kelmaydi', () => {
    codexFayliYoz({
      tokens: {
        access_token: 'eski-a',
        refresh_token: 'eski-r',
        id_token: 'saqlanishi-kerak',
        account_id: 'acc-123',
      },
    })

    codexGaYoz(yangiToken, uy)

    expect(oqi().tokens.id_token).toBe('saqlanishi-kerak')
    expect(oqi().tokens.account_id).toBe('acc-123')
  })

  test('tokens tashqarisidagi maydonlar tegilmaydi', () => {
    codexFayliYoz({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      kelajakdagi_maydon: { chuqur: true },
      tokens: { access_token: 'eski-a', refresh_token: 'eski-r' },
    })

    codexGaYoz(yangiToken, uy)

    const natija = oqi()
    expect(natija.auth_mode).toBe('chatgpt')
    expect(natija.OPENAI_API_KEY).toBeNull()
    expect(natija.kelajakdagi_maydon).toEqual({ chuqur: true })
  })

  test('last_refresh ISO vaqt bilan yangilanadi', () => {
    codexFayliYoz({ tokens: { access_token: 'a', refresh_token: 'r' }, last_refresh: null })

    codexGaYoz(yangiToken, uy)

    const qiymat = oqi().last_refresh
    expect(typeof qiymat).toBe('string')
    expect(Number.isNaN(Date.parse(qiymat))).toBe(false)
  })

  test('fayl huquqi 600 bo\'lib qoladi', () => {
    codexFayliYoz({ tokens: { access_token: 'a', refresh_token: 'r' } })

    codexGaYoz(yangiToken, uy)

    expect(statSync(yoli()).mode & 0o777).toBe(0o600)
  })

  test('token o\'zgarmagan bo\'lsa qayta yozilmaydi', () => {
    codexFayliYoz({
      tokens: { access_token: yangiToken.access, refresh_token: yangiToken.refresh },
    })

    const natija = codexGaYoz(yangiToken, uy)

    expect(natija.yozildi).toBe(false)
    expect(natija.sabab).toContain("o'zgarish yo'q")
  })

  test('fayl yo\'q bo\'lsa YARATILMAYDI — codex o\'rnatilmagan', () => {
    const natija = codexGaYoz(yangiToken, uy)

    expect(natija.yozildi).toBe(false)
    expect(natija.sabab).toContain('topilmadi')
    expect(() => statSync(yoli())).toThrow()
  })

  test('buzuq JSON — throw yo\'q, fayl tegilmaydi', () => {
    mkdirSync(join(uy, '.codex'), { recursive: true })
    writeFileSync(yoli(), '{bu json emas')

    const natija = codexGaYoz(yangiToken, uy)

    expect(natija.yozildi).toBe(false)
    expect(natija.sabab).toBeTruthy()
    expect(readFileSync(yoli(), 'utf8')).toBe('{bu json emas')
  })

  test('massiv berilsa ham yiqilmaydi', () => {
    mkdirSync(join(uy, '.codex'), { recursive: true })
    writeFileSync(yoli(), '[1,2,3]')

    const natija = codexGaYoz(yangiToken, uy)

    expect(natija.yozildi).toBe(false)
    expect(natija.sabab).toContain('kutilmagan shakl')
  })

  test('tokens maydoni yo\'q bo\'lsa yaratiladi', () => {
    codexFayliYoz({ auth_mode: 'chatgpt' })

    const natija = codexGaYoz(yangiToken, uy)

    expect(natija.yozildi).toBe(true)
    expect(oqi().tokens.access_token).toBe('yangi-access')
    expect(oqi().auth_mode).toBe('chatgpt')
  })

  test('yozilgan fayl haqiqiy JSON — yarim holat qolmaydi', () => {
    codexFayliYoz({ tokens: { access_token: 'a', refresh_token: 'r' } })

    codexGaYoz(yangiToken, uy)

    expect(() => oqi()).not.toThrow()
  })
})
