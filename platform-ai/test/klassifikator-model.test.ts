// Klassifikator uchun model tanlash.
//
// Bu mantiq jonli sinovda bir necha marta tuzatildi — test o'sha topilmalarni
// mustahkamlaydi, aks holda kelajakda "arzonroq" model tanlanib qolishi mumkin.

import { afterEach, describe, expect, test } from 'bun:test'
import type { ModelInfo } from '@platforma/shared'
import { klassifikatorModeliniTanla } from '../src/klassifikator.ts'

const ASL_ENV = process.env.PLATFORMA_KLASSIFIKATOR_MODEL

afterEach(() => {
  if (ASL_ENV === undefined) delete process.env.PLATFORMA_KLASSIFIKATOR_MODEL
  else process.env.PLATFORMA_KLASSIFIKATOR_MODEL = ASL_ENV
})

function model(qism: Partial<ModelInfo> & { provider: string; id: string }): ModelInfo {
  return {
    providerName: qism.provider,
    name: qism.id,
    contextWindow: 128_000,
    reasoning: false,
    vision: false,
    cost: { input: 1, output: 5 },
    manba: 'sinov',
    ...qism,
  }
}

describe('env bilan majburlash', () => {
  test('PLATFORMA_KLASSIFIKATOR_MODEL hamma narsadan ustun', () => {
    process.env.PLATFORMA_KLASSIFIKATOR_MODEL = 'ollama/mening-modelim'
    const t = klassifikatorModeliniTanla([model({ provider: 'openrouter', id: 'a/b' })])
    expect(t).toEqual({ provider: 'ollama', model: 'mening-modelim' })
  })

  test('slashli model id to\'g\'ri ajratiladi', () => {
    process.env.PLATFORMA_KLASSIFIKATOR_MODEL = 'openrouter/google/gemini-2.5-flash-lite'
    expect(klassifikatorModeliniTanla([])).toEqual({
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash-lite',
    })
  })
})

describe('mos kelmaydigan modellar chiqariladi', () => {
  test('o\'ylash majburiy modellar tanlanmaydi', () => {
    // Sinovda: qwen3 90 soniyada ham javob bermadi,
    // gpt-5-mini "Reasoning is mandatory for this endpoint" xatosi berdi
    delete process.env.PLATFORMA_KLASSIFIKATOR_MODEL
    const t = klassifikatorModeliniTanla([
      model({ provider: 'ollama', id: 'qwen3:8b', cost: { input: 0, output: 0 } }),
      model({ provider: 'openrouter', id: 'openai/gpt-5-mini', cost: { input: 0.1, output: 0.4 } }),
      model({ provider: 'openrouter', id: 'deepseek/deepseek-r1', cost: { input: 0, output: 0 } }),
      model({ provider: 'openrouter', id: 'inclusionai/ling-2.6-flash', cost: { input: 2, output: 8 } }),
    ])
    expect(t?.model).toBe('inclusionai/ling-2.6-flash')
  })

  test('eskirgan avlodlar tanlanmaydi', () => {
    // claude-3-haiku sinovda provider xatosi berdi
    delete process.env.PLATFORMA_KLASSIFIKATOR_MODEL
    const t = klassifikatorModeliniTanla([
      model({ provider: 'openrouter', id: 'anthropic/claude-3-haiku', cost: { input: 0, output: 0 } }),
      model({ provider: 'openrouter', id: 'meta/llama-3.3-70b', cost: { input: 5, output: 5 } }),
    ])
    expect(t?.model).toBe('meta/llama-3.3-70b')
  })

  test('kichik kontekstli model tanlanmaydi', () => {
    delete process.env.PLATFORMA_KLASSIFIKATOR_MODEL
    const t = klassifikatorModeliniTanla([
      model({ provider: 'x', id: 'kichik', contextWindow: 4096, cost: { input: 0, output: 0 } }),
      model({ provider: 'x', id: 'katta', contextWindow: 128_000, cost: { input: 9, output: 9 } }),
    ])
    expect(t?.model).toBe('katta')
  })

  test('mos model yo\'q bo\'lsa undefined', () => {
    delete process.env.PLATFORMA_KLASSIFIKATOR_MODEL
    expect(klassifikatorModeliniTanla([])).toBeUndefined()
    expect(
      klassifikatorModeliniTanla([model({ provider: 'ollama', id: 'qwen3:0.6b' })]),
    ).toBeUndefined()
  })
})

describe('sinalgan modellar ustuvor', () => {
  test('gemini-2.5-flash-lite eng ustuvor (8/8, ~0.8s)', () => {
    delete process.env.PLATFORMA_KLASSIFIKATOR_MODEL
    const t = klassifikatorModeliniTanla([
      model({ provider: 'openrouter', id: 'inclusionai/ling-2.6-flash', cost: { input: 0, output: 0 } }),
      model({ provider: 'openrouter', id: 'google/gemini-2.5-flash-lite', cost: { input: 9, output: 9 } }),
    ])
    // Qimmatroq bo'lsa ham sinalgani tanlanadi
    expect(t?.model).toBe('google/gemini-2.5-flash-lite')
  })

  test('haiku-4.5 ikkinchi o\'rinda (8/8, ~2.3s)', () => {
    delete process.env.PLATFORMA_KLASSIFIKATOR_MODEL
    const t = klassifikatorModeliniTanla([
      model({ provider: 'openrouter', id: 'inclusionai/ling-2.6-flash', cost: { input: 0, output: 0 } }),
      model({ provider: 'anthropic', id: 'claude-haiku-4-5', cost: { input: 1, output: 5 } }),
    ])
    expect(t?.model).toBe('claude-haiku-4-5')
  })

  test('reasoning bayrog\'i tanlashga to\'sqinlik qilmaydi', () => {
    // Haiku va Gemini `reasoning: true`, lekin o'ylash ixtiyoriy — ikkalasi
    // ham sinovda 8/8 berdi. Faqat MAJBURIY o'ylaydiganlar chiqariladi.
    delete process.env.PLATFORMA_KLASSIFIKATOR_MODEL
    const t = klassifikatorModeliniTanla([
      model({ provider: 'openrouter', id: 'google/gemini-2.5-flash-lite', reasoning: true }),
    ])
    expect(t?.model).toBe('google/gemini-2.5-flash-lite')
  })

  test('sinalmaganlar orasida tez oila ustuvor, keyin arzonroq', () => {
    delete process.env.PLATFORMA_KLASSIFIKATOR_MODEL
    const t = klassifikatorModeliniTanla([
      model({ provider: 'x', id: 'katta-model', cost: { input: 0, output: 0 } }),
      model({ provider: 'x', id: 'biror-flash-lite', cost: { input: 5, output: 5 } }),
    ])
    expect(t?.model).toBe('biror-flash-lite')
  })
})
