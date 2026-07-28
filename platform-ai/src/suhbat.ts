// Oddiy matnli suhbat oqimi — tool'siz.
//
// pi-ai ning boy event oqimini (text_start, thinking_delta, toolcall_end, ...)
// platformaga kerak bo'lgan uchta soddaga aylantiradi: delta / tugadi / xato.
// Tool'lar keyingi bosqichda qo'shiladi — o'shanda bu yerga `toolcall`
// eventlari va `Context.tools` qo'shiladi, chaqiruvchilar o'zgarmaydi.
//
// Xatolar throw qilinmaydi: oqim `{ tur: 'xato' }` bilan tugaydi. Sabab —
// chaqiruvchi (orchestrator) uchun xato ham javobning bir qismi: uni chat
// tarixiga yozib, WS orqali UI'ga yuborish kerak.

import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai'
import type { ModelTanlovi } from '@platforma/shared'
import { modelsKolleksiyasi } from './aniqlash.ts'

export interface SuhbatXabari {
  role: 'user' | 'assistant'
  text: string
}

export interface Sarflov {
  input: number
  output: number
  cost: number
}

export type SuhbatHodisasi =
  | { tur: 'delta'; matn: string }
  | { tur: 'tugadi'; matn: string; sarflov: Sarflov }
  | { tur: 'xato'; xabar: string }

export const STANDART_SISTEM_PROMPT = [
  "Sen platformaning yordamchi AI assistentisan. Foydalanuvchi bilan o'zbek tilida",
  "muloqot qil (agar u boshqa tilda yozmasa). Javoblaring aniq va qisqa bo'lsin.",
  "Hozircha sening ixtiyoringda hech qanday tool yo'q — faqat suhbatlashasan.",
  "Agar biror amalni bajarish so'ralsa, buni hozircha qila olmasligingni ayt.",
].join(' ')

export interface SuhbatSozlamalari {
  sistemPrompt?: string
  signal?: AbortSignal
}

/**
 * LLM javobini oqim sifatida qaytaradi.
 * Model topilmasa yoki so'rov muvaffaqiyatsiz bo'lsa — `xato` hodisasi.
 */
export async function* suhbatOqimi(
  tanlov: ModelTanlovi,
  xabarlar: SuhbatXabari[],
  sozlama?: SuhbatSozlamalari,
): AsyncGenerator<SuhbatHodisasi> {
  let model
  try {
    const models = await modelsKolleksiyasi()
    model = models.getModel(tanlov.provider, tanlov.model)
    if (!model) {
      yield {
        tur: 'xato',
        xabar: `Model topilmadi: ${tanlov.provider}/${tanlov.model}. Provider sozlanganini tekshiring.`,
      }
      return
    }

    const context: Context = {
      systemPrompt: sozlama?.sistemPrompt ?? STANDART_SISTEM_PROMPT,
      messages: xabarlarniAylantir(xabarlar),
      // tools ATAYLAB berilmaydi — bu bosqichda tool yo'q
    }

    const oqim = models.stream(model, context, { signal: sozlama?.signal })

    let toplangan = ''
    for await (const hodisa of oqim) {
      switch (hodisa.type) {
        case 'text_delta':
          toplangan += hodisa.delta
          yield { tur: 'delta', matn: hodisa.delta }
          break

        case 'done':
          yield { tur: 'tugadi', matn: toplangan, sarflov: sarflovniOl(hodisa.message) }
          return

        case 'error':
          yield {
            tur: 'xato',
            xabar: xatoXabari(hodisa.error, hodisa.reason === 'aborted'),
          }
          return

        default:
          // thinking_*, toolcall_*, text_start/end, start — bu bosqichda
          // e'tiborsiz qoldiriladi
          break
      }
    }

    // Oqim `done` ham, `error` ham bermay tugadi — bunday bo'lmasligi kerak,
    // lekin UI abadiy kutib qolmasligi uchun yopamiz
    yield { tur: 'tugadi', matn: toplangan, sarflov: { input: 0, output: 0, cost: 0 } }
  } catch (xato) {
    yield { tur: 'xato', xabar: xato instanceof Error ? xato.message : String(xato) }
  }
}

function xabarlarniAylantir(xabarlar: SuhbatXabari[]): Message[] {
  const vaqt = Date.now()
  return xabarlar.map((x) =>
    x.role === 'user'
      ? { role: 'user', content: x.text, timestamp: vaqt }
      : ({
          role: 'assistant',
          content: [{ type: 'text', text: x.text }],
          // Tarixdagi javoblar qaysi model bilan yozilgani muhim emas —
          // pi-ai bu maydonlarni faqat yangi javoblarda to'ldiradi.
          api: 'openai-completions',
          provider: 'tarix',
          model: 'tarix',
          usage: bosSarflov(),
          stopReason: 'stop',
          timestamp: vaqt,
        } satisfies AssistantMessage),
  )
}

function bosSarflov() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function sarflovniOl(xabar: AssistantMessage): Sarflov {
  return {
    input: xabar.usage.input,
    output: xabar.usage.output,
    cost: xabar.usage.cost.total,
  }
}

function xatoXabari(xabar: AssistantMessage, bekorQilindi: boolean): string {
  if (bekorQilindi) return "So'rov bekor qilindi"
  return xabar.errorMessage ?? "Noma'lum xato"
}
