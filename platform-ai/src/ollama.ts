// Ollama — foydalanuvchi PC'sida ishlaydigan mahalliy LLM serveri.
//
// pi-ai uni o'z katalogida bilmaydi (modellar foydalanuvchida qaysi biri
// yuklab olinganiga bog'liq), shuning uchun `createProvider()` bilan ish
// vaqtida quramiz: `/api/tags` dan model ro'yxatini olamiz, har birini
// OpenAI-mos model sifatida ro'yxatdan o'tkazamiz (Ollama `/v1` endpointida
// OpenAI Chat Completions API'ni taqlid qiladi).
//
// Ollama ishlamayotgan bo'lsa — bu xato emas, oddiy holat: `undefined`
// qaytadi va aniqlash davom etadi.

import { createProvider, type Model, type Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

export const OLLAMA_ID = 'ollama'
export const OLLAMA_MANBA = 'Ollama (mahalliy)'

/** `OLLAMA_HOST` env qo'llab-quvvatlanadi (Ollama'ning o'z konvensiyasi) */
export function ollamaManzili(): string {
  const xom = process.env.OLLAMA_HOST?.trim()
  if (!xom) return 'http://127.0.0.1:11434'
  // OLLAMA_HOST ba'zan sxemasiz yoziladi: "localhost:11434"
  const toliq = /^https?:\/\//.test(xom) ? xom : `http://${xom}`
  return toliq.replace(/\/+$/, '')
}

interface TagsJavobi {
  models?: {
    name?: unknown
    details?: { parameter_size?: unknown; family?: unknown }
  }[]
}

/**
 * Ollama'dagi modellar ro'yxatini oladi. Server javob bermasa yoki javob
 * kutilgan shaklda bo'lmasa — bo'sh massiv.
 */
export async function ollamaModellari(kutish = 800): Promise<string[]> {
  const manzil = ollamaManzili()
  try {
    const javob = await fetch(`${manzil}/api/tags`, {
      signal: AbortSignal.timeout(kutish),
    })
    if (!javob.ok) return []
    const tana = (await javob.json()) as TagsJavobi
    if (!Array.isArray(tana.models)) return []
    return tana.models
      .map((m) => (typeof m?.name === 'string' ? m.name : null))
      .filter((n): n is string => n !== null)
  } catch {
    // Ollama o'rnatilmagan yoki ishlamayapti — normal holat
    return []
  }
}

/**
 * Ollama kontekst oynasi model metadatasida ishonchli berilmaydi, shuning
 * uchun ehtiyotkor standart qiymat. Katta kontekst kerak bo'lsa foydalanuvchi
 * Ollama tomonda `num_ctx` ni sozlaydi.
 */
const STANDART_KONTEKST = 32_768

/**
 * Model nomidan o'ylash (reasoning) rejimini taxmin qiladi.
 *
 * Ollama metadatada buni bermaydi, lekin bilish muhim: reasoning modellari
 * javobdan oldin uzoq `<think>` bosqichini o'tkazadi. Sinovda qwen3:8b
 * 90 soniyada ham JSON javob bermadi — shuning uchun ular klassifikator
 * uchun tanlanmasligi kerak.
 */
function oylaydiganMi(nom: string): boolean {
  return /\b(qwen3|deepseek-r1|r1|marco-o1|qwq|reasoning|think)/i.test(nom)
}

function ollamaModel(nom: string, manzil: string): Model<'openai-completions'> {
  return {
    id: nom,
    name: nom,
    api: 'openai-completions',
    provider: OLLAMA_ID,
    baseUrl: `${manzil}/v1`,
    reasoning: oylaydiganMi(nom),
    input: ['text'],
    // Mahalliy model — hisob-kitob bo'yicha bepul
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: STANDART_KONTEKST,
    maxTokens: 4096,
    compat: {
      // Ollama bu OpenAI kengaytmalarini qo'llamaydi
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
    },
  }
}

/**
 * Topilgan modellardan Ollama providerini quradi.
 * Model topilmasa `undefined` — bo'sh providerni ro'yxatga qo'shishdan ma'no yo'q.
 */
export async function ollamaProvider(): Promise<Provider<'openai-completions'> | undefined> {
  const nomlar = await ollamaModellari()
  if (nomlar.length === 0) return undefined

  const manzil = ollamaManzili()
  return createProvider({
    id: OLLAMA_ID,
    name: 'Ollama',
    baseUrl: `${manzil}/v1`,
    // Ollama autentifikatsiya so'ramaydi, lekin OpenAI-mos qatlam kalitsiz
    // ishlashni rad etadi ("No API key for provider"). Shuning uchun ramziy
    // kalit beramiz — Ollama uni e'tiborsiz qoldiradi. Bu OpenAI-mos mahalliy
    // serverlar (vLLM, LM Studio) uchun ham standart amaliyot.
    auth: {
      apiKey: {
        name: 'Ollama (mahalliy, kalit kerak emas)',
        resolve: async () => ({ auth: { apiKey: 'ollama' }, source: OLLAMA_MANBA }),
      },
    },
    models: nomlar.map((n) => ollamaModel(n, manzil)),
    api: openAICompletionsApi(),
  })
}
