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
  Project,
  Server,
  Skill,
  ToolCard,
  ToolChaqiruv,
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
// Loyihalar
// ---------------------------------------------------------------------------

interface LoyihaQator {
  id: string
  name: string
  papka: string
  created_at: string
}

function loyihaQatordan(q: LoyihaQator, chatlarSoni?: number): Project {
  return {
    id: q.id,
    name: q.name,
    papka: q.papka,
    createdAt: q.created_at,
    chatlarSoni,
  }
}

/**
 * Barcha loyihalar, har biriga ulangan chatlar soni bilan.
 *
 * `LEFT JOIN`: chati yo'q loyiha ham ro'yxatda ko'rinadi (0 bilan).
 */
export function loyihalarOqi(baza?: Database): Project[] {
  const d = baza ?? globalDb()
  return d
    .query<LoyihaQator & { chatlar: number }, []>(
      `SELECT p.*, COUNT(s.id) AS chatlar
         FROM projects p
         LEFT JOIN chat_sessions s ON s.project_id = p.id
        GROUP BY p.id
        ORDER BY p.created_at DESC`,
    )
    .all()
    .map((q) => loyihaQatordan(q, q.chatlar))
}

export function loyihaOqi(id: string, baza?: Database): Project | null {
  const d = baza ?? globalDb()
  const q = d.query<LoyihaQator, [string]>('SELECT * FROM projects WHERE id = ?').get(id)
  return q ? loyihaQatordan(q) : null
}

/** Nom bo'yicha izlash — takroriy nomni oldindan ushlash uchun */
export function loyihaNomBoyicha(name: string, baza?: Database): Project | null {
  const d = baza ?? globalDb()
  const q = d.query<LoyihaQator, [string]>('SELECT * FROM projects WHERE name = ?').get(name)
  return q ? loyihaQatordan(q) : null
}

/**
 * Loyiha yozuvini yaratadi. Papkani chaqiruvchi (route) yaratadi va to'liq
 * yo'lini beradi — bu qatlam fayl tizimiga tegmaydi.
 *
 * Nom takrorlansa UNIQUE indeks xato tashlaydi; route uni 409 ga aylantiradi.
 */
export function loyihaYarat(name: string, papka: string, baza?: Database): Project {
  const d = baza ?? globalDb()
  const loyiha: Project = {
    id: crypto.randomUUID(),
    name,
    papka,
    createdAt: new Date().toISOString(),
    chatlarSoni: 0,
  }
  d.prepare('INSERT INTO projects (id, name, papka, created_at) VALUES (?, ?, ?, ?)').run(
    loyiha.id,
    loyiha.name,
    loyiha.papka,
    loyiha.createdAt,
  )
  return loyiha
}

/**
 * Sessiya ulangan loyihaning papkasi. Sessiya loyihasiz bo'lsa (yoki umuman
 * yo'q bo'lsa) `null` — chaqiruvchi sessiya papkasiga qaytadi.
 *
 * Bitta SQL bilan: orchestrator har javob oqizishda chaqiradi, ikkita
 * so'rov ortiqcha.
 */
export function sessiyaLoyihaPapkasi(sessionId: string, baza?: Database): string | null {
  const d = baza ?? globalDb()
  const q = d
    .query<{ papka: string }, [string]>(
      `SELECT p.papka AS papka
         FROM chat_sessions s
         JOIN projects p ON p.id = s.project_id
        WHERE s.id = ?`,
    )
    .get(sessionId)
  return q?.papka ?? null
}

// ---------------------------------------------------------------------------
// Chat sessiyalari
// ---------------------------------------------------------------------------

interface SessiyaQator {
  id: string
  title: string
  provider: string | null
  model: string | null
  project_id: string | null
  created_at: string
  updated_at: string
}

function sessiyaQatordan(q: SessiyaQator): ChatSession {
  return {
    id: q.id,
    title: q.title,
    provider: q.provider ?? undefined,
    model: q.model ?? undefined,
    projectId: q.project_id ?? undefined,
    createdAt: q.created_at,
    updatedAt: q.updated_at,
  }
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

/**
 * Yangi sessiya. `projectId` berilsa sessiya loyihaga ulanadi — agent
 * tool'lari o'sha loyihaning papkasida ishlaydi.
 *
 * Loyiha MAVJUDLIGI bu yerda tekshirilmaydi: route qatlami tekshirib,
 * foydalanuvchiga tushunarli xato beradi. Bazada baribir foreign key bor,
 * ya'ni yo'q loyiha bilan yozuv hosil bo'lmaydi.
 */
export function sessiyaYarat(
  title?: string,
  baza?: Database,
  projectId?: string,
): ChatSession {
  const d = baza ?? globalDb()
  const hozir = new Date().toISOString()
  const sessiya: ChatSession = {
    id: crypto.randomUUID(),
    title: title?.trim() || 'Yangi suhbat',
    projectId,
    createdAt: hozir,
    updatedAt: hozir,
  }
  d.prepare(
    'INSERT INTO chat_sessions (id, title, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sessiya.id, sessiya.title, projectId ?? null, sessiya.createdAt, sessiya.updatedAt)
  return sessiya
}

/**
 * Sessiyaning modelini qulflaydi — faqat BIRINCHI marta yozadi.
 *
 * `WHERE provider IS NULL` sharti poyga holatini oldini oladi: bir vaqtda
 * ikkita xabar kelsa, ikkinchisi mavjud providerni almashtira olmaydi.
 * Qaytish qiymati: yozildimi (true) yoki allaqachon qulflangan (false).
 */
export function sessiyaModelQulfla(
  id: string,
  provider: string,
  model: string,
  baza?: Database,
): boolean {
  const d = baza ?? globalDb()
  const natija = d
    .prepare('UPDATE chat_sessions SET provider = ?, model = ? WHERE id = ? AND provider IS NULL')
    .run(provider, model, id)
  return natija.changes > 0
}

/**
 * Sessiya ichida modelni almashtiradi (provider O'ZGARMAYDI).
 * Bir provider ichida modelni almashtirish xavfsiz — kontekst formati bir xil.
 */
export function sessiyaModelniOzgart(id: string, model: string, baza?: Database): void {
  const d = baza ?? globalDb()
  d.prepare('UPDATE chat_sessions SET model = ? WHERE id = ?').run(model, id)
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
  tool_cards: string | null
  agent_messages: string | null
  context_tokens: number | null
  created_at: string
}

function xabarQatordan(q: XabarQator): ChatMessage {
  return {
    id: q.id,
    sessionId: q.session_id,
    role: q.role,
    text: q.text,
    toolCard: q.tool_card ? (JSON.parse(q.tool_card) as ToolCard) : undefined,
    toolCards: q.tool_cards ? (JSON.parse(q.tool_cards) as ToolChaqiruv[]) : undefined,
    // Buzuq JSON butun sessiyani o'qib bo'lmaydigan qilmasin: bu ustun
    // faqat LLM konteksti uchun, u yo'qolsa suhbat `text` bilan davom etadi.
    agentMessages: jsonOqi(q.agent_messages),
    contextTokens: q.context_tokens ?? undefined,
    createdAt: q.created_at,
  }
}

/** Xom JSON ustunini o'qiydi. Buzuq bo'lsa `undefined` — xato tashlamaydi. */
function jsonOqi(xom: string | null): unknown[] | undefined {
  if (!xom) return undefined
  try {
    const tahlil = JSON.parse(xom) as unknown
    return Array.isArray(tahlil) ? tahlil : undefined
  } catch {
    return undefined
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
    toolCards: xabar.toolCards,
    agentMessages: xabar.agentMessages,
    contextTokens: xabar.contextTokens,
    createdAt: xabar.createdAt ?? new Date().toISOString(),
  }

  d.prepare(
    `INSERT INTO chat_messages
       (id, session_id, role, text, tool_card, tool_cards, agent_messages, context_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    toliq.id,
    toliq.sessionId,
    toliq.role,
    toliq.text,
    toliq.toolCard ? JSON.stringify(toliq.toolCard) : null,
    toliq.toolCards?.length ? JSON.stringify(toliq.toolCards) : null,
    toliq.agentMessages?.length ? JSON.stringify(toliq.agentMessages) : null,
    toliq.contextTokens ?? null,
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
