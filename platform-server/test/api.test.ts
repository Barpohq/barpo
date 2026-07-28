// REST endpoint testlari — Hono `app.request` orqali, tarmoqsiz.
// Har testdan oldin toza xotira bazasi ochiladi va seed qo'llanadi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { AppManifest, AuditEntry, ChatSession, Server, Skill } from '@platforma/shared'
import { app } from '../src/app.ts'
import { auditYoz } from '../src/audit.ts'
import { bazaOch, dbOrnat } from '../src/db.ts'
import { seedQol } from '../src/seed.ts'
import { hub } from '../src/ws/hub.ts'

let db: Database

beforeEach(() => {
  db = bazaOch(':memory:')
  dbOrnat(db)
  seedQol(db)
})

afterEach(() => {
  dbOrnat(null)
  hub.tozala()
  db.close()
})

/** Qisqartma: GET so'rov yuborib JSON qaytaradi */
async function get<T>(yol: string): Promise<{ status: number; body: T }> {
  const javob = await app.request(yol)
  return { status: javob.status, body: (await javob.json()) as T }
}

describe('GET /api/health', () => {
  test('ok:true va sxema versiyasini qaytaradi', async () => {
    const { status, body } = await get<{ ok: boolean; schema: number; wsClients: number }>('/api/health')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.schema).toBeGreaterThan(0)
    expect(typeof body.wsClients).toBe('number')
  })
})

describe('GET /api/servers', () => {
  test('seed dagi 5 serverni qaytaradi', async () => {
    const { status, body } = await get<{ servers: Server[] }>('/api/servers')
    expect(status).toBe(200)
    expect(body.servers).toHaveLength(5)

    const helsinki = body.servers.find((s) => s.id === 'helsinki-1')
    expect(helsinki?.status).toBe('warning')
    expect(helsinki?.disk).toBe(84)
    expect(helsinki?.note).toContain('models_cache')
  })

  test('note yo\'q serverda maydon undefined bo\'ladi', async () => {
    const { body } = await get<{ servers: Server[] }>('/api/servers')
    const frankfurt = body.servers.find((s) => s.id === 'frankfurt-1')
    expect(frankfurt?.note).toBeUndefined()
  })
})

describe('GET /api/skills', () => {
  test('skilllar ro\'yxati ruxsatlari bilan qaytadi', async () => {
    const { status, body } = await get<{ skills: Skill[] }>('/api/skills')
    expect(status).toBe(200)
    expect(body.skills).toHaveLength(7)

    const fastapi = body.skills.find((s) => s.id === 'fastapi-deploy')
    expect(fastapi?.installed).toBe(true)
    expect(fastapi?.permissions.length).toBe(3)
    expect(fastapi?.permissions.some((p) => p.level === 'xavfli')).toBe(true)
  })

  test("o'rnatilmagan skill installed:false bo'ladi", async () => {
    const { body } = await get<{ skills: Skill[] }>('/api/skills')
    expect(body.skills.find((s) => s.id === 'rust-deploy')?.installed).toBe(false)
  })
})

describe('GET /api/apps', () => {
  test('manifestlar ro\'yxatini qaytaradi', async () => {
    const { status, body } = await get<{ apps: AppManifest[] }>('/api/apps')
    expect(status).toBe(200)
    expect(body.apps).toHaveLength(1)
    expect(body.apps[0]?.id).toBe('ai-news-bot')
    expect(body.apps[0]?.widgets.length).toBe(4)
  })

  test('bitta ilova manifesti id bo\'yicha olinadi', async () => {
    const { status, body } = await get<{ manifest: AppManifest }>('/api/apps/ai-news-bot')
    expect(status).toBe(200)
    expect(body.manifest.name).toBe('ai-news-bot')
    expect(body.manifest.widgets[0]?.type).toBe('stats')
  })

  test('mavjud bo\'lmagan ilova 404 beradi', async () => {
    const { status } = await get('/api/apps/yoq-bunday-ilova')
    expect(status).toBe(404)
  })
})

describe('GET /api/audit', () => {
  test('seed audit yozuvlari qaytadi', async () => {
    const { status, body } = await get<{ entries: AuditEntry[]; total: number }>('/api/audit')
    expect(status).toBe(200)
    expect(body.total).toBe(12)
    expect(body.entries).toHaveLength(12)
  })

  test('level filtri ishlaydi', async () => {
    const { body } = await get<{ entries: AuditEntry[]; total: number }>('/api/audit?level=xavfli')
    expect(body.total).toBe(1)
    expect(body.entries[0]?.action).toContain('DROP TABLE')
  })

  test('actor filtri va limit birga ishlaydi', async () => {
    const { body } = await get<{ entries: AuditEntry[]; total: number }>(
      '/api/audit?actor=ai-news-bot&limit=2',
    )
    expect(body.total).toBe(4)
    expect(body.entries).toHaveLength(2)
    expect(body.entries.every((e) => e.actor === 'ai-news-bot')).toBe(true)
  })

  test("auditYoz bilan yozilgan yangi yozuv endpointda ko'rinadi", async () => {
    auditYoz('sinov-aktor', 'Yangi amal', 'nishon', "o'zgartirish", 'tasdiqlandi')

    const { body } = await get<{ entries: AuditEntry[] }>('/api/audit?actor=sinov-aktor')
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]?.result).toBe('tasdiqlandi')
  })

  test("noto'g'ri limit 400 beradi", async () => {
    const { status } = await get('/api/audit?limit=abc')
    expect(status).toBe(400)
  })
})

describe('chat endpointlari', () => {
  test('sessiya yaratiladi va ro\'yxatda ko\'rinadi', async () => {
    const yaratish = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Birinchi suhbat' }),
    })
    expect(yaratish.status).toBe(201)
    const { session } = (await yaratish.json()) as { session: ChatSession }
    expect(session.title).toBe('Birinchi suhbat')
    expect(session.id).toBeTruthy()

    const { body } = await get<{ sessions: ChatSession[] }>('/api/chat/sessions')
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]?.id).toBe(session.id)
  })

  test('tanasiz POST ham ishlaydi (avtomatik sarlavha)', async () => {
    const javob = await app.request('/api/chat/sessions', { method: 'POST' })
    expect(javob.status).toBe(201)
    const { session } = (await javob.json()) as { session: ChatSession }
    expect(session.title).toBe('Yangi suhbat')
  })

  test('yangi sessiyada xabarlar bo\'sh', async () => {
    const javob = await app.request('/api/chat/sessions', { method: 'POST' })
    const { session } = (await javob.json()) as { session: ChatSession }

    const { status, body } = await get<{ messages: unknown[] }>(
      `/api/chat/sessions/${session.id}/messages`,
    )
    expect(status).toBe(200)
    expect(body.messages).toHaveLength(0)
  })

  test('mavjud bo\'lmagan sessiya xabarlari 404', async () => {
    const { status } = await get('/api/chat/sessions/yoq-bunday/messages')
    expect(status).toBe(404)
  })

  test('POST /api/chat/send mavjud bo\'lmagan sessiyaga 404', async () => {
    const javob = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'yoq-bunday',
        text: 'salom',
        model: { provider: 'ollama', model: 'test' },
      }),
    })
    expect(javob.status).toBe(404)
    const tana = (await javob.json()) as { error: string }
    expect(tana.error).toContain('Sessiya')
  })
})

describe('umumiy xatti-harakat', () => {
  test("noma'lum yo'l 404 JSON qaytaradi", async () => {
    const javob = await app.request('/api/bunday-yol-yoq')
    expect(javob.status).toBe(404)
    const tana = (await javob.json()) as { error: string }
    expect(tana.error).toBe('Topilmadi')
  })
})
