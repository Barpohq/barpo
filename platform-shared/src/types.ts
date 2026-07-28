// Platformaning umumiy tiplari — UI ham, server ham shu yerdan oladi.
// Bu fayl yagona haqiqat manbai: tip o'zgarsa, ikkala tomon birdan biladi.
// (Ilgari platform-ui/src/data/mock.ts ichida edi, endi mock.ts shu yerdan
// import qilib re-export qiladi — sahifalar uchun hech narsa o'zgarmaydi.)

// ---------------------------------------------------------------------------
// Agentlar
// ---------------------------------------------------------------------------

export type AgentStatus = 'running' | 'idle' | 'paused'

export interface Agent {
  id: string
  name: string
  desc: string
  status: AgentStatus
  schedule: string
  nextRun: string
  todayCost: number
  todayCalls: number
  model: string
  metrics: { label: string; value: string }[]
}

// ---------------------------------------------------------------------------
// Serverlar
// ---------------------------------------------------------------------------

export interface Server {
  id: string
  name: string
  role: string
  region: string
  status: 'healthy' | 'warning' | 'offline'
  cpu: number
  ram: number
  disk: number
  daemon: string
  uptime: string
  note?: string
}

// ---------------------------------------------------------------------------
// Workflow (pipeline bosqichlari)
// ---------------------------------------------------------------------------

export interface WorkflowStep {
  id: string
  name: string
  desc: string
  status: 'done' | 'running' | 'waiting'
  stat: string
  detail: string
}

// ---------------------------------------------------------------------------
// LLM chaqiruvlari va xarajat
// ---------------------------------------------------------------------------

export interface LlmCall {
  time: string
  agent: string
  model: string
  task: string
  tokens: string
  cost: string
}

// ---------------------------------------------------------------------------
// Audit log — append-only, platformadagi har amal shu yerga tushadi
// ---------------------------------------------------------------------------

export type AuditLevel = "o'qish" | "o'zgartirish" | 'xavfli'

export interface AuditEntry {
  time: string
  actor: string
  action: string
  target: string
  level: AuditLevel
  result: 'OK' | 'tasdiqlandi' | 'rad etildi' | 'kutmoqda'
}

// ---------------------------------------------------------------------------
// Skill do'koni
// ---------------------------------------------------------------------------

export interface Skill {
  id: string
  name: string
  desc: string
  version: string
  installed: boolean
  category: string
  permissions: { level: AuditLevel; text: string }[]
}

// ---------------------------------------------------------------------------
// Chat: tool kartalari
// ---------------------------------------------------------------------------

/** Eski, bitta kartali shakl — mock demo va build oqimi hali shuni ishlatadi */
export interface ToolCard {
  tool: string
  args: string
  result: string
}

// ---------------------------------------------------------------------------
// Agent tool chaqiruvlari — LLM qo'l bilan qilgan amallar
// ---------------------------------------------------------------------------

export type ToolHolati = 'ishlamoqda' | 'tugadi' | 'xato' | 'rad etildi'

/** Bitta tool chaqiruvi — UI kartasi shu shakldan render qilinadi */
export interface ToolChaqiruv {
  id: string
  /** 'read' | 'write' | 'edit' | 'bash' */
  nom: string
  /** Qisqartirilgan argument ko'rinishi: fayl yo'li yoki buyruq matni */
  args: string
  holat: ToolHolati
  /** Natija matni (uzun bo'lsa qisqartirilgan) */
  natija?: string
  /** `edit` uchun diff, `bash` uchun truncation belgisi */
  tafsilot?: {
    diff?: string
    qisqartirilgan?: boolean
  }
  /** Auto rejimda klassifikator shu amal bo'yicha chiqargan qaror */
  klassifikator?: KlassifikatorQarori
}

// ---------------------------------------------------------------------------
// Ruxsat so'rovlari — xavfli amal oldidan foydalanuvchidan so'raladi
// ---------------------------------------------------------------------------

export type RuxsatTuri = 'fayl' | 'buyruq'

/** `hardoim` — ruxsat beriladi va naqsh sessiya davomida eslab qolinadi */
export type RuxsatJavobi = 'ruxsat' | 'rad' | 'hardoim'

/**
 * Ruxsat rejimi.
 *
 * `tasdiq` — har xavfli yoki notanish amal foydalanuvchidan so'raladi.
 * `auto`   — klassifikator hal qiladi: amal foydalanuvchi so'raganidan
 *            chetga chiqmasa avtomatik bajariladi.
 *
 * Qat'iy taqiq ro'yxatidagi buyruqlar ikkala rejimda ham bloklanadi.
 */
export type RuxsatRejimi = 'tasdiq' | 'auto'

export interface RejimHolati {
  rejim: RuxsatRejimi
  /** Auto o'z-o'zidan o'chgan bo'lsa — sababi */
  sabab?: string
  /** Klassifikator qaysi model bilan ishlayapti */
  klassifikatorModeli?: string
}

/** Klassifikator bitta amal bo'yicha chiqargan qaror — UI'da tool kartasi ostida */
export interface KlassifikatorQarori {
  /** Qaysi tool chaqiruviga tegishli */
  toolId?: string
  qaror: 'ruxsat' | 'blok'
  izoh: string
}

export interface RuxsatSorovi {
  id: string
  sessionId: string
  tur: RuxsatTuri
  /** Qaysi tool: 'read', 'write', 'edit', 'bash' */
  amal: string
  /** Fayl yo'li yoki buyruq matni */
  nishon: string
  /** Nega so'ralayapti — foydalanuvchiga ko'rsatiladi */
  sabab: string
  /** "Har doim ruxsat" tanlansa nima eslab qolinadi */
  naqsh: string
  vaqt: string
}

// ---------------------------------------------------------------------------
// Ilova manifestlari — vidjetlar sxema sifatida, host UI dinamik render qiladi
// ---------------------------------------------------------------------------

export interface StatItem {
  label: string
  value: string
  hint?: string
  accent?: string
}

export type Widget =
  | { type: 'stats'; items: StatItem[] }
  | { type: 'bars'; title: string; items: { label: string; value: number; note?: string }[]; suffix?: string }
  | { type: 'table'; title: string; columns: string[]; rows: string[][] }
  | { type: 'logs'; title: string; lines: string[] }
  | { type: 'note'; text: string }
  | { type: 'deploy'; url: string; kind: 'domen' | 'port'; server: string; ssl?: string; extra?: string }
  | { type: 'git'; repo: string; branch: string; commits: { hash: string; msg: string; time: string }[] }

export interface AppManifest {
  id: string
  icon: string
  name: string
  tagline: string
  version: string
  service: string
  status: 'running' | 'idle'
  widgets: Widget[]
}

// ---------------------------------------------------------------------------
// Qurilish rejalari — orchestrator shu shaklda oqim yuboradi
// ---------------------------------------------------------------------------

export interface BuildStep {
  text: string
  kind: 'info' | 'tool' | 'out' | 'done'
}

export interface DeployOption {
  label: string
  steps: BuildStep[]
  widget: Widget
}

export interface BuildPlan {
  id: string
  keywords: string[]
  intro: string
  toolCard: ToolCard
  steps: BuildStep[]
  choice?: { question: string; options: DeployOption[] }
  manifest: AppManifest
}

// ---------------------------------------------------------------------------
// AI modellari — server foydalanuvchi PC'sida aniqlaganlarini shu shaklda beradi
// ---------------------------------------------------------------------------

/** Bitta ishlatishga tayyor model (provideri sozlangan) */
export interface ModelInfo {
  /** Provider id: 'openrouter', 'ollama', 'anthropic' ... */
  provider: string
  /** Provider ko'rsatiladigan nomi: 'OpenRouter', 'Ollama' */
  providerName: string
  /** Model id: 'anthropic/claude-sonnet-4.5', 'qwen3:8b' */
  id: string
  /** Model ko'rsatiladigan nomi */
  name: string
  contextWindow: number
  /** Model o'ylash (reasoning) rejimini qo'llaydimi */
  reasoning: boolean
  /** Rasm kiritishni qo'llaydimi */
  vision: boolean
  /** 1 million token uchun narx (AQSh dollarida). Mahalliy modellarda 0. */
  cost: { input: number; output: number }
  /** Kalit qayerdan topilgani: 'OPENROUTER_API_KEY', 'Ollama (mahalliy)' ... */
  manba: string
}

/** Aniqlangan provider — model tanlagichda guruh sarlavhasi uchun */
export interface ProviderInfo {
  id: string
  name: string
  manba: string
  /** Nechta modeli mavjud */
  modelSoni: number
}

/** Aniqlash natijasida yuz bergan muammo (fatal emas, faqat ma'lumot) */
export interface AniqlashOgohlantirish {
  manba: string
  sabab: string
}

// ---------------------------------------------------------------------------
// Chat sessiyalari — backend saqlaydigan yangi tiplar
// ---------------------------------------------------------------------------

export interface ChatSession {
  id: string
  title: string
  /**
   * Sessiya boshlanganda tanlangan provider va model. Birinchi xabar
   * yuborilgunga qadar ikkalasi ham `undefined`. Bir marta o'rnatilgach
   * provider o'zgarmaydi — suhbat o'rtasida providerni almashtirish
   * kontekst formatini buzadi (thinking bloklari, tool id'lari mos kelmaydi).
   */
  provider?: string
  model?: string
  createdAt: string
  updatedAt: string
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  text: string
  /** @deprecated Eski demo oqimi uchun. Yangi kod `toolCards` ishlatadi. */
  toolCard?: ToolCard
  /** Agent shu javob davomida bajargan tool chaqiruvlari, tartib bo'yicha */
  toolCards?: ToolChaqiruv[]
  createdAt: string
}

// ---------------------------------------------------------------------------
// Qurilish sessiyalari — chat'dan boshlangan "yasab ber" oqimining holati
// ---------------------------------------------------------------------------

export type BuildSessionStatus = 'running' | 'waiting_choice' | 'done' | 'failed'

export interface BuildSession {
  id: string
  appId: string
  status: BuildSessionStatus
  createdAt: string
}

// ---------------------------------------------------------------------------
// Ilovaning DB'dagi yozuvi (manifest + hayot sikli)
// ---------------------------------------------------------------------------

export interface AppRecord {
  id: string
  manifest: AppManifest
  status: 'running' | 'idle'
  createdAt: string
  updatedAt: string
}
