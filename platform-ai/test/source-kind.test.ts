// Provider qaysi to'lov modeli bilan ulanganini ajratish.
//
// NEGA MUHIM: bir provider ikki xil kanal bilan kelishi mumkin — OpenAI API
// kaliti (har token pullik) va OpenAI Codex ChatGPT obunasi (oylik to'lovga
// kiradi). UI ikkalasini bir xil ko'rsatsa, foydalanuvchi obunam bor deb
// o'ylab pullik kanaldan ishlatib yuboradi. Shuning uchun `manbaTuri`
// UI'ning ko'rinishiga emas, aniqlash bosqichiga bog'langan.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BillingKind, ModelInfo } from '@platforma/shared'
import { claudeCodeAuth, codexAuth, localAuths } from '../src/local-auth.ts'
import { modelOrder } from '../src/detect.ts'

function uyYarat(): string {
  return mkdtempSync(join(tmpdir(), 'platforma-manba-'))
}

const TOKEN = JSON.stringify({
  access_token: 'a',
  refresh_token: 'r',
  expires_at: 4_000_000_000_000,
})

describe('mahalliy OAuth manba nomi', () => {
  test("Claude obunasi aniq nom qaytaradi — umumiy 'OAuth' emas", async () => {
    const uy = uyYarat()
    mkdirSync(join(uy, '.claude'), { recursive: true })
    writeFileSync(join(uy, '.claude', '.credentials.json'), TOKEN)

    const natija = await claudeCodeAuth(uy)
    // Foydalanuvchi qaysi fayldan kelganini ko'rishi kerak
    expect(natija.topilma?.manba).toContain('obuna')
    expect(natija.topilma?.manba).toContain('~/.claude')
    expect(natija.topilma?.manba).not.toBe('OAuth')
  })

  test('ChatGPT obunasi aniq nom qaytaradi', async () => {
    const uy = uyYarat()
    mkdirSync(join(uy, '.codex'), { recursive: true })
    writeFileSync(join(uy, '.codex', 'auth.json'), TOKEN)

    const natija = await codexAuth(uy)
    expect(natija.topilma?.manba).toContain('obuna')
    expect(natija.topilma?.manba).toContain('~/.codex')
    expect(natija.topilma?.manba).not.toBe('OAuth')
  })

  test('har bir topilma provider id va manba juftini beradi', async () => {
    const uy = uyYarat()
    mkdirSync(join(uy, '.codex'), { recursive: true })
    writeFileSync(join(uy, '.codex', 'auth.json'), TOKEN)

    // aniqlash.ts shu juftlikdan `manbalar` xaritasini quradi va uni
    // pi-ai ning umumiy `chk.source` qiymatidan ustun qo'yadi
    const natijalar = await localAuths(uy)
    const topilganlar = natijalar.filter((n) => n.topilma)
    expect(topilganlar.length).toBeGreaterThan(0)
    for (const n of topilganlar) {
      expect(n.topilma?.providerId).toBeTruthy()
      expect(n.topilma?.manba).toBeTruthy()
    }
  })
})

function model(qism: Partial<ModelInfo> & { name: string; manbaTuri: BillingKind }): ModelInfo {
  return {
    provider: qism.manbaTuri === 'obuna' ? 'openai-codex' : 'openai',
    providerName: qism.manbaTuri === 'obuna' ? 'OpenAI Codex' : 'OpenAI',
    id: qism.name.toLowerCase(),
    contextWindow: 272_000,
    reasoning: false,
    vision: false,
    // Obunada ham katalog narxi noldan katta — saralash shunga tayanmasligi kerak
    cost: { input: 1, output: 6 },
    manba: 'sinov',
    ...qism,
  }
}

describe('model tartibi', () => {
  test('bir xil model ikki kanalda bo\'lsa obuna birinchi turadi', () => {
    // Foydalanuvchi ko'rgan holat: "luna" qidiruvida API kalit versiyasi
    // tepada, obuna pastda edi — teskari bo'lishi kerak
    const royxat: ModelInfo[] = [
      model({ name: 'GPT-5.6 Luna', manbaTuri: 'kalit' }),
      model({ name: 'GPT-5.6 Luna', manbaTuri: 'obuna' }),
    ]
    royxat.sort(modelOrder)
    expect(royxat[0]?.manbaTuri).toBe('obuna')
    expect(royxat[1]?.manbaTuri).toBe('kalit')
  })

  test('mahalliy > obuna > kalit tartibi', () => {
    const royxat: ModelInfo[] = [
      model({ name: 'B kalit', manbaTuri: 'kalit' }),
      model({ name: 'A mahalliy', manbaTuri: 'mahalliy' }),
      model({ name: 'C obuna', manbaTuri: 'obuna' }),
    ]
    royxat.sort(modelOrder)
    expect(royxat.map((m) => m.manbaTuri)).toEqual(['mahalliy', 'obuna', 'kalit'])
  })

  test('obunaning narxi kalitnikidan qimmat bo\'lsa ham tepada qoladi', () => {
    // Saralash narxga emas, to'lov kanaliga tayanadi
    const royxat: ModelInfo[] = [
      model({ name: 'Arzon', manbaTuri: 'kalit', cost: { input: 0.1, output: 0.2 } }),
      model({ name: 'Qimmat', manbaTuri: 'obuna', cost: { input: 99, output: 99 } }),
    ]
    royxat.sort(modelOrder)
    expect(royxat[0]?.name).toBe('Qimmat')
  })

  test('bir xil turdagi modellar nom bo\'yicha saralanadi', () => {
    const royxat: ModelInfo[] = [
      model({ name: 'Zeta', manbaTuri: 'kalit' }),
      model({ name: 'Alfa', manbaTuri: 'kalit' }),
    ]
    royxat.sort(modelOrder)
    expect(royxat.map((m) => m.name)).toEqual(['Alfa', 'Zeta'])
  })
})
