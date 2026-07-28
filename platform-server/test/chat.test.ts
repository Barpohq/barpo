// Chat oqimi: validatsiya, sessiya provider qulfi va migratsiya 002.
//
// LLM'ning o'zi chaqirilmaydi — tarmoqqa chiqmaydigan testlar. Haqiqiy oqim
// orchestrator.test.ts da soxta LLM bilan sinaladi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { ChatSession } from '@platforma/shared'
import { app } from '../src/app.ts'
import { bazaOch, dbOrnat } from '../src/db.ts'
import {
  sessiyaModelniOzgart,
  sessiyaModelQulfla,
  sessiyaOqi,
  sessiyaYarat,
  xabarlarOqi,
  xabarYoz,
} from '../src/repo.ts'
import { hub } from '../src/ws/hub.ts'

let db: Database

beforeEach(() => {
  db = bazaOch(':memory:')
  dbOrnat(db)
})

afterEach(() => {
  dbOrnat(null)
  hub.tozala()
  db.close()
})

async function yubor(tana: unknown): Promise<{ status: number; body: Record<string, string> }> {
  const javob = await app.request('/api/chat/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tana),
  })
  return { status: javob.status, body: (await javob.json()) as Record<string, string> }
}

describe('migratsiya 002 — sessiya modeli', () => {
  test('chat_sessions da provider va model ustunlari bor', () => {
    const ustunlar = db
      .query<{ name: string }, []>('PRAGMA table_info(chat_sessions)')
      .all()
      .map((u) => u.name)
    expect(ustunlar).toContain('provider')
    expect(ustunlar).toContain('model')
  })

  test('yangi sessiyada provider va model bo\'sh', () => {
    const s = sessiyaYarat('sinov', db)
    expect(s.provider).toBeUndefined()
    expect(s.model).toBeUndefined()
  })

  test('sessiyaModelQulfla faqat birinchi marta yozadi', () => {
    const s = sessiyaYarat('sinov', db)

    expect(sessiyaModelQulfla(s.id, 'ollama', 'qwen3:8b', db)).toBe(true)
    expect(sessiyaOqi(s.id, db)?.provider).toBe('ollama')

    // Ikkinchi urinish o'zgartirmaydi — poyga holatiga qarshi himoya
    expect(sessiyaModelQulfla(s.id, 'anthropic', 'claude-haiku-4-5', db)).toBe(false)
    expect(sessiyaOqi(s.id, db)?.provider).toBe('ollama')
  })

  test('sessiyaModelniOzgart providerni saqlab modelni almashtiradi', () => {
    const s = sessiyaYarat('sinov', db)
    sessiyaModelQulfla(s.id, 'ollama', 'qwen3:0.6b', db)
    sessiyaModelniOzgart(s.id, 'qwen3:8b', db)

    const yangilangan = sessiyaOqi(s.id, db)
    expect(yangilangan?.provider).toBe('ollama')
    expect(yangilangan?.model).toBe('qwen3:8b')
  })
})

describe('POST /api/chat/send — validatsiya', () => {
  test('JSON bo\'lmagan tana 400', async () => {
    const javob = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'bu json emas',
    })
    expect(javob.status).toBe(400)
  })

  test('sessionId yo\'q — 400', async () => {
    const { status, body } = await yubor({ text: 'salom' })
    expect(status).toBe(400)
    expect(body.error).toContain('sessionId')
  })

  test('bo\'sh matn — 400', async () => {
    const s = sessiyaYarat('sinov', db)
    const { status, body } = await yubor({ sessionId: s.id, text: '   ' })
    expect(status).toBe(400)
    expect(body.error).toContain("bo'sh")
  })

  test('mavjud bo\'lmagan sessiya — 404', async () => {
    const { status } = await yubor({
      sessionId: 'yoq-bunday',
      text: 'salom',
      model: { provider: 'ollama', model: 'x' },
    })
    expect(status).toBe(404)
  })

  test('birinchi xabarda model tanlanmagan — 400', async () => {
    const s = sessiyaYarat('sinov', db)
    const { status, body } = await yubor({ sessionId: s.id, text: 'salom' })
    expect(status).toBe(400)
    expect(body.error).toContain('Model')
  })
})

describe('POST /api/chat/send — provider qulfi', () => {
  test('qulflangan sessiyada boshqa provider 409 beradi', async () => {
    const s = sessiyaYarat('sinov', db)
    sessiyaModelQulfla(s.id, 'ollama', 'qwen3:0.6b', db)

    const { status, body } = await yubor({
      sessionId: s.id,
      text: 'salom',
      model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    })
    expect(status).toBe(409)
    expect(body.error).toContain("o'zgartirib bo'lmaydi")
    expect(body.detail).toContain('ollama')
  })
})

describe('migratsiya 003 — tool kartalari', () => {
  test('chat_messages da tool_cards ustuni bor', () => {
    const ustunlar = db
      .query<{ name: string }, []>('PRAGMA table_info(chat_messages)')
      .all()
      .map((u) => u.name)
    expect(ustunlar).toContain('tool_cards')
    // Eski ustun ham joyida
    expect(ustunlar).toContain('tool_card')
  })

  test('tool kartalari yozilib qayta o\'qiladi', () => {
    const s = sessiyaYarat('sinov', db)
    xabarYoz(
      {
        sessionId: s.id,
        role: 'assistant',
        text: 'tayyor',
        toolCards: [
          { id: 't1', nom: 'read', args: 'a.txt', holat: 'tugadi', natija: 'salom' },
          { id: 't2', nom: 'bash', args: 'ls', holat: 'xato', natija: 'xato' },
        ],
      },
      db,
    )

    const xabarlar = xabarlarOqi(s.id, db)
    expect(xabarlar[0]?.toolCards).toHaveLength(2)
    expect(xabarlar[0]?.toolCards?.[0]?.nom).toBe('read')
    expect(xabarlar[0]?.toolCards?.[1]?.holat).toBe('xato')
  })

  test('tool kartasiz xabar undefined qaytaradi', () => {
    const s = sessiyaYarat('sinov', db)
    xabarYoz({ sessionId: s.id, role: 'user', text: 'salom' }, db)
    expect(xabarlarOqi(s.id, db)[0]?.toolCards).toBeUndefined()
  })
})

describe('POST /api/chat/permission', () => {
  test('noto\'g\'ri javob qiymati 400', async () => {
    const javob = await app.request('/api/chat/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', sorovId: 'r', javob: 'nimadir' }),
    })
    expect(javob.status).toBe(400)
  })

  test('sessionId yo\'q — 400', async () => {
    const javob = await app.request('/api/chat/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sorovId: 'r', javob: 'ruxsat' }),
    })
    expect(javob.status).toBe(400)
  })

  test('mavjud bo\'lmagan so\'rov 404', async () => {
    const javob = await app.request('/api/chat/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', sorovId: 'yoq-bunday', javob: 'ruxsat' }),
    })
    expect(javob.status).toBe(404)
  })
})

describe('GET /api/chat/sessions — model maydonlari', () => {
  test('qulflangan sessiya provider va modelni qaytaradi', async () => {
    const s = sessiyaYarat('sinov', db)
    sessiyaModelQulfla(s.id, 'openrouter', 'anthropic/claude-haiku-4.5', db)

    const javob = await app.request('/api/chat/sessions')
    const { sessions } = (await javob.json()) as { sessions: ChatSession[] }
    const topilgan = sessions.find((x) => x.id === s.id)

    expect(topilgan?.provider).toBe('openrouter')
    expect(topilgan?.model).toBe('anthropic/claude-haiku-4.5')
  })
})
