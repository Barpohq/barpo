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

export interface ToolCard {
  tool: string
  args: string
  result: string
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
// Chat sessiyalari — backend saqlaydigan yangi tiplar
// ---------------------------------------------------------------------------

export interface ChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  text: string
  toolCard?: ToolCard
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
