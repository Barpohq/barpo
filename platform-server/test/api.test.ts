// REST endpoint tests — through Hono's `app.request`, with no network.
// A clean in-memory database is opened and seeded before every test.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { AppManifest, AuditEntry, ChatSession, Server, Skill } from '@platforma/shared'
import { app } from '../src/app.ts'
import { auditWrite } from '../src/audit.ts'
import { openDb, setDb } from '../src/db.ts'
import { saveApp } from '../src/repo.ts'
import { applySeed } from '../src/seed.ts'
import { hub } from '../src/ws/hub.ts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)
  applySeed(db)
})

afterEach(() => {
  setDb(null)
  hub.clear()
  db.close()
})

/** Shorthand: sends a GET request and returns the JSON */
async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await app.request(path)
  return { status: response.status, body: (await response.json()) as T }
}

describe('GET /api/health', () => {
  test('it returns ok:true and the schema version', async () => {
    const { status, body } = await get<{ ok: boolean; schema: number; wsClients: number }>('/api/health')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.schema).toBeGreaterThan(0)
    expect(typeof body.wsClients).toBe('number')
  })
})

describe('GET /api/servers', () => {
  // There is no server seed (migration 007): a row points at a real SSH
  // connection. The full add/delete flow lives in `servers.test.ts`.
  test('it returns an empty list', async () => {
    const { status, body } = await get<{ servers: Server[] }>('/api/servers')
    expect(status).toBe(200)
    expect(body.servers).toEqual([])
  })
})

describe('GET /api/skills', () => {
  // There is NO skill seed: skills are tied to a real `SKILL.md` on disk and
  // the user connects a GitHub source themselves. The full install flow is
  // exercised in `skills.test.ts`.
  test('it returns an empty catalog', async () => {
    const { status, body } = await get<{ skills: Skill[]; sources: unknown[] }>('/api/skills')
    expect(status).toBe(200)
    expect(body.skills).toEqual([])
    expect(body.sources).toEqual([])
  })
})

describe('GET /api/apps', () => {
  // There is NO app seed: a dashboard is built from a real manifest and
  // installed through `appPublish` in the chat, so the tests write their own
  // manifest.
  const testApp: AppManifest = {
    id: 'expense-bot',
    icon: '💸',
    name: 'expense-bot',
    tagline: 'Expense tracker',
    version: 'v0.1.0',
    service: 'frankfurt-1 · docker',
    status: 'running',
    widgets: [{ type: 'stats', items: [{ label: 'Today', value: '$0.12' }] }],
  }

  test('it returns an empty list', async () => {
    const { status, body } = await get<{ apps: AppManifest[] }>('/api/apps')
    expect(status).toBe(200)
    expect(body.apps).toEqual([])
  })

  test('it returns the list of manifests', async () => {
    saveApp(testApp, db)

    const { status, body } = await get<{ apps: AppManifest[] }>('/api/apps')
    expect(status).toBe(200)
    expect(body.apps).toHaveLength(1)
    expect(body.apps[0]?.id).toBe('expense-bot')
    expect(body.apps[0]?.widgets.length).toBe(1)
  })

  test('a single app manifest is fetched by id', async () => {
    saveApp(testApp, db)

    const { status, body } = await get<{ manifest: AppManifest }>('/api/apps/expense-bot')
    expect(status).toBe(200)
    expect(body.manifest.name).toBe('expense-bot')
    expect(body.manifest.widgets[0]?.type).toBe('stats')
  })

  test('an app that does not exist gives a 404', async () => {
    const { status } = await get('/api/apps/no-such-app')
    expect(status).toBe(404)
  })
})

describe('GET /api/audit', () => {
  test('the seeded audit entries come back', async () => {
    const { status, body } = await get<{ entries: AuditEntry[]; total: number }>('/api/audit')
    expect(status).toBe(200)
    expect(body.total).toBe(12)
    expect(body.entries).toHaveLength(12)
  })

  test('the level filter works', async () => {
    const { body } = await get<{ entries: AuditEntry[]; total: number }>('/api/audit?level=dangerous')
    expect(body.total).toBe(1)
    expect(body.entries[0]?.action).toContain('DROP TABLE')
  })

  test('the actor filter and limit work together', async () => {
    const { body } = await get<{ entries: AuditEntry[]; total: number }>(
      '/api/audit?actor=ai-news-bot&limit=2',
    )
    expect(body.total).toBe(4)
    expect(body.entries).toHaveLength(2)
    expect(body.entries.every((e) => e.actor === 'ai-news-bot')).toBe(true)
  })

  test('an entry written with auditWrite shows up on the endpoint', async () => {
    auditWrite('test-actor', 'A new action', 'target', 'write', 'approved')

    const { body } = await get<{ entries: AuditEntry[] }>('/api/audit?actor=test-actor')
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]?.result).toBe('approved')
  })

  test('a non-numeric limit gives a 400', async () => {
    const { status } = await get('/api/audit?limit=abc')
    expect(status).toBe(400)
  })
})

describe('chat endpoints', () => {
  test('a session is created and appears in the list', async () => {
    const created = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'First conversation' }),
    })
    expect(created.status).toBe(201)
    const { session } = (await created.json()) as { session: ChatSession }
    expect(session.title).toBe('First conversation')
    expect(session.id).toBeTruthy()

    const { body } = await get<{ sessions: ChatSession[] }>('/api/chat/sessions')
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]?.id).toBe(session.id)
  })

  test('a POST with no body works too (the title is generated)', async () => {
    const response = await app.request('/api/chat/sessions', { method: 'POST' })
    expect(response.status).toBe(201)
    const { session } = (await response.json()) as { session: ChatSession }
    expect(session.title).toBe('New conversation')
  })

  test('a new session has no messages', async () => {
    const response = await app.request('/api/chat/sessions', { method: 'POST' })
    const { session } = (await response.json()) as { session: ChatSession }

    const { status, body } = await get<{ messages: unknown[] }>(
      `/api/chat/sessions/${session.id}/messages`,
    )
    expect(status).toBe(200)
    expect(body.messages).toHaveLength(0)
  })

  test('asking for the messages of a missing session gives a 404', async () => {
    const { status } = await get('/api/chat/sessions/no-such-session/messages')
    expect(status).toBe(404)
  })

  test('POST /api/chat/send to a missing session gives a 404', async () => {
    const response = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'no-such-session',
        text: 'hello',
        model: { provider: 'ollama', model: 'test' },
      }),
    })
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('Session')
  })
})

describe('general behaviour', () => {
  test('an unknown path returns a 404 as JSON', async () => {
    const response = await app.request('/api/no-such-path')
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('Not found')
  })
})
