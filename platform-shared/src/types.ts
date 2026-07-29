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

// Bazada faqat ULANISH ma'lumoti saqlanadi. Jonli holat (metrikalar,
// online/offline) `ServerMetrika` sifatida har so'rovda SSH orqali olinadi —
// saqlanmaydi, chunki eskirgan qiymat "ishonchli ko'ringan yolg'on" bo'lardi.
export interface Server {
  id: string
  /** SSH alias — `ssh <name>` shu nom bilan ishlaydi. Faqat [a-z0-9-]. */
  name: string
  host: string
  port: number
  /** Odatda 'root' — platforma serverni to'liq boshqarishi uchun */
  username: string
  createdAt: string
}

/** SSH orqali jonli o'qiladigan holat — bazaga yozilmaydi */
export interface ServerMetrika {
  holat: 'ulangan' | 'xato'
  /** holat='xato' bo'lsa sabab shu yerda */
  xato?: string
  /** "3 kun 4 soat" ko'rinishida */
  uptime?: string
  /** Foizlar: 0-100. CPU — 1 daqiqalik load / yadro soni. */
  cpu?: number
  ram?: number
  disk?: number
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
// Skilllar
// ---------------------------------------------------------------------------
//
// Model uch qatlamdan iborat — ularni ARALASHTIRMASLIK kerak:
//
//   MANBA   — ulangan GitHub repo (`anthropics/skills`). Bir manbada ko'p skill.
//   SKILL   — repo ichida topilgan bitta `SKILL.md`. Katalogda ko'rinadi,
//             lekin diskda hali yo'q — bu shunchaki "mavjud" degani.
//   O'RNATISH — skill qayerda ishlashi: global (hamma joyda) yoki aniq
//             loyihalarda. Bitta skill bir vaqtda bir necha loyihaga
//             o'rnatilishi mumkin, shuning uchun bu alohida ro'yxat.
//
// Diskda skill FAQAT o'rnatilgandan keyin paydo bo'ladi (omborda), sessiya
// boshida esa loyiha papkasiga nusxalanadi. Batafsil: platform-server/
// src/skill-ombor.ts.

/** Hozircha faqat GitHub. `tur` kelajakda kengayadi (gitlab, mahalliy papka). */
export type SkillManbaTuri = 'github'

export interface SkillManba {
  id: string
  tur: SkillManbaTuri
  /** Foydalanuvchi kiritgan asl URL — UI'da shu ko'rsatiladi */
  url: string
  owner: string
  repo: string
  /** Branch yoki tag. Bo'sh bo'lsa repo'ning standart branch'i ishlatilgan. */
  ref: string
  /** Oxirgi sinxronlashdagi commit SHA — o'zgarganini shundan bilamiz */
  commitSha: string | null
  oxirgiSinxron: string | null
  createdAt: string
}

/** Skill qayerda ishlaydi */
export type SkillQamrov = 'global' | 'loyiha'

export interface SkillOrnatish {
  qamrov: SkillQamrov
  /** `qamrov: 'loyiha'` bo'lganda majburiy, aks holda undefined */
  projectId?: string
}

export interface Skill {
  id: string
  manbaId: string
  /** Repo ichidagi yo'l — `document-skills/pdf/SKILL.md` */
  yol: string
  /** Frontmatter'dagi `name`, yo'q bo'lsa papka nomi */
  nom: string
  /** Frontmatter'dagi `description` — MAJBURIY, promptga shu tushadi */
  tavsif: string
  litsenziya?: string
  /**
   * Frontmatter'dagi `allowed-tools`.
   *
   * HOZIRCHA MAJBURLANMAYDI — o'rnatish modalida foydalanuvchiga
   * ko'rsatiladi, xolos. Majburlash alohida bosqich (pi'da ham
   * implementatsiya qilinmagan).
   */
  allowedTools?: string[]
  /** Spec'ga mos kelmagan joylar — skill baribir yuklanadi, UI'da ko'rsatiladi */
  ogohlantirishlar: string[]
  /** Bo'sh massiv = o'rnatilmagan, faqat katalogda turibdi */
  ornatilgan: SkillOrnatish[]
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
  /**
   * Amal qanday tasdiqdan o'tgani. Bazaga tool chaqiruvi bilan birga
   * yoziladi, ya'ni suhbat qayta ochilganda ham ko'rinadi.
   */
  ruxsat?: RuxsatQarori
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

/**
 * Amal QANDAY tasdiqdan o'tgani — tool chaqiruvi bilan birga saqlanadi.
 *
 * Bu javobning O'ZI emas, javob QAYERDAN kelgani. Foydalanuvchi keyinroq
 * "bu buyruq nega bajarildi?" deb so'raganda yagona ishonchli manba shu:
 *
 *   `hardoim`    — shu sessiyada avval "Har doim" tanlangan, qayta so'ralmadi
 *   `auto`       — auto rejimda klassifikator ruxsat berdi
 *   `auto-blok`  — auto rejimda klassifikator bloklandi
 *   `foydalanuvchi` — foydalanuvchi "Ruxsat berish" bosdi
 *   `foydalanuvchi-hardoim` — foydalanuvchi "Har doim" bosdi
 *   `rad`        — foydalanuvchi rad etdi
 *   `muddat`     — javob kelmadi, muddat tugab RAD etildi
 *   `bekor`      — javob oqimi to'xtatildi, so'rov o'z-o'zidan yopildi
 *   `taqiqlangan` — qat'iy taqiq ro'yxati, hech kimdan so'ralmaydi
 *
 * `bekor` va `rad` ATAYLAB ajratilgan: birinchisida foydalanuvchi butun
 * javobni to'xtatgan, ikkinchisida aynan shu amalni rad etgan. Ikkalasini
 * "siz rad etdingiz" deb ko'rsatish yolg'on bo'lardi.
 */
export type RuxsatManbasi =
  | 'hardoim'
  | 'auto'
  | 'auto-blok'
  | 'foydalanuvchi'
  | 'foydalanuvchi-hardoim'
  | 'rad'
  | 'muddat'
  | 'bekor'
  | 'taqiqlangan'

/** Ruxsat qarori — qanday hal bo'lgani, tool chaqiruviga biriktiriladi */
export interface RuxsatQarori {
  /** Foydalanuvchiga ko'rsatiladigan so'rov id'si; so'ralmagan bo'lsa yo'q */
  sorovId?: string
  manba: RuxsatManbasi
  /** Ruxsat berildimi (`rad`/`auto-blok`/`muddat`/`taqiqlangan` da `false`) */
  berildi: boolean
  /** "Har doim" da eslab qolingan naqsh */
  naqsh?: string
  vaqt: string
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

/**
 * Provider qanday to'lov modeli bilan ulangani.
 *
 * Foydalanuvchi uchun bu narxdan ham muhim: `obuna` da tokenlar oylik to'lovga
 * kiradi, `kalit` da esa har token alohida hisoblanadi. Ikkalasi bir xil
 * ko'rinsa foydalanuvchi bilmay pullik kanaldan ishlatib yuboradi.
 *
 * UI matn tahlil qilmasligi uchun alohida maydon — `manba` satri erkin matn
 * (masalan `~/.codex (ChatGPT obunasi)`) va o'zgarishi mumkin.
 */
export type ManbaTuri = 'obuna' | 'kalit' | 'mahalliy'

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
  /** To'lov modeli — obuna / API kaliti / mahalliy */
  manbaTuri: ManbaTuri
}

/** Aniqlangan provider — model tanlagichda guruh sarlavhasi uchun */
export interface ProviderInfo {
  id: string
  name: string
  manba: string
  /** To'lov modeli — obuna / API kaliti / mahalliy */
  manbaTuri: ManbaTuri
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
  /**
   * Sessiya ulangan loyiha. `undefined` bo'lsa agent tool'lari sessiyaning
   * o'z papkasida ishlaydi; ulangan bo'lsa loyiha papkasida — ya'ni bir
   * loyihaning hamma suhbatlari bitta fayllar to'plamini ko'radi.
   */
  projectId?: string
  createdAt: string
  updatedAt: string
  /**
   * Suhbatdagi xabarlar soni. Faqat RO'YXAT so'rovida (`GET /api/chat/sessions`)
   * to'ldiriladi — bitta sessiya so'ralganda ortiqcha hisob-kitob shart emas.
   *
   * UI shu bilan "bo'sh suhbat" ni ajratadi: sessiya yaratilib, birinchi
   * xabar yuborilmasdan tashlab ketilishi oddiy holat.
   */
  xabarlarSoni?: number
}

// ---------------------------------------------------------------------------
// Loyihalar (project / workspace)
// ---------------------------------------------------------------------------

/**
 * Loyiha — nom bilan bog'langan ish papkasi.
 *
 * Papkani platforma o'zi yaratadi (`~/.platforma/loyihalar/<slug>/`),
 * foydalanuvchi yo'l bermaydi: ixtiyoriy yo'l qabul qilinsa, agent tool'lari
 * uchun chegara `/` ga ham qo'yilishi mumkin bo'lardi.
 */
export interface Project {
  id: string
  name: string
  /** To'liq yo'l — UI uni faqat ko'rsatadi, o'zgartira olmaydi */
  papka: string
  createdAt: string
  /** Shu loyihaga ulangan chat sessiyalari soni */
  chatlarSoni?: number
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
  /**
   * LLM ko'radigan to'liq kontekst — pi-agent-core ning `AgentMessage[]`
   * massivi xom holda (tool call'lar, tool NATIJALARI, thinking bloklari).
   *
   * `text` dan farqi: `text` — UI ko'rsatadigan toza javob matni,
   * bu esa keyingi turn'da LLM'ga qaytariladigan tarix. Tool natijalari
   * faqat shu yerda bo'ladi, ya'ni usiz agent har turn xotirasini yo'qotadi.
   *
   * Tip `unknown[]`: `@platforma/shared` AI paketiga bog'lanmasligi kerak
   * (UI ham shu tiplarni import qiladi). Aniq tip serverda tiklanadi.
   *
   * Eski xabarlarda (004-migratsiyadan oldin) `undefined` — u holda tarix
   * `text` dan quriladi.
   */
  agentMessages?: unknown[]
  /**
   * Provider aytgan kontekst hajmi (token). Compaction qarori shunga
   * tayanadi — butun tarixni qayta hisoblash o'rniga aniq raqam.
   */
  contextTokens?: number
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
