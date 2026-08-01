// URL hash ↔ app state.
//
// Hash formats:
//   (empty)               — plain mode, new conversation
//   #chat/<uuid>          — plain mode, open conversation
//   #pro/chat             — pro mode, chat page
//   #pro/chat/<uuid>      — pro mode, open conversation
//   #pro/servers          — pro mode, another page
//   #pro/app:<id>         — pro mode, installed app
//
// The session id sits in the last segment and ONLY the UUID shape is accepted
// — otherwise arbitrary text like "chat/xyz" would be read as a session and
// the UI would try to load a conversation that does not exist.
//
// Pure functions (they never touch the DOM) — hence testable.

/** UUID v4 — the shape of ids from `crypto.randomUUID()` */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_SHAPE.test(value)
}

export interface HashState {
  pro: boolean
  /** Page path: 'chat', 'servers', 'app:xyz' ... */
  path: string
  sessionId: string | null
}

/** Turns a hash string into state. The input may or may not start with '#'. */
export function parseHash(raw: string): HashState {
  const parts = raw.replace(/^#/, '').split('/').filter(Boolean)
  const pro = parts[0] === 'pro'
  const rest = pro ? parts.slice(1) : parts

  const last = rest[rest.length - 1]
  const sessionId = last && isUuid(last) ? last : null
  const path = (sessionId ? rest.slice(0, -1) : rest).join('/')

  return { pro, path, sessionId }
}

/**
 * Builds the hash string from state (without the leading '#').
 *
 * The session id is only appended on the chat page: anywhere else it is
 * meaningless and would only confuse the URL.
 */
export function buildHash(pro: boolean, path: string, sessionId: string | null): string {
  const parts: string[] = []
  if (pro) parts.push('pro')

  const hasSession = Boolean(sessionId) && path === 'chat'
  // In plain mode the word 'chat' is redundant (there is no other page) — BUT
  // it is written when there is a session, otherwise the URL would read as a
  // confusing '#<uuid>'
  if (pro || path !== 'chat' || hasSession) parts.push(path)
  if (hasSession) parts.push(sessionId as string)

  return parts.filter(Boolean).join('/')
}
