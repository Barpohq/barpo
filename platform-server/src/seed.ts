// Boshlang'ich ma'lumotlar — platform-ui/src/data/mock.ts dagi seed data.
//
// IDEMPOTENT: har jadval faqat BO'SH bo'lsagina to'ldiriladi. Server qayta
// ishga tushganda mavjud ma'lumot ustiga yozilmaydi, foydalanuvchi kiritgan
// o'zgarishlar saqlanadi.
//
// Keyingi bosqichda real ma'lumot manbalari (daemon telemetriyasi, haqiqiy
// skill do'koni) ulanadi — o'shanda bu fayl faqat bo'sh o'rnatish uchun qoladi.

import type { Database } from 'bun:sqlite'
import type { AppManifest, AuditEntry } from '@platforma/shared'

// Serverlar seed'i ATAYLAB YO'Q (007-migratsiyadan beri): server yozuvi
// haqiqiy SSH ulanishiga ishora qiladi, o'ylab topilgan qator "ulanmaydigan
// server" bo'lib qolardi. Foydalanuvchi serverni Servers sahifasidan qo'shadi.

// ---------------------------------------------------------------------------
// Audit log (eng eskisidan yangisiga — INSERT tartibi shu bo'lishi kerak,
// chunki o'qishda id DESC bo'yicha saralanadi)
// ---------------------------------------------------------------------------

export const seedAuditLog: AuditEntry[] = [
  { time: '00:12', actor: 'berlin-1 daemon', action: 'Daily backup', target: 'sqlite → berlin-1', level: "o'zgartirish", result: 'tasdiqlandi' },
  { time: '05:55', actor: 'server-monitor', action: 'Restart proposed', target: 'nyc-1 · nginx', level: "o'zgartirish", result: 'kutmoqda' },
  { time: '06:00', actor: 'ai-news-bot', action: 'Pipeline started', target: 'helsinki-1', level: "o'qish", result: 'OK' },
  { time: '08:47', actor: 'skill:postgres-backup', action: 'DROP TABLE attempt blocked', target: 'db-01', level: 'xavfli', result: 'rad etildi' },
  { time: '09:00', actor: 'ai-news-bot', action: 'Health report sent', target: 'admin chat', level: "o'qish", result: 'OK' },
  { time: '10:14', actor: 'ai-news-bot', action: 'Tavily search call', target: 'enricher', level: "o'qish", result: 'OK' },
  { time: '11:31', actor: 'firdavs', action: 'Deploy request (via chat)', target: 'frankfurt-1', level: "o'zgartirish", result: 'OK' },
  { time: '11:32', actor: 'claude-code', action: 'tmux session opened', target: 'frankfurt-1', level: "o'zgartirish", result: 'tasdiqlandi' },
  { time: '11:50', actor: 'server-monitor', action: 'Disk usage read', target: 'helsinki-1', level: "o'qish", result: 'OK' },
  { time: '11:50', actor: 'server-monitor', action: 'Alert sent', target: 'admin chat', level: "o'qish", result: 'OK' },
  { time: '12:04', actor: 'firdavs', action: 'Post approved (✅)', target: 'post #4', level: "o'zgartirish", result: 'OK' },
  { time: '12:06', actor: 'ai-news-bot', action: 'Post published', target: 't.me/kanal/6', level: "o'zgartirish", result: 'tasdiqlandi' },
]

// ---------------------------------------------------------------------------
// O'rnatilgan ilovalar
// ---------------------------------------------------------------------------

// Ilovalar seed'i ATAYLAB YO'Q: ilova yozuvi haqiqiy manifest va ishlayotgan
// servisga ishora qiladi, o'ylab topilgan dashboard hech qayerga ulanmagan
// bo'sh sahifa bo'lib qolardi. Ilova chatda quriladi va `appPublish` orqali
// o'rnatiladi.
export const seedApps: AppManifest[] = []

// ---------------------------------------------------------------------------
// Seed qo'llash
// ---------------------------------------------------------------------------

function bosh(db: Database, jadval: string): boolean {
  const q = db.query<{ soni: number }, []>(`SELECT COUNT(*) AS soni FROM ${jadval}`).get()
  return (q?.soni ?? 0) === 0
}

export interface SeedNatija {
  audit: number
  apps: number
}

/**
 * Seed ma'lumotlarni bazaga yozadi. Har jadval mustaqil tekshiriladi —
 * faqat bo'sh jadvallar to'ldiriladi, shuning uchun qayta chaqirish xavfsiz.
 */
export function seedQol(db: Database): SeedNatija {
  const natija: SeedNatija = { audit: 0, apps: 0 }
  const hozir = new Date().toISOString()

  // Skilllar seed'i ATAYLAB YO'Q: skill diskdagi haqiqiy `SKILL.md` bilan
  // bog'langan, ya'ni o'ylab topilgan qator hech qayerga ishora qilmaydi.
  // Foydalanuvchi GitHub manbasini o'zi ulaydi (Skills sahifasi).

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
