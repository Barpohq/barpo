// Foydalanuvchi PC'sidagi AI providerlarini aniqlash.
//
// Uch manba, uchtasi ham mustaqil — biri ishlamasa qolganlari ishlayveradi:
//
//   1) Muhit o'zgaruvchilari — pi-ai o'zi biladigan ~38 provider
//      (OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, ...).
//      `models.checkAuth(id)` sozlanganini aytadi.
//   2) Ollama — mahalliy server; ollama.ts qurib beradi.
//   3) Mahalliy OAuth — ~/.claude va ~/.codex fayllaridagi obuna tokenlari;
//      mahalliy-auth.ts o'qiydi, biz kredensial omboriga joylaymiz.
//
// Natija keshlanadi: har chat so'rovida 38 providerni qayta tekshirish
// (ba'zilari tarmoqqa chiqadi) ortiqcha. `modellarniAniqla({ majburiy: true })`
// keshni yangilaydi.

import type { AniqlashOgohlantirish, ModelInfo, ProviderInfo } from '@platforma/shared'
import type { Api, Model, Models, MutableModels } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { FaylKredensialOmbori } from './kredensial.ts'
import { mahalliyAuthlar } from './mahalliy-auth.ts'
import { OLLAMA_ID, OLLAMA_MANBA, ollamaProvider } from './ollama.ts'

export interface AniqlashNatijasi {
  models: ModelInfo[]
  providers: ProviderInfo[]
  ogohlantirishlar: AniqlashOgohlantirish[]
  /** Aniqlash tugagan vaqt (ISO) */
  vaqt: string
}

export interface AniqlashSozlamalari {
  /** Keshni chetlab o'tib qayta aniqlash */
  majburiy?: boolean
  /** Kredensial fayli yo'li (testlarda boshqa yo'l beriladi) */
  kredensialYoli?: string
}

/** Standart kredensial fayli — DB yonida turadi */
export const STANDART_KREDENSIAL_YOLI = new URL(
  '../../platform-server/data/ai-auth.json',
  import.meta.url,
).pathname

let _kesh: AniqlashNatijasi | null = null
let _models: Models | null = null
let _ishlayotgan: Promise<AniqlashNatijasi> | null = null

/**
 * Aniqlangan providerlar bilan to'ldirilgan pi-ai kolleksiyasi.
 * `modellarniAniqla()` chaqirilmagan bo'lsa avtomatik chaqiriladi.
 */
export async function modelsKolleksiyasi(sozlama?: AniqlashSozlamalari): Promise<Models> {
  if (!_models || sozlama?.majburiy) await modellarniAniqla(sozlama)
  // modellarniAniqla har doim _models ni o'rnatadi
  return _models as Models
}

/** Oxirgi aniqlash natijasi (hali aniqlanmagan bo'lsa null) */
export function keshdagiNatija(): AniqlashNatijasi | null {
  return _kesh
}

/** Testlar uchun: keshni tozalash */
export function keshniTozala(): void {
  _kesh = null
  _models = null
  _ishlayotgan = null
}

export async function modellarniAniqla(sozlama?: AniqlashSozlamalari): Promise<AniqlashNatijasi> {
  if (_kesh && !sozlama?.majburiy) return _kesh
  // Bir vaqtda ikkita so'rov kelsa — bittasi aniqlaydi, ikkinchisi kutadi
  if (_ishlayotgan && !sozlama?.majburiy) return _ishlayotgan

  _ishlayotgan = aniqlashniBajar(sozlama).finally(() => {
    _ishlayotgan = null
  })
  return _ishlayotgan
}

async function aniqlashniBajar(sozlama?: AniqlashSozlamalari): Promise<AniqlashNatijasi> {
  const ogohlantirishlar: AniqlashOgohlantirish[] = []
  const ombor = new FaylKredensialOmbori(sozlama?.kredensialYoli ?? STANDART_KREDENSIAL_YOLI)
  const models = builtinModels({ credentials: ombor }) as MutableModels

  // --- 3-manba avval: mahalliy OAuth omborga yoziladi, chunki checkAuth
  // saqlangan credential'ni ham hisobga oladi ---
  await mahalliyAuthlarniUla(ombor, ogohlantirishlar)

  // --- 2-manba: Ollama ---
  const manbalar = new Map<string, string>()
  try {
    const ollama = await ollamaProvider()
    if (ollama) {
      models.setProvider(ollama)
      manbalar.set(OLLAMA_ID, OLLAMA_MANBA)
    } else {
      ogohlantirishlar.push({
        manba: 'Ollama',
        sabab: 'mahalliy server javob bermadi yoki modellar yuklanmagan',
      })
    }
  } catch (xato) {
    ogohlantirishlar.push({ manba: 'Ollama', sabab: xatoMatni(xato) })
  }

  // --- 1-manba: env kalitlari + yuqorida yozilgan credential'lar ---
  const providers: ProviderInfo[] = []
  const modellar: ModelInfo[] = []

  for (const provider of models.getProviders()) {
    let manba: string | undefined
    try {
      const chk = await models.checkAuth(provider.id)
      if (!chk) continue // sozlanmagan — ro'yxatga tushmaydi
      manba = manbalar.get(provider.id) ?? chk.source ?? (chk.type === 'oauth' ? 'OAuth' : 'kalit')
    } catch (xato) {
      ogohlantirishlar.push({ manba: provider.name, sabab: xatoMatni(xato) })
      continue
    }

    let provModellar: readonly Model<Api>[]
    try {
      provModellar = models.getModels(provider.id)
    } catch (xato) {
      ogohlantirishlar.push({ manba: provider.name, sabab: xatoMatni(xato) })
      continue
    }
    if (provModellar.length === 0) continue

    providers.push({
      id: provider.id,
      name: provider.name,
      manba,
      modelSoni: provModellar.length,
    })

    for (const m of provModellar) {
      modellar.push({
        provider: provider.id,
        providerName: provider.name,
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        reasoning: m.reasoning,
        vision: m.input.includes('image'),
        cost: { input: m.cost.input, output: m.cost.output },
        manba,
      })
    }
  }

  // Mahalliy (bepul) modellar tepada, keyin provider va model nomi bo'yicha
  modellar.sort((a, b) => {
    const bepulFarq = Number(b.cost.input === 0) - Number(a.cost.input === 0)
    if (bepulFarq !== 0) return bepulFarq
    if (a.providerName !== b.providerName) return a.providerName.localeCompare(b.providerName)
    return a.name.localeCompare(b.name)
  })
  providers.sort((a, b) => a.name.localeCompare(b.name))

  _models = models
  _kesh = { models: modellar, providers, ogohlantirishlar, vaqt: new Date().toISOString() }
  return _kesh
}

/** ~/.claude va ~/.codex tokenlarini kredensial omboriga ko'chiradi */
async function mahalliyAuthlarniUla(
  ombor: FaylKredensialOmbori,
  ogohlantirishlar: AniqlashOgohlantirish[],
): Promise<void> {
  let natijalar: Awaited<ReturnType<typeof mahalliyAuthlar>>
  try {
    natijalar = await mahalliyAuthlar()
  } catch (xato) {
    // mahalliyAuthlar o'zi throw qilmasligi kerak, lekin himoya qatlami
    ogohlantirishlar.push({ manba: 'Mahalliy OAuth', sabab: xatoMatni(xato) })
    return
  }

  for (const natija of natijalar) {
    if (!natija.topilma) {
      if (natija.sabab) ogohlantirishlar.push({ manba: 'Mahalliy OAuth', sabab: natija.sabab })
      continue
    }
    const { providerId, credential } = natija.topilma
    try {
      await ombor.modify(providerId, async (hozirgi) => {
        // Omborda allaqachon yangiroq token bo'lsa — tegmaymiz. pi-ai uni
        // o'zi refresh qilib turgan bo'lishi mumkin, mahalliy fayldagisi esa
        // eskirgan bo'lishi mumkin.
        if (hozirgi?.type === 'oauth' && hozirgi.expires > credential.expires) return undefined
        return credential
      })
    } catch (xato) {
      ogohlantirishlar.push({
        manba: natija.topilma.manba,
        sabab: `omborga yozib bo'lmadi: ${xatoMatni(xato)}`,
      })
    }
  }
}

function xatoMatni(xato: unknown): string {
  return xato instanceof Error ? xato.message : String(xato)
}
