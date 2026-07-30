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
  AppManifest,
  ChatBiriktirma,
  ChatMessage,
  ChatSession,
  McpManba,
  McpQamrov,
  McpServer,
  McpSozlamaMaydoni,
  McpTransportTuri,
  ModelInfo,
  Project,
  ProviderInfo,
  RejimHolati,
  RuxsatJavobi,
  RuxsatRejimi,
  RuxsatSorovi,
  Server,
  ServerMetrika,
  Skill,
  SkillManba,
  SkillQamrov,
  SozlamaMaydoni,
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

/**
 * Xabar yuboradi. `biriktirmalar` — `biriktirmaYukla()` qaytargan ID'lar.
 *
 * Faqat ID yuboriladi: yo'l va turni server bazadan oladi (mijoz ularni
 * bersa ish papkasidan tashqariga ko'rsatishi yoki vision qorovulini
 * aldab o'tishi mumkin bo'lardi).
 */
export function xabarYubor(
  sessionId: string,
  text: string,
  model: { provider: string; model: string },
  biriktirmalar?: string[],
): Promise<YuborishJavobi> {
  return sorov<YuborishJavobi>('/api/chat/send', {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify({ sessionId, text, model, biriktirmalar }),
  })
}

/**
 * Chatga fayl yoki rasm biriktiradi.
 *
 * `content-type` ATAYLAB QO'YILMAYDI: FormData uchun brauzer uni
 * `multipart/form-data; boundary=...` bilan o'zi qo'yadi. Qo'lda qo'yilsa
 * boundary yo'qoladi va server tanani o'qiy olmaydi.
 *
 * `sessionId` majburiy — fayl darhol sessiya papkasiga tushadi. Chat sahifasi
 * shu sababli fayl tanlangan payt sessiyani yaratadi.
 */
export async function biriktirmaYukla(
  sessionId: string,
  fayllar: File[],
): Promise<ChatBiriktirma[]> {
  const tana = new FormData()
  tana.set('sessionId', sessionId)
  for (const f of fayllar) tana.append('fayl', f)

  const javob = await sorov<{ biriktirmalar: ChatBiriktirma[] }>('/api/chat/biriktirma', {
    method: 'POST',
    body: tana,
  })
  return javob.biriktirmalar
}

/**
 * Biriktirmani olib tashlaydi (chipdagi `×`).
 *
 * Xabarga allaqachon bog'langan biriktirma uchun server 409 beradi: u
 * suhbat tarixining qismi va agent uni ko'rgan.
 */
export function biriktirmaOchir(id: string): Promise<{ ochirildi: boolean }> {
  return sorov<{ ochirildi: boolean }>(`/api/chat/biriktirma/${id}`, { method: 'DELETE' })
}

/** Biriktirma mazmuni manzili — `<img src>` va yuklab olish uchun */
export function biriktirmaManzili(id: string): string {
  return `/api/chat/biriktirma/${id}`
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

/**
 * Sessiyada javob kutayotgan ruxsat so'rovlari.
 *
 * `chat.permission` WS eventiga QO'SHIMCHA yo'l: event bir marta yuboriladi
 * va yetib bormasligi mumkin (sahifa oqim o'rtasida ochilgan, WS qayta
 * ulanmoqda, sessiya filtri hali o'rnatilmagan). Shusiz agent javob kutib
 * turadi, foydalanuvchi esa nima kutilayotganini ko'rmaydi.
 */
export async function kutayotganRuxsatlarOl(sessionId: string): Promise<RuxsatSorovi[]> {
  const javob = await sorov<{ sorovlar: RuxsatSorovi[] }>(
    `/api/chat/sessions/${sessionId}/ruxsatlar`,
  )
  return javob.sorovlar
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
// Ilovalar (dinamik dashboardlar)
// ---------------------------------------------------------------------------

/**
 * Agent `appPublish` bilan chiqargan dashboardlar.
 *
 * Sidebar shu ro'yxatdan quriladi — mock ma'lumotdan emas. Manifest
 * server tomonida allaqachon tekshirilgan (`manifestniTekshir`), shuning
 * uchun bu yerda qayta tekshiruv kerak emas.
 */
export async function ilovalarOl(): Promise<AppManifest[]> {
  const javob = await sorov<{ apps: AppManifest[] }>('/api/apps')
  return javob.apps
}

// ---------------------------------------------------------------------------
// Ilova boshqaruvi — sozlamalar va amallar
// ---------------------------------------------------------------------------
//
// HAQIQAT MANBAI — SERVER. Qiymatlar serverdagi ilovaning o'z
// konfiguratsiyasiga yoziladi (`types.ts` dagi boshqaruv qatlami izohiga q.),
// shuning uchun sir qiymatlar HECH QACHON bu yerga kelmaydi — faqat
// `ornatilgan` bayrog'i.

export interface SozlamaHolati {
  maydonlar: SozlamaMaydoni[]
  /** Sirsiz joriy qiymatlar (serverdan o'qilgan) */
  qiymatlar: Record<string, string>
  /** Sir maydonlar uchun: kalit → serverda o'rnatilganmi */
  ornatilgan: Record<string, boolean>
  /** O'qish yiqilsa — sabab. Forma baribir ko'rsatiladi. */
  ogohlantirish?: string
}

export function ilovaSozlamalariniOl(appId: string): Promise<SozlamaHolati> {
  return sorov<SozlamaHolati>(`/api/apps/${encodeURIComponent(appId)}/sozlama`)
}

export interface SozlamaYozishJavobi {
  ok: boolean
  xabar?: string
  xato?: string
  /** Validatsiya xatolari (400) */
  xatolar?: string[]
}

/**
 * Qiymatlarni serverga yozadi.
 *
 * BO'SH SIR YUBORILMASIN: bo'sh satr "o'zgartirmadim" degani va server uni
 * tashlab ketadi, lekin uni umuman yubormaslik aniqroq.
 */
export function ilovaSozlamalariniSaqla(
  appId: string,
  qiymatlar: Record<string, string>,
): Promise<SozlamaYozishJavobi> {
  return sorov<SozlamaYozishJavobi>(`/api/apps/${encodeURIComponent(appId)}/sozlama`, {
    method: 'PUT',
    headers: jsonSarlavha,
    body: JSON.stringify({ qiymatlar }),
  })
}

export interface AmalJavobi {
  ok: boolean
  xabar?: string
  xato?: string
  /** Amal allaqachon bajarilib turgan edi — natija o'shanikidan */
  bandEdi?: boolean
  /** `yangila` da ko'rsatilgan statelarning yangi qiymatlari */
  statelar?: Record<string, { ok: boolean; qiymat?: unknown; xato?: string; vaqt: string }>
}

export function ilovaAmaliniBajar(appId: string, nom: string): Promise<AmalJavobi> {
  return sorov<AmalJavobi>(
    `/api/apps/${encodeURIComponent(appId)}/amal/${encodeURIComponent(nom)}`,
    { method: 'POST' },
  )
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
// MCP serverlar
// ---------------------------------------------------------------------------
//
// Skilllar bo'limi bilan bir xil shakl. IKKI FARQ:
//   - registry qidiruvi ALOHIDA bosqich (natija saqlanmaydi);
//   - `sozlamaQiymatlari` yuboriladi, lekin MAXFIY qiymatlar javobda
//     HECH QACHON qaytmaydi (server ularni umuman o'qimaydi).

export interface McpKatalogi {
  serverlar: McpServer[]
  manbalar: McpManba[]
}

export function mcpServerlarniOl(): Promise<McpKatalogi> {
  return sorov<McpKatalogi>('/api/mcp')
}

/** Registry qidiruv natijasi — hali katalogga tushmagan yozuv */
export interface McpRegistryNatija {
  nom: string
  tavsif: string
  transport: McpTransportTuri
  versiya: string | null
  sozlamalar: McpSozlamaMaydoni[]
}

/** Rasmiy registry'da qidiradi. HECH NARSA SAQLAMAYDI. */
export async function mcpRegistryQidir(soz: string): Promise<McpRegistryNatija[]> {
  const javob = await sorov<{ natijalar: McpRegistryNatija[] }>(
    `/api/mcp/registry/qidir?q=${encodeURIComponent(soz)}`,
  )
  return javob.natijalar
}

export interface McpManbaNatija {
  manba: McpManba
  qoshildi: number
  yangilandi: number
  ochirildi: number
  ogohlantirishlar?: string[]
}

/** Registry'dan tanlangan serverni katalogga qo'shadi */
export function mcpRegistryQosh(nom: string): Promise<McpManbaNatija> {
  return sorov<McpManbaNatija>('/api/mcp/manba/registry', {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify({ nom }),
  })
}

/** GitHub repo'dan `server.json` fayllarini skanerlaydi */
export function mcpGithubUlash(url: string): Promise<McpManbaNatija> {
  return sorov<McpManbaNatija>('/api/mcp/manba/github', {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify({ url }),
  })
}

export interface McpQoldaKirish {
  nom: string
  tavsif?: string
  transport: McpTransportTuri
  /** stdio uchun */
  buyruq?: string
  argumentlar?: string[]
  /** http uchun */
  url?: string
  sozlamalar?: McpSozlamaMaydoni[]
}

/** Qo'lda server qo'shish — buyruq yoki URL foydalanuvchidan */
export function mcpQoldaQosh(kirish: McpQoldaKirish): Promise<McpManbaNatija> {
  return sorov<McpManbaNatija>('/api/mcp/manba/qolda', {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify(kirish),
  })
}

export function mcpManbaSinxronla(id: string): Promise<Omit<McpManbaNatija, 'manba'>> {
  return sorov<Omit<McpManbaNatija, 'manba'>>(`/api/mcp/manba/${id}/sinxron`, {
    method: 'POST',
  })
}

export function mcpManbaOchir(id: string): Promise<{ ok: boolean }> {
  return sorov<{ ok: boolean }>(`/api/mcp/manba/${id}`, { method: 'DELETE' })
}

/**
 * Serverni o'rnatadi.
 *
 * `sozlamaQiymatlari` — maydon nomi → qiymat. Maxfiy maydonlar alohida
 * faylga tushadi (bazaga emas). BO'SH qiymat "o'zgartirmadim" degani:
 * saqlangan token o'rnida qoladi.
 */
export async function mcpOrnat(
  id: string,
  qamrov: McpQamrov,
  sozlamaQiymatlari: Record<string, string>,
  projectIds?: string[],
): Promise<McpServer> {
  const javob = await sorov<{ server: McpServer }>(`/api/mcp/${id}/ornat`, {
    method: 'POST',
    headers: jsonSarlavha,
    body: JSON.stringify({ qamrov, projectIds, sozlamaQiymatlari }),
  })
  return javob.server
}

export async function mcpOrnatishniBekor(
  id: string,
  qamrov: McpQamrov,
  projectIds?: string[],
): Promise<McpServer | null> {
  const javob = await sorov<{ server: McpServer | null }>(`/api/mcp/${id}/ornat`, {
    method: 'DELETE',
    headers: jsonSarlavha,
    body: JSON.stringify({ qamrov, projectIds }),
  })
  return javob.server
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
