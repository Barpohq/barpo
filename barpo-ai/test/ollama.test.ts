// Ollama aniqlash — asosiy talab: server ishlamasa ham yiqilmaslik.

import { afterEach, describe, expect, test } from 'bun:test'
import { ollamaBaseUrl, ollamaModels, ollamaProvider } from '../src/ollama.ts'

const ASL_HOST = process.env.OLLAMA_HOST

afterEach(() => {
  if (ASL_HOST === undefined) delete process.env.OLLAMA_HOST
  else process.env.OLLAMA_HOST = ASL_HOST
})

describe('ollamaBaseUrl', () => {
  test('standart manzil', () => {
    delete process.env.OLLAMA_HOST
    expect(ollamaBaseUrl()).toBe('http://127.0.0.1:11434')
  })

  test('OLLAMA_HOST sxemasiz berilsa http qo\'shiladi', () => {
    process.env.OLLAMA_HOST = 'localhost:9999'
    expect(ollamaBaseUrl()).toBe('http://localhost:9999')
  })

  test('sxemali manzil o\'zgarmaydi, oxirgi slash olib tashlanadi', () => {
    process.env.OLLAMA_HOST = 'https://ollama.ichki:443/'
    expect(ollamaBaseUrl()).toBe('https://ollama.ichki:443')
  })

  test('bo\'sh qiymat standartga qaytadi', () => {
    process.env.OLLAMA_HOST = '   '
    expect(ollamaBaseUrl()).toBe('http://127.0.0.1:11434')
  })
})

describe('ollamaModels', () => {
  test('server javob bermasa bo\'sh massiv, throw yo\'q', async () => {
    // Hech kim tinglamaydigan port
    process.env.OLLAMA_HOST = '127.0.0.1:1'
    expect(await ollamaModels(200)).toEqual([])
  })

  test('provider ham undefined qaytaradi', async () => {
    process.env.OLLAMA_HOST = '127.0.0.1:1'
    expect(await ollamaProvider()).toBeUndefined()
  })
})

describe('ollamaProvider (haqiqiy server bo\'lsa)', () => {
  test('ishlab turgan Ollama modellar bilan provider beradi', async () => {
    delete process.env.OLLAMA_HOST
    const nomlar = await ollamaModels(1000)
    if (nomlar.length === 0) {
      // Ollama ishlamayapti — bu test shartli, o'tkazib yuboriladi
      expect(await ollamaProvider()).toBeUndefined()
      return
    }

    const provider = await ollamaProvider()
    expect(provider).toBeTruthy()
    expect(provider?.id).toBe('ollama')

    const modellar = provider!.getModels()
    expect(modellar.length).toBe(nomlar.length)
    for (const m of modellar) {
      expect(m.api).toBe('openai-completions')
      expect(m.baseUrl).toContain('/v1')
      // Mahalliy model — bepul
      expect(m.cost.input).toBe(0)
      expect(m.cost.output).toBe(0)
    }
  })
})
