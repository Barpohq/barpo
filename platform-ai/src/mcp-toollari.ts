// MCP tool'larini agentga e'lon qilish.
//
// `server-toollari.ts` / `dashboard-toollari.ts` bilan bir xil "manba
// inversiyasi" naqshi: boshqaruvchi berilmasa BO'SH ro'yxat qaytadi, ya'ni
// tool umuman e'lon qilinmaydi va prompt ham MCP haqida bir og'iz so'z
// aytmaydi. Agent MCP borligini BILMAYDI.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ ULARDAN TUB FARQI: TOOL'LAR DINAMIK.                                 │
// │                                                                      │
// │ `serverList` va `appPublish` — bitta statik tool, nomi oldindan       │
// │ ma'lum va `agent.toollar.yoqilgan` config ro'yxatida turadi.          │
// │                                                                      │
// │ MCP tool'lari esa sessiya boshlanguncha NOMA'LUM: qaysi serverlar     │
// │ o'rnatilgani bazadan, ular qanday tool berishi esa serverning o'zidan │
// │ (`tools/list`) aniqlanadi. Ya'ni ularni statik config ro'yxatiga      │
// │ yozib bo'lmaydi.                                                     │
// │                                                                      │
// │ YECHIM: config bayrog'i UMUMAN YO'Q. Nazorat o'rnatishda:             │
// │ server o'rnatilmagan bo'lsa `mcpManbasi` bo'sh ro'yxat qaytaradi →    │
// │ boshqaruvchi yaratilmaydi → bu funksiya `[]` qaytaradi. O'rnatishning │
// │ o'zi allaqachon ongli harakat, ustiga yana bayroq qo'yish             │
// │ foydalanuvchini "nega ishlamayapti" holatiga tushirardi.              │
// └──────────────────────────────────────────────────────────────────────┘

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { McpBoshqaruvchi } from './mcp-boshqaruvchi.ts'
import type { QidiruvTooli } from './qidiruv-toollari.ts'

/** UI va loglar uchun tafsilot */
export interface McpToolTafsiloti {
  serverNomi: string
  toolNomi: string
}

/** Agentga ko'rinadigan tool nomlari prefiksi */
export const MCP_TOOL_PREFIKSI = 'mcp__'

/**
 * Nomni tool identifikatorida ishlatish uchun tozalaydi.
 *
 * Model tool nomini AYNAN qaytarishi kerak, shuning uchun unda faqat
 * xavfsiz belgilar qolishi lozim. Registry nomlari reverse-DNS
 * (`io.github.owner/repo`) — ulardagi `.` va `/` ni `_` ga aylantiramiz.
 *
 * `skill-ombor.ts` dagi `xavfsizNom` bilan bir xil g'oya, lekin u
 * `platform-server` da va bu paket unga bog'liq emas.
 */
export function xavfsizToolNomi(x: string): string {
  return x.replace(/[^a-zA-Z0-9_-]/g, '_') || 'nomalum'
}

/**
 * Agentga ko'rinadigan to'liq tool nomi.
 *
 * KOLLIZIYA HAL QILISH: ikki xil MCP server bir xil tool nomini bersa
 * (masalan ikkalasida ham `search`), prefikssiz ular tenglashib qolardi va
 * model qaysi biri chaqirilganini bilmasdi. Server nomi prefiksga kirgani
 * uchun bunday bo'lishi mumkin emas.
 *
 * `__` ajratuvchi: MCP tool nomlari odatda `[a-zA-Z0-9_-]` bilan
 * cheklangan, ya'ni ikki pastki chiziq tabiiy ravishda kelib qolishi kam.
 * Bu Claude Code'dagi konvensiya bilan ham bir xil.
 */
export function mcpToolNomi(serverNomi: string, toolNomi: string): string {
  return `${MCP_TOOL_PREFIKSI}${xavfsizToolNomi(serverNomi)}__${toolNomi}`
}

/** Tool nomi MCP tooliga tegishlimi */
export function mcpTooliMi(nom: string): boolean {
  return nom.startsWith(MCP_TOOL_PREFIKSI)
}

/**
 * MCP tool'larini xom (kontekst biriktirilmagan) shaklda qaytaradi.
 *
 * Boshqaruvchi berilmasa yoki hech qanday tool topilmasa — bo'sh ro'yxat.
 *
 * `execute` KONTEKSTNI ISHLATMAYDI (`env.cwd` MCP uchun ma'nosiz), lekin
 * `QidiruvTooli` shakliga rioya qiladi: `agent.ts` hamma tool'ni bir xil
 * o'ramdan o'tkazadi (`serverList` ham aynan shunday qiladi).
 */
export function mcpToollariXom(boshqaruvchi?: McpBoshqaruvchi): QidiruvTooli<never>[] {
  if (!boshqaruvchi) return []

  const toollar = boshqaruvchi.royxat().map(({ serverId, serverNomi, tool }) => {
    const nom = mcpToolNomi(serverNomi, tool.name)
    return {
      name: nom,
      label: nom,
      // Server nomi tavsifga ham qo'shiladi: model prefiksni o'qimasdan
      // ham qaysi tizim bilan ishlayotganini bilsin.
      description: [`[MCP: ${serverNomi}]`, tool.description ?? `${tool.name} vositasi`].join(' '),
      // JSON Schema TO'G'RIDAN-TO'G'RI o'tadi. `QidiruvTooli.parameters`
      // tipi `unknown` — ATAYLAB, aynan shu holat uchun. Konvertatsiya
      // qilsak MCP serverning sxemasi buzilishi mumkin edi.
      parameters: tool.inputSchema,
      async execute(
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<McpToolTafsiloti>> {
        // Ruxsat TEKSHIRUVI SHU CHAQIRUV ICHIDA — `chaqir()` metodi
        // (`mcp-boshqaruvchi.ts`) `sora()` ni o'zi chaqiradi. Bu yerda
        // qo'shimcha tekshiruv YO'Q: bitta darvoza, ikki joyda emas.
        const natija = await boshqaruvchi.chaqir(serverId, tool.name, params, signal)
        return {
          content: natija.content.map((c) => ({
            type: 'text' as const,
            text: c.text ?? '',
          })),
          // Tool o'zi xato natija qaytargan bo'lsa agentga shunday
          // ko'rsatamiz — u boshqa yo'l izlashi mumkin.
          isError: natija.isError,
          details: { serverNomi, toolNomi: tool.name },
        }
      },
    }
  })

  return toollar as unknown as QidiruvTooli<never>[]
}

/**
 * MCP tool'lari — kontekst biriktirilgan shakl (testlar va to'g'ridan
 * ishlatish uchun; `agent.ts` xom shaklni o'zi o'raydi).
 */
export function mcpToollari(boshqaruvchi?: McpBoshqaruvchi): AgentTool<never>[] {
  return mcpToollariXom(boshqaruvchi).map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: never) =>
      tool.execute(toolCallId, params, signal, onUpdate, { env: { cwd: '' } }),
  })) as unknown as AgentTool<never>[]
}

/**
 * `AGENT_SISTEM_PROMPT` ga qo'shiladigan qism.
 *
 * FAQAT MCP TOOL'LARI MAVJUD BO'LGANDA qo'shiladi (`agent.ts` dagi `mcpBor`
 * bayrog'i). Aks holda model yo'q imkoniyat haqida o'ylab vaqt sarflardi —
 * `SERVER_PROMPT_QISMI` bilan bir xil qoida.
 */
export const MCP_PROMPT_QISMI = {
  royxat: [
    "- mcp__<server>__<tool>: tools from MCP servers connected to this platform",
  ],
  qoida: [
    'MCP TOOLS. The prefix in the name tells you which server a tool comes from',
    '(`mcp__github__create_issue` → the `github` server). Their descriptions come',
    'from the server itself — read them to decide when a tool applies.',
    '',
    'These tools act on EXTERNAL systems, not on the working directory: creating',
    'issues, sending messages, querying remote APIs. That means their effects are',
    'usually NOT reversible by editing a file. Use them when the task calls for',
    'that system, and prefer a read-only tool over a writing one when both would',
    'answer the question.',
    '',
    'Each call may ask the user for permission — that is normal, the same rule as',
    'for bash. If permission is denied you get an error: explain it and suggest',
    'another way.',
  ],
} as const
