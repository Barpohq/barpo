// The chat flow: validation, the session's provider lock and migration 002.
//
// The LLM itself is never called — these tests do not go near the network. The
// real stream is exercised in orchestrator.test.ts with a fake LLM.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { ChatSession } from '@barpo/shared'
import { setCache, clearCache } from '@barpo/ai'
import { app } from '../src/app.ts'
import { openDb, setDb } from '../src/db.ts'
import {
  writeAttachment,
  changeSessionModel,
  lockSessionModel,
  readSession,
  createSession,
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

async function send(body: unknown): Promise<{ status: number; body: Record<string, string> }> {
  const response = await app.request('/api/chat/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, string> }
}

describe('migration 002 — the session model', () => {
  test('chat_sessions has provider and model columns', () => {
    const columns = db
      .query<{ name: string }, []>('PRAGMA table_info(chat_sessions)')
      .all()
      .map((c) => c.name)
    expect(columns).toContain('provider')
    expect(columns).toContain('model')
  })

  test('a new session has no provider or model yet', () => {
    const s = createSession('test', db)
    expect(s.provider).toBeUndefined()
    expect(s.model).toBeUndefined()
  })

  test('lockSessionModel only writes the first time', () => {
    const s = createSession('test', db)

    expect(lockSessionModel(s.id, 'ollama', 'qwen3:8b', db)).toBe(true)
    expect(readSession(s.id, db)?.provider).toBe('ollama')

    // A second attempt changes nothing — protection against a race
    expect(lockSessionModel(s.id, 'anthropic', 'claude-haiku-4-5', db)).toBe(false)
    expect(readSession(s.id, db)?.provider).toBe('ollama')
  })

  test('changeSessionModel swaps the model but keeps the provider', () => {
    const s = createSession('test', db)
    lockSessionModel(s.id, 'ollama', 'qwen3:0.6b', db)
    changeSessionModel(s.id, 'qwen3:8b', db)

    const updated = readSession(s.id, db)
    expect(updated?.provider).toBe('ollama')
    expect(updated?.model).toBe('qwen3:8b')
  })
})

describe('POST /api/chat/send — validation', () => {
  test('a body that is not JSON gives 400', async () => {
    const response = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this is not json',
    })
    expect(response.status).toBe(400)
  })

  test('no sessionId — 400', async () => {
    const { status, body } = await send({ text: 'hello' })
    expect(status).toBe(400)
    expect(body.error).toContain('sessionId')
  })

  test('empty text — 400', async () => {
    const s = createSession('test', db)
    const { status, body } = await send({ sessionId: s.id, text: '   ' })
    expect(status).toBe(400)
    expect(body.error).toContain('empty')
  })

  test('a session that does not exist — 404', async () => {
    const { status } = await send({
      sessionId: 'no-such-thing',
      text: 'hello',
      model: { provider: 'ollama', model: 'x' },
    })
    expect(status).toBe(404)
  })

  test('no model chosen on the first message — 400', async () => {
    const s = createSession('test', db)
    const { status, body } = await send({ sessionId: s.id, text: 'hello' })
    expect(status).toBe(400)
    expect(body.error).toContain('model')
  })
})

describe('POST /api/chat/send — the provider lock', () => {
  test('a different provider in a locked session gives 409', async () => {
    const s = createSession('test', db)
    lockSessionModel(s.id, 'ollama', 'qwen3:0.6b', db)

    const { status, body } = await send({
      sessionId: s.id,
      text: 'hello',
      model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    })
    expect(status).toBe(409)
    expect(body.error).toContain('cannot be changed')
    expect(body.detail).toContain('ollama')
  })
})

describe('migration 003 — tool cards', () => {
  test('chat_messages has a tool_cards column', () => {
    const columns = db
      .query<{ name: string }, []>('PRAGMA table_info(chat_messages)')
      .all()
      .map((c) => c.name)
    expect(columns).toContain('tool_cards')
    // The old column is still in place
    expect(columns).toContain('tool_card')
  })

  test('tool cards are written and read back', () => {
    const s = createSession('test', db)
    writeMessage(
      {
        sessionId: s.id,
        role: 'assistant',
        text: 'ready',
        toolCards: [
          { id: 't1', name: 'read', args: 'a.txt', status: 'done', result: 'hello' },
          { id: 't2', name: 'bash', args: 'ls', status: 'error', result: 'error' },
        ],
      },
      db,
    )

    const messages = readMessages(s.id, db)
    expect(messages[0]?.toolCards).toHaveLength(2)
    expect(messages[0]?.toolCards?.[0]?.name).toBe('read')
    expect(messages[0]?.toolCards?.[1]?.status).toBe('error')
  })

  test('a message with no tool card returns undefined', () => {
    const s = createSession('test', db)
    writeMessage({ sessionId: s.id, role: 'user', text: 'hello' }, db)
    expect(readMessages(s.id, db)[0]?.toolCards).toBeUndefined()
  })
})

describe('POST /api/chat/permission', () => {
  test('an invalid answer value gives 400', async () => {
    const response = await app.request('/api/chat/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', requestId: 'r', answer: 'something' }),
    })
    expect(response.status).toBe(400)
  })

  test('no sessionId — 400', async () => {
    const response = await app.request('/api/chat/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'r', answer: 'allow' }),
    })
    expect(response.status).toBe(400)
  })

  test('a request that does not exist gives 404', async () => {
    const response = await app.request('/api/chat/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', requestId: 'no-such-thing', answer: 'allow' }),
    })
    expect(response.status).toBe(404)
  })
})

describe('GET /api/chat/running', () => {
  // A stream actually in flight is exercised in orchestrator.test.ts, where the
  // LLM module is faked. Here the shape and the empty case are checked.

  test('an empty list comes back when nothing is running', async () => {
    const response = await app.request('/api/chat/running')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ running: [] })
  })

  test('`running` is always an array — the UI maps it unconditionally', async () => {
    const response = await app.request('/api/chat/running')
    const body = (await response.json()) as { running: unknown }
    expect(Array.isArray(body.running)).toBe(true)
  })
})

describe('GET /api/chat/sessions — the model fields', () => {
  test('a locked session returns its provider and model', async () => {
    const s = createSession('test', db)
    lockSessionModel(s.id, 'openrouter', 'anthropic/claude-haiku-4.5', db)

    const response = await app.request('/api/chat/sessions')
    const { sessions } = (await response.json()) as { sessions: ChatSession[] }
    const found = sessions.find((x) => x.id === s.id)

    expect(found?.provider).toBe('openrouter')
    expect(found?.model).toBe('anthropic/claude-haiku-4.5')
  })
})

// For restoring a conversation from the URL: when the page is opened with
// `#chat/<uuid>` the UI takes the session's model and project from this route.
describe('GET /api/chat/sessions/:id — restoring from the URL', () => {
  test('an existing session comes back', async () => {
    const s = createSession('restorable', db)

    const response = await app.request(`/api/chat/sessions/${s.id}`)
    expect(response.status).toBe(200)

    const { session } = (await response.json()) as { session: ChatSession }
    expect(session.id).toBe(s.id)
    expect(session.title).toBe('restorable')
  })

  test('it returns the model — this is how the UI restores the provider', async () => {
    const s = createSession('with a model', db)
    lockSessionModel(s.id, 'openai-codex', 'gpt-5.6-luna', db)

    const response = await app.request(`/api/chat/sessions/${s.id}`)
    const { session } = (await response.json()) as { session: ChatSession }

    expect(session.provider).toBe('openai-codex')
    expect(session.model).toBe('gpt-5.6-luna')
  })

  test('404 for a session that is gone — the UI reads that as "fall back to an empty chat"', async () => {
    const response = await app.request('/api/chat/sessions/00000000-0000-4000-8000-000000000000')
    expect(response.status).toBe(404)
  })

  test('rubbish in place of an id gives 404, not 500', async () => {
    const response = await app.request('/api/chat/sessions/not-a-uuid')
    expect(response.status).toBe(404)
  })
})

// Attachments are linked by id in `/chat/send`. The vision guard is here too —
// this is the single point at which it can live, because the model is locked
// EXACTLY here.
describe('POST /api/chat/send — attachments', () => {
  /** An unlinked attachment record (the file system is not touched) */
  function attachment(sessionId: string, kind: 'image' | 'file' = 'file') {
    return writeAttachment(
      {
        sessionId,
        kind,
        name: 'a.png',
        originalName: 'a.png',
        path: 'fayllar/a.png',
        mime: kind === 'image' ? 'image/png' : 'application/octet-stream',
        size: 100,
      },
      db,
    )
  }

  test('an attachment is linked to the message', async () => {
    const s = createSession('test', db)
    const a = attachment(s.id)

    const { status } = await send({
      sessionId: s.id,
      text: 'take a look at this',
      model: { provider: 'ollama', model: 'x' },
      attachments: [a.id],
    })

    expect(status).toBe(202)
    const messages = readMessages(s.id, db)
    expect(messages[0]?.attachments).toHaveLength(1)
  })

  // A user dropping in an image and writing nothing is a normal thing to do
  test('empty text passes when there is an attachment', async () => {
    const s = createSession('test', db)
    const a = attachment(s.id)

    const { status } = await send({
      sessionId: s.id,
      text: '',
      model: { provider: 'ollama', model: 'x' },
      attachments: [a.id],
    })

    expect(status).toBe(202)
  })

  test('empty text with no attachment is still 400', async () => {
    const s = createSession('test', db)

    const { status } = await send({
      sessionId: s.id,
      text: '  ',
      model: { provider: 'ollama', model: 'x' },
    })

    expect(status).toBe(400)
  })

  // SECURITY: the client can send any id it likes
  test("another session's attachment id — 404", async () => {
    const one = createSession('one', db)
    const two = createSession('two', db)
    const foreign = attachment(two.id)

    const { status, body } = await send({
      sessionId: one.id,
      text: 'hello',
      model: { provider: 'ollama', model: 'x' },
      attachments: [foreign.id],
    })

    expect(status).toBe(404)
    expect(body.error).toContain('Attachment')
    // The message MUST NOT be written — no orphaned user message may be left
    // in the database
    expect(readMessages(one.id, db)).toHaveLength(0)
  })

  test('an attachment id that does not exist — 404', async () => {
    const s = createSession('test', db)

    const { status } = await send({
      sessionId: s.id,
      text: 'hello',
      model: { provider: 'ollama', model: 'x' },
      attachments: ['no-such-id'],
    })

    expect(status).toBe(404)
  })

  test('attachments that is not an array — 400', async () => {
    const s = createSession('test', db)

    const { status } = await send({
      sessionId: s.id,
      text: 'hello',
      model: { provider: 'ollama', model: 'x' },
      attachments: 'not an array',
    })

    expect(status).toBe(400)
  })

  test('an empty attachments array passes without trouble', async () => {
    const s = createSession('test', db)

    const { status } = await send({
      sessionId: s.id,
      text: 'hello',
      model: { provider: 'ollama', model: 'x' },
      attachments: [],
    })

    expect(status).toBe(202)
  })
})

// The vision guard leans on the model CACHE. With an empty cache the guard lets
// things through (we do not forbid on uncertainty) — which is why these tests
// fill the cache themselves.
describe('POST /api/chat/send — the vision guard', () => {
  function attachment(sessionId: string, kind: 'image' | 'file') {
    return writeAttachment(
      {
        sessionId,
        kind,
        name: 'a',
        originalName: 'a',
        path: 'fayllar/a',
        mime: kind === 'image' ? 'image/png' : 'application/octet-stream',
        size: 10,
      },
      db,
    )
  }

  /** The cache: one provider, two models — one with vision, one without */
  function fillCache() {
    setCache({
      models: [
        { provider: 'ollama', providerName: 'Ollama', id: 'seeing', name: 'Seeing', contextWindow: 8000, reasoning: false, vision: true, cost: { input: 0, output: 0 }, source: 'test', billing: 'local' },
        { provider: 'ollama', providerName: 'Ollama', id: 'unseeing', name: 'Unseeing', contextWindow: 8000, reasoning: false, vision: false, cost: { input: 0, output: 0 }, source: 'test', billing: 'local' },
      ],
      providers: [],
      warnings: [],
      time: new Date().toISOString(),
    })
  }

  afterEach(() => {
    clearCache()
  })

  test('an image for a model without vision — 400, and the message IS NOT WRITTEN', async () => {
    fillCache()
    const s = createSession('test', db)
    const a = attachment(s.id, 'image')

    const { status, body } = await send({
      sessionId: s.id,
      text: 'what is this?',
      model: { provider: 'ollama', model: 'unseeing' },
      attachments: [a.id],
    })

    expect(status).toBe(400)
    expect(body.error).toContain('images')
    expect(body.detail).toContain('Unseeing')
    // A rejected message must not be left behind in the database
    expect(readMessages(s.id, db)).toHaveLength(0)
  })

  test('a FILE for a model without vision — passes', async () => {
    fillCache()
    const s = createSession('test', db)
    const a = attachment(s.id, 'file')

    const { status } = await send({
      sessionId: s.id,
      text: 'check this',
      model: { provider: 'ollama', model: 'unseeing' },
      attachments: [a.id],
    })

    expect(status).toBe(202)
  })

  test('an image for a model with vision — passes', async () => {
    fillCache()
    const s = createSession('test', db)
    const a = attachment(s.id, 'image')

    const { status } = await send({
      sessionId: s.id,
      text: 'what is this?',
      model: { provider: 'ollama', model: 'seeing' },
      attachments: [a.id],
    })

    expect(status).toBe(202)
  })

  // We do not forbid on uncertainty: with an empty cache the provider reports
  // its own error
  test('an empty cache — the guard lets it through', async () => {
    const s = createSession('test', db)
    const a = attachment(s.id, 'image')

    const { status } = await send({
      sessionId: s.id,
      text: 'what is this?',
      model: { provider: 'ollama', model: 'unknown' },
      attachments: [a.id],
    })

    expect(status).toBe(202)
  })
})
