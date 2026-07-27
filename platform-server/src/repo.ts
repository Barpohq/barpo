// Baza bilan ishlash qatlami — SQL faqat shu yerda (va audit.ts da) yoziladi.
// Route fayllari SQL yozmaydi, shu funksiyalarni chaqiradi. Sabab: jadval
// sxemasi o'zgarganda bitta joy tahrirlansa yetadi.

import type { Database } from 'bun:sqlite'
import type {
  AppManifest,
  AppRecord,
  BuildSession,
  BuildSessionStatus,
  ChatMessage,
  ChatSession,
  Server,
  Skill,
  ToolCard,
} from '@platforma/shared'
import { db as globalDb } from './db.ts'

// ---------------------------------------------------------------------------
// Serverlar
// ---------------------------------------------------------------------------

interface ServerQator {
  id: string
  name: string
  role: string
  region: string
  status: Server['status']
  cpu: number
  ram: number
  disk: number
  daemon: string
  uptime: string
  note: string | null
}

export function serverlarOqi(baza?: Database): Server[] {
  const d = baza ?? globalDb()
  return d
    .query<ServerQator, []>('SELECT * FROM servers ORDER BY rowid')
    .all()
    .map((q) => ({ ...q, note: q.note ?? undefined }))
}

// ---------------------------------------------------------------------------
// Skilllar
// ---------------------------------------------------------------------------

interface SkillQator {
  id: string
  name: string
  desc: string
  version: string
  installed: number
  category: string
  permissions: string
}

export function skilllarOqi(baza?: Database): Skill[] {
  const d = baza ?? globalDb()
  return d
    .query<SkillQator, []>('SELECT * FROM skills ORDER BY rowid')
    .all()
    .map((q) => ({
      id: q.id,
      name: q.name,
      desc: q.desc,
      version: q.version,
      installed: q.installed === 1,
      category: q.category,
      permissions: JSON.parse(q.permissions) as Skill['permissions'],
    }))
}

// ---------------------------------------------------------------------------
// Ilovalar
// ---------------------------------------------------------------------------

interface AppQator {
  id: string
  manifest: string
  status: AppRecord['status']
  created_at: string
  updated_at: string
}

function appQatordan(q: AppQator): AppRecord {
  return {
    id: q.id,
    manifest: JSON.parse(q.manifest) as AppManifest,
    status: q.status,
    createdAt: q.created_at,
    updatedAt: q.updated_at,
  }
}

export function ilovalarOqi(baza?: Database): AppRecord[] {
  const d = baza ?? globalDb()
  return d.query<AppQator, []>('SELECT * FROM apps ORDER BY created_at').all().map(appQatordan)
}

export function ilovaOqi(id: string, baza?: Database): AppRecord | null {
  const d = baza ?? globalDb()
  const q = d.query<AppQator, [string]>('SELECT * FROM apps WHERE id = ?').get(id)
  return q ? appQatordan(q) : null
}

/**
 * Manifestni yozadi yoki yangilaydi (upsert). Yangi ilova o'rnatilganda ham,
 * mavjudi yangilanganda ham shu funksiya ishlatiladi — qaysi biri bo'lganini
 * qaytariladigan `yangi` bayrog'i aytadi (WS eventini tanlash uchun kerak).
 */
export function ilovaSaqla(
  manifest: AppManifest,
  baza?: Database,
): { record: AppRecord; yangi: boolean } {
  const d = baza ?? globalDb()
  const hozir = new Date().toISOString()
  const mavjud = ilovaOqi(manifest.id, d)

  if (mavjud) {
    d.prepare('UPDATE apps SET manifest = ?, status = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(manifest),
      manifest.status,
      hozir,
      manifest.id,
    )
    return {
      record: { ...mavjud, manifest, status: manifest.status, updatedAt: hozir },
      yangi: false,
    }
  }

  d.prepare('INSERT INTO apps (id, manifest, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    manifest.id,
    JSON.stringify(manifest),
    manifest.status,
    hozir,
    hozir,
  )
  return {
    record: { id: manifest.id, manifest, status: manifest.status, createdAt: hozir, updatedAt: hozir },
    yangi: true,
  }
}

// ---------------------------------------------------------------------------
// Chat sessiyalari
// ---------------------------------------------------------------------------

interface SessiyaQator {
  id: string
  title: string
  created_at: string
  updated_at: string
}

function sessiyaQatordan(q: SessiyaQator): ChatSession {
  return { id: q.id, title: q.title, createdAt: q.created_at, updatedAt: q.updated_at }
}

export function sessiyalarOqi(baza?: Database): ChatSession[] {
  const d = baza ?? globalDb()
  return d
    .query<SessiyaQator, []>('SELECT * FROM chat_sessions ORDER BY updated_at DESC')
    .all()
    .map(sessiyaQatordan)
}

export function sessiyaOqi(id: string, baza?: Database): ChatSession | null {
  const d = baza ?? globalDb()
  const q = d.query<SessiyaQator, [string]>('SELECT * FROM chat_sessions WHERE id = ?').get(id)
  return q ? sessiyaQatordan(q) : null
}

export function sessiyaYarat(title?: string, baza?: Database): ChatSession {
  const d = baza ?? globalDb()
  const hozir = new Date().toISOString()
  const sessiya: ChatSession = {
    id: crypto.randomUUID(),
    title: title?.trim() || 'Yangi suhbat',
    createdAt: hozir,
    updatedAt: hozir,
  }
  d.prepare('INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    sessiya.id,
    sessiya.title,
    sessiya.createdAt,
    sessiya.updatedAt,
  )
  return sessiya
}

// ---------------------------------------------------------------------------
// Chat xabarlari
// ---------------------------------------------------------------------------

interface XabarQator {
  id: string
  session_id: string
  role: ChatMessage['role']
  text: string
  tool_card: string | null
  created_at: string
}

function xabarQatordan(q: XabarQator): ChatMessage {
  return {
    id: q.id,
    sessionId: q.session_id,
    role: q.role,
    text: q.text,
    toolCard: q.tool_card ? (JSON.parse(q.tool_card) as ToolCard) : undefined,
    createdAt: q.created_at,
  }
}

export function xabarlarOqi(sessionId: string, baza?: Database): ChatMessage[] {
  const d = baza ?? globalDb()
  return d
    .query<XabarQator, [string]>(
      'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at, rowid',
    )
    .all(sessionId)
    .map(xabarQatordan)
}

export function xabarYoz(
  xabar: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
  baza?: Database,
): ChatMessage {
  const d = baza ?? globalDb()
  const toliq: ChatMessage = {
    id: xabar.id ?? crypto.randomUUID(),
    sessionId: xabar.sessionId,
    role: xabar.role,
    text: xabar.text,
    toolCard: xabar.toolCard,
    createdAt: xabar.createdAt ?? new Date().toISOString(),
  }

  d.prepare(
    `INSERT INTO chat_messages (id, session_id, role, text, tool_card, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    toliq.id,
    toliq.sessionId,
    toliq.role,
    toliq.text,
    toliq.toolCard ? JSON.stringify(toliq.toolCard) : null,
    toliq.createdAt,
  )

  // Sessiya "oxirgi faollik" vaqti yangilanadi — ro'yxat shu bo'yicha saralanadi
  d.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(toliq.createdAt, toliq.sessionId)

  return toliq
}

// ---------------------------------------------------------------------------
// Qurilish sessiyalari — skeleton, keyingi bosqichda orchestrator to'ldiradi
// ---------------------------------------------------------------------------

interface BuildQator {
  id: string
  app_id: string
  session_id: string | null
  status: BuildSessionStatus
  error: string | null
  created_at: string
  updated_at: string
}

function buildQatordan(q: BuildQator): BuildSession {
  return { id: q.id, appId: q.app_id, status: q.status, createdAt: q.created_at }
}

export function buildYarat(
  appId: string,
  sessionId: string | null = null,
  baza?: Database,
): BuildSession {
  const d = baza ?? globalDb()
  const hozir = new Date().toISOString()
  const id = crypto.randomUUID()
  d.prepare(
    `INSERT INTO build_sessions (id, app_id, session_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?)`,
  ).run(id, appId, sessionId, hozir, hozir)
  return { id, appId, status: 'running', createdAt: hozir }
}

export function buildHolatiOzgart(
  id: string,
  status: BuildSessionStatus,
  error?: string,
  baza?: Database,
): void {
  const d = baza ?? globalDb()
  d.prepare('UPDATE build_sessions SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(
    status,
    error ?? null,
    new Date().toISOString(),
    id,
  )
}

export function buildOqi(id: string, baza?: Database): BuildSession | null {
  const d = baza ?? globalDb()
  const q = d.query<BuildQator, [string]>('SELECT * FROM build_sessions WHERE id = ?').get(id)
  return q ? buildQatordan(q) : null
}
