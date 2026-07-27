// Mock ma'lumotlar — demo rejim. Raqamlar loyihaning real tarixidan olingan
// (roadmap 2026-07-26: 247 klaster, 151 qabul, $0.037/post, approval 96%).
//
// TIPLAR endi @platforma/shared paketida (platform-shared/src/types.ts) —
// backend ham xuddi shu tiplarni ishlatadi. Bu fayl ularni re-export qiladi,
// shuning uchun sahifalardagi `import { Agent } from '../data/mock'` kabi
// importlar avvalgidek ishlaydi. Backend ulanganda faqat DATA almashtiriladi.

// Shu faylda annotatsiya sifatida ishlatiladigan tiplar
import type {
  Agent,
  AppManifest,
  AuditEntry,
  BuildPlan,
  LlmCall,
  Server,
  Skill,
  ToolCard,
  WorkflowStep,
} from '@platforma/shared'

export type {
  Agent,
  AgentStatus,
  AppManifest,
  AuditEntry,
  AuditLevel,
  BuildPlan,
  BuildStep,
  ChatMessage,
  ChatSession,
  BuildSession,
  DeployOption,
  LlmCall,
  Server,
  Skill,
  StatItem,
  ToolCard,
  Widget,
  WorkflowStep,
} from '@platforma/shared'

export const agents: Agent[] = [
  {
    id: 'ai-news-bot',
    name: 'ai-news-bot',
    desc: "AI yangiliklarini 32 manbadan yig'adi, saralaydi, boyitadi va Telegram kanalga chiqaradi",
    status: 'running',
    schedule: 'Har kuni 06:00 / 12:00 / 18:00 (Toshkent)',
    nextRun: 'Bugun 18:00',
    todayCost: 0.081,
    todayCalls: 214,
    model: 'opus-5 (writer) · gemini-flash (rank)',
    metrics: [
      { label: 'Bugungi klasterlar', value: '247' },
      { label: 'Qabul / rad', value: '151 / 96' },
      { label: 'Yozilgan postlar', value: '5' },
      { label: 'Kanalga chiqdi', value: '4' },
    ],
  },
  {
    id: 'server-monitor',
    name: 'server-monitor',
    desc: "5 serverni SSH orqali tekshiradi, muammo topilsa LLM bilan izohlab Telegram'ga alert yuboradi",
    status: 'idle',
    schedule: 'Har 10 daqiqada',
    nextRun: '4 daqiqadan keyin',
    todayCost: 0.003,
    todayCalls: 4,
    model: 'gemini-flash (diagnostika)',
    metrics: [
      { label: 'Bugungi tekshiruvlar', value: '86' },
      { label: 'Alertlar', value: '1' },
      { label: 'Diagnostika chaqiruvi', value: '4' },
      { label: "O'rtacha narx", value: '$0.0007' },
    ],
  },
]

export const servers: Server[] = [
  { id: 'frankfurt-1', name: 'frankfurt-1', role: 'Platforma yadrosi', region: 'Hetzner · FSN1', status: 'healthy', cpu: 23, ram: 41, disk: 37, daemon: 'v0.3.1 · ulangan', uptime: '84 kun' },
  { id: 'helsinki-1', name: 'helsinki-1', role: 'ai-news-bot', region: 'Hetzner · HEL1', status: 'warning', cpu: 12, ram: 58, disk: 84, daemon: 'v0.3.1 · ulangan', uptime: '31 kun', note: "Disk 84% — models_cache tozalash tavsiya etiladi" },
  { id: 'tashkent-1', name: 'tashkent-1', role: 'Media / fayl ombori', region: 'UZ · TAS', status: 'healthy', cpu: 4, ram: 22, disk: 51, daemon: 'v0.3.0 · ulangan', uptime: '112 kun' },
  { id: 'nyc-1', name: 'nyc-1', role: 'Proxy / fetch chiqish nuqtasi', region: 'DO · NYC3', status: 'healthy', cpu: 8, ram: 30, disk: 19, daemon: 'v0.3.1 · ulangan', uptime: '58 kun' },
  { id: 'berlin-1', name: 'berlin-1', role: 'Zaxira (backup)', region: 'Contabo · BER', status: 'healthy', cpu: 2, ram: 14, disk: 62, daemon: 'v0.3.1 · ulangan', uptime: '203 kun' },
]

export const workflowSteps: WorkflowStep[] = [
  { id: 'collector', name: 'Collector', desc: 'RSS + HN + Reddit', status: 'done', stat: '412 element', detail: "32 manbadan yig'ildi, 3 manba Google News orqali" },
  { id: 'dedup', name: 'Dedup', desc: 'Embedding + klasterlash', status: 'done', stat: '247 klaster', detail: '7 kunlik oyna bilan takrorlar birlashtirildi' },
  { id: 'rank', name: 'Rank', desc: 'Baholash + spam filtri', status: 'done', stat: '151 qabul', detail: '96 rad (24 spam) · $0.047 · 0 xato' },
  { id: 'enricher', name: 'Enricher', desc: 'Web search + fetch', status: 'done', stat: '26 boyitildi', detail: "16 fetch, 10 Tavily search · 62 → 4805 belgi" },
  { id: 'writer', name: 'Writer', desc: 'Kanal uslubida post', status: 'done', stat: '5 post', detail: "O'rtacha 840 belgi · $0.037/post · opus-5" },
  { id: 'approval', name: 'Approval', desc: 'Inson tasdig\'i', status: 'running', stat: '4 ✓ · 1 kutmoqda', detail: 'Shaxsiy chatga yuborildi, 1 post javob kutyapti' },
  { id: 'publisher', name: 'Publisher', desc: 'Telegram kanal', status: 'waiting', stat: '4 nashr', detail: 'Takror filtri 1 postni avtomatik chiqarib tashladi' },
]

// 7 kunlik xarajat (USD) — agent kesimida
export const costDays = [
  { day: 'Du', newsBot: 0.092, monitor: 0.004 },
  { day: 'Se', newsBot: 0.078, monitor: 0.003 },
  { day: 'Cho', newsBot: 0.104, monitor: 0.006 },
  { day: 'Pa', newsBot: 0.083, monitor: 0.003 },
  { day: 'Ju', newsBot: 0.117, monitor: 0.004 },
  { day: 'Sha', newsBot: 0.069, monitor: 0.003 },
  { day: 'Ya', newsBot: 0.081, monitor: 0.003 },
]

export const modelCosts = [
  { model: 'claude-opus-5', task: 'Writer', cost: 1.82 },
  { model: 'gemini-3-flash', task: 'Rank + diagnostika', cost: 0.31 },
  { model: 'deepseek-v4', task: 'Til sinovi (nomzod)', cost: 0.14 },
  { model: 'bge-m3 (lokal)', task: 'Embedding', cost: 0.0 },
]

export const llmCalls: LlmCall[] = [
  { time: '12:04:18', agent: 'ai-news-bot', model: 'claude-opus-5', task: 'writer · post #5', tokens: '3.1k → 412', cost: '$0.0371' },
  { time: '12:03:52', agent: 'ai-news-bot', model: 'claude-opus-5', task: 'writer · post #4', tokens: '2.8k → 388', cost: '$0.0344' },
  { time: '12:01:07', agent: 'ai-news-bot', model: 'gemini-3-flash', task: 'rank · 40 klaster', tokens: '18.2k → 1.4k', cost: '$0.0061' },
  { time: '12:00:41', agent: 'ai-news-bot', model: 'gemini-3-flash', task: 'rank · 40 klaster', tokens: '17.9k → 1.3k', cost: '$0.0059' },
  { time: '11:50:12', agent: 'server-monitor', model: 'gemini-3-flash', task: 'diagnostika · helsinki-1 disk', tokens: '2.2k → 310', cost: '$0.0007' },
  { time: '06:02:33', agent: 'ai-news-bot', model: 'gemini-3-flash', task: 'rank · 34 klaster', tokens: '15.1k → 1.2k', cost: '$0.0052' },
]

export const auditLog: AuditEntry[] = [
  { time: '12:06', actor: 'ai-news-bot', action: 'Post nashr qilindi', target: 't.me/kanal/6', level: "o'zgartirish", result: 'tasdiqlandi' },
  { time: '12:04', actor: 'firdavs', action: 'Post tasdiqlandi (✅)', target: 'post #4', level: "o'zgartirish", result: 'OK' },
  { time: '11:50', actor: 'server-monitor', action: 'Disk holati o\'qildi', target: 'helsinki-1', level: "o'qish", result: 'OK' },
  { time: '11:50', actor: 'server-monitor', action: 'Alert yuborildi', target: 'admin chat', level: "o'qish", result: 'OK' },
  { time: '11:32', actor: 'claude-code', action: 'tmux sessiya ochildi', target: 'frankfurt-1', level: "o'zgartirish", result: 'tasdiqlandi' },
  { time: '11:31', actor: 'firdavs', action: "Deploy so'rovi (chat orqali)", target: 'frankfurt-1', level: "o'zgartirish", result: 'OK' },
  { time: '10:14', actor: 'ai-news-bot', action: 'Tavily search chaqiruvi', target: 'enricher', level: "o'qish", result: 'OK' },
  { time: '09:00', actor: 'ai-news-bot', action: 'Health hisobot yuborildi', target: 'admin chat', level: "o'qish", result: 'OK' },
  { time: '08:47', actor: 'skill:postgres-backup', action: 'DROP TABLE urinishi bloklandi', target: 'db-01', level: 'xavfli', result: 'rad etildi' },
  { time: '06:00', actor: 'ai-news-bot', action: 'Pipeline ishga tushdi', target: 'helsinki-1', level: "o'qish", result: 'OK' },
  { time: '05:55', actor: 'server-monitor', action: 'Restart taklifi', target: 'nyc-1 · nginx', level: "o'zgartirish", result: 'kutmoqda' },
  { time: '00:12', actor: 'berlin-1 daemon', action: 'Kunlik backup', target: 'sqlite → berlin-1', level: "o'zgartirish", result: 'tasdiqlandi' },
]

export const skills: Skill[] = [
  {
    id: 'rss-collector',
    name: 'RSS Collector',
    desc: "RSS/Atom manbalardan element yig'ish, buzilgan feed'larga chidamli",
    version: 'v2.1',
    installed: true,
    category: 'Data manba',
    permissions: [
      { level: "o'qish", text: 'Tashqi URL\'larga HTTP so\'rov' },
      { level: "o'zgartirish", text: "Bazaga element yozish" },
    ],
  },
  {
    id: 'telegram-publisher',
    name: 'Telegram Publisher',
    desc: 'Kanalga post chiqarish, approval flow bilan',
    version: 'v1.8',
    installed: true,
    category: 'Chiqish kanali',
    permissions: [
      { level: "o'zgartirish", text: 'Telegram Bot API orqali xabar yuborish' },
      { level: "o'qish", text: 'Kanal statistikasi' },
    ],
  },
  {
    id: 'django-deploy',
    name: 'Django Deploy',
    desc: "Django loyihani serverga chiqarish: venv, gunicorn, nginx, migratsiya",
    version: 'v1.2',
    installed: false,
    category: 'Deploy',
    permissions: [
      { level: "o'zgartirish", text: 'Serverda paket o\'rnatish va servis yaratish' },
      { level: "o'zgartirish", text: 'Nginx konfiguratsiyasini yozish' },
      { level: 'xavfli', text: 'Systemd servisni qayta ishga tushirish' },
    ],
  },
  {
    id: 'fastapi-deploy',
    name: 'FastAPI Deploy',
    desc: "FastAPI + frontend loyihani to'liq deploy qilish: venv, gunicorn, migratsiya, nginx",
    version: 'v1.1',
    installed: true,
    category: 'Deploy',
    permissions: [
      { level: "o'zgartirish", text: 'Serverda venv yaratish va systemd unit yozish' },
      { level: "o'zgartirish", text: "Bazaga migratsiya qo'llash" },
      { level: 'xavfli', text: 'Servisni qayta ishga tushirish (zero-downtime)' },
    ],
  },
  {
    id: 'rust-deploy',
    name: 'Rust Binary Deploy',
    desc: 'Cross-compile qilingan binary\'ni serverga ko\'chirish va servis qilish',
    version: 'v0.9',
    installed: false,
    category: 'Deploy',
    permissions: [
      { level: "o'zgartirish", text: 'Binary yuklash va systemd unit yaratish' },
      { level: 'xavfli', text: 'Eski versiyani almashtirish (rollback saqlanadi)' },
    ],
  },
  {
    id: 'docker-compose-deploy',
    name: 'Docker Compose Deploy',
    desc: "compose.yml asosida stack ko'tarish, preview muhit bilan",
    version: 'v1.5',
    installed: false,
    category: 'Deploy',
    permissions: [
      { level: "o'qish", text: 'Konteyner loglari va holati' },
      { level: "o'zgartirish", text: 'docker compose up / down' },
      { level: 'xavfli', text: 'Volume\'larni o\'chirish (har doim tasdiq bilan)' },
    ],
  },
  {
    id: 'postgres-backup',
    name: 'Postgres Backup',
    desc: 'Kunlik pg_dump, saqlash muddati siyosati bilan',
    version: 'v1.0',
    installed: false,
    category: 'Ma\'lumotlar',
    permissions: [
      { level: "o'qish", text: 'Bazadan pg_dump o\'qish' },
      { level: "o'zgartirish", text: 'Zaxira faylini berlin-1 ga yozish' },
    ],
  },
]

// Chat uchun tayyor javoblar (faqat demo rejim — backend ulanganda o'chadi)
export interface CannedReply {
  match: string[]
  toolCard?: ToolCard
  text: string
  approval?: boolean
}

export const pendingPost = {
  title: 'Til sinovi natijalari: kichik modellar ham yozadi',
  body: "🔬 DeepSeek V4 va Gemini 3 Flash kanal uslubidagi post yozishda sinovdan o'tkazildi. 20 postlik taqqoslovda Flash 17/20 holatda tahririy tekshiruvdan o'tdi — Opus 5'dan 14 barobar arzon narxda. Keyingi hafta writer bosqichi bosqichma-bosqich Flash'ga o'tkaziladi, sifat pasaysa avtomatik rollback.\n\n💰 Kutilayotgan tejash: ~$0.9/oy → $0.06/oy",
  cluster: 'klaster #291 · 3 manba',
}

export const cannedReplies: CannedReply[] = [
  {
    match: ['bugun', 'nima qildi'],
    toolCard: {
      tool: 'bot.stats',
      args: '{ "davr": "bugun" }',
      result: '247 klaster · 151 qabul · 5 post · 4 nashr · $0.084',
    },
    text: "Botingiz bugun 32 manbadan 412 element yig'di, ular 247 klasterga birlashtirildi. Rank bosqichi 151 tasini qabul qildi (24 spam filtrlandi), Writer 5 ta post yozdi — 4 tasi kanalga chiqdi, 1 tasi hozir tasdiq kutyapti. Bugungi jami xarajat: $0.084.",
  },
  {
    match: ['server', 'holat'],
    toolCard: {
      tool: 'monitor.status',
      args: '{ "hamma": true }',
      result: '4 sog\'lom · 1 ogohlantirish (helsinki-1 disk 84%)',
    },
    text: "5 serverdan 4 tasi to'liq sog'lom. helsinki-1 da disk 84% ga yetgan — asosiy sabab models_cache papkasi (embedding modellari). Xohlasangiz tozalash buyrug'ini tayyorlab beraman, u \"o'zgartirish\" darajasida bo'lgani uchun tasdiqingiz bilan bajariladi.",
  },
  {
    match: ['tasdiq', 'post'],
    toolCard: {
      tool: 'bot.pending',
      args: '{}',
      result: '1 post kutmoqda (klaster #291)',
    },
    text: 'Bitta post tasdiq kutyapti:',
    approval: true,
  },
  {
    match: ['xarajat', 'qancha'],
    toolCard: {
      tool: 'llm.costs',
      args: '{ "davr": "7 kun" }',
      result: 'jami $0.65 · eng qimmati: writer (opus-5)',
    },
    text: "Oxirgi 7 kunda jami $0.65 sarflandi. Eng katta ulush — ai-news-bot'ning writer bosqichi (claude-opus-5, $0.037/post). Til sinovi tugagach writer arzon modelga o'tsa, oylik xarajat taxminan 5 barobar tushadi. Har ilovaning xarajati o'z sahifasida ko'rinadi.",
  },
]

export const fallbackReply =
  "Bu demo rejim — orchestrator hali ulanmagan, shuning uchun faqat tayyor stsenariylar ishlaydi. Pastdagi tavsiya tugmalarini sinab ko'ring: bot statistikasi, serverlar holati, tasdiq kutayotgan postlar yoki xarajatlar."

export const botLogLines = [
  '06:00:01 [scheduler] pipeline boshlandi (kunlik run #212)',
  '06:00:02 [collector] 32 manba navbatga qo\'yildi',
  '06:00:14 [collector] openai-blog: 403 → search fallback',
  '06:00:38 [collector] 412 element yig\'ildi (9.2s)',
  '06:01:02 [dedup] embedding: 412 element → bge-m3 (lokal)',
  '06:01:47 [dedup] 247 klaster (7 kunlik oyna)',
  '06:02:10 [rank] gemini-3-flash · batch 1/7',
  '06:04:55 [rank] 151 qabul, 96 rad (24 spam) · $0.047',
  '06:05:12 [enricher] 26 klaster boyitildi (16 fetch, 10 search)',
  '06:08:30 [writer] post #1 yozildi (784 belgi) · $0.036',
  '06:09:02 [writer] post #2 yozildi (911 belgi) · $0.039',
  '06:09:41 [writer] takror filtri: klaster 264 chiqarildi (model ID mos)',
  '06:10:15 [approval] 5 post shaxsiy chatga yuborildi',
  '11:58:00 [publisher] 4 post kanalga chiqdi',
  '12:06:44 [health] approval rate: 96% (30 kunlik)',
]

// ---------------------------------------------------------------------------
// Ilova modullari — platformaning asosiy g'oyasi: yaratilgan har bir dastur
// manifest bilan keladi va o'z dashboardini UI'ga o'zi "olib kiradi".
// Vidjetlar sxema (data) sifatida — host UI ularni dinamik render qiladi,
// yangi ilova uchun frontend qayta build qilinmaydi.
// ---------------------------------------------------------------------------

export const installedApps: AppManifest[] = [
  {
    id: 'ai-news-bot',
    icon: '📰',
    name: 'ai-news-bot',
    tagline: "AI yangiliklarini yig'ib, saralab, Telegram kanalga chiqaradi",
    version: 'v1.4.2',
    service: 'helsinki-1 · docker · uptime 31 kun',
    status: 'running',
    widgets: [
      {
        type: 'stats',
        items: [
          { label: 'Bugungi klasterlar', value: '247' },
          { label: 'Kanalga chiqdi', value: '4', hint: '1 tasdiq kutmoqda' },
          { label: 'Approval rate', value: '96%', accent: 'var(--color-lazur)' },
          { label: 'Bugungi xarajat', value: '$0.084', accent: 'var(--color-gold)' },
        ],
      },
      {
        type: 'table',
        title: 'Oxirgi postlar',
        columns: ['Vaqt', 'Sarlavha', 'Holat'],
        rows: [
          ['12:06', 'Gemini 3 Flash narxi 40% tushdi', 'nashr ✓'],
          ['12:04', 'Til sinovi natijalari: kichik modellar', 'tasdiq kutmoqda'],
          ['11:59', "OpenAI yangi realtime API e'lon qildi", 'nashr ✓'],
          ['11:58', 'Mistral open-weights model chiqardi', 'nashr ✓'],
          ['11:58', 'Claude Fable 5 benchmark natijalari', 'nashr ✓'],
        ],
      },
      {
        type: 'bars',
        title: 'Manba turlari (bugungi 412 element)',
        suffix: ' ta',
        items: [
          { label: 'RSS (rasmiy bloglar)', value: 214 },
          { label: 'Hacker News', value: 102 },
          { label: 'Reddit', value: 71 },
          { label: 'Google News (fallback)', value: 25 },
        ],
      },
      { type: 'note', text: "Keyingi run: bugun 18:00 (Toshkent). Til sinovi tugagach writer arzon modelga o'tadi." },
    ],
  },
]

// Chat orqali "yasab ber" deyilganda quriladigan yangi ilova
const xarajatBotManifest: AppManifest = {
  id: 'xarajat-bot',
  icon: '💸',
  name: 'xarajat-bot',
  tagline: "Telegram orqali kundalik xarajatlarni yozib boradi, oylik hisobot beradi",
  version: 'v0.1.0',
  service: 'frankfurt-1 · docker sandbox · hozirgina deploy qilindi',
  status: 'running',
  widgets: [
    {
      type: 'stats',
      items: [
        { label: 'Bugungi yozuvlar', value: '3', hint: "oxirgisi: 14:02" },
        { label: 'Bugun jami', value: "128 ming", accent: 'var(--color-gold)' },
        { label: 'Iyul jami', value: '2.4 mln' },
        { label: 'Kunlik o\'rtacha', value: '89 ming' },
      ],
    },
    {
      type: 'bars',
      title: 'Kategoriya bo\'yicha (iyul)',
      suffix: '%',
      items: [
        { label: 'Oziq-ovqat', value: 34 },
        { label: 'Transport', value: 18 },
        { label: 'Kommunal', value: 15 },
        { label: 'Texnika', value: 12 },
        { label: 'Boshqa', value: 21 },
      ],
    },
    {
      type: 'table',
      title: 'Oxirgi yozuvlar',
      columns: ['Vaqt', 'Izoh', 'Kategoriya', 'Summa'],
      rows: [
        ['14:02', 'Tushlik', 'Oziq-ovqat', '45 000'],
        ['11:30', 'Yandex taksi', 'Transport', '28 000'],
        ['09:15', 'Kofe', 'Oziq-ovqat', '55 000'],
      ],
    },
    {
      type: 'logs',
      title: 'Servis loglari',
      lines: [
        '14:05:12 [bot] webhook ulandi: @xarajat_demo_bot',
        '14:05:12 [db] sqlite tayyor: 3 jadval, 0 migratsiya kutmoqda',
        '14:05:13 [hisobot] oylik hisobot cron: har oy 1-sana 08:00',
        '14:05:13 [health] platforma daemon bilan handshake OK',
      ],
    },
    { type: 'note', text: "Bot: @xarajat_demo_bot · /hisobot — oylik taqsimot, /export — CSV. Sandbox faqat Telegram API'ga chiqa oladi." },
  ],
}

// ---------------------------------------------------------------------------
// Qurilish rejalari — platforma har xil turdagi loyihalarni yarata oladi:
// bot, static sayt, full-stack. Har reja: qadamlar + (ixtiyoriy) deploy
// tanlovi + tayyor manifest. Real versiyada bu orchestrator'dan oqib keladi.
// ---------------------------------------------------------------------------

const portfolioManifest: AppManifest = {
  id: 'portfolio-site',
  icon: '🌐',
  name: 'portfolio-site',
  tagline: 'Bir sahifali portfolio landing — static, aloqa formasi bilan',
  version: 'v1.0.0',
  service: 'frankfurt-1 · caddy static',
  status: 'running',
  widgets: [
    {
      type: 'stats',
      items: [
        { label: 'Lighthouse', value: '98', hint: 'perf · 100 a11y · 100 SEO', accent: 'var(--color-lazur)' },
        { label: 'Hajm', value: '84 KB', hint: '3 fayl, kutubxonasiz' },
        { label: 'Build vaqti', value: '1.2s' },
        { label: 'Holat', value: 'jonli', accent: 'var(--color-mint)' },
      ],
    },
    {
      type: 'git',
      repo: 'git.platforma.lokal/portfolio-site',
      branch: 'main',
      commits: [
        { hash: '9c2d7ee', msg: 'chore: caddy deploy konfiguratsiyasi', time: 'hozir' },
        { hash: '4be9d01', msg: 'feat: hero, xizmatlar, aloqa formasi', time: '1 daqiqa oldin' },
        { hash: 'aa10f2c', msg: 'init: dizayn tokenlari va skeleton', time: '2 daqiqa oldin' },
      ],
    },
    { type: 'note', text: "O'zgartirish uchun chatda ayting: \"portfolio saytga blog bo'limi qo'sh\" — har o'zgarish git'da commit bo'ladi, xohlasangiz rollback qilinadi." },
  ],
}

const crmManifest: AppManifest = {
  id: 'buyurtma-crm',
  icon: '📦',
  name: 'buyurtma-crm',
  tagline: "FastAPI + React — buyurtmalarni boshqarish tizimi (GitHub'dan deploy qilindi)",
  version: 'v2.3.1',
  service: 'frankfurt-1 + db-01 · docker',
  status: 'running',
  widgets: [
    {
      type: 'stats',
      items: [
        { label: 'API endpointlar', value: '24' },
        { label: 'Testlar', value: '61/61', accent: 'var(--color-mint)' },
        { label: 'Migratsiyalar', value: '12/12' },
        { label: 'Deploy vaqti', value: '3m 12s' },
      ],
    },
    {
      type: 'deploy',
      url: 'https://crm.mening-domen.uz',
      kind: 'domen',
      server: 'frankfurt-1',
      ssl: "Let's Encrypt · avto-yangilanadi",
      extra: 'backend :8000 (faqat ichki) · frontend nginx static',
    },
    {
      type: 'git',
      repo: 'github.com/firdavs/buyurtma-crm',
      branch: 'main',
      commits: [
        { hash: '8f4e2cd', msg: "deploy: platforma manifest qo'shildi", time: 'hozir' },
        { hash: 'b3c90f1', msg: 'feat: PDF eksport', time: 'kecha' },
        { hash: 'e7d21aa', msg: 'fix: buyurtma filtri sanasi', time: '2 kun oldin' },
      ],
    },
    {
      type: 'table',
      title: 'Servislar',
      columns: ['Servis', 'Holat', 'Manzil'],
      rows: [
        ['backend (gunicorn)', 'ishlayapti', 'frankfurt-1:8000'],
        ['frontend (nginx)', 'ishlayapti', 'crm.mening-domen.uz'],
        ['postgres 16', 'ishlayapti', 'db-01:5432'],
        ['redis (navbat)', 'ishlayapti', 'lokal'],
      ],
    },
    { type: 'note', text: "Skill: FastAPI Deploy v1.1 ishlatildi. Keyingi yangilanish bitta gap: \"crm'ni main'dan qayta deploy qil\" — git pull, migratsiya, zero-downtime restart." },
  ],
}

export const buildPlans: BuildPlan[] = [
  {
    id: 'portfolio-site',
    keywords: ['landing', 'sayt', 'website', 'veb', 'portfolio'],
    intro: "Yaxshi — portfolio landing yozishni boshladim. Static bo'ladi (kutubxonasiz, tez), kod platformaning lokal git'ida versiyalanadi. Tayyor bo'lgach qayerga chiqarishni sizdan so'rayman:",
    toolCard: {
      tool: 'builder.create',
      args: '{ "turi": "static-site", "nom": "portfolio-site" }',
      result: 'sandbox tayyor · git repo yaratildi · frankfurt-1',
    },
    steps: [
      { text: 'Talab tahlili: bir sahifali portfolio · static · aloqa formasi', kind: 'info' },
      { text: '● dizayn: token palitra + tipografika tanlandi', kind: 'tool' },
      { text: '● yozildi: index.html · styles.css · app.js (84 KB, kutubxonasiz)', kind: 'tool' },
      { text: '● git: 3 commit (init → feat → deploy config)', kind: 'tool' },
      { text: '  ⎿ Lighthouse: 98 perf · 100 a11y · 100 SEO', kind: 'out' },
      { text: '✓ sayt tayyor — deploy nishonini tanlang', kind: 'done' },
    ],
    choice: {
      question: 'Qayerga chiqaray?',
      options: [
        {
          label: '🌐 portfolio.uz domeniga ulash',
          steps: [
            { text: '● DNS: portfolio.uz → frankfurt-1 (A yozuv)', kind: 'tool' },
            { text: "● caddy: virtual host + Let's Encrypt SSL", kind: 'tool' },
            { text: '✓ jonli: https://portfolio.uz', kind: 'done' },
          ],
          widget: {
            type: 'deploy',
            url: 'https://portfolio.uz',
            kind: 'domen',
            server: 'frankfurt-1',
            ssl: "Let's Encrypt · avto-yangilanadi",
            extra: 'caddy static · gzip + cache sozlandi',
          },
        },
        {
          label: "🔌 Port bilan preview (avval ko'raman)",
          steps: [
            { text: "● preview port ochildi: 8091 (faqat sizning IP'ingizga)", kind: 'tool' },
            { text: '✓ preview: http://frankfurt-1:8091', kind: 'done' },
          ],
          widget: {
            type: 'deploy',
            url: 'http://frankfurt-1:8091',
            kind: 'port',
            server: 'frankfurt-1',
            extra: 'Domenga ulash uchun keyin ayting: "portfolio saytni domenga ula"',
          },
        },
      ],
    },
    manifest: portfolioManifest,
  },
  {
    id: 'buyurtma-crm',
    keywords: ['github', 'deploy', 'crm', 'python'],
    intro: "GitHub'dagi loyihangizni clone qilib tahlil qildim — FastAPI + React + Postgres. Bu katta ish, shuning uchun do'kondan FastAPI Deploy skill'ini yuklab olaman (ruxsatlari ko'rsatiladi) va u butun zanjirni boshqaradi:",
    toolCard: {
      tool: 'builder.deploy',
      args: '{ "manba": "github.com/firdavs/buyurtma-crm" }',
      result: 'clone OK · stack: FastAPI + React + Postgres',
    },
    steps: [
      { text: 'git clone github.com/firdavs/buyurtma-crm · tahlil', kind: 'info' },
      { text: '  ⎿ aniqlandi: FastAPI backend · React frontend · PostgreSQL · redis', kind: 'out' },
      { text: "● skill yuklandi: FastAPI Deploy v1.1 (do'kondan, ruxsatlar tasdiqlandi)", kind: 'tool' },
      { text: '● backend: venv · gunicorn · systemd — db-01 dagi postgres ulandi', kind: 'tool' },
      { text: '● frontend: bun run build → nginx static', kind: 'tool' },
      { text: "  ⎿ migratsiyalar 12/12 · testlar 61/61 o'tdi", kind: 'out' },
      { text: "● domen: crm.mening-domen.uz → SSL o'rnatildi", kind: 'tool' },
      { text: "✓ jonli: https://crm.mening-domen.uz — hammasi audit log'da", kind: 'done' },
    ],
    manifest: crmManifest,
  },
  {
    id: 'xarajat-bot',
    keywords: ['bot yasab', 'bot qil', 'bot yarat', 'kuzatuvchi bot'],
    intro: "Qabul qildim. Xarajat kuzatuvchi Telegram bot uchun sandbox tayyorladim — Claude Code orqa fonda yozishni boshladi. Jarayon jonli, Pro rejimda tmux sessiyasini ham ko'rishingiz mumkin:",
    toolCard: {
      tool: 'builder.create',
      args: '{ "turi": "telegram-bot", "nom": "xarajat-bot" }',
      result: 'sandbox tayyor · frankfurt-1 · ruxsat: faqat Telegram API',
    },
    steps: [
      { text: 'Talab tahlili: Telegram bot · SQLite · oylik hisobot · kategoriya', kind: 'info' },
      { text: '● claude-code · tmux sessiya ochildi (frankfurt-1, sandbox)', kind: 'tool' },
      { text: '  ⎿ skeleton yozildi: bot/ db/ hisobot/ — 14 fayl', kind: 'out' },
      { text: "  ⎿ testlar: 18/18 o'tdi", kind: 'out' },
      { text: '● docker image qurildi: xarajat-bot:0.1.0 (42 MB)', kind: 'tool' },
      { text: "● deploy: frankfurt-1 · ruxsat: faqat Telegram API (o'zgartirish darajasi)", kind: 'tool' },
      { text: "● manifest ro'yxatdan o'tdi: 5 vidjet · sidebar'ga qo'shilmoqda", kind: 'tool' },
      { text: "✓ xarajat-bot ishga tushdi — hammasi audit log'da", kind: 'done' },
    ],
    manifest: xarajatBotManifest,
  },
]

// Umumiy "yasab ber / yarat" so'zlari kelsa-yu, aniq reja topilmasa — bot rejasi
export const genericBuildWords = ['yasab', 'yarat', 'tayyorla', 'qurib ber']

export const tmuxLines = [
  { text: '$ claude -p "helsinki-1 dagi models_cache ni tahlil qil"', kind: 'cmd' },
  { text: '● SSH orqali helsinki-1 ga ulanmoqda...', kind: 'info' },
  { text: '● Bash(du -sh /opt/ai-news-bot/models_cache/*)', kind: 'tool' },
  { text: '  ⎿ 3.1G  bge-m3', kind: 'out' },
  { text: '  ⎿ 1.8G  bge-m3-unused-snapshot-0612', kind: 'out' },
  { text: '  ⎿ 0.4G  tokenizers', kind: 'out' },
  { text: '● Eski snapshot topildi: bge-m3-unused-snapshot-0612 (1.8G)', kind: 'info' },
  { text: "● Bu faylni o'chirish diskni 84% → 61% ga tushiradi.", kind: 'info' },
  { text: "● O'chirish \"o'zgartirish\" darajasida — tasdiq so'ralmoqda...", kind: 'warn' },
  { text: '⏸ Inson tasdig\'i kutilmoqda (chat yoki shu yerdan)', kind: 'wait' },
]
