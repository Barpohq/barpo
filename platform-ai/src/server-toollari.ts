// `serverList` tool'i — agentga platformaga ulangan serverlarni ko'rsatadi.
//
// NEGA KERAK. Agent `bash` orqali `ssh <nom> ...` bajara oladi (boshqariladigan
// ssh config tufayli parolsiz ishlaydi — `platform-server/src/ssh.ts` ga q.),
// LEKIN qaysi nomlar mavjudligini bilmaydi. Foydalanuvchi "web serverdagi
// joyni tekshir" desa, agent nom taxmin qilishga majbur bo'lardi. Bu tool
// o'sha bo'shliqni yopadi: nomlar ro'yxati → keyin `bash` bilan ish.
//
// QAMROV — FAQAT O'QISH. Tool serverga ULANMAYDI, birorta SSH chaqiruvi
// qilmaydi va jonli holatni bilmaydi. U bazadagi ulanish yozuvlarini
// qaytaradi, xolos. Serverda amal bajarish `bash` orqali boradi, ya'ni
// `buyruq-tahlil.ts` va ruxsat mexanizmi to'liq ishlaydi — bu tool ularni
// chetlab o'tadigan yon eshik OCHMAYDI.
//
// NEGA RUXSAT SO'RAMAYDI. Qidiruv tool'lari bilan bir xil mantiq
// (`qidiruv-toollari.ts` boshidagi izoh): bu tabiatan o'qish amali, hech
// narsani o'zgartirmaydi va foydalanuvchining O'ZI platformaga qo'shgan
// serverlar ro'yxatini qaytaradi. Har ro'yxat uchun ruxsat so'rash "ruxsat
// charchog'i" ga olib kelardi.
//
// MAXFIYLIK. Chiqishda host/port/user bor — bular ulanish uchun zarur va
// foydalanuvchi ularni UI'da baribir ko'radi. PAROL yo'q, chunki u umuman
// saqlanmaydi (`ssh.ts`). SSH kaliti ham chiqmaydi.
//
// QATLAM CHEGARASI. Serverlar SQLite'da, ya'ni `platform-server` da.
// `@platforma/ai` esa serverga BOG'LIQ EMAS (bog'liqlik faqat teskari
// yo'nalishda) — shuning uchun ro'yxat bu yerga INVERSIYA orqali keladi:
// chaqiruvchi `ServerManbasi` funksiyasini beradi. Shu sabab bu fayl
// bazani ham, `repo.ts` ni ham bilmaydi.

import { Type, type Static } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { QidiruvTooli } from './qidiruv-toollari.ts'

/**
 * Tool ko'radigan server yozuvi.
 *
 * `@platforma/shared` dagi `Server` tipining KERAKLI qismi. Ataylab tor:
 * bu yerda faqat agentga ko'rsatiladigan maydonlar turadi, shuning uchun
 * `Server` ga kelajakda maxfiyroq maydon qo'shilsa (masalan token), u bu
 * tool chiqishiga O'Z-O'ZIDAN tushib qolmaydi.
 */
export interface ServerYozuvi {
  /** SSH alias — `ssh <name>` shu nom bilan ishlaydi */
  name: string
  host: string
  port: number
  username: string
}

/**
 * Serverlar ro'yxatini beradigan manba (chaqiruvchi tomondan beriladi).
 *
 * HAR CHAQIRUVDA yangi o'qiladi, keshlanmaydi: foydalanuvchi suhbat
 * davomida server qo'shishi yoki o'chirishi mumkin va agent eskirgan
 * ro'yxatga qarab yo'q serverga ulanishga urinmasin.
 */
export type ServerManbasi = () => ServerYozuvi[] | Promise<ServerYozuvi[]>

/** UI va loglar uchun tafsilot */
export interface ServerTafsiloti {
  soni: number
}

const serverListSxemasi = Type.Object({})

export type ServerListKirishi = Static<typeof serverListSxemasi>

/**
 * Ro'yxatni jadval ko'rinishidagi matnga aylantiradi.
 *
 * Ustunlar tekislanadi — model uchun shart emas, lekin bu matn tool
 * kartasi bo'lib UI'da FOYDALANUVCHIGA ham ko'rinadi.
 *
 * Standart port (22) ataylab ko'rsatiladi: agent `ssh -p` kerakmi-yo'qmi
 * deb taxmin qilmasin.
 */
export function serverlarniMatnga(serverlar: ServerYozuvi[]): string {
  if (serverlar.length === 0) {
    return [
      "Platformaga hali server ulanmagan.",
      "Foydalanuvchi ularni platformaning 'Serverlar' sahifasidan qo'shadi.",
    ].join(' ')
  }

  const sarlavha = ['NOM', 'HOST', 'PORT', 'USER']
  const qatorlar = serverlar.map((s) => [s.name, s.host, String(s.port), s.username])
  const kengliklar = sarlavha.map((_, i) =>
    Math.max(sarlavha[i]!.length, ...qatorlar.map((q) => q[i]!.length)),
  )

  const tekisla = (q: string[]) =>
    q.map((k, i) => (i === q.length - 1 ? k : k.padEnd(kengliklar[i]!))).join('  ').trimEnd()

  return [
    tekisla(sarlavha),
    ...qatorlar.map(tekisla),
    '',
    "Serverda buyruq bajarish uchun `bash` bilan `ssh <NOM> '<buyruq>'` ishlat —",
    'parolsiz ulanish allaqachon sozlangan.',
  ].join('\n')
}

/**
 * `serverList` tool'ini yaratadi.
 *
 * Kontekst (`env.cwd`) BU TOOLGA KERAK EMAS — serverlar ish papkasiga
 * bog'liq emas. Lekin `QidiruvTooli` shakli saqlanadi, chunki
 * `toollarniTayyorla()` hamma tool'ni bir xil o'ramdan o'tkazadi va
 * kontekstni oxirgi argument sifatida uzatadi.
 */
export function serverListToolYarat(
  manba: ServerManbasi,
): QidiruvTooli<ServerListKirishi, ServerTafsiloti> {
  return {
    name: 'serverList',
    label: 'serverList',
    description: [
      'List the servers connected to this platform.',
      'Returns each server as name, host, port and username — no live status, no metrics.',
      'The name is an SSH alias: passwordless `ssh <name>` already works from bash,',
      'so use this tool first when the user refers to a server by name or asks what servers exist.',
      'Read-only and needs no permission prompt; running anything on a server still goes through bash.',
    ].join(' '),
    parameters: serverListSxemasi,
    async execute(): Promise<AgentToolResult<ServerTafsiloti>> {
      const serverlar = await manba()
      return {
        content: [{ type: 'text', text: serverlarniMatnga(serverlar) }],
        details: { soni: serverlar.length },
      }
    },
  }
}

/**
 * Server tool'lari — kontekst biriktirilmagan xom shakl.
 *
 * Manba berilmagan bo'lsa BO'SH ro'yxat qaytadi: tool umuman e'lon
 * qilinmaydi, ya'ni agent uning borligini bilmaydi. Bu "bor, lekin har doim
 * bo'sh" dan yaxshiroq — model yo'q imkoniyatni qayta-qayta urinmaydi.
 * (`toollarniTayyorla()` dagi o'chirilgan tool mantig'i bilan bir xil.)
 */
export function serverToollariXom(manba?: ServerManbasi): QidiruvTooli<never>[] {
  if (!manba) return []
  return [serverListToolYarat(manba)] as unknown as QidiruvTooli<never>[]
}

/**
 * Server tool'lari — kontekst biriktirilgan shakl (testlar va to'g'ridan
 * ishlatish uchun; `agent.ts` xom shaklni o'zi o'raydi).
 */
export function serverToollari(manba?: ServerManbasi): AgentTool<never>[] {
  return serverToollariXom(manba).map((tool) => ({
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
 * `QIDIRUV_PROMPT_QISMI` bilan bir xil sabab: tool xulqi va uni tavsiflovchi
 * matn BIR FAYLDA tursin, aks holda ikkisi asta-sekin bir-biridan uzoqlashadi.
 *
 * Prompt SHARTLI qo'shiladi (`agent.ts`): manba yo'q bo'lsa tool ham yo'q,
 * u holda uning haqida yozish modelni chalg'itardi.
 */
export const SERVER_PROMPT_QISMI = {
  /** Tool ro'yxatiga qo'shiladigan qator */
  royxat: ["- serverList: platformaga ulangan serverlar ro'yxati (nom, host, port, user)"],
  /** Qanday ishlatish bo'yicha ko'rsatma */
  qoida: [
    "Foydalanuvchi serverni nom bilan tilga olsa yoki qanday serverlar borligini",
    "so'rasa, avval `serverList` ni chaqir — nomlarni taxmin QILMA.",
    "Serverda buyruq bajarish uchun `bash` bilan `ssh <nom> '<buyruq>'` ishlat;",
    "parolsiz ulanish sozlangan. Masofadagi buyruqlar uchun ham odatdagi",
    "ruxsat qoidalari amal qiladi.",
  ],
} as const
