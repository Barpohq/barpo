// REST endpoint tests — through Hono's `app.request`, with no network.
// A clean in-memory database is opened and seeded before every test.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppManifest, AuditEntry, ChatSession, Server, Skill } from '@platforma/shared'
import { app } from '../src/app.ts'
import { auditWrite } from '../src/audit.ts'
import { openDb, setDb } from '../src/db.ts'
import { applySeed } from '../src/seed.ts'
import { hub } from '../src/ws/hub.ts'
import { cleanupApps, publishTestApp, useTempApps } from './app-fixture.ts'

let db: Database
let appsRoot: string

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)
  applySeed(db)
  appsRoot = useTempApps()
})

afterEach(() => {
  setDb(null)
  hub.clear()
  db.close()
  cleanupApps(appsRoot)
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
  // There is NO app seed: an app is a FOLDER on disk, written in the chat and
  // registered through `appPublish`. So the tests build their own folder.
  const widgets = [{ type: 'stats', items: [{ label: 'Today', value: '$0.12' }] }]

  test('it returns an empty list', async () => {
    const { status, body } = await get<{ apps: AppManifest[] }>('/api/apps')
    expect(status).toBe(200)
    expect(body.apps).toEqual([])
  })

  test('it returns the list of manifests', async () => {
    await publishTestApp(appsRoot, 'expense-bot', { widgets }, db)

    const { status, body } = await get<{ apps: AppManifest[] }>('/api/apps')
    expect(status).toBe(200)
    expect(body.apps).toHaveLength(1)
    expect(body.apps[0]?.id).toBe('expense-bot')
    expect(body.apps[0]?.widgets.length).toBe(1)
  })

  test('a single app manifest is fetched by id, with its folder', async () => {
    await publishTestApp(appsRoot, 'expense-bot', { widgets }, db)

    const { status, body } = await get<{ manifest: AppManifest; dir: string }>(
      '/api/apps/expense-bot',
    )
    expect(status).toBe(200)
    expect(body.manifest.name).toBe('expense-bot')
    expect(body.manifest.widgets[0]?.type).toBe('stats')
    // The path is returned because the user edits these files themselves
    expect(body.dir).toContain('expense-bot')
  })

  test('an app that does not exist gives a 404', async () => {
    const { status } = await get('/api/apps/no-such-app')
    expect(status).toBe(404)
  })
})

describe('DELETE /api/apps/:id', () => {
  test('it removes the app and its folder', async () => {
    await publishTestApp(appsRoot, 'doomed', {}, db)
    expect(existsSync(join(appsRoot, 'doomed'))).toBe(true)

    const response = await app.request('/api/apps/doomed', { method: 'DELETE' })
    const body = (await response.json()) as { ok: boolean; folderRemoved: boolean }

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.folderRemoved).toBe(true)
    expect(existsSync(join(appsRoot, 'doomed'))).toBe(false)

    const { body: list } = await get<{ apps: AppManifest[] }>('/api/apps')
    expect(list.apps).toEqual([])
  })

  test('deleting an app that does not exist gives a 404', async () => {
    const response = await app.request('/api/apps/no-such-app', { method: 'DELETE' })
    expect(response.status).toBe(404)
  })

  test('the deletion is recorded in the audit log', async () => {
    // Erasing files must leave a trace — the audit table blocks UPDATE and
    // DELETE with a SQL trigger, so the entry cannot be quietly removed later.
    await publishTestApp(appsRoot, 'doomed', {}, db)
    await app.request('/api/apps/doomed', { method: 'DELETE' })

    const { body } = await get<{ entries: AuditEntry[] }>('/api/audit')
    const entry = body.entries.find((e) => e.action.includes('App deleted'))
    expect(entry).toBeDefined()
    expect(entry?.target).toBe('doomed')
    expect(entry?.level).toBe('dangerous')
  })
})

describe('GET /api/audit', () => {
  // Nothing is seeded any more (see seed.ts), so each test writes the history
  // it needs. That is closer to reality anyway: entries only ever come from
  // `auditWrite`, never from a fixture.
  function writeSample() {
    auditWrite('collector', 'Pipeline started', 'helsinki-1', 'read')
    auditWrite('collector', 'Report sent', 'admin chat', 'read')
    auditWrite('skill:postgres-backup', 'DROP TABLE attempt blocked', 'db-01', 'dangerous', 'denied')
  }

  test('a fresh platform has an empty log', async () => {
    const { status, body } = await get<{ entries: AuditEntry[]; total: number }>('/api/audit')
    expect(status).toBe(200)
    expect(body.total).toBe(0)
    expect(body.entries).toEqual([])
  })

  test('written entries come back', async () => {
    writeSample()

    const { status, body } = await get<{ entries: AuditEntry[]; total: number }>('/api/audit')
    expect(status).toBe(200)
    expect(body.total).toBe(3)
    expect(body.entries).toHaveLength(3)
  })

  test('the level filter works', async () => {
    writeSample()

    const { body } = await get<{ entries: AuditEntry[]; total: number }>('/api/audit?level=dangerous')
    expect(body.total).toBe(1)
    expect(body.entries[0]?.action).toContain('DROP TABLE')
  })

  test('the actor filter and limit work together', async () => {
    writeSample()

    const { body } = await get<{ entries: AuditEntry[]; total: number }>(
      '/api/audit?actor=collector&limit=1',
    )
    // `total` counts every match, `entries` is what the limit let through
    expect(body.total).toBe(2)
    expect(body.entries).toHaveLength(1)
    expect(body.entries.every((e) => e.actor === 'collector')).toBe(true)
  })

  test('offset reaches entries past the first page', async () => {
    // Without an offset the rows beyond the limit are unreachable from the UI
    // entirely — the counter would say "100 of 500" and stop there.
    for (let i = 0; i < 5; i++) auditWrite('bot', `action-${i}`, 't', 'read')

    const { body: page1 } = await get<{ entries: AuditEntry[]; total: number }>(
      '/api/audit?limit=2',
    )
    const { body: page2 } = await get<{ entries: AuditEntry[] }>('/api/audit?limit=2&offset=2')

    expect(page1.total).toBe(5)
    expect(page1.entries.map((e) => e.action)).toEqual(['action-4', 'action-3'])
    expect(page2.entries.map((e) => e.action)).toEqual(['action-2', 'action-1'])
  })

  test('entries carry the full date, not only HH:MM', async () => {
    auditWrite('bot', 'An action', 't', 'read')

    const { body } = await get<{ entries: AuditEntry[] }>('/api/audit')
    expect(body.entries[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('the actor list ignores the active filter', async () => {
    // Otherwise the dropdown would shrink to the selected actor and the filter
    // could never be widened back out.
    writeSample()

    const { body } = await get<{ actors: string[] }>('/api/audit?actor=collector')
    expect(body.actors).toEqual(['collector', 'skill:postgres-backup'])
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
