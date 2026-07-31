// The WebSocket protocol — the single contract between the client and the
// server. Both directions are discriminated unions, split by the `type` field,
// so inside a switch TypeScript knows the remaining fields by itself.
//
// How to add a new event:
//   1) write the interface here (`type` — a unique string literal),
//   2) add it to the ClientEvent or ServerEvent union,
//   3) send it with hub.broadcast(...) on the server side,
//   4) add a new case to the switch on the UI side.
// Nothing else needs to change.

import type {
  AppManifest,
  AuditEntry,
  BuildStep,
  ClassifierVerdict,
  ModeState,
  PermissionAnswer,
  PermissionMode,
  PermissionRequest,
  ToolCard,
  ToolCall,
} from './types.ts'

export const PROTOCOL_VERSION = '0.1.0'

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/** The model selected for the chat — together with its provider */
export interface ModelChoice {
  provider: string
  model: string
}

/** The user sent a message to the chat */
export interface ChatSendEvent {
  type: 'chat.send'
  sessionId: string
  text: string
  /**
   * Only taken into account on the FIRST message of a session — that is when
   * the session's provider is locked. If a different provider is sent in a
   * later message the server rejects it (chat.error).
   */
  model?: ModelChoice
  /**
   * The IDs of the files attached to the message (returned by
   * `POST /api/chat/attachment`).
   *
   * IDS ONLY — not objects. The path, kind and mime are taken from the
   * database ON THE SERVER: if the client supplied `path` it could point
   * outside the work directory, and if it supplied `kind` it could trick the
   * vision guard.
   *
   * When there is an attachment, `text` may be empty — dropping in an image
   * and writing nothing is a natural thing for a user to do.
   */
  attachments?: string[]
}

/** A choice in the build flow (for example "domain" or "port preview") */
export interface ChatChoiceEvent {
  type: 'chat.choice'
  sessionId: string
  buildId: string
  optionIndex: number
}

/**
 * Subscribing to channels — only the needed events arrive.
 *
 * `sessionId` — WHICH chat session the client is watching. When given, only
 * that session's chat events go to this client (`chat.delta`, `chat.tool`,
 * `chat.permission` and so on). If two browser windows open two different
 * conversations, neither SEES the other's reply.
 *
 * When omitted the old behaviour is preserved: the client receives the events
 * of every session on the channel. This is deliberate for backwards
 * compatibility — old clients that send `sub` (and diagnostic tools not bound
 * to a session) keep working. A client that needs session isolation asks for
 * it EXPLICITLY.
 */
export interface SubEvent {
  type: 'sub'
  channels: string[]
  /**
   * The chat session being watched.
   *
   *   string    — that session's chat events are watched;
   *   null      — DELIBERATELY removing the filter (every session is visible again);
   *   field absent — the previous choice stays unchanged (the client may just
   *                 be adding a new channel).
   *
   * `null` and "field absent" are distinguished, because in JSON `undefined`
   * loses the field entirely — there is no other way to express the "clear it"
   * intent.
   */
  sessionId?: string | null
}

/**
 * The user answered a permission request.
 * `always` — permission is granted and the pattern is remembered for the session.
 */
export interface ChatPermissionReplyEvent {
  type: 'chat.permission.reply'
  sessionId: string
  requestId: string
  answer: PermissionAnswer
}

/**
 * The user changed the permission mode (or re-enabled auto).
 */
export interface ChatModeSetEvent {
  type: 'chat.mode.set'
  sessionId: string
  mode: PermissionMode
}

export type ClientEvent =
  | ChatSendEvent
  | ChatChoiceEvent
  | ChatPermissionReplyEvent
  | ChatModeSetEvent
  | SubEvent

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

/** Sent first when the connection opens */
export interface HelloEvent {
  type: 'hello'
  version: string
}

/** The next chunk of the streaming reply */
export interface ChatDeltaEvent {
  type: 'chat.delta'
  sessionId: string
  messageId: string
  delta: string
}

/** A tool card inside the reply (the old demo flow) */
export interface ChatToolCardEvent {
  type: 'chat.toolcard'
  sessionId: string
  messageId: string
  toolCard: ToolCard
}

/**
 * The status of an agent tool call changed.
 * It arrives several times for one `id`: running → done/error.
 * The UI updates the existing card by `id`.
 */
export interface ChatToolEvent {
  type: 'chat.tool'
  sessionId: string
  messageId: string
  tool: ToolCall
}

/**
 * The agent attempted a dangerous action — permission is being asked of the
 * user. The answer comes back as `chat.permission.reply`. If no answer
 * arrives, the server denies it itself after 5 minutes.
 */
export interface ChatPermissionEvent {
  type: 'chat.permission'
  sessionId: string
  messageId: string
  request: PermissionRequest
}

/**
 * The classifier produced a verdict for an action (auto mode).
 * It shows up in the UI as a small label under the tool card.
 */
export interface ChatClassifierEvent {
  type: 'chat.classifier'
  sessionId: string
  messageId: string
  verdict: ClassifierVerdict
}

/**
 * The permission mode changed — either the user switched it themselves or it
 * was turned off by the auto fallback (a broken classifier / the block limit).
 */
export interface ChatModeEvent {
  type: 'chat.mode'
  sessionId: string
  state: ModeState
}

/**
 * The overall status of the agent stream in a session — for the "background
 * agents" view.
 *
 * `chat.delta`/`chat.done` are about the reply TEXT, this one is about the
 * STREAM: whether the session is running right now, waiting for permission or
 * finished. The sidebar badges and the "Agents" page rely on this event.
 *
 * IMPORTANT: this event is DELIBERATELY NOT FILTERED by session
 * (`eventSession()` returns `null` for it). The reason: even when a client is
 * watching a single session, it needs to see the status of the OTHER sessions
 * — otherwise "an agent is running in the second conversation" would not show
 * up in the sidebar. This is not a data leak: the event carries only the
 * session id and the status, no reply text, no tool result and no permission
 * detail.
 */
export interface ChatStatusEvent {
  type: 'chat.status'
  sessionId: string
  status: StreamStatus
}

/** The status of a session's stream */
export type StreamStatus = 'running' | 'awaiting-permission' | 'done' | 'error'

/** The reply is finished */
export interface ChatDoneEvent {
  type: 'chat.done'
  sessionId: string
  messageId: string
  /** Tokens spent and the cost — when available */
  usage?: {
    input: number
    output: number
    cost: number
  }
}

/**
 * The reply stream was cut short by an error. It arrives instead of
 * `chat.done` — the two never arrive together, so the UI must also end the
 * "waiting for a reply" state on this event.
 */
export interface ChatErrorEvent {
  type: 'chat.error'
  sessionId: string
  messageId: string
  error: string
}

/** The next step of the build */
export interface BuildStepEvent {
  type: 'build.step'
  buildId: string
  appId: string
  step: BuildStep
}

/** The build paused and is asking the user to choose */
export interface BuildChoiceEvent {
  type: 'build.choice'
  buildId: string
  question: string
  options: { label: string }[]
}

/** The build finished successfully */
export interface BuildDoneEvent {
  type: 'build.done'
  buildId: string
  appId: string
}

/** The build finished with an error */
export interface BuildFailedEvent {
  type: 'build.failed'
  buildId: string
  error: string
}

/** A new app was installed — the UI adds it to the sidebar */
export interface AppInstalledEvent {
  type: 'app.installed'
  manifest: AppManifest
}

/** An existing app's manifest was updated */
export interface AppUpdatedEvent {
  type: 'app.updated'
  manifest: AppManifest
}

/**
 * An app was deleted — the UI drops it from the sidebar.
 *
 * The ID ALONE is sent, not the manifest: by the time this event goes out the
 * folder is gone, so there is no manifest left to describe. The sidebar only
 * needs to know which entry to remove.
 */
export interface AppRemovedEvent {
  type: 'app.removed'
  id: string
}

/** A new entry landed in the audit log */
export interface AuditEntryEvent {
  type: 'audit.entry'
  entry: AuditEntry
}

/** One line of terminal (tmux session) output */
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
  | ChatClassifierEvent
  | ChatModeEvent
  | ChatStatusEvent
  | ChatDoneEvent
  | ChatErrorEvent
  | BuildStepEvent
  | BuildChoiceEvent
  | BuildDoneEvent
  | BuildFailedEvent
  | AppInstalledEvent
  | AppUpdatedEvent
  | AppRemovedEvent
  | AuditEntryEvent
  | TerminalLineEvent

export type ProtocolEvent = ClientEvent | ServerEvent

// ---------------------------------------------------------------------------
// Channels — the standard names used in the `sub` event.
// A client that has not subscribed only receives the "for everyone" events.
// ---------------------------------------------------------------------------

export const CHANNELS = {
  chat: 'chat',
  build: 'build',
  apps: 'apps',
  audit: 'audit',
  terminal: 'terminal',
} as const

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS]

/** Which event type belongs to which channel — the hub filters by this table */
export function eventChannel(event: ServerEvent): Channel | null {
  switch (event.type) {
    case 'chat.delta':
    case 'chat.toolcard':
    case 'chat.tool':
    case 'chat.permission':
    case 'chat.classifier':
    case 'chat.mode':
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
    case 'app.removed':
      return CHANNELS.apps
    case 'audit.entry':
      return CHANNELS.audit
    case 'terminal.line':
      return CHANNELS.terminal
    case 'hello':
      return null // hello is always sent, regardless of the channel
  }
}

/**
 * Which chat session an event belongs to — `null` when it is not tied to a
 * session.
 *
 * The hub applies a second filter based on this function: a session-bound
 * event is only sent to the client watching that session (or to one that did
 * not name a session at all).
 *
 * IMPORTANT: when a new session-bound event is added, it must be added HERE as
 * well. Otherwise it is broadcast to every client and data leaks between
 * sessions. The `switch` deliberately enumerates every case — when a new event
 * type is added, TypeScript reminds us through the `ServerEvent` union.
 */
export function eventSession(event: ServerEvent): string | null {
  switch (event.type) {
    case 'chat.delta':
    case 'chat.toolcard':
    case 'chat.tool':
    case 'chat.permission':
    case 'chat.classifier':
    case 'chat.mode':
    case 'chat.done':
    case 'chat.error':
      return event.sessionId

    // `chat.status` DOES carry a `sessionId`, but it is DELIBERATELY not
    // filtered. This is the single conscious exception to the rule: the
    // sidebar has to show the status of every session, which means a client
    // with one conversation open must still receive the "running / awaiting
    // permission" markers of the others. The event carries no content (no
    // text, no tool result, no permission detail) — only an id and a status.
    case 'chat.status':
      return null

    default:
      // build.*, app.*, audit.*, terminal.*, hello — not tied to a session
      return null
  }
}

/** Does the incoming JSON really look like a ClientEvent — a lightweight check */
export function isClientEvent(value: unknown): value is ClientEvent {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { type?: unknown }).type
  return (
    kind === 'chat.send' ||
    kind === 'chat.choice' ||
    kind === 'chat.permission.reply' ||
    kind === 'chat.mode.set' ||
    kind === 'sub'
  )
}
