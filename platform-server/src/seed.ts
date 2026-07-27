// Boshlang'ich ma'lumotlar — platform-ui/src/data/mock.ts dagi seed data.
//
// IDEMPOTENT: har jadval faqat BO'SH bo'lsagina to'ldiriladi. Server qayta
// ishga tushganda mavjud ma'lumot ustiga yozilmaydi, foydalanuvchi kiritgan
// o'zgarishlar saqlanadi.
//
// Keyingi bosqichda real ma'lumot manbalari (daemon telemetriyasi, haqiqiy
// skill do'koni) ulanadi — o'shanda bu fayl faqat bo'sh o'rnatish uchun qoladi.

import type { Database } from 'bun:sqlite'
import type { AppManifest, AuditEntry, Server, Skill } from '@platforma/shared'

// ---------------------------------------------------------------------------
// Serverlar
// ---------------------------------------------------------------------------

export const seedServers: Server[] = [
  { id: 'frankfurt-1', name: 'frankfurt-1', role: 'Platforma yadrosi', region: 'Hetzner · FSN1', status: 'healthy', cpu: 23, ram: 41, disk: 37, daemon: 'v0.3.1 · ulangan', uptime: '84 kun' },
  { id: 'helsinki-1', name: 'helsinki-1', role: 'ai-news-bot', region: 'Hetzner · HEL1', status: 'warning', cpu: 12, ram: 58, disk: 84, daemon: 'v0.3.1 · ulangan', uptime: '31 kun', note: 'Disk 84% — models_cache tozalash tavsiya etiladi' },
  { id: 'tashkent-1', name: 'tashkent-1', role: 'Media / fayl ombori', region: 'UZ · TAS', status: 'healthy', cpu: 4, ram: 22, disk: 51, daemon: 'v0.3.0 · ulangan', uptime: '112 kun' },
  { id: 'nyc-1', name: 'nyc-1', role: 'Proxy / fetch chiqish nuqtasi', region: 'DO · NYC3', status: 'healthy', cpu: 8, ram: 30, disk: 19, daemon: 'v0.3.1 · ulangan', uptime: '58 kun' },
  { id: 'berlin-1', name: 'berlin-1', role: 'Zaxira (backup)', region: 'Contabo · BER', status: 'healthy', cpu: 2, ram: 14, disk: 62, daemon: 'v0.3.1 · ulangan', uptime: '203 kun' },
]

// ---------------------------------------------------------------------------
// Skill do'koni
// ---------------------------------------------------------------------------

export const seedSkills: Skill[] = [
  {
    id: 'rss-collector',
    name: 'RSS Collector',
    desc: "RSS/Atom manbalardan element yig'ish, buzilgan feed'larga chidamli",
    version: 'v2.1',
    installed: true,
    category: 'Data manba',
    permissions: [
      { level: "o'qish", text: "Tashqi URL'larga HTTP so'rov" },
      { level: "o'zgartirish", text: 'Bazaga element yozish' },
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
    desc: 'Django loyihani serverga chiqarish: venv, gunicorn, nginx, migratsiya',
    version: 'v1.2',
    installed: false,
    category: 'Deploy',
    permissions: [
      { level: "o'zgartirish", text: "Serverda paket o'rnatish va servis yaratish" },
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
    desc: "Cross-compile qilingan binary'ni serverga ko'chirish va servis qilish",
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
      { level: 'xavfli', text: "Volume'larni o'chirish (har doim tasdiq bilan)" },
    ],
  },
  {
    id: 'postgres-backup',
    name: 'Postgres Backup',
    desc: 'Kunlik pg_dump, saqlash muddati siyosati bilan',
    version: 'v1.0',
    installed: false,
    category: "Ma'lumotlar",
    permissions: [
      { level: "o'qish", text: "Bazadan pg_dump o'qish" },
      { level: "o'zgartirish", text: 'Zaxira faylini berlin-1 ga yozish' },
    ],
  },
]

// ---------------------------------------------------------------------------
// Audit log (eng eskisidan yangisiga — INSERT tartibi shu bo'lishi kerak,
// chunki o'qishda id DESC bo'yicha saralanadi)
// ---------------------------------------------------------------------------

export const seedAuditLog: AuditEntry[] = [
  { time: '00:12', actor: 'berlin-1 daemon', action: 'Kunlik backup', target: 'sqlite → berlin-1', level: "o'zgartirish", result: 'tasdiqlandi' },
  { time: '05:55', actor: 'server-monitor', action: 'Restart taklifi', target: 'nyc-1 · nginx', level: "o'zgartirish", result: 'kutmoqda' },
  { time: '06:00', actor: 'ai-news-bot', action: 'Pipeline ishga tushdi', target: 'helsinki-1', level: "o'qish", result: 'OK' },
  { time: '08:47', actor: 'skill:postgres-backup', action: 'DROP TABLE urinishi bloklandi', target: 'db-01', level: 'xavfli', result: 'rad etildi' },
  { time: '09:00', actor: 'ai-news-bot', action: 'Health hisobot yuborildi', target: 'admin chat', level: "o'qish", result: 'OK' },
  { time: '10:14', actor: 'ai-news-bot', action: 'Tavily search chaqiruvi', target: 'enricher', level: "o'qish", result: 'OK' },
  { time: '11:31', actor: 'firdavs', action: "Deploy so'rovi (chat orqali)", target: 'frankfurt-1', level: "o'zgartirish", result: 'OK' },
  { time: '11:32', actor: 'claude-code', action: 'tmux sessiya ochildi', target: 'frankfurt-1', level: "o'zgartirish", result: 'tasdiqlandi' },
  { time: '11:50', actor: 'server-monitor', action: "Disk holati o'qildi", target: 'helsinki-1', level: "o'qish", result: 'OK' },
  { time: '11:50', actor: 'server-monitor', action: 'Alert yuborildi', target: 'admin chat', level: "o'qish", result: 'OK' },
  { time: '12:04', actor: 'firdavs', action: 'Post tasdiqlandi (✅)', target: 'post #4', level: "o'zgartirish", result: 'OK' },
  { time: '12:06', actor: 'ai-news-bot', action: 'Post nashr qilindi', target: 't.me/kanal/6', level: "o'zgartirish", result: 'tasdiqlandi' },
]

// ---------------------------------------------------------------------------
// O'rnatilgan ilovalar
// ---------------------------------------------------------------------------

export const seedApps: AppManifest[] = [
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

// ---------------------------------------------------------------------------
// Seed qo'llash
// ---------------------------------------------------------------------------

function bosh(db: Database, jadval: string): boolean {
  const q = db.query<{ soni: number }, []>(`SELECT COUNT(*) AS soni FROM ${jadval}`).get()
  return (q?.soni ?? 0) === 0
}

export interface SeedNatija {
  servers: number
  skills: number
  audit: number
  apps: number
}

/**
 * Seed ma'lumotlarni bazaga yozadi. Har jadval mustaqil tekshiriladi —
 * faqat bo'sh jadvallar to'ldiriladi, shuning uchun qayta chaqirish xavfsiz.
 */
export function seedQol(db: Database): SeedNatija {
  const natija: SeedNatija = { servers: 0, skills: 0, audit: 0, apps: 0 }
  const hozir = new Date().toISOString()

  if (bosh(db, 'servers')) {
    const st = db.prepare(
      `INSERT INTO servers (id, name, role, region, status, cpu, ram, disk, daemon, uptime, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    db.transaction(() => {
      for (const s of seedServers) {
        st.run(s.id, s.name, s.role, s.region, s.status, s.cpu, s.ram, s.disk, s.daemon, s.uptime, s.note ?? null)
        natija.servers++
      }
    })()
  }

  if (bosh(db, 'skills')) {
    const st = db.prepare(
      `INSERT INTO skills (id, name, desc, version, installed, category, permissions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    db.transaction(() => {
      for (const s of seedSkills) {
        st.run(s.id, s.name, s.desc, s.version, s.installed ? 1 : 0, s.category, JSON.stringify(s.permissions))
        natija.skills++
      }
    })()
  }

  // Audit seed'i to'g'ridan-to'g'ri yoziladi (auditYoz emas) — bular tarixiy
  // yozuvlar, ularni WS orqali "yangi hodisa" sifatida tarqatish noto'g'ri
  // bo'lardi va vaqt maydonlari ham o'tmishdagi qiymatlar.
  if (bosh(db, 'audit_log')) {
    const st = db.prepare(
      `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const kun = hozir.slice(0, 10)
    db.transaction(() => {
      for (const a of seedAuditLog) {
        st.run(a.time, a.actor, a.action, a.target, a.level, a.result, `${kun}T${a.time}:00.000Z`)
        natija.audit++
      }
    })()
  }

  if (bosh(db, 'apps')) {
    const st = db.prepare(
      `INSERT INTO apps (id, manifest, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
    db.transaction(() => {
      for (const a of seedApps) {
        st.run(a.id, JSON.stringify(a), a.status, hozir, hozir)
        natija.apps++
      }
    })()
  }

  return natija
}
