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

import type { AppManifest, AuditEntry, BuildStep, ToolCard } from './types.ts'

export const PROTOCOL_VERSION = '0.1.0'

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/** Foydalanuvchi chatga xabar yubordi */
export interface ChatSendEvent {
  type: 'chat.send'
  sessionId: string
  text: string
}

/** Qurilish oqimidagi tanlov (masalan "domen" yoki "port preview") */
export interface ChatChoiceEvent {
  type: 'chat.choice'
  sessionId: string
  buildId: string
  optionIndex: number
}

/** Kanallarga obuna bo'lish — faqat kerakli eventlar keladi */
export interface SubEvent {
  type: 'sub'
  channels: string[]
}

export type ClientEvent = ChatSendEvent | ChatChoiceEvent | SubEvent

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

/** Javob ichidagi tool kartasi */
export interface ChatToolCardEvent {
  type: 'chat.toolcard'
  sessionId: string
  messageId: string
  toolCard: ToolCard
}

/** Javob tugadi */
export interface ChatDoneEvent {
  type: 'chat.done'
  sessionId: string
  messageId: string
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
  | ChatDoneEvent
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
    case 'chat.done':
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

/** Kelgan JSON haqiqatan ClientEvent'ga o'xshaydimi — yengil tekshiruv */
export function clientEventMi(qiymat: unknown): qiymat is ClientEvent {
  if (typeof qiymat !== 'object' || qiymat === null) return false
  const tur = (qiymat as { type?: unknown }).type
  return tur === 'chat.send' || tur === 'chat.choice' || tur === 'sub'
}
