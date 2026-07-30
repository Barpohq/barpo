// WebSocket protokoli — client va server o'rtasidagi yagona shartnoma.
// Ikkala yo'nalish ham discriminated union: `type` maydoni bo'yicha ajratiladi,
// shuning uchun switch ichida TypeScript qolgan maydonlarni o'zi biladi.
//
// Yangi event qo'shish tartibi:
//   1) shu yerda interfeys yozing (`type` — noyob satr literal),
//   2) uni ClientEvent yoki ServerEvent union'iga qo'shing,
//   3) server tomonda hub.broadcast(...) bilan yuboring,
//   4) UI tomonda switch'ga yangi case qo'shing.
// Boshqa joyni o'zgartirish shart emas.

import type {
  AppManifest,
  AuditEntry,
  BuildStep,
  KlassifikatorQarori,
  RejimHolati,
  RuxsatJavobi,
  RuxsatRejimi,
  RuxsatSorovi,
  ToolCard,
  ToolChaqiruv,
} from './types.ts'

export const PROTOCOL_VERSION = '0.1.0'

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/** Chat uchun tanlangan model — provider bilan birga */
export interface ModelTanlovi {
  provider: string
  model: string
}

/** Foydalanuvchi chatga xabar yubordi */
export interface ChatSendEvent {
  type: 'chat.send'
  sessionId: string
  text: string
  /**
   * Faqat sessiyaning BIRINCHI xabarida hisobga olinadi — shunda sessiya
   * provideri qulflanadi. Keyingi xabarlarda boshqa provider yuborilsa
   * server rad etadi (chat.error).
   */
  model?: ModelTanlovi
  /**
   * Xabarga biriktirilgan fayllarning ID'lari (`POST /api/chat/biriktirma`
   * qaytargan).
   *
   * FAQAT ID — obyekt emas. Yo'l, tur va mime SERVERDA bazadan olinadi:
   * mijoz `yol` bergan bo'lsa u ish papkasidan tashqariga ko'rsata olardi,
   * `tur` bergan bo'lsa vision qorovulini aldab o'tardi.
   *
   * Biriktirma bo'lsa `text` bo'sh bo'lishi mumkin — foydalanuvchi rasm
   * tashlab hech narsa yozmasligi tabiiy holat.
   */
  biriktirmalar?: string[]
}

/** Qurilish oqimidagi tanlov (masalan "domen" yoki "port preview") */
export interface ChatChoiceEvent {
  type: 'chat.choice'
  sessionId: string
  buildId: string
  optionIndex: number
}

/**
 * Kanallarga obuna bo'lish — faqat kerakli eventlar keladi.
 *
 * `sessionId` — mijoz QAYSI chat sessiyasini kuzatayotgani. Berilsa, shu
 * mijozga faqat o'sha sessiyaning chat eventlari boradi (`chat.delta`,
 * `chat.tool`, `chat.permission` va h.k.). Ikki brauzer oynasi ikki xil
 * suhbatni ochsa, biri ikkinchisining javobini KO'RMAYDI.
 *
 * Berilmasa eski xulq saqlanadi: mijoz kanaldagi hamma sessiyaning
 * eventlarini oladi. Orqaga moslik uchun ataylab shunday — `sub` yuboradigan
 * eski mijozlar (va sessiyaga bog'lanmagan diagnostika vositalari) ishlashda
 * davom etadi. Sessiyali izolyatsiya kerak bo'lsa mijoz uni ANIQ so'raydi.
 */
export interface SubEvent {
  type: 'sub'
  channels: string[]
  /**
   * Kuzatilayotgan chat sessiyasi.
   *
   *   string    — shu sessiyaning chat eventlari kuzatiladi;
   *   null      — filtrni ATAYLAB olib tashlash (yana hamma sessiya ko'rinadi);
   *   maydon yo'q — oldingi tanlov o'zgarishsiz qoladi (mijoz faqat yangi
   *                 kanal qo'shayotgan bo'lishi mumkin).
   *
   * `null` va "maydon yo'q" farqlanadi, chunki JSON'da `undefined` maydonni
   * butunlay yo'qotadi — "tozala" niyatini bildirishning boshqa yo'li yo'q.
   */
  sessionId?: string | null
}

/**
 * Foydalanuvchi ruxsat so'roviga javob berdi.
 * `hardoim` — ruxsat beriladi va naqsh sessiya davomida eslab qolinadi.
 */
export interface ChatPermissionReplyEvent {
  type: 'chat.permission.reply'
  sessionId: string
  sorovId: string
  javob: RuxsatJavobi
}

/**
 * Foydalanuvchi ruxsat rejimini o'zgartirdi (yoki auto ni qayta yoqdi).
 */
export interface ChatRejimSetEvent {
  type: 'chat.rejim.set'
  sessionId: string
  rejim: RuxsatRejimi
}

export type ClientEvent =
  | ChatSendEvent
  | ChatChoiceEvent
  | ChatPermissionReplyEvent
  | ChatRejimSetEvent
  | SubEvent

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

/** Ulanish ochilganda birinchi bo'lib yuboriladi */
export interface HelloEvent {
  type: 'hello'
  version: string
}

/** Streaming javobning navbatdagi bo'lagi */
export interface ChatDeltaEvent {
  type: 'chat.delta'
  sessionId: string
  messageId: string
  delta: string
}

/** Javob ichidagi tool kartasi (eski demo oqimi) */
export interface ChatToolCardEvent {
  type: 'chat.toolcard'
  sessionId: string
  messageId: string
  toolCard: ToolCard
}

/**
 * Agent tool chaqiruvining holati o'zgardi.
 * Bitta `id` uchun bir necha marta keladi: ishlamoqda → tugadi/xato.
 * UI `id` bo'yicha mavjud kartani yangilaydi.
 */
export interface ChatToolEvent {
  type: 'chat.tool'
  sessionId: string
  messageId: string
  tool: ToolChaqiruv
}

/**
 * Agent xavfli amalga urindi — foydalanuvchidan ruxsat so'ralmoqda.
 * Javob `chat.permission.reply` bilan qaytariladi. Javob kelmasa
 * server 5 daqiqadan keyin o'zi rad etadi.
 */
export interface ChatPermissionEvent {
  type: 'chat.permission'
  sessionId: string
  messageId: string
  sorov: RuxsatSorovi
}

/**
 * Klassifikator amal bo'yicha qaror chiqardi (auto rejim).
 * UI'da tool kartasi ostida kichik yorliq bo'lib ko'rinadi.
 */
export interface ChatKlassifikatorEvent {
  type: 'chat.klassifikator'
  sessionId: string
  messageId: string
  qaror: KlassifikatorQarori
}

/**
 * Ruxsat rejimi o'zgardi — foydalanuvchi o'zi almashtirdi yoki auto
 * fallback tufayli o'chdi (klassifikator nosoz / blok chegarasi).
 */
export interface ChatRejimEvent {
  type: 'chat.rejim'
  sessionId: string
  holat: RejimHolati
}

/**
 * Sessiyadagi agent oqimining umumiy holati — "fon agentlari" ko'rinishi uchun.
 *
 * `chat.delta`/`chat.done` javob MATNI haqida, bu esa OQIM haqida: sessiya
 * hozir ishlayaptimi, ruxsat kutyaptimi, tugadimi. Sidebar badge'lari va
 * "Agentlar" sahifasi shu eventga tayanadi.
 *
 * MUHIM: bu event ATAYLAB sessiya bo'yicha FILTRLANMAYDI (`eventSessiyasi()`
 * uning uchun `null` qaytaradi). Sabab: mijoz bitta sessiyani kuzatayotgan
 * bo'lsa ham, BOSHQA sessiyalarning holatini ko'rishi kerak — aks holda
 * sidebar'da "ikkinchi suhbatda agent ishlayapti" ko'rinmaydi. Bu ma'lumot
 * sizishi emas: eventda faqat sessiya id'si va holat bor, javob matni,
 * tool natijasi yoki ruxsat tafsiloti yo'q.
 */
export interface ChatStatusEvent {
  type: 'chat.status'
  sessionId: string
  holat: OqimHolati
}

/** Sessiya oqimining holati */
export type OqimHolati = 'ishlayapti' | 'ruxsat-kutmoqda' | 'tugadi' | 'xato'

/** Javob tugadi */
export interface ChatDoneEvent {
  type: 'chat.done'
  sessionId: string
  messageId: string
  /** Sarflangan tokenlar va narx — mavjud bo'lsa */
  usage?: {
    input: number
    output: number
    cost: number
  }
}

/**
 * Javob oqimi xato bilan uzildi. `chat.done` o'rniga keladi — ikkalasi
 * bir vaqtda kelmaydi, shuning uchun UI "javob kutmoqda" holatini shu
 * eventda ham tugatishi kerak.
 */
export interface ChatErrorEvent {
  type: 'chat.error'
  sessionId: string
  messageId: string
  error: string
}

/** Qurilishning navbatdagi qadami */
export interface BuildStepEvent {
  type: 'build.step'
  buildId: string
  appId: string
  step: BuildStep
}

/** Qurilish to'xtab, foydalanuvchidan tanlov so'ralmoqda */
export interface BuildChoiceEvent {
  type: 'build.choice'
  buildId: string
  question: string
  options: { label: string }[]
}

/** Qurilish muvaffaqiyatli tugadi */
export interface BuildDoneEvent {
  type: 'build.done'
  buildId: string
  appId: string
}

/** Qurilish xato bilan tugadi */
export interface BuildFailedEvent {
  type: 'build.failed'
  buildId: string
  error: string
}

/** Yangi ilova o'rnatildi — UI sidebar'ga qo'shadi */
export interface AppInstalledEvent {
  type: 'app.installed'
  manifest: AppManifest
}

/** Mavjud ilova manifesti yangilandi */
export interface AppUpdatedEvent {
  type: 'app.updated'
  manifest: AppManifest
}

/** Audit log'ga yangi yozuv tushdi */
export interface AuditEntryEvent {
  type: 'audit.entry'
  entry: AuditEntry
}

/** Terminal (tmux sessiya) chiqishining bir qatori */
export interface TerminalLineEvent {
  type: 'terminal.line'
  buildId: string
  line: string
}

export type ServerEvent =
  | HelloEvent
  | ChatDeltaEvent
  | ChatToolCardEvent
  | ChatToolEvent
  | ChatPermissionEvent
  | ChatKlassifikatorEvent
  | ChatRejimEvent
  | ChatStatusEvent
  | ChatDoneEvent
  | ChatErrorEvent
  | BuildStepEvent
  | BuildChoiceEvent
  | BuildDoneEvent
  | BuildFailedEvent
  | AppInstalledEvent
  | AppUpdatedEvent
  | AuditEntryEvent
  | TerminalLineEvent

export type ProtocolEvent = ClientEvent | ServerEvent

// ---------------------------------------------------------------------------
// Kanallar — `sub` eventida ishlatiladigan standart nomlar.
// Obuna bo'lmagan mijoz faqat "hamma uchun" eventlarni oladi (CHANNELS.hammasi).
// ---------------------------------------------------------------------------

export const CHANNELS = {
  chat: 'chat',
  build: 'build',
  apps: 'apps',
  audit: 'audit',
  terminal: 'terminal',
} as const

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS]

/** Qaysi event turi qaysi kanalga tegishli — hub shu jadval bo'yicha filtrlaydi */
export function eventKanali(event: ServerEvent): Channel | null {
  switch (event.type) {
    case 'chat.delta':
    case 'chat.toolcard':
    case 'chat.tool':
    case 'chat.permission':
    case 'chat.klassifikator':
    case 'chat.rejim':
    case 'chat.status':
    case 'chat.done':
    case 'chat.error':
      return CHANNELS.chat
    case 'build.step':
    case 'build.choice':
    case 'build.done':
    case 'build.failed':
      return CHANNELS.build
    case 'app.installed':
    case 'app.updated':
      return CHANNELS.apps
    case 'audit.entry':
      return CHANNELS.audit
    case 'terminal.line':
      return CHANNELS.terminal
    case 'hello':
      return null // hello har doim yuboriladi, kanaldan qat'i nazar
  }
}

/**
 * Event qaysi chat sessiyasiga tegishli — sessiyaga bog'liq bo'lmasa `null`.
 *
 * Hub shu funksiya bo'yicha ikkinchi filtrni qo'llaydi: sessiyali eventni
 * faqat o'sha sessiyani kuzatayotgan (yoki umuman sessiya ko'rsatmagan)
 * mijozga yuboradi.
 *
 * MUHIM: yangi sessiyali event qo'shilsa, uni SHU YERGA ham qo'shish kerak.
 * Aks holda u hamma mijozga tarqalib, sessiyalar orasida ma'lumot sizadi.
 * `switch` ataylab to'liq sanab o'tadi — yangi event turi qo'shilganda
 * TypeScript `ServerEvent` union'i bo'yicha eslatib turadi.
 */
export function eventSessiyasi(event: ServerEvent): string | null {
  switch (event.type) {
    case 'chat.delta':
    case 'chat.toolcard':
    case 'chat.tool':
    case 'chat.permission':
    case 'chat.klassifikator':
    case 'chat.rejim':
    case 'chat.done':
    case 'chat.error':
      return event.sessionId

    // `chat.status` da `sessionId` BOR, lekin u ATAYLAB filtrlanmaydi.
    // Bu qoidadan yagona ongli istisno: sidebar hamma sessiyaning holatini
    // ko'rsatishi kerak, ya'ni bitta suhbatni ochgan mijoz ham qolganlarining
    // "ishlayapti / ruxsat kutmoqda" belgisini olishi shart. Eventda mazmun
    // (matn, tool natijasi, ruxsat tafsiloti) yo'q — faqat id va holat.
    case 'chat.status':
      return null

    default:
      // build.*, app.*, audit.*, terminal.*, hello — sessiyaga bog'liq emas
      return null
  }
}

/** Kelgan JSON haqiqatan ClientEvent'ga o'xshaydimi — yengil tekshiruv */
export function clientEventMi(qiymat: unknown): qiymat is ClientEvent {
  if (typeof qiymat !== 'object' || qiymat === null) return false
  const tur = (qiymat as { type?: unknown }).type
  return (
    tur === 'chat.send' ||
    tur === 'chat.choice' ||
    tur === 'chat.permission.reply' ||
    tur === 'chat.rejim.set' ||
    tur === 'sub'
  )
}
