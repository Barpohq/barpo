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

/**
 * Skill manbasi qayerdan keladi.
 *
 * `github`   — foydalanuvchi ulagan repo (`owner/repo`).
 * `platforma` — platforma bilan BIRGA kelgan standart skilllar.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ NEGA `platforma` ALOHIDA TUR. Standart skilllar (dashboard yozish  │
 * │ kabi) platformaning bir qismi va u bilan birga versiyalanadi.      │
 * │                                                                    │
 * │ Hozir ular repo ichidagi `skills/` papkasidan o'qiladi, chunki     │
 * │ repo yopiq. Repo ochilganda manba GitHub'ga ko'chadi — o'shanda    │
 * │ FAQAT skanerlash manbai o'zgaradi, katalog, o'rnatish va UI        │
 * │ oqimlari o'z holicha qoladi. Shu sabab ular boshidanoq oddiy       │
 * │ manba kabi katalogdan o'tadi.                                      │
 * └────────────────────────────────────────────────────────────────────┘
 */
export type SkillManbaTuri = 'github' | 'platforma'

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
// MCP (Model Context Protocol) serverlar
// ---------------------------------------------------------------------------
//
// Model skilllar bilan AYNAN BIR XIL uch qatlamli (yuqoridagi izohga q.):
//
//   MANBA   — katalog qayerdan kelgan (registry, GitHub repo, qo'lda, standart).
//   SERVER  — katalogdagi bitta MCP server yozuvi. "Mavjud" degani, ulangan
//             degani EMAS.
//   O'RNATISH — server qayerda faol: global yoki aniq loyihalarda.
//
// SKILLLARDAN TUB FARQI — bu yerda DISK EMAS, JARAYON.
//
// Skill o'rnatilganda fayl ko'chiriladi va shu bilan tugaydi; agent uni
// `read` bilan o'qiydi. MCP server o'rnatilganda esa hech narsa ko'chmaydi:
// u har sessiya boshida JARAYON sifatida ishga tushadi (stdio) yoki
// masofaviy manzilga ulanadi (http), va agentga YANGI TOOL'LAR beradi.
//
// Shundan kelib chiqadigan uch narsa (platform-ai/src/mcp-*.ts):
//   1) lifecycle — jarayonni ko'tarish, o'ldirish, zombi qoldirmaslik;
//   2) kredensial — deyarli har server token talab qiladi (pastga q.);
//   3) ruxsat — har tool chaqiruvi `RuxsatBoshqaruvchi.sora()` dan o'tadi.

/**
 * MCP server bilan qanday gaplashiladi.
 *
 * `stdio` — mahalliy jarayon (`npx`/`uvx`/`docker`), JSON-RPC stdin/stdout
 *           orqali. Ekotizimning katta qismi shunday.
 * `http`  — masofaviy server (`streamable-http` yoki `sse`). Mahalliy kod
 *           ishga tushmaydi, ya'ni xavfsizlik jihatidan tozaroq.
 */
export type McpTransportTuri = 'stdio' | 'http'

/**
 * Katalog yozuvi qayerdan kelgan.
 *
 * `registry` — rasmiy MCP registry (registry.modelcontextprotocol.io).
 * `github`   — repo'da `server.json` qidirib topilgan.
 * `qolda`    — foydalanuvchi o'zi kiritgan (buyruq yoki URL).
 * `standart` — platforma bilan birga kelgan to'plam.
 *
 * `SkillManbaTuri` bilan bir xil g'oya: manba turi FAQAT yozuvni QANDAY
 * olishda farq qiladi, undan keyingi hamma qadam (katalog, o'rnatish, UI)
 * turni bilmaydi.
 */
export type McpKatalogManbaTuri = 'registry' | 'github' | 'qolda' | 'standart'

export interface McpManba {
  id: string
  tur: McpKatalogManbaTuri
  /**
   * Manbani identifikatsiya qiluvchi nom — turga qarab boshqa ma'no:
   * `registry` uchun server nomi, `github` uchun `owner/repo`,
   * `qolda` uchun foydalanuvchi bergan nom, `standart` uchun papka nomi.
   */
  manbaNomi: string
  /** Faqat `github` turida to'ladi */
  owner: string | null
  repo: string | null
  /** Branch yoki tag. Bo'sh satr = standart branch. */
  ref: string
  oxirgiSinxron: string | null
  createdAt: string
}

/**
 * Bitta sozlanadigan maydon — env o'zgaruvchisi (stdio) yoki HTTP sarlavha.
 *
 * MUHIM: bu FAQAT SXEMA, qiymat emas. Ya'ni "bu server `GITHUB_TOKEN`
 * so'raydi" degan ma'lumot. Qiymatning o'zi o'rnatish paytida kiritiladi
 * va `maxfiy` bo'lsa bazaga UMUMAN tushmaydi (`mcp-kredensial.ts`).
 *
 * Rasmiy registry sxemasidagi `KeyValueInput` dan olinadi:
 * `isRequired` → `majburiy`, `isSecret` → `maxfiy`.
 */
export interface McpSozlamaMaydoni {
  nom: string
  izoh?: string
  majburiy: boolean
  /** true — UI'da yashiriladi, kredensial omboriga tushadi, API qaytarmaydi */
  maxfiy: boolean
  standart?: string
}

/**
 * Katalogdagi MCP server — "bunday server bor" degani.
 *
 * `transport` bo'yicha ikki xil to'ldiriladi: `stdio` uchun
 * `buyruq`+`argumentlar`, `http` uchun `url`. Bazada bu CHECK bilan
 * majburlanadi (migratsiya 011).
 */
export interface McpKatalogYozuvi {
  id: string
  manbaId: string
  /** Registry'dagi reverse-DNS nom (`com.example/github`) yoki erkin nom */
  nom: string
  tavsif: string
  transport: McpTransportTuri
  /** `stdio`: ishga tushirish buyrug'i — `npx`, `uvx`, `docker` */
  buyruq?: string
  /**
   * `stdio`: argumentlar. O'rin egallovchilar (`{token}`) HALI
   * almashtirilmagan — ular jarayon ko'tarilishidan oldin, `Bun.spawn`
   * argv massivi ichida almashtiriladi (shell orqali EMAS).
   */
  argumentlar?: string[]
  /** `http`: server manzili */
  url?: string
  /** Kerakli env/sarlavhalar TAVSIFI — qiymatsiz */
  sozlamalar: McpSozlamaMaydoni[]
  createdAt: string
}

/** MCP server qayerda faol — `SkillQamrov` bilan bir xil */
export type McpQamrov = 'global' | 'loyiha'

export interface McpOrnatish {
  /** O'rnatish qatorining id'si — kredensial kaliti shundan quriladi */
  id: string
  qamrov: McpQamrov
  /** `qamrov: 'loyiha'` bo'lganda majburiy */
  projectId?: string
  /**
   * MAXFIY BO'LMAGAN sozlama qiymatlari (masalan `BASE_URL`).
   *
   * Maxfiylar bu yerda YO'Q — ular `mcp-kredensial.ts` da, alohida faylda.
   * Har o'rnatishning o'z qiymatlari bor: bir server ikki loyihada turli
   * token bilan ishlashi mumkin.
   */
  sozlamaQiymatlari: Record<string, string>
}

/** Katalog + o'rnatish holati — UI ro'yxati uchun to'liq ko'rinish */
export interface McpServer extends McpKatalogYozuvi {
  /** Bo'sh massiv = o'rnatilmagan, faqat katalogda turibdi */
  ornatilgan: McpOrnatish[]
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

/**
 * Ruxsat so'raladigan amal turi.
 *
 * `fayl`   — ish papkasidan tashqaridagi fayl (`muhit.ts`).
 * `buyruq` — xavfli yoki notanish bash buyrug'i (`buyruq-tahlil.ts`).
 * `mcp`    — ulangan MCP serverning vositasi (`mcp-boshqaruvchi.ts`).
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ NEGA MCP UCHINCHI TUR, `buyruq` EMAS. MCP chaqiruvi na fayl, na    │
 * │ mahalliy buyruq: u tashqi tizimda yon effekt qiladi (GitHub'ga     │
 * │ issue, Slack'ga xabar) va bu ta'sir mahalliy fayl tizimida         │
 * │ KO'RINMAYDI. Klassifikator ham shu farqni bilishi kerak, aks       │
 * │ holda u "bash buyrug'i" deb baholab, buyruq matnini qidiradi —     │
 * │ MCP chaqiruvida esa unday matn yo'q.                               │
 * └────────────────────────────────────────────────────────────────────┘
 */
export type RuxsatTuri = 'fayl' | 'buyruq' | 'mcp'

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

/**
 * AI yozgan ko'rinish kodi — IXTIYORIY qatlam.
 *
 * NEGA KOD KERAK. `Widget` lug'ati ataylab tor: u bashoratli va xavfsiz,
 * lekin har dashboard unga sig'avermaydi. Kod qatlami o'sha shiftni ochadi —
 * AI o'zi xohlagan tartibni JSX bilan yozadi.
 *
 * ⚠️ ISHONCH DARAJASI. Kod HOST React daraxtida ishlaydi, ya'ni
 * platformaning huquqi bilan (avval sandbox iframe'da edi — `AiKorinish.tsx`
 * boshidagi izoh nega o'zgarganini tushuntiradi). Bu `states` qatlami bilan
 * bir xil daraja va bir xil ongli qaror.
 *
 * Chegara `view-qurish.ts` da: `import` va `fetch` taqiqlangan, ya'ni kod
 * ixtiyoriy tarmoq chiqishi qila olmaydi. Yozish faqat platforma bergan
 * `ui.saqla` / `ui.amal` orqali va faqat O'Z ilovasiga
 * (`AiKorinish.tsx` da app id closure'ga qulflangan).
 *
 * Xato izolyatsiyasi saqlanadi: `KorinishChegarasi` render xatosini ushlaydi
 * va faqat shu blok o'chadi.
 */
export interface AppView {
  /**
   * Kompilyatsiya QILINGAN JS (JSX emas).
   *
   * AI JSX yozadi, server `Bun.build` bilan aylantiradi — brauzerga
   * transform yuki tushmasin va xato UI'da emas, serverda ushlansin.
   */
  kod: string
  /** Manba kodining xashi — keshni yangilash va audit uchun */
  xash: string
}

/**
 * Vaqt o'tishi bilan YANGILANADIGAN ma'lumot bo'lagi.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ QOIDA O'ZGARMAYDI: AI YANGI API YOZMAYDI.                          │
 * │                                                                    │
 * │ Endpoint bitta va OLDINDAN tayyor:                                 │
 * │     GET /api/apps/:id/state/:nom                                   │
 * │ AI faqat o'sha endpoint NIMA QAYTARISHINI belgilaydi — ya'ni       │
 * │ state kodini yozadi, marshrutni emas.                              │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * NEGA HAR STATE ALOHIDA. Dashboarddagi ma'lumotlar bir xil tezlikda
 * eskirmaydi: CPU 5 soniyada o'zgaradi, disk hajmi esa 30 soniyada ham
 * deyarli o'zgarmaydi. Hammasini bitta obyektga qo'shsak, eng tez
 * yangilanadigani butun to'plamni har safar qayta hisoblatardi — ya'ni
 * disk uchun `df` har 5 soniyada bejiz ishga tushardi.
 *
 * Shuning uchun har state — mustaqil birlik: o'z kodi, o'z intervali,
 * o'z keshi.
 */
export interface AppState {
  /**
   * State nomi — `data` ichida shu kalit ostida turadi va URL'ga tushadi.
   *
   * Faqat `[a-z0-9_]` (`manifest-tekshir.ts` majburlaydi): u yo'l
   * bo'lagiga aylanadi.
   */
  nom: string
  /**
   * Serverda bajariladigan JS kod.
   *
   * `module.exports = async function () { ... }` shaklida — natija
   * `data[nom]` ga tushadi. Kod SERVER JARAYONIDA ishlaydi, ya'ni
   * `child_process`, `fs` va tarmoq unga ochiq.
   *
   * ┌──────────────────────────────────────────────────────────────────┐
   * │ ⚠️ ISHONCH DARAJASI. Bu kod platformaning to'liq huquqi bilan    │
   * │ ishlaydi va interval bo'yicha AVTOMATIK takrorlanadi.            │
   * │                                                                  │
   * │ Hozircha u ruxsat qatlamidan O'TMAYDI — bu ONGLI vaqtinchalik    │
   * │ qaror. Keyingi bosqichda kodni tekshiradigan klassifikator       │
   * │ qo'shiladi (prompt injection himoyasi), ulanish nuqtasi:         │
   * │ `platform-server/src/state-bajar.ts` → `kodniTekshir()`.         │
   * └──────────────────────────────────────────────────────────────────┘
   */
  kod: string
  /**
   * Qayta hisoblash oralig'i (soniya).
   *
   * `0` yoki berilmagan — avtomatik yangilanmaydi, faqat sahifa
   * ochilganda bir marta hisoblanadi.
   */
  interval?: number
}

// ---------------------------------------------------------------------------
// Boshqaruv qatlami — sozlamalar (forma) va amallar (tugma)
// ---------------------------------------------------------------------------
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ HAQIQAT MANBAI — SERVER, PLATFORMA EMAS.                             │
// │                                                                      │
// │ Ilova (masalan telegram bot) serverda MUSTAQIL ishlaydi va tokenni   │
// │ o'z konfiguratsiyasidan (`/opt/bot/.env`) o'qiydi. Foydalanuvchi      │
// │ tokenni platformada kiritganda u SHU YERGA yoziladi, platformaning    │
// │ o'z bazasiga EMAS.                                                    │
// │                                                                      │
// │     brauzer → platforma → SSH → server:/opt/bot/.env → restart       │
// │                                                                      │
// │ Sirlar TESKARI yo'nalishda oqmaydi: platforma sir maydon uchun faqat │
// │ "o'rnatilgan / o'rnatilmagan" ni biladi, qiymatini o'qimaydi.         │
// │                                                                      │
// │ NEGA `mcp-kredensial.ts` DAN FARQLI. MCP serverni platformaning       │
// │ O'ZI ishga tushiradi — token unga KERAK, shuning uchun saqlanadi.     │
// │ Ilova esa serverda o'zi ishlaydi — token platformaga kerak emas,      │
// │ ya'ni uni saqlash faqat qo'shimcha xavf bo'lardi.                     │
// └──────────────────────────────────────────────────────────────────────┘

/**
 * Sozlama maydonining turi — UI qanday kiritish elementi chizishini belgilaydi.
 *
 * `sir` alohida toifada: u UI'da yashiriladi, joriy qiymati HECH QACHON
 * qaytarilmaydi va bo'sh qoldirilsa "o'zgartirmadim" degani
 * (`McpSozlamaMaydoni.maxfiy` bilan bir xil qaror).
 */
export type SozlamaTuri = 'matn' | 'sir' | 'raqam' | 'tanlov' | 'kalit' | 'kopMatn'

export interface SozlamaMaydoni {
  /**
   * Sozlama kaliti — serverdagi konfiguratsiyada shu nom bilan yoziladi.
   *
   * Faqat `[a-z][a-z0-9_]*`: u `.env` kaliti bo'lib chiqadi (yuqori registrga
   * aylantirilib) va JSON kaliti bo'lishi mumkin. Qat'iy naqsh injection
   * yo'llarini yopadi — `manifest-tekshir.ts` majburlaydi.
   */
  kalit: string
  turi: SozlamaTuri
  yorliq: string
  izoh?: string
  majburiy?: boolean
  /** Boshlang'ich qiymat — `sir` uchun ISHLATILMAYDI */
  standart?: string
  /** `turi: 'tanlov'` uchun variantlar ro'yxati */
  variantlar?: string[]
  /**
   * Validatsiya regexi (satr shaklida, `RegExp` konstruktoriga beriladi).
   *
   * ┌────────────────────────────────────────────────────────────────────┐
   * │ BU — INJECTION HIMOYASINING UCHINCHI QATLAMI.                      │
   * │                                                                    │
   * │ `states` qatlamida foydalanuvchi kirishi YO'Q edi, bu yerda BOR.   │
   * │ Birinchi ikki qatlam kirishni shell'dan butunlay ajratadi          │
   * │ (argv massivi + stdin), naqsh esa qiymatning O'ZINI cheklaydi —    │
   * │ masalan bot tokeni `^\d+:[A-Za-z0-9_-]+$` shaklidan chiqmasin.     │
   * └────────────────────────────────────────────────────────────────────┘
   */
  naqsh?: string
  /** Naqsh buzilganda foydalanuvchiga ko'rsatiladigan matn */
  naqshIzohi?: string
}

/**
 * Ilova sozlamalari — forma sxemasi va uni serverga yozadigan kod.
 *
 * Sxema (`maydonlar`) va kod (`yoz`) ATAYLAB ajratilgan: sxema bashoratli va
 * UI uni o'zi render qiladi (`widgets` falsafasi), kod esa har ilova uchun
 * boshqacha bo'ladigan qismni oladi — qaysi faylga, qaysi formatda, qanday
 * restart bilan.
 */
export interface AppSozlamalari {
  maydonlar: SozlamaMaydoni[]
  /**
   * Qiymatlarni SERVERGA yozadigan kod.
   *
   * `module.exports = async function ({ qiymatlar, ssh, appId }) { ... }`
   *
   * `ssh.envYoz()` va `ssh.buyruq()` platforma tomonidan beriladi — AI shell
   * satri yozmaydi (`amal-bajar.ts` dagi izohga q.).
   */
  yoz: string
  /**
   * Joriy qiymatlarni SERVERDAN o'qiydigan kod (ixtiyoriy).
   *
   * ⚠️ SIR QAYTARMASLIGI KERAK. Sir kalit qaytarilsa u tashlanadi va
   * ogohlantirish yoziladi — token server → platforma → brauzer yo'lini
   * bosib o'tmasligi kerak.
   *
   * Berilmasa forma bo'sh ochiladi (faqat `standart` qiymatlar bilan).
   */
  oqi?: string
}

/**
 * Foydalanuvchi bosadigan amal — restart, stop, keshni tozalash.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ ⚠️ ISHONCH DARAJASI — `states` BILAN BIR XIL.                        │
 * │                                                                      │
 * │ Amal kodi server jarayonida, platformaning to'liq huquqi bilan       │
 * │ ishlaydi. Farqi: `states` AVTOMATIK takrorlanadi, amal esa           │
 * │ foydalanuvchi BOSGANDA bir marta ishlaydi va auditga tushadi.        │
 * │                                                                      │
 * │ Ruxsat qatlamidan O'TMAYDI (`bash` tool'idan farqli) — bu ongli      │
 * │ vaqtinchalik qaror. Klassifikator ulanish nuqtasi:                   │
 * │ `platform-server/src/amal-bajar.ts` → `kodniTekshir()`.              │
 * └──────────────────────────────────────────────────────────────────────┘
 */
export interface AppAmali {
  /**
   * Amal nomi — URL yo'liga tushadi (`POST /api/apps/:id/amal/:nom`).
   *
   * `AppState.nom` bilan bir xil naqsh va bir xil sabab: yo'l chiqishini
   * (`../`) va kodlash muammolarini butunlay yopadi.
   */
  nom: string
  yorliq: string
  izoh?: string
  /** Audit darajasi — berilmasa `'o'zgartirish'` */
  xavf?: AuditLevel
  /**
   * `true` — UI bosishdan oldin tasdiq so'raydi.
   *
   * ⚠️ Bu TASODIFIY bosishga qarshi, HUJUMGA qarshi emas: tekshiruv UI
   * tomonda va API'ni to'g'ridan chaqirgan kod uni o'tkazib yuboradi.
   */
  tasdiq?: boolean
  /** `module.exports = async function ({ ssh, sozlama, appId }) { ... }` */
  kod: string
  /**
   * Amal tugagandan keyin MAJBURIY yangilanadigan state nomlari.
   *
   * Restart bosilganda status darhol yangilanishi kerak — keshdagi eski
   * qiymat interval tugashini kutib turmasin.
   */
  yangila?: string[]
}

export interface AppManifest {
  id: string
  icon: string
  name: string
  tagline: string
  version: string
  service: string
  status: 'running' | 'idle'
  widgets: Widget[]
  /**
   * Ko'rinishga beriladigan BOSHLANG'ICH ma'lumot.
   *
   * `states` bo'lsa, ularning hisoblangan natijalari shu obyekt ustiga
   * yoziladi (`data[state.nom]`). Ya'ni bu — birinchi renderdagi qiymat,
   * keyin jonli ma'lumot bilan almashadi.
   *
   * `unknown` ataylab: shakl har ilovada boshqacha va uni AI belgilaydi.
   * Chegara mazmunga emas, HAJMGA qo'yiladi (`manifest-tekshir.ts`).
   */
  data?: Record<string, unknown>
  /**
   * Jonli ma'lumot manbalari — har biri o'z intervali bilan.
   *
   * Bo'lmasa dashboard statik qoladi (`data` dagi qiymatlar o'zgarmaydi).
   */
  states?: AppState[]
  /** Bo'lmasa — `widgets` render qilinadi. Ikkalasi ham bo'lishi mumkin. */
  view?: AppView
  /**
   * Sozlamalar formasi — bo'lmasa forma ko'rsatilmaydi.
   *
   * Qiymatlar SERVERDAGI ilovaga yoziladi, platformaga emas (yuqoridagi
   * qatlam izohiga q.).
   */
  sozlamalar?: AppSozlamalari
  /** Foydalanuvchi bosadigan amallar — bo'lmasa tugmalar ko'rsatilmaydi */
  amallar?: AppAmali[]
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
