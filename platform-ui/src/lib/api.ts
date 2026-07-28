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
