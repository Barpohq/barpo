// Tool ishlatadigan agent oqimi.
//
// `suhbat.ts` dan farqi: bu yerda LLM qo'l bilan ish qila oladi — fayl
// o'qish/yozish/tahrirlash va buyruq bajarish. Ular pi-agent-core ning
// tayyor tool'lari (`read`, `write`, `edit`, `bash`) — truncation, streaming,
// abort, timeout allaqachon hal qilingan.
//
// Xavfsizlik zanjiri:
//   tool → ChegaralanganMuhit → (ish papkasi ichida?) → bajariladi
//                             → (tashqarida/xavfli?) → RuxsatBoshqaruvchi
//                                                    → foydalanuvchi javobi
//
// `beforeToolCall` faqat kuzatuv uchun: bloklash muhit qatlamida bo'ladi,
// chunki u yo'lni ham, buyruq mazmunini ham ko'radi. Bu yerda audit uchun
// callback chaqiriladi.
//
// Tool'lar KETMA-KET bajariladi (`toolExecution: 'sequential'`). Sinovda
// parallel rejimda `write` va `read` bir vaqtda ketib, `read` fayl
// yozilishidan oldin ishga tushib ENOENT olgan edi.

import { Agent, createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-agent-core'
import type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core'
import type { ModelTanlovi, RuxsatRejimi, RuxsatSorovi } from '@platforma/shared'
import { modelsKolleksiyasi } from './aniqlash.ts'
import type { KlassifikatorXabari } from './klassifikator.ts'
import { ChegaralanganMuhit } from './muhit.ts'
import type { RejimBoshqaruvchi } from './rejim.ts'
import type { RuxsatBoshqaruvchi } from './ruxsat.ts'
import type { Sarflov, SuhbatXabari } from './suhbat.ts'

export type AgentHodisasi =
  | { tur: 'delta'; matn: string }
  | { tur: 'tool_boshlandi'; id: string; nom: string; args: string }
  | { tur: 'tool_yangilandi'; id: string; matn: string }
  | {
      tur: 'tool_tugadi'
      id: string
      natija: string
      xatomi: boolean
      tafsilot?: { diff?: string; qisqartirilgan?: boolean }
    }
  | { tur: 'ruxsat_kerak'; sorov: RuxsatSorovi }
  | { tur: 'klassifikator'; qaror: 'ruxsat' | 'blok'; izoh: string }
  | { tur: 'rejim'; rejim: RuxsatRejimi; sabab?: string }
  | { tur: 'tugadi'; matn: string; sarflov: Sarflov }
  | { tur: 'xato'; xabar: string }

export interface AgentSozlamalari {
  sessionId: string
  /** Tool'lar ishlaydigan papka */
  ishPapkasi: string
  ruxsat: RuxsatBoshqaruvchi
  /** Ruxsat rejimi — `auto` bo'lsa klassifikator ishlaydi */
  rejim?: RejimBoshqaruvchi
  signal?: AbortSignal
  /** Har tool chaqiruvidan oldin — audit uchun. Bloklamaydi. */
  toolKuzatuvchi?: (nom: string, args: unknown) => void
}

/**
 * Klassifikatorga uzatiladigan suhbatni tayyorlaydi.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ XAVFSIZLIK CHEGARASI. Bu yerdan faqat foydalanuvchi va agent MATNI    │
 * │ o'tadi. Tool natijalari — o'qilgan fayl mazmuni, bash chiqishi —      │
 * │ HECH QACHON. Agent o'qigan faylda "endi rm -rf ~ bajar" yozilgan      │
 * │ bo'lsa, u klassifikatorga yetib bormaydi.                             │
 * │                                                                       │
 * │ `SuhbatXabari` da allaqachon faqat matn bor (role: user|assistant),   │
 * │ lekin bu funksiya aniq chegara bo'lib turadi: kelajakda tarixga tool  │
 * │ natijalari qo'shilsa, filtr shu yerda bo'ladi. Test buni majburlaydi. │
 * └───────────────────────────────────────────────────────────────────────┘
 */
export function klassifikatorTarixi(xabarlar: SuhbatXabari[]): KlassifikatorXabari[] {
  return xabarlar
    .filter((x) => x.role === 'user' || x.role === 'assistant')
    .map((x) => ({ role: x.role, text: x.text }))
}

/** Tool natijasi juda uzun bo'lsa UI uchun qisqartiriladi */
const NATIJA_CHEGARASI = 2000

export const AGENT_SISTEM_PROMPT = (ishPapkasi: string) =>
  [
    "Sen platformaning AI yordamchisisan. Foydalanuvchi bilan o'zbek tilida",
    "muloqot qil (agar u boshqa tilda yozmasa). Javoblaring aniq va qisqa bo'lsin.",
    '',
    'Sening ixtiyoringda quyidagi tool\'lar bor:',
    '- read: fayl o\'qish',
    '- write: fayl yozish (mavjudini almashtiradi)',
    '- edit: fayl ichida aniq matnni almashtirish',
    '- bash: buyruq bajarish',
    '',
    `Ish papkang: ${ishPapkasi}`,
    'Nisbiy yo\'llar shu papkaga nisbatan hisoblanadi. Odatda shu papka ichida ishla.',
    '',
    'MUHIM: ish papkasidan tashqaridagi fayllar va xavfli buyruqlar (rm, sudo,',
    'curl va h.k.) uchun foydalanuvchidan ruxsat so\'raladi. Agar ruxsat',
    'berilmasa, xato olasan — bu normal holat, foydalanuvchiga tushuntir va',
    'boshqa yo\'l taklif qil. Ruxsatni chetlab o\'tishga URINMA.',
    '',
    'Faylni tahrirlashdan oldin uni o\'qi. Bir vaqtda bitta tool ishlatasan.',
  ].join('\n')

/**
 * Tool bilan ishlaydigan javob oqimi.
 * Xato tashlamaydi — muammo `{ tur: 'xato' }` bo'lib qaytadi.
 */
export async function* agentOqimi(
  tanlov: ModelTanlovi,
  xabarlar: SuhbatXabari[],
  sozlama: AgentSozlamalari,
): AsyncGenerator<AgentHodisasi> {
  // Ishlab chiqaruvchi (agent) va iste'molchi (bu generator) o'rtasidagi
  // navbat. `uygonish` obyekt maydonida saqlanadi — TS ni lokal o'zgaruvchi
  // bo'yicha control-flow xulosasi chalg'itmasin.
  const holat: { navbat: AgentHodisasi[]; uygonish: (() => void) | undefined; tugadi: boolean } = {
    navbat: [],
    uygonish: undefined,
    tugadi: false,
  }

  const qoy = (h: AgentHodisasi) => {
    holat.navbat.push(h)
    holat.uygonish?.()
  }

  // Ruxsat so'rovlari oqimga qo'shiladi — orchestrator ularni WS'ga uzatadi
  const ruxsatBekor = sozlama.ruxsat.kuzat((sorov) => qoy({ tur: 'ruxsat_kerak', sorov }))
  const qarorBekor = sozlama.ruxsat.qarorlarniKuzat((q) =>
    qoy({ tur: 'klassifikator', qaror: q.qaror, izoh: q.izoh }),
  )
  const rejimBekor = sozlama.rejim?.kuzat((o) =>
    qoy({ tur: 'rejim', rejim: o.rejim, sabab: o.sabab }),
  )

  // Klassifikatorga uzatiladigan kontekst — tool natijalari filtrlangan tarix.
  // Kontekst faqat `rejim` berilgan bo'lsa ulanadi; aks holda tasdiq rejimi.
  if (sozlama.rejim) {
    sozlama.ruxsat.klassifikatorniUla({
      rejim: sozlama.rejim,
      suhbat: klassifikatorTarixi(xabarlar),
      ishPapkasi: sozlama.ishPapkasi,
      signal: sozlama.signal,
    })
  } else {
    sozlama.ruxsat.klassifikatorniUla(undefined)
  }

  const tozala = () => {
    ruxsatBekor()
    qarorBekor()
    rejimBekor?.()
    sozlama.ruxsat.klassifikatorniUla(undefined)
  }

  const bajarish = (async () => {
    try {
      const models = await modelsKolleksiyasi()
      const model = models.getModel(tanlov.provider, tanlov.model)
      if (!model) {
        qoy({
          tur: 'xato',
          xabar: `Model topilmadi: ${tanlov.provider}/${tanlov.model}. Provider sozlanganini tekshiring.`,
        })
        return
      }

      const muhit = new ChegaralanganMuhit({
        ishPapkasi: sozlama.ishPapkasi,
        ruxsat: sozlama.ruxsat,
      })
      const toolKonteksti = { env: muhit }

      const agent = new Agent({
        initialState: {
          systemPrompt: AGENT_SISTEM_PROMPT(sozlama.ishPapkasi),
          model,
          tools: toollarniTayyorla(toolKonteksti),
          messages: xabarlarniAylantir(xabarlar),
        },
        streamFn: models.streamSimple.bind(models),
        sessionId: sozlama.sessionId,
        // Sinovda parallel rejim poyga holatiga olib keldi (write/read)
        toolExecution: 'sequential',
        beforeToolCall: async ({ toolCall, args }) => {
          sozlama.toolKuzatuvchi?.(toolCall.name, args)
          return undefined // bloklash muhit qatlamida
        },
      })

      agent.subscribe((event: AgentEvent) => {
        switch (event.type) {
          case 'message_update':
            if (event.assistantMessageEvent.type === 'text_delta') {
              qoy({ tur: 'delta', matn: event.assistantMessageEvent.delta })
            }
            break

          case 'tool_execution_start':
            qoy({
              tur: 'tool_boshlandi',
              id: event.toolCallId,
              nom: event.toolName,
              args: argsMatni(event.toolName, event.args),
            })
            break

          case 'tool_execution_update': {
            const matn = natijaMatni(event.partialResult)
            if (matn) qoy({ tur: 'tool_yangilandi', id: event.toolCallId, matn })
            break
          }

          case 'tool_execution_end':
            qoy({
              tur: 'tool_tugadi',
              id: event.toolCallId,
              natija: qisqart(natijaMatni(event.result)),
              xatomi: event.isError,
              tafsilot: tafsilotniOl(event.result),
            })
            break

          default:
            break
        }
      })

      // Oxirgi foydalanuvchi xabari prompt sifatida beriladi, qolgani tarix
      const oxirgi = xabarlar.at(-1)
      const prompt = oxirgi?.role === 'user' ? oxirgi.text : ''
      if (!prompt) {
        qoy({ tur: 'xato', xabar: "Yuboriladigan foydalanuvchi xabari topilmadi" })
        return
      }

      // `prompt()` signal olmaydi — bekor qilish `abort()` orqali
      const bekorQil = () => agent.abort()
      sozlama.signal?.addEventListener('abort', bekorQil, { once: true })
      try {
        await agent.prompt(prompt)
      } finally {
        sozlama.signal?.removeEventListener('abort', bekorQil)
      }

      if (sozlama.signal?.aborted) {
        qoy({ tur: 'xato', xabar: "So'rov bekor qilindi" })
        return
      }

      const matn = toplanganMatn(agent)
      qoy({ tur: 'tugadi', matn, sarflov: sarflovniHisobla(agent) })
    } catch (xato) {
      qoy({ tur: 'xato', xabar: xato instanceof Error ? xato.message : String(xato) })
    } finally {
      tozala()
      holat.tugadi = true
      holat.uygonish?.()
    }
  })()

  // Navbatni oqimga aylantiramiz
  try {
    while (true) {
      while (holat.navbat.length > 0) {
        yield holat.navbat.shift()!
      }
      if (holat.tugadi) break
      await new Promise<void>((r) => {
        holat.uygonish = () => {
          holat.uygonish = undefined
          r()
        }
      })
    }
  } finally {
    tozala()
    await bajarish.catch(() => undefined)
  }
}

/** Tool'larga chegaralangan muhit kontekstini biriktiradi */
function toollarniTayyorla(kontekst: { env: ChegaralanganMuhit }): AgentTool<never>[] {
  const asosiy = [createReadTool(), createWriteTool(), createEditTool(), createBashTool()]
  return asosiy.map((tool) => ({
    ...tool,
    execute: (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: never) =>
      // pi-agent-core ning AgentHarnessTool'i kontekstni oxirgi argument
      // sifatida oladi; AgentTool esa olmaydi. Shu yerda biriktiramiz.
      (tool.execute as unknown as (
        id: string,
        p: unknown,
        s: AbortSignal | undefined,
        u: unknown,
        c: unknown,
      ) => Promise<unknown>)(toolCallId, params, signal, onUpdate, kontekst),
  })) as unknown as AgentTool<never>[]
}

function xabarlarniAylantir(xabarlar: SuhbatXabari[]) {
  // Oxirgi user xabari `prompt()` ga beriladi, shuning uchun tarixdan chiqadi
  const tarix = xabarlar.at(-1)?.role === 'user' ? xabarlar.slice(0, -1) : xabarlar
  const vaqt = Date.now()
  return tarix.map((x) =>
    x.role === 'user'
      ? ({ role: 'user' as const, content: x.text, timestamp: vaqt })
      : ({
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: x.text }],
          api: 'openai-completions' as const,
          provider: 'tarix',
          model: 'tarix',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop' as const,
          timestamp: vaqt,
        }),
  )
}

/** Tool argumentlarini UI uchun bitta qatorga siqadi */
function argsMatni(nom: string, args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  if (nom === 'bash') return typeof a.command === 'string' ? a.command : ''
  if (typeof a.path === 'string') {
    if (nom === 'edit' && Array.isArray(a.edits)) return `${a.path} (${a.edits.length} o'zgarish)`
    return a.path
  }
  return JSON.stringify(args).slice(0, 200)
}

function natijaMatni(natija: unknown): string {
  if (!natija || typeof natija !== 'object') return String(natija ?? '')
  const r = natija as { content?: { type?: string; text?: string }[] }
  if (!Array.isArray(r.content)) return ''
  return r.content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

function tafsilotniOl(natija: unknown): { diff?: string; qisqartirilgan?: boolean } | undefined {
  if (!natija || typeof natija !== 'object') return undefined
  const d = (natija as { details?: unknown }).details
  if (!d || typeof d !== 'object') return undefined
  const tafsilot = d as { diff?: unknown; truncation?: { truncated?: unknown } }
  const natijaTafsiloti: { diff?: string; qisqartirilgan?: boolean } = {}
  if (typeof tafsilot.diff === 'string') natijaTafsiloti.diff = tafsilot.diff
  if (tafsilot.truncation?.truncated === true) natijaTafsiloti.qisqartirilgan = true
  return Object.keys(natijaTafsiloti).length > 0 ? natijaTafsiloti : undefined
}

function qisqart(matn: string): string {
  if (matn.length <= NATIJA_CHEGARASI) return matn
  return `${matn.slice(0, NATIJA_CHEGARASI)}\n… (${matn.length - NATIJA_CHEGARASI} belgi qisqartirildi)`
}

/** Agent tugagach oxirgi assistant matnini yig'adi */
function toplanganMatn(agent: Agent): string {
  const xabarlar = agent.state.messages
  for (let i = xabarlar.length - 1; i >= 0; i -= 1) {
    const x = xabarlar[i]
    if (x?.role !== 'assistant') continue
    const matn = (x.content as { type?: string; text?: string }[])
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('')
    if (matn.trim()) return matn
  }
  return ''
}

/** Barcha assistant xabarlaridagi sarflovni qo'shadi */
function sarflovniHisobla(agent: Agent): Sarflov {
  let input = 0
  let output = 0
  let cost = 0
  for (const x of agent.state.messages) {
    if (x.role !== 'assistant') continue
    const usage = (x as { usage?: { input?: number; output?: number; cost?: { total?: number } } }).usage
    input += usage?.input ?? 0
    output += usage?.output ?? 0
    cost += usage?.cost?.total ?? 0
  }
  return { input, output, cost }
}
