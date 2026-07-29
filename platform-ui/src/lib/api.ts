// Backend REST API bilan ishlash — yupqa `fetch` qatlami.
//
// Manzillar nisbiy (`/api/...`): dev'da vite proxy, prodda bitta jarayon
// — ikkalasida ham bir xil yo'l ishlaydi.
//
// Server xatolari `{ error, detail? }` shaklida keladi; `ApiXatosi` shu
// ma'lumotni statusi bilan birga saqlaydi, chaqiruvchi 409 (provider qulfi)
// kabi holatlarni ajrata olsin.

import type {
  AniqlashOgohlantirish,
  ChatMessage,
  ChatSession,
  ModelInfo,
  Project,
  ProviderInfo,
  RejimHolati,
  RuxsatJavobi,
  RuxsatRejimi,
  Server,
  ServerMetrika,
  Skill,
  SkillManba,
  SkillQamrov,
} from '@platforma/shared'

export class ApiXatosi extends Error {
  status: number
  detail?: string

  constructor(status: number, xabar: string, detail?: string) {
    super(xabar)
    this.name = 'ApiXatosi'
    this.status = status
    this.detail = detail
  }
}

async function sorov<T>(yol: string, sozlama?: RequestInit): Promise<T> {
  let javob: Response
  try {
    javob = await fetch(yol, sozlama)
  } catch (xato) {
    throw new ApiXatosi(0, "Serverga ulanib bo'lmadi", xato instanceof Error ? xato.message : undefined)
  }

  const matn = await javob.text()
  let tana: unknown
  try {
    tana = matn ? JSON.parse(matn) : {}
  } catch {
    throw new ApiXatosi(javob.status, 'Server javobini o\'qib bo\'lmadi', matn.slice(0, 200))
  }

  if (!javob.ok) {
    const x = tana as { error?: string; detail?: string }
    throw new ApiXatosi(javob.status, x.error ?? `Xato ${javob.status}`, x.detail)
  }
  return tana as T
}

const jsonSarlavha = { 'content-type': 'application/json' }

// ---------------------------------------------------------------------------
// Modellar
// ---------------------------------------------------------------------------

export interface ModellarJavobi {
  models: ModelInfo[]
  providers: ProviderInfo[]
  ogohlantirishlar: AniqlashOgohlantirish[]
  vaqt: string
}

export function modellarOl(): Promise<ModellarJavobi> {
  return sorov<ModellarJavobi>('/api/models')
}

export function modellarniYangila(): Promise<ModellarJavobi> {
  return sorov<ModellarJavobi>('/api/models/refresh', { method: 'POST' })
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * Yangi sessiya. `projectId` berilsa suhbat loyihaga ulanadi va agent
 * tool'lari loyiha papkasida ishlaydi.
 */
export async function sessiyaYarat(title?: string, projectId?: string): Promise<ChatSession> {
  const javob = await sorov<{ session: ChatSession }>('/api/chat/sessions', {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify({ title, projectId }),
  })
  return javob.session
}

/**
 * Barcha suhbatlar — oxirgi faollik bo'yicha (yangisi birinchi).
 *
 * Har bir yozuvda `xabarlarSoni` bor: UI bo'sh suhbatlarni ajratadi.
 */
export async function sessiyalarOl(): Promise<ChatSession[]> {
  const javob = await sorov<{ sessions: ChatSession[] }>('/api/chat/sessions')
  return javob.sessions
}

/** Suhbat nomini o'zgartiradi. Faqat sarlavha — model va loyiha qulflangan. */
export async function sessiyaSarlavhaOzgart(
  sessionId: string,
  title: string,
): Promise<ChatSession> {
  const javob = await sorov<{ session: ChatSession }>(`/api/chat/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: jsonSarlavha,
    body: JSON.stringify({ title }),
  })
  return javob.session
}

/**
 * Suhbatni o'chiradi — xabarlari bilan birga, qaytarib bo'lmaydi.
 *
 * Oqim ketayotgan bo'lsa server uni avval to'xtatadi.
 */
export function sessiyaOchir(
  sessionId: string,
): Promise<{ ochirildi: boolean; oqimToxtatildi: boolean }> {
  return sorov<{ ochirildi: boolean; oqimToxtatildi: boolean }>(
    `/api/chat/sessions/${sessionId}`,
    { method: 'DELETE' },
  )
}

/**
 * Bitta sessiya — URL'dan tiklash uchun.
 *
 * `null` qaytadi (throw emas) agar sessiya topilmasa: URL eskirgan yoki
 * noto'g'ri bo'lishi oddiy holat, chaqiruvchi shunchaki bo'sh chatga tushadi.
 */
export async function sessiyaOl(sessionId: string): Promise<ChatSession | null> {
  try {
    const javob = await sorov<{ session: ChatSession }>(`/api/chat/sessions/${sessionId}`)
    return javob.session
  } catch {
    return null
  }
}

export async function xabarlarOl(sessionId: string): Promise<ChatMessage[]> {
  const javob = await sorov<{ messages: ChatMessage[] }>(`/api/chat/sessions/${sessionId}/messages`)
  return javob.messages
}

export interface YuborishJavobi {
  messageId: string
  model: { provider: string; model: string }
}

export function xabarYubor(
  sessionId: string,
  text: string,
  model: { provider: string; model: string },
): Promise<YuborishJavobi> {
  return sorov<YuborishJavobi>('/api/chat/send', {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify({ sessionId, text, model }),
  })
}

export function ruxsatJavobiYubor(
  sessionId: string,
  sorovId: string,
  javob: RuxsatJavobi,
): Promise<{ qabulQilindi: boolean }> {
  return sorov<{ qabulQilindi: boolean }>('/api/chat/permission', {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify({ sessionId, sorovId, javob }),
  })
}

export async function rejimOl(sessionId: string): Promise<RejimHolati> {
  const javob = await sorov<{ holat: RejimHolati }>(`/api/chat/sessions/${sessionId}/rejim`)
  return javob.holat
}

export async function rejimOrnat(
  sessionId: string,
  rejim: RuxsatRejimi,
): Promise<RejimHolati> {
  const javob = await sorov<{ holat: RejimHolati }>(`/api/chat/sessions/${sessionId}/rejim`, {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify({ rejim }),
  })
  return javob.holat
}

/** Hozir agent oqimi ketayotgan bitta sessiya */
export interface IshlayotganSessiya {
  sessionId: string
  holat: 'ishlayapti' | 'ruxsat-kutmoqda'
  /** Sessiya sarlavhasi — sessiya o'chirilgan bo'lsa yo'q */
  title?: string
}

/**
 * Ishlayotgan sessiyalarning boshlang'ich ro'yxati.
 *
 * Faqat sahifa ochilganda kerak: undan keyin ro'yxat `chat.status` WS
 * eventlari bilan yangilanadi. Ikkalasi ham kerak, chunki WS ulanishidan
 * oldingi holat o'zgarishlari mijozga yetib bormaydi.
 */
export async function ishlayotganlarniOl(): Promise<IshlayotganSessiya[]> {
  const javob = await sorov<{ running: IshlayotganSessiya[] }>('/api/chat/running')
  return javob.running
}

export function oqimniToxtat(sessionId: string): Promise<{ toxtatildi: boolean }> {
  return sorov<{ toxtatildi: boolean }>('/api/chat/stop', {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify({ sessionId }),
  })
}

// ---------------------------------------------------------------------------
// Loyihalar
// ---------------------------------------------------------------------------

export async function loyihalarOl(): Promise<Project[]> {
  const javob = await sorov<{ projects: Project[] }>('/api/projects')
  return javob.projects
}

/**
 * Yangi loyiha. Faqat nom yuboriladi — papkani server o'zi yaratadi
 * (`~/.platforma/loyihalar/<slug>/`), mijoz yo'l bera olmaydi.
 */
export async function loyihaYarat(name: string): Promise<Project> {
  const javob = await sorov<{ project: Project }>('/api/projects', {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify({ name }),
  })
  return javob.project
}

// ---------------------------------------------------------------------------
// Skilllar
// ---------------------------------------------------------------------------

export interface SkillKatalogi {
  skills: Skill[]
  manbalar: SkillManba[]
}

export function skilllarniOl(): Promise<SkillKatalogi> {
  return sorov<SkillKatalogi>('/api/skills')
}

export interface ManbaNatija {
  manba: SkillManba
  qoshildi: number
  yangilandi: number
  ochirildi: number
  ogohlantirishlar: string[]
}

/** GitHub repo ulash — skilllar katalogga tushadi, DISKKA YUKLANMAYDI */
export function manbaQosh(url: string): Promise<ManbaNatija> {
  return sorov<ManbaNatija>('/api/skills/manba', {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify({ url }),
  })
}

export function manbaSinxronla(
  id: string,
): Promise<Omit<ManbaNatija, 'manba'>> {
  return sorov<Omit<ManbaNatija, 'manba'>>(`/api/skills/manba/${id}/sinxron`, {
    method: 'POST',
  })
}

export function manbaOchir(id: string): Promise<{ ok: boolean }> {
  return sorov<{ ok: boolean }>(`/api/skills/manba/${id}`, { method: 'DELETE' })
}

/**
 * Skillni o'rnatadi. `qamrov: 'loyiha'` bo'lsa `projectIds` majburiy —
 * bir chaqiruvda bir necha loyihaga o'rnatish mumkin.
 */
export async function skillOrnat(
  id: string,
  qamrov: SkillQamrov,
  projectIds?: string[],
): Promise<Skill> {
  const javob = await sorov<{ skill: Skill }>(`/api/skills/${id}/ornat`, {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify({ qamrov, projectIds }),
  })
  return javob.skill
}

export async function skillOrnatishniBekor(
  id: string,
  qamrov: SkillQamrov,
  projectIds?: string[],
): Promise<Skill | null> {
  const javob = await sorov<{ skill: Skill | null }>(`/api/skills/${id}/ornat`, {
    method: 'DELETE',
    headers: jsonSarlavha,
    body: JSON.stringify({ qamrov, projectIds }),
  })
  return javob.skill
}

// ---------------------------------------------------------------------------
// Serverlar
// ---------------------------------------------------------------------------

export function serverlarOl(): Promise<{ servers: Server[] }> {
  return sorov<{ servers: Server[] }>('/api/servers')
}

/**
 * Server qo'shadi: backend platforma kalitini serverga joylaydi va
 * `ssh <name>` ishlaydigan holatga keltiradi. `parol` ixtiyoriy — mavjud
 * kalitlaringiz serverga kira olsa kerak emas; berilsa ham SAQLANMAYDI.
 */
export async function serverQosh(malumot: {
  name: string
  host: string
  port?: number | string
  username?: string
  parol?: string
}): Promise<{ server: Server; ulanishXatosi?: string }> {
  return sorov<{ server: Server; ulanishXatosi?: string }>('/api/servers', {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify(malumot),
  })
}

export function serverOchir(id: string): Promise<{ ok: boolean; eslatma?: string }> {
  return sorov<{ ok: boolean; eslatma?: string }>(`/api/servers/${id}`, { method: 'DELETE' })
}

export function serverMetrikaOl(id: string): Promise<{ metrika: ServerMetrika }> {
  return sorov<{ metrika: ServerMetrika }>(`/api/servers/${id}/metrika`)
}
