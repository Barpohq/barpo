// Kredensial ombori yangilangan tokenni manba fayliga qaytaradimi?
//
// Bu eng muhim halqa: pi-ai refresh qilganda natijani `modify` orqali yozadi,
// biz esa o'sha yerdan ~/.codex/auth.json ni yangilaymiz. Bu ishlamasa
// rotatsiyadan keyin terminaldagi `codex` o'lik token bilan qoladi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Credential } from '@earendil-works/pi-ai'
import { FaylKredensialOmbori } from '../src/kredensial.ts'

let uy: string
let omborYoli: string

beforeEach(() => {
  uy = mkdtempSync(join(tmpdir(), 'platforma-ombor-'))
  omborYoli = join(uy, 'ombor', 'ai-auth.json')
  mkdirSync(join(uy, '.codex'), { recursive: true })
  writeFileSync(
    join(uy, '.codex', 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'eski-a', refresh_token: 'eski-r', id_token: 'eski-id' },
    }),
    { mode: 0o600 },
  )
})

afterEach(() => {
  rmSync(uy, { recursive: true, force: true })
})

function codexOqi(): Record<string, any> {
  return JSON.parse(readFileSync(join(uy, '.codex', 'auth.json'), 'utf8'))
}

const yangi: Credential = {
  type: 'oauth',
  access: 'rotatsiyalangan-a',
  refresh: 'rotatsiyalangan-r',
  expires: Date.now() + 86_400_000,
}

describe('FaylKredensialOmbori manba sinxronizatsiyasi', () => {
  test('openai-codex yangilanganda ~/.codex/auth.json ham yangilanadi', async () => {
    const ombor = new FaylKredensialOmbori(omborYoli, { uy })

    await ombor.modify('openai-codex', async () => yangi)

    expect(codexOqi().tokens.refresh_token).toBe('rotatsiyalangan-r')
    expect(codexOqi().tokens.access_token).toBe('rotatsiyalangan-a')
  })

  test('sinxronizatsiya id_token va auth_mode ni buzmaydi', async () => {
    const ombor = new FaylKredensialOmbori(omborYoli, { uy })

    await ombor.modify('openai-codex', async () => yangi)

    expect(codexOqi().tokens.id_token).toBe('eski-id')
    expect(codexOqi().auth_mode).toBe('chatgpt')
  })

  test('boshqa provider codex fayliga tegmaydi', async () => {
    const ombor = new FaylKredensialOmbori(omborYoli, { uy })

    await ombor.modify('anthropic', async () => yangi)

    expect(codexOqi().tokens.refresh_token).toBe('eski-r')
  })

  test('api_key turidagi kredensial codex fayliga yozilmaydi', async () => {
    const ombor = new FaylKredensialOmbori(omborYoli, { uy })

    const kalit: Credential = { type: 'api_key', key: 'sk-test' }
    await ombor.modify('openai-codex', async () => kalit)

    expect(codexOqi().tokens.refresh_token).toBe('eski-r')
  })

  test('o\'zgarishsiz qoldirilsa (undefined) codex fayliga yozilmaydi', async () => {
    const ombor = new FaylKredensialOmbori(omborYoli, { uy })

    await ombor.modify('openai-codex', async () => undefined)

    expect(codexOqi().tokens.refresh_token).toBe('eski-r')
  })

  test('manbagaSinxron: false bo\'lsa codex fayli tegilmaydi', async () => {
    const ombor = new FaylKredensialOmbori(omborYoli, { uy, manbagaSinxron: false })

    await ombor.modify('openai-codex', async () => yangi)

    expect(codexOqi().tokens.refresh_token).toBe('eski-r')
  })

  test('codex fayli yo\'q bo\'lsa ham ombor ishlayveradi', async () => {
    rmSync(join(uy, '.codex'), { recursive: true, force: true })
    const ombor = new FaylKredensialOmbori(omborYoli, { uy })

    const natija = await ombor.modify('openai-codex', async () => yangi)

    expect(natija).toEqual(yangi)
    expect(await ombor.read('openai-codex')).toEqual(yangi)
  })

  test('codex fayli buzuq bo\'lsa ham ombor o\'z ishini bajaradi', async () => {
    writeFileSync(join(uy, '.codex', 'auth.json'), '{buzuq')
    const ombor = new FaylKredensialOmbori(omborYoli, { uy })

    const natija = await ombor.modify('openai-codex', async () => yangi)

    expect(natija).toEqual(yangi)
    expect(await ombor.read('openai-codex')).toEqual(yangi)
  })

  test('ketma-ket ikkita refresh — oxirgi token manbada qoladi', async () => {
    const ombor = new FaylKredensialOmbori(omborYoli, { uy })

    await ombor.modify('openai-codex', async () => yangi)
    const ikkinchi: Credential = { ...yangi, access: 'ikkinchi-a', refresh: 'ikkinchi-r' }
    await ombor.modify('openai-codex', async () => ikkinchi)

    expect(codexOqi().tokens.refresh_token).toBe('ikkinchi-r')
  })
})
