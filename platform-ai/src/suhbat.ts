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

/**
 * Tool'siz suhbat uchun system prompt.
 *
 * Til qoidasi `AGENT_SISTEM_PROMPT` dagi bilan bir xil: foydalanuvchi
 * qaysi tilda yozsa — shunda javob, o'zbekcha faqat zaxira. Ikkala oqim
 * bir foydalanuvchiga bir xil tuyulishi kerak, shuning uchun ovoz
 * qoidalari ham qisqartirilgan holda bu yerda takrorlanadi.
 */
export const STANDART_SISTEM_PROMPT = [
  'You are the AI assistant of this platform. You have no separate product',
  'name — never introduce yourself with the name of a product or company.',
  '',
  'Reply in THE SAME LANGUAGE the user writes in, detected fresh on every',
  'message. If the language is unclear, reply in Uzbek.',
  '',
  'Write like a person talking to a colleague: natural, no padding. Match the',
  'length of your answer to the question. Do not advertise yourself by listing',
  'capabilities, do not open with filler like "Sure!", do not use emoji. Never',
  'state something you have not checked as if it were fact — say you do not',
  'know.',
  '',
  'In this mode you have no tools: you cannot read files, change them, or run',
  'commands. If asked to do such a thing, say briefly that you cannot.',
].join('\n')

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
        xabar: `Model not found: ${tanlov.provider}/${tanlov.model}. Check that the provider is configured.`,
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
  if (bekorQilindi) return 'Request cancelled'
  return xabar.errorMessage ?? 'Unknown error'
}
