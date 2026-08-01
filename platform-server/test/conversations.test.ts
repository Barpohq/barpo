// Listing, renaming and deleting conversations.
//
// The "last 5 chats" sidebar list and the Conversations page in the UI both
// rely on these routes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { ChatSession } from '@barpo/shared'
import { app } from '../src/app.ts'
import { openDb, setDb } from '../src/db.ts'
import {
  deleteSession,
  readSession,
  renameSession,
  createSession,
  readSessions,
  readMessages,
  writeMessage,
} from '../src/repo.ts'
import { hub } from '../src/ws/hub.ts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)
})

afterEach(() => {
  setDb(null)
  hub.clear()
  db.close()
})

describe('readSessions — the message count', () => {
  test('a session with no messages is listed with a count of 0', () => {
    createSession('empty conversation', db)

    const list = readSessions(db)
    expect(list).toHaveLength(1)
    expect(list[0]?.messageCount).toBe(0)
  })

  test('messages are counted', () => {
    const s = createSession('a full conversation', db)
    writeMessage({ sessionId: s.id, role: 'user', text: 'hello' }, db)
    writeMessage({ sessionId: s.id, role: 'assistant', text: 'hello there' }, db)

    expect(readSessions(db)[0]?.messageCount).toBe(2)
  })

  test('the messages of one session are not counted against another', () => {
    const a = createSession('a', db)
    const b = createSession('b', db)
    writeMessage({ sessionId: a.id, role: 'user', text: 'only in a' }, db)

    const list = readSessions(db)
    expect(list.find((s) => s.id === a.id)?.messageCount).toBe(1)
    expect(list.find((s) => s.id === b.id)?.messageCount).toBe(0)
  })

  test('the list is sorted by last activity — the newest first', async () => {
    const older = createSession('older', db)
    // `updated_at` is compared as an ISO string — created in the same
    // millisecond the order would be undefined
    await Bun.sleep(2)
    const newer = createSession('newer', db)

    const list = readSessions(db)
    expect(list[0]?.id).toBe(newer.id)
    expect(list[1]?.id).toBe(older.id)
  })

  test('writing a message moves the conversation to the top', async () => {
    const first = createSession('first', db)
    await Bun.sleep(2)
    createSession('second', db)
    await Bun.sleep(2)

    writeMessage({ sessionId: first.id, role: 'user', text: 'revived' }, db)
    expect(readSessions(db)[0]?.id).toBe(first.id)
  })
})

describe('renameSession', () => {
  test('it replaces the title', () => {
    const s = createSession('old title', db)

    expect(renameSession(s.id, 'new title', db)).toBe(true)
    expect(readSession(s.id, db)?.title).toBe('new title')
  })

  test('it returns false for a session that does not exist', () => {
    expect(renameSession('no-such-session', 'title', db)).toBe(false)
  })

  test('it leaves updated_at alone, so an edit does not bump the conversation', async () => {
    const s = createSession('first', db)
    await Bun.sleep(2)
    const next = createSession('second', db)

    renameSession(s.id, 'renamed', db)

    // The order must not change: the second one is still on top
    expect(readSessions(db)[0]?.id).toBe(next.id)
  })
})

describe('deleteSession', () => {
  test('the session and its messages go together (CASCADE)', () => {
    const s = createSession('doomed', db)
    writeMessage({ sessionId: s.id, role: 'user', text: 'hello' }, db)

    expect(deleteSession(s.id, db)).toBe(true)
    expect(readSession(s.id, db)).toBeNull()
    expect(readMessages(s.id, db)).toHaveLength(0)
  })

  test('it does not touch other sessions', () => {
    const a = createSession('a', db)
    const b = createSession('b', db)
    writeMessage({ sessionId: b.id, role: 'user', text: 'must survive' }, db)

    deleteSession(a.id, db)

    expect(readSession(b.id, db)).not.toBeNull()
    expect(readMessages(b.id, db)).toHaveLength(1)
  })

  test('it returns false for a session that does not exist', () => {
    expect(deleteSession('no-such-session', db)).toBe(false)
  })
})

describe('PATCH /api/chat/sessions/:id', () => {
  async function rename(id: string, body: unknown) {
    const response = await app.request(`/api/chat/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  test('it changes the title and returns the updated session', async () => {
    const s = createSession('old', db)

    const { status, body } = await rename(s.id, { title: 'new title' })
    expect(status).toBe(200)
    expect((body.session as ChatSession).title).toBe('new title')
  })

  test('surrounding whitespace is trimmed from the title', async () => {
    const s = createSession('old', db)
    await rename(s.id, { title: '  trimmed  ' })
    expect(readSession(s.id, db)?.title).toBe('trimmed')
  })

  test('an empty title gives a 400', async () => {
    const s = createSession('old', db)
    const { status } = await rename(s.id, { title: '   ' })
    expect(status).toBe(400)
    // The old title stays in place
    expect(readSession(s.id, db)?.title).toBe('old')
  })

  test('a missing title gives a 400', async () => {
    const s = createSession('old', db)
    const { status } = await rename(s.id, {})
    expect(status).toBe(400)
  })

  test('an overlong title gives a 400', async () => {
    const s = createSession('old', db)
    const { status } = await rename(s.id, { title: 'a'.repeat(201) })
    expect(status).toBe(400)
  })

  test('a session that does not exist gives a 404', async () => {
    const { status } = await rename('00000000-0000-4000-8000-000000000000', {
      title: 'title',
    })
    expect(status).toBe(404)
  })

  test('a body that is not JSON gives a 400', async () => {
    const s = createSession('old', db)
    const response = await app.request(`/api/chat/sessions/${s.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: 'this is not json',
    })
    expect(response.status).toBe(400)
  })
})

describe('DELETE /api/chat/sessions/:id', () => {
  test('it deletes the session', async () => {
    const s = createSession('doomed', db)
    writeMessage({ sessionId: s.id, role: 'user', text: 'hello' }, db)

    const response = await app.request(`/api/chat/sessions/${s.id}`, { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ deleted: true, streamStopped: false })
    expect(readSession(s.id, db)).toBeNull()
  })

  test('once deleted it disappears from the list', async () => {
    const s = createSession('doomed', db)
    await app.request(`/api/chat/sessions/${s.id}`, { method: 'DELETE' })

    const response = await app.request('/api/chat/sessions')
    const { sessions } = (await response.json()) as { sessions: ChatSession[] }
    expect(sessions.find((x) => x.id === s.id)).toBeUndefined()
  })

  test('a session that does not exist gives a 404', async () => {
    const response = await app.request('/api/chat/sessions/00000000-0000-4000-8000-000000000000', {
      method: 'DELETE',
    })
    expect(response.status).toBe(404)
  })

  test('deleting twice gives a 404 the second time', async () => {
    const s = createSession('doomed', db)
    await app.request(`/api/chat/sessions/${s.id}`, { method: 'DELETE' })

    const second = await app.request(`/api/chat/sessions/${s.id}`, { method: 'DELETE' })
    expect(second.status).toBe(404)
  })
})

describe('GET /api/chat/sessions — the shape of the list', () => {
  test('the message count comes back, so the UI can spot an empty conversation', async () => {
    const s = createSession('test', db)
    writeMessage({ sessionId: s.id, role: 'user', text: 'hello' }, db)

    const response = await app.request('/api/chat/sessions')
    const { sessions } = (await response.json()) as { sessions: ChatSession[] }
    expect(sessions.find((x) => x.id === s.id)?.messageCount).toBe(1)
  })

  test('with no sessions it returns an empty array, so the UI can map unconditionally', async () => {
    const response = await app.request('/api/chat/sessions')
    expect(await response.json()).toEqual({ sessions: [] })
  })
})
