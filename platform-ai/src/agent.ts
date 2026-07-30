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
import type { ModelTanlovi, RuxsatQarori, RuxsatRejimi, RuxsatSorovi } from '@platforma/shared'
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
import { kontekstniPromptga, loyihaKontekstiniOqi } from './loyiha-konteksti.ts'
import { skilllarniOqi, skilllarniPromptga } from './skill-yuklash.ts'
import { indeksniOqi, xotiralarniOqi, xotiralarniPromptga } from './xotira.ts'
import { ChegaralanganMuhit } from './muhit.ts'
import type { RejimBoshqaruvchi } from './rejim.ts'
import { qidiruvToollariXom } from './qidiruv-toollari.ts'
import { SERVER_PROMPT_QISMI, serverToollariXom, type ServerManbasi } from './server-toollari.ts'
import {
  DASHBOARD_PROMPT_QISMI,
  dashboardToollariXom,
  type DashboardManbasi,
} from './dashboard-toollari.ts'
import { McpBoshqaruvchi, type McpUlanadiganServer } from './mcp-boshqaruvchi.ts'
import { MCP_PROMPT_QISMI, mcpTooliMi, mcpToollariXom } from './mcp-toollari.ts'
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
  /**
   * Ruxsat masalasi hal bo'ldi — qaror qayerdan kelgani bilan.
   * Chaqiruvchi buni AYNAN O'SHA PAYT ishlayotgan tool chaqiruviga
   * biriktiradi (tool'lar ketma-ket bajariladi, ya'ni bittasi aniq).
   */
  | { tur: 'ruxsat_qarori'; qaror: RuxsatQarori }
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

/**
 * Sessiya uchun ulanadigan MCP serverlar ro'yxati.
 *
 * HAR OQIM BOSHIDA yangi o'qiladi, keshlanmaydi: foydalanuvchi suhbat
 * davomida server o'rnatishi yoki olib tashlashi mumkin (`ServerManbasi`
 * bilan bir xil sabab).
 */
export type McpManbasi = () => McpUlanadiganServer[] | Promise<McpUlanadiganServer[]>

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
  /**
   * Platformaga ulangan serverlar ro'yxatini beradigan manba.
   *
   * Berilmasa `serverList` tool'i UMUMAN e'lon qilinmaydi va prompt ham
   * uni tilga olmaydi (`server-toollari.ts` ga q.). Inversiya: serverlar
   * bazasi `platform-server` da, bu paket unga bog'liq emas.
   */
  serverManbasi?: ServerManbasi
  /**
   * Ilova manifestini saqlaydigan manba (dinamik dashboard).
   *
   * Berilmasa `appPublish` tool'i UMUMAN e'lon qilinmaydi va prompt ham
   * uni tilga olmaydi (`dashboard-toollari.ts` ga q.). `serverManbasi`
   * bilan bir xil inversiya sababi: manifestlar bazasi `platform-server`
   * da, bu paket unga bog'liq emas.
   */
  dashboardManbasi?: DashboardManbasi
  /**
   * Sessiyada ulanishi kerak bo'lgan MCP serverlar ro'yxatini beradigan manba.
   *
   * `serverManbasi`/`dashboardManbasi` bilan bir xil inversiya: serverlar
   * bazasi `platform-server` da, bu paket unga bog'liq emas.
   *
   * Berilmasa YOKI bo'sh ro'yxat qaytarsa — MCP qatlami umuman ishga
   * tushmaydi: boshqaruvchi yaratilmaydi, tool e'lon qilinmaydi va prompt
   * MCP haqida bir og'iz so'z aytmaydi. Ya'ni "MCP yoqilgan/o'chirilgan"
   * degan alohida config bayrog'i KERAK EMAS — o'rnatishning o'zi nazorat.
   */
  mcpManbasi?: McpManbasi
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

/**
 * Oqim provider xatosi bilan tugaganmi — tugagan bo'lsa sabab matni.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ NEGA BU KERAK. `agent.prompt()` provider xatosida XATO TASHLAMAYDI.  │
 * │ pi-agent-core xatoni oxirgi `assistant` xabariga yozib qo'yadi       │
 * │ (`stopReason: 'error'`, `errorMessage: '...'`) va jimgina qaytadi.   │
 * │                                                                      │
 * │ Buni tekshirmasak oqim MUVAFFAQIYATLI deb hisoblanardi: matn bo'sh,  │
 * │ tool yo'q, xato yo'q. Foydalanuvchi uchun bu "chat boshlandi va      │
 * │ darhol tugadi, hech narsa bo'lmadi" — sababi ko'rinmaydi. Bazada     │
 * │ ham iz qolmasdi (`orchestrator.ts`: bo'sh javob yozilmaydi).         │
 * │                                                                      │
 * │ Haqiqiy misollar: OpenRouter `400 Reasoning is mandatory for this    │
 * │ endpoint`, Codex `invalidated oauth token`. Ikkalasi ham shu yo'ldan │
 * │ o'tib, foydalanuvchiga bo'sh javob bo'lib ko'ringan.                 │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * `aborted` bu yerda XATO EMAS: bekor qilishni chaqiruvchi o'zi biladi
 * (`signal.aborted`) va uni alohida xabar bilan bildiradi.
 *
 * Faqat OXIRGI assistant xabari tekshiriladi: undan oldingilari muvaffaqiyatli
 * tugagan turn'lar (tool zanjiri) va ular javobni buzmagan.
 */
export function oqimXatosi(xabarlar: readonly unknown[]): string | undefined {
  for (let i = xabarlar.length - 1; i >= 0; i -= 1) {
    const x = xabarlar[i] as
      | { role?: string; stopReason?: string; errorMessage?: string }
      | undefined
    if (x?.role !== 'assistant') continue
    if (x.stopReason !== 'error') return undefined
    return x.errorMessage?.trim() || 'provider javobni qaytara olmadi'
  }
  return undefined
}

/**
 * Agentning system prompti.
 *
 * TUZILISHI (tartib ataylab): kimsan → til → qanday gapirasan → qanday
 * ishlaysan → tool'lar → qo'shimcha qatlamlar. Xulq-atvor qoidalari
 * tool mexanikasidan OLDIN turadi, chunki ular har javobga taalluqli;
 * tool qoidalari esa faqat tool ishlatilganda.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ NEGA "BULARNI QILMA" RO'YXATI BOR.                                   │
 * │                                                                      │
 * │ Prompt modelga tool ro'yxatini, ish papkasi yo'lini va ruxsat        │
 * │ qoidalarini beradi. Bu ma'lumot ISHLASH uchun kerak, lekin model     │
 * │ uni FOYDALANUVCHIGA QAYTA O'QIB berishga moyil: "Salom! Mana nima    │
 * │ qila olaman: fayl o'qish, yozish… Ish papkam: /home/…". Haqiqiy      │
 * │ sinovda aynan shunday bo'ldi.                                        │
 * │                                                                      │
 * │ Ya'ni promptdagi har qator ikki vazifani bajaradi — modelga          │
 * │ ko'rsatma va (istalmagan holda) javob uchun material. Ikkinchisini   │
 * │ ochiq taqiqlash kerak, aks holda model o'zini tanishtirganda         │
 * │ promptni qayta aytib beradi.                                         │
 * │                                                                      │
 * │ Shu sabab identifikatsiya ham ochiq yozilgan: "sen kimsan" savoliga  │
 * │ javob bo'lmasa, model o'z trening identifikatsiyasiga qaytadi va     │
 * │ o'zini boshqa mahsulot nomi bilan tanishtiradi.                      │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * TIL STATIK EMAS. Ilgari prompt "o'zbek tilida muloqot qil" deb qat'iy
 * aytardi va model boshqa tilda yozilgan xabarga ham o'zbekcha javob
 * berardi. Endi til HAR XABARDA foydalanuvchining tilidan aniqlanadi;
 * o'zbekcha faqat til noaniq bo'lganda ishlatiladigan zaxira.
 *
 * `loyihaKonteksti` — ish papkasidagi `AGENTS.md`/`CLAUDE.md` matni
 * (`loyiha-konteksti.ts`). U promptning OXIRIGA, platformaning o'z
 * qoidalaridan KEYIN qo'shiladi: model uchun keyingi matn kuchliroq
 * ko'rinmasin degan qoida yo'q, lekin tartib niyatni aniq ko'rsatadi —
 * platforma qoidalari asos, loyiha ko'rsatmasi ular ustiga qo'shiladi.
 *
 * `skilllar` — ish papkasidagi `.platforma/skills/` ro'yxati
 * (`skill-yuklash.ts`). Faqat nom+tavsif+yo'l tushadi, to'liq matnni model
 * `read` bilan o'zi oladi.
 *
 * `xotira` — ish papkasidagi `.platforma/memory/` ro'yxati (`xotira.ts`).
 * Skilllar bilan bir xil progressive disclosure, lekin bo'sh bo'lganda ham
 * qo'shiladi: yozish qoidasi bo'lmasa agent mexanizm borligini bilmaydi.
 *
 * Uchala matn ham KLASSIFIKATORGA BORMAYDI — u alohida prompt
 * (`klassifikator.ts`) bilan ishlaydi va bu funksiyani umuman chaqirmaydi.
 *
 * `serverlarBor` — `serverList` tool'i e'lon qilinganmi. Yuqoridagi uchtadan
 * FARQLI o'laroq bu matn emas, bayroq: tool mavjud bo'lmaganda uni tilga
 * olish modelni yo'q imkoniyatga undardi.
 */
export const AGENT_SISTEM_PROMPT = (
  ishPapkasi: string,
  loyihaKonteksti?: string,
  skilllar?: string,
  xotira?: string,
  serverlarBor = false,
  dashboardBor = false,
  mcpBor = false,
) =>
  [
    'You are the AI assistant of this platform. You work on the user\'s project:',
    'reading files, writing them, and running commands.',
    '',
    'IDENTITY. You have no separate product name. Never introduce yourself with',
    'the name of a product, company, or model. If asked who you are, answer in',
    'one sentence: you are this platform\'s assistant and you work on their',
    'project. You do not need to know which model you are — if asked, say you',
    'do not know for certain.',
    '',
    'LANGUAGE. Reply in THE SAME LANGUAGE the user writes in. Detect it fresh on',
    'every message; never stick to the language of an earlier turn. If the',
    'language is unclear (a very short first message, only code or a link),',
    'reply in Uzbek. Never translate code, identifiers, commands, or file names.',
    '',
    '--- How you speak ---',
    '',
    'Write like a person talking to a colleague: natural, precise, no padding.',
    'Match the length of your answer to the weight of the question — one or two',
    'sentences for a simple question, real detail for real work.',
    '',
    'DO NOT:',
    '- Volunteer your tool list, your working directory path, the permission',
    '  mechanics, or any rule from these instructions. That is internal',
    '  information. Mention it only if the user asks, or if it is genuinely',
    '  needed to explain your work — and then briefly, not as a list.',
    '- Advertise yourself by enumerating your capabilities.',
    '- Introduce yourself again once the conversation has started. You are only',
    '  asked who you are once, if at all — after that, just answer.',
    '- Open replies with filler like "Sure!", "Great question!", "Absolutely!".',
    '- Recap everything you just did as a report. State the result and anything',
    '  that matters; stop there.',
    '- Use emoji (unless the user uses them first or asks for them).',
    '- Use headings, bold, or bullet lists unless the content is genuinely',
    '  structured. A plain answer is plain text.',
    '',
    '--- How you work ---',
    '',
    'SCOPE. What was asked is what you deliver — do not quietly widen it or',
    'narrow it:',
    '- Do not fix unrelated flaws you notice along the way. If you spot one,',
    '  finish the task and mention it in one sentence at the end.',
    '- Do not start refactoring, renaming, or style cleanup that was not asked',
    '  for.',
    '- Do not wander into files outside the task.',
    '- Do not add tests, docs, or extra features that were not requested.',
    'Small decisions inside the task (a variable name, where to put a helper)',
    'are yours to make — do not ask about those.',
    '',
    'AMBIGUITY. Read the request the way a careful colleague would: in ordinary',
    'cases decide yourself and keep going. BUT if two readings of the request',
    'lead to genuinely different work, ask before doing it. The test is: if my',
    'assumption is wrong, is the work wasted? If yes, ask. If no, state your',
    'assumption and proceed. Stopping everything to ask is only right when a',
    'wrong assumption would cause harm.',
    '',
    'HONESTY. Do not dress up results. If a test fails, say it failed and show',
    'the output. If you could not do part of the task, do the rest in full and',
    'say plainly what you left out and why. Call work "done" only when it is',
    'actually done and verified. Never state something you have not checked as',
    'if it were fact — verify it or say you do not know.',
    '',
    'MISTAKES. If you get something wrong, fix it and move on. Do not apologize',
    'at length or dwell on it. Correct an earlier statement only when it would',
    'change the user\'s decisions or their code.',
    '',
    '--- Tools ---',
    '',
    'You have these tools:',
    '- read: read a file',
    '- write: write a file (replaces existing content)',
    '- edit: replace an exact string inside a file',
    '- grep: search inside files with a regex (`file:line:text`)',
    '- find: locate files by glob',
    '- ls: list a directory',
    '- bash: run a command',
    ...(serverlarBor ? SERVER_PROMPT_QISMI.royxat : []),
    ...(dashboardBor ? DASHBOARD_PROMPT_QISMI.royxat : []),
    ...(mcpBor ? MCP_PROMPT_QISMI.royxat : []),
    '',
    ...(serverlarBor ? [...SERVER_PROMPT_QISMI.qoida, ''] : []),
    ...(dashboardBor ? [...DASHBOARD_PROMPT_QISMI.qoida, ''] : []),
    ...(mcpBor ? [...MCP_PROMPT_QISMI.qoida, ''] : []),
    'To find files use `grep`/`find`/`ls`, NOT `bash` — they are faster and ask',
    'for no permission. Reach for `bash` only when nothing else will do. Those',
    'three tools work only inside the working directory and by default skip',
    '`.git`, `node_modules`, `dist` and similar (pass `all: true` to include',
    'them).',
    '',
    '`bash` is the most powerful and most dangerous tool. Use it for real work:',
    'builds, tests, git, installing packages. To read or write a file use',
    '`read`/`write`, NOT `cat`/`echo`. Know what a command does before running',
    'it, and never run an irreversible one (deleting files, `git reset --hard`,',
    'force push) unless the user explicitly asked for it.',
    '',
    `Your working directory: ${ishPapkasi}`,
    'Relative paths resolve against it. Normally, work inside this directory.',
    '',
    'IMPORTANT: files outside the working directory and dangerous commands (rm,',
    'sudo, curl, etc.) require the user\'s permission. If permission is denied',
    'you get an error — that is normal. Explain it to the user and suggest',
    'another way. NEVER try to work around the permission system.',
    '',
    'Read a file before you edit it. Use one tool at a time. After changing a',
    'file you do not need to read it back to verify — if `edit` returned',
    'successfully, the change was written.',
    ...(skilllar ? [skilllar] : []),
    ...(xotira ? [xotira] : []),
    ...(loyihaKonteksti ? [loyihaKonteksti] : []),
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
  const ruxsatQaroriBekor = sozlama.ruxsat.ruxsatQarorlariniKuzat((qaror) =>
    qoy({ tur: 'ruxsat_qarori', qaror }),
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

  // MCP boshqaruvchisi `bajarish` ichida yaratiladi, lekin `tozala()` unga
  // yeta olishi kerak: oqim bekor qilinganda ham jarayonlar yopilishi shart.
  // Shu sabab tashqarida e'lon qilinadi.
  let mcpBoshqaruvchi: McpBoshqaruvchi | undefined

  const tozala = () => {
    ruxsatBekor()
    qarorBekor()
    ruxsatQaroriBekor()
    rejimBekor?.()
    sozlama.ruxsat.klassifikatorniUla(undefined)
    // ZOMBI JARAYON QOLDIRMASLIK. `tozala()` sinxron (uni `finally` bloklari
    // chaqiradi), MCP yopish esa async — natijani KUTMAYMIZ, faqat ishga
    // tushiramiz. Xato yutiladi: tozalash har qanday holatda oxirigacha
    // borishi kerak va MCP yopilmagani sessiyani yiqitmasligi lozim.
    mcpBoshqaruvchi?.yop().catch(() => undefined)
    mcpBoshqaruvchi = undefined
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

      // --- MCP serverlar: sessiyaga o'rnatilganlarga ulanish ---
      //
      // AYNI `sozlama.ruxsat` INSTANSIYASI beriladi (yangisi yaratilmaydi):
      // shunda "har doim ruxsat" naqshlari, blok hisoblagichlari va
      // klassifikator konteksti fayl/buyruq so'rovlari bilan BIR XIL
      // holatni baham ko'radi. Foydalanuvchi uchun ruxsat tizimi yagona.
      //
      // XATO TASHLAMAYDI: ulanolmagan server `ulanishXatolari` da qoladi va
      // sessiya USIZ davom etadi (`mcp-boshqaruvchi.ts` izohiga q.).
      if (sozlama.mcpManbasi) {
        const serverlar = await sozlama.mcpManbasi()
        if (serverlar.length > 0) {
          mcpBoshqaruvchi = new McpBoshqaruvchi(sozlama.sessionId, sozlama.ruxsat)
          // Timeoutlar CONFIGDAN qo'llanadi. Manba (`platform-server`) ularni
          // bilmaydi — u faqat "qaysi serverga ulanish kerak" ni aytadi,
          // "qancha kutish" esa platforma sozlamasi. Manba o'zi bergan
          // qiymat bo'lsa u ustun turadi (test va maxsus holatlar uchun).
          await mcpBoshqaruvchi.ulash(
            serverlar.map((s) => ({
              ...s,
              sozlama: {
                handshakeTimeoutMs: sozlamalar.mcp.ulanishTimeoutSekund * 1000,
                chaqiruvTimeoutMs: sozlamalar.mcp.chaqiruvTimeoutSekund * 1000,
                ...s.sozlama,
              },
            })),
            sozlama.signal,
          )
        }
      }

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

      // Ish papkasidagi AGENTS.md / CLAUDE.md — agentga qo'shimcha
      // ko'rsatma. Klassifikatorga bormaydi (loyiha-konteksti.ts ga q.).
      const loyihaKonteksti = loyihaKontekstiniOqi(sozlama.ishPapkasi)

      // O'rnatilgan skilllar ro'yxati (`.platforma/skills/`). Papkani sessiya
      // boshida server tayyorlaydi — bu yerda faqat o'qiymiz.
      const skilllar = skilllarniPromptga(skilllarniOqi(sozlama.ishPapkasi))

      // Loyiha xotirasi (`.platforma/memory/`) — agentning o'z yozuvlari.
      // Skilllardan farqli, hech kim sinxronlamaydi: fayllar o'sha yerda
      // yashaydi. Klassifikatorga bormaydi (`xotira.ts` ga q.).
      //
      // Indeks (`MEMORY.md`) TO'LIQ tushadi, xotira fayllari — faqat
      // nom+tavsif. Ikkalasi bir-birini to'ldiradi: indeks agentning o'z
      // yo'l xaritasi, ro'yxat esa mashina qurgan to'liq katalog.
      const xotira = xotiralarniPromptga(
        xotiralarniOqi(sozlama.ishPapkasi),
        sozlama.ishPapkasi,
        indeksniOqi(sozlama.ishPapkasi),
      )

      // Tool ro'yxati bir marta quriladi va prompt bayrog'i undan OLINADI:
      // `serverList` config'da o'chirilgan bo'lishi ham mumkin, u holda
      // prompt uni tilga olmasligi kerak. Ikkisini alohida hisoblasak,
      // ular bir-biridan uzoqlashib "yo'q tool haqidagi ko'rsatma" paydo
      // bo'lardi.
      const toollar = toollarniTayyorla(
        toolKonteksti,
        sozlamalar.agent.toollar.yoqilgan,
        sozlama.serverManbasi,
        sozlama.dashboardManbasi,
        mcpBoshqaruvchi,
      )
      const serverlarBor = toollar.some((t) => t.name === 'serverList')
      const dashboardBor = toollar.some((t) => t.name === 'appPublish')
      // MCP tool'lari dinamik — nomlarini oldindan bilmaymiz, shuning uchun
      // prefiks bo'yicha tekshiramiz. Bittasi ham bo'lmasa prompt MCP'ni
      // tilga OLMAYDI.
      const mcpBor = toollar.some((t) => mcpTooliMi(t.name))

      const agent = new Agent({
        initialState: {
          systemPrompt: AGENT_SISTEM_PROMPT(
            sozlama.ishPapkasi,
            loyihaKonteksti ? kontekstniPromptga(loyihaKonteksti) : undefined,
            skilllar ?? undefined,
            xotira,
            serverlarBor,
            dashboardBor,
            mcpBor,
          ),
          model,
          tools: toollar,
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

      // Provider xatosi `prompt()` dan tashqariga chiqmaydi — u oxirgi
      // assistant xabarida yozilib qoladi (`oqimXatosi` izohiga q.).
      // Tekshirmasak bo'sh javob "muvaffaqiyat" bo'lib ketardi.
      const providerXatosi = oqimXatosi(agent.state.messages)
      if (providerXatosi) {
        qoy({ tur: 'xato', xabar: providerXatosi })
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
  serverManbasi?: ServerManbasi,
  dashboardManbasi?: DashboardManbasi,
  mcpBoshqaruvchi?: McpBoshqaruvchi,
): AgentTool<never>[] {
  // pi'ning tayyor tool'lari + o'zimizning qidiruv va server tool'lari.
  // Hammasi kontekstni oxirgi argument sifatida oladi, shuning uchun
  // quyidagi o'ram ularga bir xil qo'llanadi (`serverList` kontekstni
  // ishlatmaydi, lekin shaklga rioya qiladi).
  const barchasi = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool(),
    ...qidiruvToollariXom(),
    ...serverToollariXom(serverManbasi),
    ...dashboardToollariXom(dashboardManbasi),
  ]

  // Configda o'chirilgan tool UMUMAN E'LON QILINMAYDI — agent uning
  // borligini bilmaydi. Bu "chaqirsang rad etaman" dan yaxshiroq: model
  // mavjud bo'lmagan imkoniyatni qayta-qayta urinib vaqt sarflamaydi.
  const ruxsatEtilgan = new Set(yoqilgan)
  const asosiy = barchasi.filter((tool) => ruxsatEtilgan.has(tool.name))

  // MCP tool'lari YUQORIDAGI FILTRDAN O'TMAYDI — ular statik ro'yxatda yo'q
  // va nomlari sessiyada aniqlanadi (`mcp-toollari.ts` izohiga q.).
  // Nazorat o'rnatishda: server o'rnatilmagan bo'lsa boshqaruvchi umuman
  // yaratilmaydi va bu ro'yxat bo'sh bo'ladi.
  const hammasi = [...asosiy, ...mcpToollariXom(mcpBoshqaruvchi)]

  return hammasi.map((tool) => ({
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
