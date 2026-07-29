// `grep`, `find`, `ls` tool'lari — agentga fayl qidirish imkonini beradi.
//
// NEGA ALOHIDA TOOL, `bash` YETARLI EMASMI?
// Yetarli, lekin qimmat. `bash` orqali qidirish `buyruq-tahlil.ts` dan
// o'tadi va ko'p holatda ruxsat so'raydi — masalan naqshda `/` bo'lsa yoki
// buyruq oq ro'yxatda bo'lmasa. Fayl qidirish esa TABIATAN o'qish amali:
// u hech narsani o'zgartirmaydi. Har `grep` uchun foydalanuvchini uyg'otish
// — bu "ruxsat charchog'i", ya'ni foydalanuvchi o'ylamay "ha" bosishni
// o'rganib qoladi va ROSTDAN xavfli so'rovni ham o'tkazib yuboradi.
//
// Shuning uchun bu uch tool ruxsat so'ramaydi — LEKIN faqat ish papkasi
// ICHIDA. Tashqaridagi yo'l so'ralsa xato qaytadi (`ChegaraXatosi`), chunki
// bu tool'lar hech qachon tashqariga qaramaydi. Foydalanuvchi rostdan
// tashqarida qidirmoqchi bo'lsa `bash` bor — u yerda ruxsat mexanizmi
// to'liq ishlaydi.
//
// Xavfsizlik zanjiri:
//   grep/find/ls → chegaraniTekshir (matn yo'li + realpath)
//                → ichkarida?  → bajariladi
//                → tashqarida? → ChegaraXatosi (ruxsat SO'RALMAYDI)
//
// Natijada chiqadigan yo'llar HAR DOIM ish papkasiga nisbiy — absolut yo'l
// oshkor bo'lmaydi.

import { Type, type Static } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import {
  FIND_CHEGARASI,
  GREP_CHEGARASI,
  LS_CHEGARASI,
  QATOR_CHEGARASI,
  type GrepMosligi,
  type PapkaElementi,
  type QidiruvNatijasi,
} from './qidiruv-asos.ts'
import { findQidir, grepQidir, lsRoyxat } from './qidiruv-motor.ts'

// ---------------------------------------------------------------------------
// Tool shakli
// ---------------------------------------------------------------------------

/**
 * `pi-agent-core` ning `AgentHarnessTool` shakli.
 *
 * Paketdan tayyor tipni import qilish o'rniga shu yerda takrorlangan,
 * chunki `AgentHarnessTool` `dist/harness/types.ts` ichida va u paketning
 * ommaviy `exports` yuzasida yo'q. Shakl bir xil bo'lsa yetarli —
 * `agent.ts` dagi `toollarniTayyorla()` uni qanday chaqirishini bilamiz:
 * kontekst OXIRGI argument sifatida uzatiladi.
 */
export interface QidiruvTooli<TParams = unknown, TTafsilot = QidiruvTafsiloti | undefined> {
  name: string
  label: string
  description: string
  parameters: unknown
  execute(
    toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    kontekst: { env: { cwd: string } },
  ): Promise<AgentToolResult<TTafsilot>>
}

/** UI va loglar uchun tafsilot — qaysi backend ishladi, kesildimi */
export interface QidiruvTafsiloti {
  backend: 'rg' | 'node'
  /** Topilgan elementlar soni (kesilishdan keyin) */
  soni: number
  kesildi: boolean
}

/** Matnni tool natijasi shakliga o'raydi */
function natija(matn: string, tafsilot: QidiruvTafsiloti): AgentToolResult<QidiruvTafsiloti> {
  return { content: [{ type: 'text', text: matn }], details: tafsilot }
}

/**
 * Kesilganda qo'shiladigan ogohlantirish.
 *
 * Bu ATAYLAB ochiq yoziladi: agent natija to'liq deb o'ylab "faylda bu
 * yo'q" degan noto'g'ri xulosa chiqarmasin. Modelga nima qilish kerakligi
 * ham aytiladi (naqshni toraytir), aks holda u shunchaki qayta urinadi.
 */
function kesilganOgohi(korsatilgan: number, nima: string): string {
  return `\n\n[Natija ${korsatilgan} ta ${nima} bilan cheklandi — yana bor. Naqshni toraytiring yoki \`path\` bilan aniqroq papka bering.]`
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const grepSxemasi = Type.Object({
  pattern: Type.String({
    description:
      'Regular expression to search for. JavaScript regex syntax (lookahead/lookbehind supported).',
  }),
  path: Type.Optional(
    Type.String({
      description:
        'Directory or file to search in, relative to the working directory. Defaults to the working directory.',
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description:
        "Only search files whose name matches this glob, e.g. '*.ts' or 'src/**/*.tsx'.",
    }),
  ),
  caseInsensitive: Type.Optional(
    Type.Boolean({ description: 'Ignore case when matching. Default: false.' }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description:
        'Also search normally-skipped directories (.git, node_modules, dist, ...). Default: false.',
    }),
  ),
})

export type GrepToolKirishi = Static<typeof grepSxemasi>

/** Grep natijasini `fayl:qator:matn` qatorlariga aylantiradi */
export function grepNatijasiniMatnga(natija: QidiruvNatijasi<GrepMosligi>): string {
  if (natija.elementlar.length === 0) return 'Mos kelish topilmadi.'
  const qatorlar = natija.elementlar.map((m) => `${m.yol}:${m.qator}:${m.matn}`)
  let matn = qatorlar.join('\n')
  if (natija.kesildi) matn += kesilganOgohi(natija.elementlar.length, 'mos kelish')
  return matn
}

export function grepToolYarat(): QidiruvTooli<GrepToolKirishi> {
  return {
    name: 'grep',
    label: 'grep',
    description: [
      'Search file contents with a regular expression. Returns matching lines as `path:line:text`.',
      `Long lines are cut to ${QATOR_CHEGARASI} characters and results are capped at ${GREP_CHEGARASI} matches.`,
      'Only searches inside the working directory; paths outside it are rejected.',
      '.git, node_modules, dist and similar directories are skipped unless `all` is set.',
      'Prefer this over running grep/rg through bash — it is faster and needs no permission prompt.',
    ].join(' '),
    parameters: grepSxemasi,
    async execute(_id, params, signal, _onUpdate, kontekst) {
      const topilgan = await grepQidir({
        ishPapkasi: kontekst.env.cwd,
        pattern: params.pattern,
        path: params.path,
        glob: params.glob,
        caseInsensitive: params.caseInsensitive,
        barchasi: params.all,
        signal,
      })
      return natija(grepNatijasiniMatnga(topilgan), {
        backend: topilgan.backend,
        soni: topilgan.elementlar.length,
        kesildi: topilgan.kesildi,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

const findSxemasi = Type.Object({
  pattern: Type.String({
    description:
      "Glob pattern for file names, e.g. '*.ts', 'src/**/*.test.ts'. A pattern without '/' matches the file name at any depth.",
  }),
  path: Type.Optional(
    Type.String({
      description: 'Directory to search in, relative to the working directory.',
    }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description:
        'Also search normally-skipped directories (.git, node_modules, dist, ...). Default: false.',
    }),
  ),
})

export type FindToolKirishi = Static<typeof findSxemasi>

export function findNatijasiniMatnga(natija: QidiruvNatijasi<string>): string {
  if (natija.elementlar.length === 0) return 'Fayl topilmadi.'
  let matn = natija.elementlar.join('\n')
  if (natija.kesildi) matn += kesilganOgohi(natija.elementlar.length, 'fayl')
  return matn
}

export function findToolYarat(): QidiruvTooli<FindToolKirishi> {
  return {
    name: 'find',
    label: 'find',
    description: [
      'Find files by glob pattern. Returns paths relative to the working directory, one per line.',
      `Capped at ${FIND_CHEGARASI} files.`,
      'Only searches inside the working directory; paths outside it are rejected.',
      '.git, node_modules, dist and similar directories are skipped unless `all` is set.',
      'Prefer this over running find/fd through bash — it is faster and needs no permission prompt.',
    ].join(' '),
    parameters: findSxemasi,
    async execute(_id, params, signal, _onUpdate, kontekst) {
      const topilgan = await findQidir({
        ishPapkasi: kontekst.env.cwd,
        pattern: params.pattern,
        path: params.path,
        barchasi: params.all,
        signal,
      })
      return natija(findNatijasiniMatnga(topilgan), {
        backend: topilgan.backend,
        soni: topilgan.elementlar.length,
        kesildi: topilgan.kesildi,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

const lsSxemasi = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        'Directory to list, relative to the working directory. Defaults to the working directory.',
    }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description:
        'Also show normally-skipped directories (.git, node_modules, dist, ...). Default: false.',
    }),
  ),
})

export type LsToolKirishi = Static<typeof lsSxemasi>

/** Baytni o'qishga qulay ko'rinishga o'tkazadi */
export function olchamniMatnga(bayt: number): string {
  if (bayt < 1024) return `${bayt}B`
  if (bayt < 1024 * 1024) return `${(bayt / 1024).toFixed(1)}K`
  return `${(bayt / (1024 * 1024)).toFixed(1)}M`
}

export function lsNatijasiniMatnga(natija: QidiruvNatijasi<PapkaElementi>): string {
  if (natija.elementlar.length === 0) return "Papka bo'sh."
  const qatorlar = natija.elementlar.map((e) => {
    // Papka `/` bilan tugaydi, symlink `@` bilan — `ls -F` an'anasi.
    // Bu agent uchun turni bir qarashda ko'rsatadi, qo'shimcha ustunsiz.
    if (e.tur === 'papka') return `${e.nom}/`
    if (e.tur === 'symlink') return `${e.nom}@`
    return e.olcham === undefined ? e.nom : `${e.nom}  (${olchamniMatnga(e.olcham)})`
  })
  let matn = qatorlar.join('\n')
  if (natija.kesildi) matn += kesilganOgohi(natija.elementlar.length, 'element')
  return matn
}

export function lsToolYarat(): QidiruvTooli<LsToolKirishi> {
  return {
    name: 'ls',
    label: 'ls',
    description: [
      'List the contents of a directory. Directories end with `/`, symlinks with `@`, files show their size.',
      `Capped at ${LS_CHEGARASI} entries.`,
      'Only lists inside the working directory; paths outside it are rejected.',
      '.git, node_modules, dist and similar directories are hidden unless `all` is set.',
      'Prefer this over running ls through bash — it needs no permission prompt.',
    ].join(' '),
    parameters: lsSxemasi,
    async execute(_id, params, signal, _onUpdate, kontekst) {
      const topilgan = await lsRoyxat({
        ishPapkasi: kontekst.env.cwd,
        path: params.path,
        barchasi: params.all,
        signal,
      })
      return natija(lsNatijasiniMatnga(topilgan), {
        backend: topilgan.backend,
        soni: topilgan.elementlar.length,
        kesildi: topilgan.kesildi,
      })
    },
  }
}

/**
 * Uchala qidiruv tool'i — kontekst BIRIKTIRILMAGAN holda.
 *
 * Bu quyi darajali shakl: har tool `execute()` ni beshinchi argument
 * (kontekst) bilan chaqirishni kutadi, xuddi pi'ning o'z tool'lari kabi.
 * Agar `agent.ts` pi tool'lari bilan bitta o'ramdan o'tkazsa, shu ishlatiladi.
 */
export function qidiruvToollariXom(): QidiruvTooli<never>[] {
  return [grepToolYarat(), findToolYarat(), lsToolYarat()] as unknown as QidiruvTooli<never>[]
}

/**
 * Uchala qidiruv tool'i — kontekst BIRIKTIRILGAN holda.
 *
 * `agent.ts` dagi `toollarniTayyorla()` shuni chaqiradi va natijani
 * to'g'ridan-to'g'ri `Agent` ga beradi: kontekst allaqachon ichida, ya'ni
 * `execute()` pi'ning `AgentTool` shakliga (4 argument) mos keladi.
 *
 * Tool'lar `kontekst.env.cwd` dan ish papkasini oladi. `ChegaralanganMuhit`
 * ham shu maydonni beradi, shuning uchun tip ataylab tor emas — testda
 * oddiy `{ env: { cwd } }` bilan ham chaqirish mumkin.
 *
 * MUHIM: bu tool'lar `ChegaralanganMuhit` ning fayl amallarini ISHLATMAYDI —
 * ular papkani o'zi aylanadi (`rg` ham shunday qiladi). Chegara shu sababli
 * `qidiruv-asos.ts` dagi `chegaraniTekshir()` orqali mustaqil qo'llanadi va
 * mantiq `ChegaralanganMuhit.yolniTekshir` bilan bir xil: matn yo'li +
 * `realpath`. Muhitdan faqat `cwd` olinadi.
 */
export function qidiruvToollari(kontekst: { env: { cwd: string } }): AgentTool<never>[] {
  return qidiruvToollariXom().map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: never) =>
      tool.execute(toolCallId, params, signal, onUpdate, kontekst),
  })) as unknown as AgentTool<never>[]
}

/**
 * `AGENT_SISTEM_PROMPT` ga qo'shiladigan qism.
 *
 * Prompt matni tool'lar bilan BIR JOYDA turadi: tool xulqi o'zgarsa
 * (masalan `all` bayrog'i olib tashlansa) tavsif ham shu faylda yangilanadi.
 * Agar u `agent.ts` da qolsa, ikkisi asta-sekin bir-biridan uzoqlashardi —
 * model esa yo'q xususiyat haqida o'qib, uni chaqirishga urinardi.
 *
 * Ikki qismdan iborat: tool ro'yxati qatorlari va ulardan qanday
 * foydalanish qoidasi.
 */
export const QIDIRUV_PROMPT_QISMI = {
  /** Tool ro'yxatiga qo'shiladigan qatorlar */
  royxat: [
    '- grep: search inside files with a regex (`file:line:text`)',
    '- find: locate files by glob',
    '- ls: list a directory',
  ],
  /** Qanday ishlatish bo'yicha ko'rsatma */
  qoida: [
    'To find files use `grep`/`find`/`ls`, NOT `bash` — they are faster and ask',
    'for no permission. Reach for `bash` only when nothing else will do. Those',
    'three tools work only inside the working directory and by default skip',
    '`.git`, `node_modules`, `dist` and similar (pass `all: true` to include',
    'them).',
  ],
} as const
