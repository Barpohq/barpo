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
import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import type { Api, Model, Models } from '@earendil-works/pi-ai'
import type { Config } from '@platforma/config'
import { standartConfig } from '@platforma/config'
import type { ModelTanlovi, RuxsatRejimi, RuxsatSorovi } from '@platforma/shared'
import { modelsKolleksiyasi } from './aniqlash.ts'
import {
  keyinZanjiri,
  maxfiyniYashirHooki,
  oldinZanjiri,
  qoshimchaTaqiqHooki,
  uzunlikHooki,
  type ToolHooki,
} from './hooklar.ts'
import type { KlassifikatorXabari } from './klassifikator.ts'
import {
  eskilarniTashla,
  kontekstniQur,
  kontekstTokenlari,
  siq,
  siqishKerakmi,
  toolNatijalariniQisqart,
  type SaqlanganXabar,
} from './kontekst.ts'
import { ChegaralanganMuhit } from './muhit.ts'
import type { RejimBoshqaruvchi } from './rejim.ts'
import { qidiruvToollariXom } from './qidiruv-toollari.ts'
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
  /** Kontekst siqildi — UI foydalanuvchiga bildiradi */
  | { tur: 'siqildi'; oldingiTokenlar: number; yangiTokenlar: number }
  | {
      tur: 'tugadi'
      matn: string
      sarflov: Sarflov
      /**
       * Agent qurgan to'liq kontekst — TOOL NATIJALARI BILAN.
       * Chaqiruvchi shuni saqlaydi va keyingi turn'da qaytaradi; usiz
       * agent har turn o'z tool natijalarini unutadi.
       */
      xabarlar: AgentMessage[]
      /** Provider aytgan kontekst hajmi — keyingi siqish qarori uchun */
      kontekstTokenlari: number
    }
  | { tur: 'xato'; xabar: string }

export interface AgentSozlamalari {
  sessionId: string
  /** Tool'lar ishlaydigan papka */
  ishPapkasi: string
  ruxsat: RuxsatBoshqaruvchi
  /** Ruxsat rejimi — `auto` bo'lsa klassifikator ishlaydi */
  rejim?: RejimBoshqaruvchi
  signal?: AbortSignal
  /** Platforma sozlamalari. Berilmasa standart qiymatlar. */
  sozlamalar?: Config
  /**
   * Klassifikatorga beriladigan MATNLI tarix.
   *
   * Berilmasa `xabarlar` dan qurilib, tool natijalari filtrlanadi. Chaqiruvchi
   * o'zi bergani afzal: u bazadagi toza matnni biladi va shu bilan bir emas,
   * ikki qatlamli himoya hosil bo'ladi.
   */
  klassifikatorTarixi?: SuhbatXabari[]
  /** Har tool chaqiruvidan oldin — audit uchun. Bloklamaydi. */
  toolKuzatuvchi?: (nom: string, args: unknown) => void
  /** Qo'shimcha hook'lar — config'dagilarga qo'shiladi */
  hooklar?: ToolHooki[]
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
    '- grep: fayllar ichidan regex bilan qidirish (`fayl:qator:matn`)',
    '- find: glob bo\'yicha fayl nomini topish',
    '- ls: papka ro\'yxatini ko\'rish',
    '- bash: buyruq bajarish',
    '',
    'Fayl qidirishda `bash` EMAS, `grep`/`find`/`ls` ni ishlat — ular tezroq',
    'va ruxsat so\'ramaydi. `bash` faqat boshqa ilojisi bo\'lmaganda kerak.',
    'Bu uch tool faqat ish papkasi ichida ishlaydi va standart holda `.git`,',
    '`node_modules`, `dist` kabi papkalarni tashlab ketadi (`all: true` bilan',
    'ularni ham ko\'rish mumkin).',
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
  xabarlar: SaqlanganXabar[],
  sozlama: AgentSozlamalari,
): AsyncGenerator<AgentHodisasi> {
  const sozlamalar = sozlama.sozlamalar ?? standartConfig()
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

  // Config qiymatlarini boshqaruvchilarga uzatamiz. Ular sessiya bo'yicha
  // reestrda saqlanadi va yaratilgan paytda config hali ma'lum emas edi.
  sozlama.ruxsat.kutishMuddatiniOrnat(sozlamalar.ruxsat.kutishSoniya * 1000)
  sozlama.rejim?.chegaralarniOrnat(
    sozlamalar.ruxsat.ketmaKetBlokChegarasi,
    sozlamalar.ruxsat.jamiBlokChegarasi,
  )

  // Ruxsat so'rovlari oqimga qo'shiladi — orchestrator ularni WS'ga uzatadi
  const ruxsatBekor = sozlama.ruxsat.kuzat((sorov) => qoy({ tur: 'ruxsat_kerak', sorov }))
  const qarorBekor = sozlama.ruxsat.qarorlarniKuzat((q) =>
    qoy({ tur: 'klassifikator', qaror: q.qaror, izoh: q.izoh }),
  )
  const rejimBekor = sozlama.rejim?.kuzat((o) =>
    qoy({ tur: 'rejim', rejim: o.rejim, sabab: o.sabab }),
  )

  // Klassifikatorga uzatiladigan kontekst — TOOL NATIJALARISIZ tarix.
  // Chaqiruvchi tayyor matnli tarix bergan bo'lsa shuni olamiz, aks holda
  // saqlangan xabarlarning faqat `text` maydonidan quramiz. Ikkala yo'lda
  // ham `agentMessages` (tool natijalari bor joy) HISOBGA OLINMAYDI.
  // Kontekst faqat `rejim` berilgan bo'lsa ulanadi; aks holda tasdiq rejimi.
  if (sozlama.rejim) {
    sozlama.ruxsat.klassifikatorniUla({
      rejim: sozlama.rejim,
      suhbat: klassifikatorTarixi(sozlama.klassifikatorTarixi ?? matnliTarix(xabarlar)),
      ishPapkasi: sozlama.ishPapkasi,
      signal: sozlama.signal,
      model: sozlamalar.ruxsat.klassifikatorModeli,
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
        buyruqTimeoutMs: sozlamalar.agent.toollar.bashTimeoutSekund * 1000,
      })
      const toolKonteksti = { env: muhit }

      // --- Kontekstni tayyorlash: tool natijalari bilan, siqilgan holda ---
      const oxirgiUser = oxirgiUserIndeksi(xabarlar)
      if (oxirgiUser < 0) {
        qoy({ tur: 'xato', xabar: "Yuboriladigan foydalanuvchi xabari topilmadi" })
        return
      }
      const prompt = xabarlar[oxirgiUser]!.text

      // Oxirgi user xabari `prompt()` ga beriladi — tarixda takrorlanmasin.
      // Undan KEYINGI xabarlar (bekor qilingan javob) tarixda qoladi.
      const tarixXabarlari = [...xabarlar.slice(0, oxirgiUser), ...xabarlar.slice(oxirgiUser + 1)]

      let kontekst = kontekstniQur(tarixXabarlari)
      kontekst = toolNatijalariniQisqart(kontekst, sozlamalar.agent.tarix.toolNatijasiChegarasi)

      // Siqish: avval LLM bilan xulosalash, u ishlamasa qattiq kesish.
      // Ikkalasi ham bo'lmasa uzun suhbat context window'ga sig'may qoladi
      // va sessiya butunlay ishlamay qo'yadi.
      if (siqishKerakmi(kontekst, model.contextWindow, sozlamalar.agent.siqish)) {
        const oldingi = kontekstTokenlari(kontekst)
        const natija = await siq(
          kontekst,
          models,
          siqishModeli(models, model, sozlamalar),
          sozlamalar.agent.siqish,
          sozlama.signal,
        )
        if (natija.holat === 'siqildi') {
          kontekst = natija.xabarlar
          qoy({
            tur: 'siqildi',
            oldingiTokenlar: natija.oldingiTokenlar,
            yangiTokenlar: kontekstTokenlari(kontekst),
          })
        } else if (natija.holat === 'nosoz') {
          // Xulosalash ishlamadi — qattiq kesishga o'tamiz. Kontekst
          // yo'qoladi, lekin sessiya ishlashda davom etadi (alternativa —
          // so'rov context window xatosi bilan yiqilishi).
          kontekst = eskilarniTashla(kontekst, Math.floor(sozlamalar.agent.tarix.maksXabar / 2))
          qoy({ tur: 'siqildi', oldingiTokenlar: oldingi, yangiTokenlar: kontekstTokenlari(kontekst) })
        }
      }

      // Qattiq chegara har holda qo'llanadi — siqish yoqilmagan bo'lsa ham
      kontekst = eskilarniTashla(kontekst, sozlamalar.agent.tarix.maksXabar)

      // --- Hook zanjiri ---
      const hooklar: ToolHooki[] = [
        qoshimchaTaqiqHooki(sozlamalar.ruxsat.qoshimchaTaqiqlar),
        maxfiyniYashirHooki(),
        uzunlikHooki(sozlamalar.agent.tarix.toolNatijasiChegarasi),
        ...(sozlama.hooklar ?? []),
      ]
      const hookKonteksti = { ishPapkasi: sozlama.ishPapkasi, sessionId: sozlama.sessionId }

      const agent = new Agent({
        initialState: {
          systemPrompt: AGENT_SISTEM_PROMPT(sozlama.ishPapkasi),
          model,
          tools: toollarniTayyorla(toolKonteksti, sozlamalar.agent.toollar.yoqilgan),
          messages: kontekst,
        },
        streamFn: models.streamSimple.bind(models),
        sessionId: sozlama.sessionId,
        // Sinovda parallel rejim poyga holatiga olib keldi (write/read)
        toolExecution: 'sequential',
        beforeToolCall: async ({ toolCall, args }) => {
          sozlama.toolKuzatuvchi?.(toolCall.name, args)
          // Hook'lar QO'SHIMCHA cheklov qo'ya oladi. Asosiy xavfsizlik
          // (qat'iy taqiq, ish papkasi chegarasi, klassifikator) muhit
          // qatlamida va undan oldinroq ishlaydi — hook uni bekor qila olmaydi.
          const qaror = await oldinZanjiri(hooklar, {
            ...hookKonteksti,
            nom: toolCall.name,
            args,
          })
          if (qaror?.blokla) return { block: true, reason: qaror.sabab }
          return undefined
        },
        afterToolCall: async ({ toolCall, args, result, isError }) => {
          const xom = natijaMatni(result)
          const yangi = await keyinZanjiri(hooklar, {
            ...hookKonteksti,
            nom: toolCall.name,
            args,
            natija: xom,
            xatomi: isError,
          })
          if (yangi.natija === xom && yangi.xatomi === isError) return undefined
          return {
            content: [{ type: 'text', text: yangi.natija }],
            isError: yangi.xatomi,
          }
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

      // Prompt va tarix yuqorida ajratilgan.
      //
      // ESLATMA: "massivning oxirgi elementi user'mi" deb tekshirish YETARLI
      // EMAS. Tarix `assistant` bilan tugashi mumkin — quyidagi POYGA HOLATI
      // haqiqatda uchraydi:
      //   1) foydalanuvchi xabar yubordi, oqim ketmoqda;
      //   2) u "To'xtatish" bosdi va darhol yangi xabar yubordi;
      //   3) `javobOqizi` eski oqimni abort qiladi va YANGI user xabarini
      //      bazaga yozadi;
      //   4) abort qilingan eski oqim esa `finally` da o'z javobini
      //      ("⚠︎ Javob to'liq kelmadi: So'rov bekor qilindi") endi saqlaydi —
      //      ya'ni yangi user xabaridan KEYIN.
      // Natijada tarix `... user, assistant` bo'lib qoladi va oldingi kod
      // "Yuboriladigan foydalanuvchi xabari topilmadi" xatosi bilan
      // foydalanuvchining xabarini JIMGINA yo'qotardi. Shuning uchun oxirgi
      // USER xabari qidiriladi va undan keyingilari tarixda qoldiriladi.

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
      qoy({
        tur: 'tugadi',
        matn,
        sarflov: sarflovniHisobla(agent),
        // To'liq kontekst — tool natijalari bilan. Chaqiruvchi buni saqlaydi
        // va keyingi turn'da qaytaradi, shunda agent xotirasini yo'qotmaydi.
        xabarlar: agent.state.messages,
        kontekstTokenlari: kontekstTokenlari(agent.state.messages),
      })
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
function toollarniTayyorla(
  kontekst: { env: ChegaralanganMuhit },
  yoqilgan: readonly string[],
): AgentTool<never>[] {
  // pi'ning tayyor tool'lari + o'zimizning qidiruv tool'lari. Ikkalasi ham
  // kontekstni oxirgi argument sifatida oladi, shuning uchun quyidagi
  // o'ram ularga bir xil qo'llanadi.
  const barchasi = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool(),
    ...qidiruvToollariXom(),
  ]

  // Configda o'chirilgan tool UMUMAN E'LON QILINMAYDI — agent uning
  // borligini bilmaydi. Bu "chaqirsang rad etaman" dan yaxshiroq: model
  // mavjud bo'lmagan imkoniyatni qayta-qayta urinib vaqt sarflamaydi.
  const ruxsatEtilgan = new Set(yoqilgan)
  const asosiy = barchasi.filter((tool) => ruxsatEtilgan.has(tool.name))

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

/**
 * Oxirgi `user` xabarining indeksi, topilmasa -1.
 *
 * `prompt()` ga aynan shu xabar beriladi. Oddiy holatda u massivning oxirgi
 * elementi, lekin har doim emas — yuqoridagi poyga holati izohiga qarang.
 */
export function oxirgiUserIndeksi(xabarlar: { role: 'user' | 'assistant' }[]): number {
  for (let i = xabarlar.length - 1; i >= 0; i -= 1) {
    if (xabarlar[i]?.role === 'user') return i
  }
  return -1
}

/**
 * Saqlangan xabarlardan FAQAT MATNLI tarix ajratadi.
 *
 * Klassifikator uchun ishlatiladi: `agentMessages` (tool natijalari bor joy)
 * ataylab tashlanadi. Chaqiruvchi o'z matnli tarixini bergan bo'lsa bu
 * funksiya kerak bo'lmaydi — u holda ikki qatlamli himoya hosil bo'ladi.
 */
function matnliTarix(xabarlar: SaqlanganXabar[]): SuhbatXabari[] {
  return xabarlar
    .filter((x) => x.text.trim().length > 0)
    .map((x) => ({ role: x.role, text: x.text }))
}

/**
 * Siqish uchun modelni tanlaydi.
 *
 * Standart holatda ASOSIY CHAT MODELI ishlatiladi. Sabab: xulosa sifati
 * to'g'ridan-to'g'ri agentning keyingi ishiga ta'sir qiladi — yomon xulosa
 * jimgina noto'g'ri xulqqa olib keladi va buni foydalanuvchi darrov
 * sezmaydi. Arzon model bilan tejash bu xavfga arzimaydi.
 *
 * Configda `agent.siqish.modeli` berilgan bo'lsa o'sha ishlatiladi; topilmasa
 * asosiy modelga qaytiladi (xato tashlamaymiz — siqish umuman bo'lmagandan
 * ko'ra asosiy model bilan bo'lgani yaxshi).
 */
function siqishModeli(models: Models, asosiy: Model<Api>, sozlamalar: Config): Model<Api> {
  const tanlangan = sozlamalar.agent.siqish.modeli
  if (!tanlangan) return asosiy
  const [provider, ...qolgan] = tanlangan.split('/')
  const model = qolgan.join('/')
  if (!provider || !model) return asosiy
  return models.getModel(provider, model) ?? asosiy
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
