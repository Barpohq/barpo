// URL hash ↔ app state (barpo-ui/src/lib/hash-path.ts).
//
// WHY IT LIVES IN THE SERVER TESTS: the functions are pure (they never touch
// the DOM) and the UI package has no test harness yet. The logic is delicate —
// restoring the open conversation after a page reload depends on it — so it
// must not go uncovered.

import { describe, expect, test } from 'bun:test'
import { buildHash, parseHash, isUuid } from '../../barpo-ui/src/lib/hash-path.ts'

const UUID = '3f8a1c2e-9b4d-4e7a-8c1f-2d5e6a7b8c9d'

describe('parseHash', () => {
  test('an empty hash means plain mode with no session', () => {
    expect(parseHash('')).toEqual({ pro: false, path: '', sessionId: null })
  })

  test('a leading # makes no difference', () => {
    expect(parseHash('#pro/servers')).toEqual(parseHash('pro/servers'))
  })

  test('a conversation in plain mode: #chat/<uuid>', () => {
    expect(parseHash(`#chat/${UUID}`)).toEqual({ pro: false, path: 'chat', sessionId: UUID })
  })

  test('a conversation in pro mode: #pro/chat/<uuid>', () => {
    expect(parseHash(`#pro/chat/${UUID}`)).toEqual({ pro: true, path: 'chat', sessionId: UUID })
  })

  test('a pro page with no session', () => {
    expect(parseHash('#pro/servers')).toEqual({ pro: true, path: 'servers', sessionId: null })
  })

  test('an app page survives parsing intact', () => {
    expect(parseHash('#pro/app:ai-news-bot')).toEqual({
      pro: true,
      path: 'app:ai-news-bot',
      sessionId: null,
    })
  })

  // THE MOST IMPORTANT GUARD: a trailing segment that is not a UUID must not
  // be taken for a session — otherwise the UI would try to load a conversation
  // that does not exist
  test('a trailing segment that is not a UUID is not taken as a session', () => {
    expect(parseHash('#pro/chat/hello').sessionId).toBeNull()
    expect(parseHash('#pro/chat/123').sessionId).toBeNull()
    expect(parseHash('#chat/not-a-uuid-at-all').sessionId).toBeNull()
  })

  test('a truncated or malformed UUID is rejected', () => {
    expect(parseHash('#chat/3f8a1c2e-9b4d-4e7a-8c1f').sessionId).toBeNull()
    expect(parseHash(`#chat/${UUID}xx`).sessionId).toBeNull()
  })

  test('the UUID match is case-insensitive', () => {
    expect(parseHash(`#chat/${UUID.toUpperCase()}`).sessionId).toBe(UUID.toUpperCase())
  })

  test('redundant slashes do not break parsing', () => {
    expect(parseHash('#//pro//chat//')).toEqual({ pro: true, path: 'chat', sessionId: null })
  })
})

describe('buildHash', () => {
  test('plain mode with no session produces an empty hash', () => {
    expect(buildHash(false, 'chat', null)).toBe('')
  })

  test('a conversation in plain mode', () => {
    expect(buildHash(false, 'chat', UUID)).toBe(`chat/${UUID}`)
  })

  test('a conversation in pro mode', () => {
    expect(buildHash(true, 'chat', UUID)).toBe(`pro/chat/${UUID}`)
  })

  test('the session id is only written on the chat page', () => {
    // The id of an open conversation is meaningless on the servers page
    expect(buildHash(true, 'servers', UUID)).toBe('pro/servers')
  })

  test('an app page', () => {
    expect(buildHash(true, 'app:ai-news-bot', null)).toBe('pro/app:ai-news-bot')
  })
})

describe('buildHash ↔ parseHash round trip', () => {
  // The two must be inverses of each other, otherwise writing the URL and
  // reading it back would produce a different state and lose the conversation
  const states: { pro: boolean; path: string; sessionId: string | null }[] = [
    { pro: false, path: 'chat', sessionId: null },
    { pro: false, path: 'chat', sessionId: UUID },
    { pro: true, path: 'chat', sessionId: UUID },
    { pro: true, path: 'chat', sessionId: null },
    { pro: true, path: 'servers', sessionId: null },
    { pro: true, path: 'app:ai-news-bot', sessionId: null },
  ]

  for (const s of states) {
    test(`${JSON.stringify(s)} — survives a build-then-parse round trip`, () => {
      const parsed = parseHash(buildHash(s.pro, s.path, s.sessionId))
      expect(parsed.pro).toBe(s.pro)
      // In plain mode a session-less 'chat' is not written (the hash is empty),
      // so it reads back empty too and App treats that as the default 'chat'
      const chatIsWritten = s.pro || s.path !== 'chat' || s.sessionId
      expect(parsed.path).toBe(chatIsWritten ? s.path : '')
      expect(parsed.sessionId).toBe(s.sessionId)
    })
  }
})

describe('isUuid', () => {
  test('a real UUID is accepted', () => {
    expect(isUuid(UUID)).toBe(true)
    expect(isUuid(crypto.randomUUID())).toBe(true)
  })

  test('an empty string and junk are rejected', () => {
    expect(isUuid('')).toBe(false)
    expect(isUuid('chat')).toBe(false)
  })
})
