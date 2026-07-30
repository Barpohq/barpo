// Baza bilan ishlash qatlami — SQL faqat shu yerda (va audit.ts da) yoziladi.
// Route fayllari SQL yozmaydi, shu funksiyalarni chaqiradi. Sabab: jadval
// sxemasi o'zgarganda bitta joy tahrirlansa yetadi.

import type { Database } from 'bun:sqlite'
import type {
  AppManifest,
  AppRecord,
  BuildSession,
  BuildSessionStatus,
  ChatBiriktirma,
  ChatMessage,
  ChatSession,
  McpKatalogManbaTuri,
  McpKatalogYozuvi,
  McpManba,
  McpOrnatish,
  McpQamrov,
  McpServer,
  McpSozlamaMaydoni,
  McpTransportTuri,
  Project,
  Server,
  Skill,
  SkillManba,
  SkillManbaTuri,
  SkillOrnatish,
  SkillQamrov,
  ToolCard,
  ToolChaqiruv,
} from '@platforma/shared'
import { manifestniTekshir } from '@platforma/shared'
import { db as globalDb } from './db.ts'

// ---------------------------------------------------------------------------
// Serverlar
// ---------------------------------------------------------------------------

interface ServerQator {
  id: string
  name: string
  host: string
  port: number
  username: string
  created_at: string
}

function serverQatordan(q: ServerQator): Server {
  return {
    id: q.id,
    name: q.name,
    host: q.host,
    port: q.port,
    username: q.username,
    createdAt: q.created_at,
  }
}

export function serverlarOqi(baza?: Database): Server[] {
  const d = baza ?? globalDb()
  return d
    .query<ServerQator, []>('SELECT * FROM servers ORDER BY rowid')
    .all()
    .map(serverQatordan)
}

export function serverIdBoyicha(id: string, baza?: Database): Server | null {
  const d = baza ?? globalDb()
  const q = d.query<ServerQator, [string]>('SELECT * FROM servers WHERE id = ?').get(id)
  return q ? serverQatordan(q) : null
}

export function serverNomBoyicha(name: string, baza?: Database): Server | null {
  const d = baza ?? globalDb()
  const q = d.query<ServerQator, [string]>('SELECT * FROM servers WHERE name = ?').get(name)
  return q ? serverQatordan(q) : null
}

export function serverYarat(
  malumot: { name: string; host: string; port: number; username: string },
  baza?: Database,
): Server {
  const d = baza ?? globalDb()
  const server: Server = {
    id: crypto.randomUUID(),
    name: malumot.name,
    host: malumot.host,
    port: malumot.port,
    username: malumot.username,
    createdAt: new Date().toISOString(),
  }
  d.query(
    'INSERT INTO servers (id, name, host, port, username, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(server.id, server.name, server.host, server.port, server.username, server.createdAt)
  return server
}

export function serverOchir(id: string, baza?: Database): boolean {
  const d = baza ?? globalDb()
  const q = d.query('DELETE FROM servers WHERE id = ?').run(id)
  return q.changes > 0
}

// ---------------------------------------------------------------------------
// Skilllar
// ---------------------------------------------------------------------------
//
// Uch jadval: manba (repo) → skill (katalog yozuvi) → o'rnatish (qamrov).
// Batafsil model izohi: migrations/006-skilllar.ts.

interface ManbaQator {
  id: string
  tur: SkillManbaTuri
  url: string
  owner: string
  repo: string
  ref: string
  commit_sha: string | null
  oxirgi_sinxron: string | null
  created_at: string
}

function manbaQatordan(q: ManbaQator): SkillManba {
  return {
    id: q.id,
    tur: q.tur,
    url: q.url,
    owner: q.owner,
    repo: q.repo,
    ref: q.ref,
    commitSha: q.commit_sha,
    oxirgiSinxron: q.oxirgi_sinxron,
    createdAt: q.created_at,
  }
}

export function manbalarOqi(baza?: Database): SkillManba[] {
  const d = baza ?? globalDb()
  return d
    .query<ManbaQator, []>('SELECT * FROM skill_manbalari ORDER BY created_at')
    .all()
    .map(manbaQatordan)
}

export function manbaOqi(id: string, baza?: Database): SkillManba | null {
  const d = baza ?? globalDb()
  const q = d.query<ManbaQator, [string]>('SELECT * FROM skill_manbalari WHERE id = ?').get(id)
  return q ? manbaQatordan(q) : null
}

/**
 * Manbani yaratadi yoki mavjudini qaytaradi.
 *
 * Takroriy ulash XATO EMAS: foydalanuvchi bir repo'ni ikki marta qo'shsa,
 * "allaqachon bor" deb yiqilishdan ko'ra mavjudini qaytargan tuzukroq —
 * natija baribir u kutgan holat (repo ulangan).
 */
export function manbaYarat(
  m: Omit<SkillManba, 'id' | 'commitSha' | 'oxirgiSinxron' | 'createdAt'>,
  baza?: Database,
): SkillManba {
  const d = baza ?? globalDb()
  const mavjud = d
    .query<ManbaQator, [string, string, string]>(
      'SELECT * FROM skill_manbalari WHERE owner = ? AND repo = ? AND ref = ?',
    )
    .get(m.owner, m.repo, m.ref)
  if (mavjud) return manbaQatordan(mavjud)

  const id = crypto.randomUUID()
  const hozir = new Date().toISOString()
  d.prepare(
    `INSERT INTO skill_manbalari (id, tur, url, owner, repo, ref, commit_sha, oxirgi_sinxron, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(id, m.tur, m.url, m.owner, m.repo, m.ref, hozir)

  return { ...m, id, commitSha: null, oxirgiSinxron: null, createdAt: hozir }
}

/** Manba va uning HAMMA skilllari (CASCADE orqali o'rnatishlar ham) o'chadi */
export function manbaOchir(id: string, baza?: Database): boolean {
  const d = baza ?? globalDb()
  return d.prepare('DELETE FROM skill_manbalari WHERE id = ?').run(id).changes > 0
}

interface SkillQator {
  id: string
  manba_id: string
  yol: string
  nom: string
  tavsif: string
  litsenziya: string | null
  allowed_tools: string | null
  ogohlantirishlar: string
}

/**
 * `skilllar` + `skill_ornatish` ni birlashtirib qaytaradi.
 *
 * O'rnatishlar alohida so'rov bilan olinadi va xotirada bog'lanadi (JOIN
 * emas): JOIN bir skillni har o'rnatish uchun takrorlab yuborardi va uni
 * qayta yig'ish kerak bo'lardi. Skilllar soni yuzlab — bu tezlik muammosi emas.
 */
function skilllarniYig(qatorlar: SkillQator[], d: Database): Skill[] {
  const ornatishlar = new Map<string, SkillOrnatish[]>()
  for (const o of d
    .query<{ skill_id: string; qamrov: SkillQamrov; project_id: string | null }, []>(
      'SELECT skill_id, qamrov, project_id FROM skill_ornatish',
    )
    .all()) {
    const royxat = ornatishlar.get(o.skill_id) ?? []
    royxat.push({ qamrov: o.qamrov, projectId: o.project_id ?? undefined })
    ornatishlar.set(o.skill_id, royxat)
  }

  return qatorlar.map((q) => ({
    id: q.id,
    manbaId: q.manba_id,
    yol: q.yol,
    nom: q.nom,
    tavsif: q.tavsif,
    litsenziya: q.litsenziya ?? undefined,
    allowedTools: q.allowed_tools ? (JSON.parse(q.allowed_tools) as string[]) : undefined,
    ogohlantirishlar: JSON.parse(q.ogohlantirishlar) as string[],
    ornatilgan: ornatishlar.get(q.id) ?? [],
  }))
}

/** Butun katalog — o'rnatilgani ham, o'rnatilmagani ham */
export function skilllarOqi(baza?: Database): Skill[] {
  const d = baza ?? globalDb()
  const qatorlar = d.query<SkillQator, []>('SELECT * FROM skilllar ORDER BY nom').all()
  return skilllarniYig(qatorlar, d)
}

export function skillOqi(id: string, baza?: Database): Skill | null {
  const d = baza ?? globalDb()
  const q = d.query<SkillQator, [string]>('SELECT * FROM skilllar WHERE id = ?').get(id)
  return q ? (skilllarniYig([q], d)[0] ?? null) : null
}

/**
 * Loyihada FAOL skilllar: global o'rnatilganlar + shu loyihaga
 * o'rnatilganlar. `projectId` null bo'lsa (loyihasiz sessiya) faqat global.
 *
 * Sessiya boshida `.platforma/skills/` shu ro'yxatga qarab quriladi.
 */
export function faolSkilllar(projectId: string | null, baza?: Database): Skill[] {
  const d = baza ?? globalDb()
  const qatorlar = d
    .query<SkillQator, [string | null]>(
      `SELECT DISTINCT s.* FROM skilllar s
         JOIN skill_ornatish o ON o.skill_id = s.id
        WHERE o.qamrov = 'global' OR o.project_id = ?
        ORDER BY s.nom`,
    )
    .all(projectId)
  return skilllarniYig(qatorlar, d)
}

/**
 * Sinxronlash natijasini bazaga yozadi: topilganlar UPSERT qilinadi,
 * yo'qolganlar o'chiriladi.
 *
 * UPSERT (INSERT emas) ATAYLAB: qayta sinxronlashda skill `id` si o'zgarmasa,
 * unga bog'langan o'rnatishlar saqlanadi. Aks holda foydalanuvchi har
 * sinxrondan keyin hammasini qayta o'rnatishga majbur bo'lardi.
 */
export function skilllarniSinxronla(
  manbaId: string,
  topilgan: Omit<Skill, 'id' | 'manbaId' | 'ornatilgan'>[],
  commitSha: string | null,
  baza?: Database,
): { qoshildi: number; yangilandi: number; ochirildi: number } {
  const d = baza ?? globalDb()
  const natija = { qoshildi: 0, yangilandi: 0, ochirildi: 0 }

  d.transaction(() => {
    const eskiYollar = new Set(
      d
        .query<{ yol: string }, [string]>('SELECT yol FROM skilllar WHERE manba_id = ?')
        .all(manbaId)
        .map((q) => q.yol),
    )

    const st = d.prepare(
      `INSERT INTO skilllar (id, manba_id, yol, nom, tavsif, litsenziya, allowed_tools, ogohlantirishlar)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (manba_id, yol) DO UPDATE SET
            nom = excluded.nom,
            tavsif = excluded.tavsif,
            litsenziya = excluded.litsenziya,
            allowed_tools = excluded.allowed_tools,
            ogohlantirishlar = excluded.ogohlantirishlar`,
    )

    for (const s of topilgan) {
      st.run(
        crypto.randomUUID(),
        manbaId,
        s.yol,
        s.nom,
        s.tavsif,
        s.litsenziya ?? null,
        s.allowedTools ? JSON.stringify(s.allowedTools) : null,
        JSON.stringify(s.ogohlantirishlar),
      )
      if (eskiYollar.delete(s.yol)) natija.yangilandi++
      else natija.qoshildi++
    }

    // Repo'dan olib tashlangan skilllar — CASCADE o'rnatishlarni ham tozalaydi
    const ochir = d.prepare('DELETE FROM skilllar WHERE manba_id = ? AND yol = ?')
    for (const yol of eskiYollar) {
      ochir.run(manbaId, yol)
      natija.ochirildi++
    }

    d.prepare('UPDATE skill_manbalari SET commit_sha = ?, oxirgi_sinxron = ? WHERE id = ?').run(
      commitSha,
      new Date().toISOString(),
      manbaId,
    )
  })()

  return natija
}

/** Idempotent — allaqachon o'rnatilgan bo'lsa jim o'tadi */
export function skillOrnat(
  skillId: string,
  qamrov: SkillQamrov,
  projectId: string | null,
  baza?: Database,
): void {
  const d = baza ?? globalDb()
  d.prepare(
    `INSERT INTO skill_ornatish (id, skill_id, qamrov, project_id, created_at)
          VALUES (?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(crypto.randomUUID(), skillId, qamrov, projectId, new Date().toISOString())
}

export function skillOrnatishniOchir(
  skillId: string,
  qamrov: SkillQamrov,
  projectId: string | null,
  baza?: Database,
): boolean {
  const d = baza ?? globalDb()
  return (
    d
      .prepare(
        `DELETE FROM skill_ornatish
          WHERE skill_id = ? AND qamrov = ? AND COALESCE(project_id, '') = COALESCE(?, '')`,
      )
      .run(skillId, qamrov, projectId).changes > 0
  )
}

// ---------------------------------------------------------------------------
// MCP serverlar
// ---------------------------------------------------------------------------
//
// Yuqoridagi skilllar bo'limi bilan AYNAN BIR XIL uch qatlamli naqsh
// (manba → katalog → o'rnatish) va bir xil qoidalar:
//   - `mcpManbaYarat` idempotent (takroriy ulash xato emas);
//   - `mcpServerlarniSinxronla` UPSERT + diff, id o'zgarmaydi;
//   - o'rnatish alohida jadvalda, `COALESCE` bilan global/loyiha solishtiriladi.
//
// FARQ: `McpOrnatish` da `id` va `sozlamaQiymatlari` bor. `id` kerak, chunki
// maxfiy kredensiallar shu id bo'yicha alohida faylda saqlanadi
// (`mcp-kredensial.ts`) — skilllarda saqlanadigan narsa yo'q edi.
//
// Batafsil model izohi: migrations/011-mcp-serverlar.ts.

interface McpManbaQator {
  id: string
  tur: McpKatalogManbaTuri
  manba_nomi: string
  owner: string | null
  repo: string | null
  ref: string
  oxirgi_sinxron: string | null
  created_at: string
}

function mcpManbaQatordan(q: McpManbaQator): McpManba {
  return {
    id: q.id,
    tur: q.tur,
    manbaNomi: q.manba_nomi,
    owner: q.owner,
    repo: q.repo,
    ref: q.ref,
    oxirgiSinxron: q.oxirgi_sinxron,
    createdAt: q.created_at,
  }
}

export function mcpManbalarOqi(baza?: Database): McpManba[] {
  const d = baza ?? globalDb()
  return d
    .query<McpManbaQator, []>('SELECT * FROM mcp_manbalari ORDER BY created_at')
    .all()
    .map(mcpManbaQatordan)
}

export function mcpManbaOqi(id: string, baza?: Database): McpManba | null {
  const d = baza ?? globalDb()
  const q = d.query<McpManbaQator, [string]>('SELECT * FROM mcp_manbalari WHERE id = ?').get(id)
  return q ? mcpManbaQatordan(q) : null
}

/**
 * Manbani yaratadi yoki mavjudini qaytaradi.
 *
 * `manbaYarat` (skilllar) bilan bir xil qoida: takroriy ulash XATO EMAS,
 * chunki natija baribir foydalanuvchi kutgan holat. Faqat yagonalik kaliti
 * boshqacha — bu yerda `(tur, manba_nomi, ref)`, chunki manba GitHub repo
 * bo'lishi ham, registry yozuvi yoki qo'lda kiritilgan nom bo'lishi ham
 * mumkin.
 */
export function mcpManbaYarat(
  m: Omit<McpManba, 'id' | 'oxirgiSinxron' | 'createdAt'>,
  baza?: Database,
): McpManba {
  const d = baza ?? globalDb()
  const mavjud = d
    .query<McpManbaQator, [string, string, string]>(
      'SELECT * FROM mcp_manbalari WHERE tur = ? AND manba_nomi = ? AND ref = ?',
    )
    .get(m.tur, m.manbaNomi, m.ref)
  if (mavjud) return mcpManbaQatordan(mavjud)

  const id = crypto.randomUUID()
  const hozir = new Date().toISOString()
  d.prepare(
    `INSERT INTO mcp_manbalari (id, tur, manba_nomi, owner, repo, ref, oxirgi_sinxron, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(id, m.tur, m.manbaNomi, m.owner, m.repo, m.ref, hozir)

  return { ...m, id, oxirgiSinxron: null, createdAt: hozir }
}

/** Manba, uning serverlari va o'rnatishlari (CASCADE) o'chadi */
export function mcpManbaOchir(id: string, baza?: Database): boolean {
  const d = baza ?? globalDb()
  return d.prepare('DELETE FROM mcp_manbalari WHERE id = ?').run(id).changes > 0
}

interface McpServerQator {
  id: string
  manba_id: string
  nom: string
  tavsif: string
  transport: McpTransportTuri
  buyruq: string | null
  argumentlar: string | null
  url: string | null
  sozlamalar: string
}

/**
 * `mcp_serverlar` + `mcp_ornatish` ni birlashtiradi.
 *
 * `skilllarniYig` bilan bir xil sabab bo'yicha JOIN emas: JOIN bir serverni
 * har o'rnatish uchun takrorlab yuborardi.
 */
function mcpServerlarniYig(qatorlar: McpServerQator[], d: Database): McpServer[] {
  const ornatishlar = new Map<string, McpOrnatish[]>()
  for (const o of d
    .query<
      {
        id: string
        server_id: string
        qamrov: McpQamrov
        project_id: string | null
        sozlama_qiymatlari: string
      },
      []
    >('SELECT id, server_id, qamrov, project_id, sozlama_qiymatlari FROM mcp_ornatish')
    .all()) {
    const royxat = ornatishlar.get(o.server_id) ?? []
    royxat.push({
      id: o.id,
      qamrov: o.qamrov,
      projectId: o.project_id ?? undefined,
      sozlamaQiymatlari: JSON.parse(o.sozlama_qiymatlari) as Record<string, string>,
    })
    ornatishlar.set(o.server_id, royxat)
  }

  return qatorlar.map((q) => ({
    id: q.id,
    manbaId: q.manba_id,
    nom: q.nom,
    tavsif: q.tavsif,
    transport: q.transport,
    buyruq: q.buyruq ?? undefined,
    argumentlar: q.argumentlar ? (JSON.parse(q.argumentlar) as string[]) : undefined,
    url: q.url ?? undefined,
    sozlamalar: JSON.parse(q.sozlamalar) as McpSozlamaMaydoni[],
    // Katalog yozuvi manbadan keladi va o'z `created_at` ustuni yo'q —
    // sinxronlashda u qayta yozilishi mumkin, ya'ni "qachon paydo bo'lgani"
    // manba darajasida ma'noli. UI'da ham manba sanasi ko'rsatiladi.
    createdAt: '',
    ornatilgan: ornatishlar.get(q.id) ?? [],
  }))
}

/** Butun katalog — o'rnatilgani ham, o'rnatilmagani ham */
export function mcpServerlarOqi(baza?: Database): McpServer[] {
  const d = baza ?? globalDb()
  const qatorlar = d.query<McpServerQator, []>('SELECT * FROM mcp_serverlar ORDER BY nom').all()
  return mcpServerlarniYig(qatorlar, d)
}

export function mcpServerOqi(id: string, baza?: Database): McpServer | null {
  const d = baza ?? globalDb()
  const q = d.query<McpServerQator, [string]>('SELECT * FROM mcp_serverlar WHERE id = ?').get(id)
  return q ? (mcpServerlarniYig([q], d)[0] ?? null) : null
}

/**
 * Loyihada FAOL MCP serverlar: global o'rnatilganlar + shu loyihaga
 * o'rnatilganlar. `faolSkilllar` bilan bir xil so'rov.
 *
 * Sessiya boshida shu ro'yxatga qarab ulanish amalga oshiriladi
 * (`orchestrator.ts` → `agentOqimi` → `McpBoshqaruvchi`).
 */
export function faolMcpServerlar(projectId: string | null, baza?: Database): McpServer[] {
  const d = baza ?? globalDb()
  const qatorlar = d
    .query<McpServerQator, [string | null]>(
      `SELECT DISTINCT s.* FROM mcp_serverlar s
         JOIN mcp_ornatish o ON o.server_id = s.id
        WHERE o.qamrov = 'global' OR o.project_id = ?
        ORDER BY s.nom`,
    )
    .all(projectId)
  return mcpServerlarniYig(qatorlar, d)
}

/**
 * Skanerlash natijasini bazaga yozadi: topilganlar UPSERT, yo'qolganlar
 * o'chiriladi.
 *
 * `skilllarniSinxronla` bilan bir xil sabab bo'yicha UPSERT: server `id` si
 * saqlansa, unga bog'langan o'rnatishlar VA kredensiallar (ular o'rnatish
 * id'siga bog'langan) joyida qoladi. INSERT bo'lsa foydalanuvchi har
 * sinxrondan keyin tokenni qaytadan kiritishga majbur bo'lardi.
 */
export function mcpServerlarniSinxronla(
  manbaId: string,
  topilgan: Omit<McpKatalogYozuvi, 'id' | 'manbaId' | 'createdAt'>[],
  baza?: Database,
): { qoshildi: number; yangilandi: number; ochirildi: number } {
  const d = baza ?? globalDb()
  const natija = { qoshildi: 0, yangilandi: 0, ochirildi: 0 }

  d.transaction(() => {
    const eskiNomlar = new Set(
      d
        .query<{ nom: string }, [string]>('SELECT nom FROM mcp_serverlar WHERE manba_id = ?')
        .all(manbaId)
        .map((q) => q.nom),
    )

    const st = d.prepare(
      `INSERT INTO mcp_serverlar (id, manba_id, nom, tavsif, transport, buyruq, argumentlar, url, sozlamalar)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (manba_id, nom) DO UPDATE SET
            tavsif = excluded.tavsif,
            transport = excluded.transport,
            buyruq = excluded.buyruq,
            argumentlar = excluded.argumentlar,
            url = excluded.url,
            sozlamalar = excluded.sozlamalar`,
    )

    for (const s of topilgan) {
      st.run(
        crypto.randomUUID(),
        manbaId,
        s.nom,
        s.tavsif,
        s.transport,
        s.buyruq ?? null,
        s.argumentlar ? JSON.stringify(s.argumentlar) : null,
        s.url ?? null,
        JSON.stringify(s.sozlamalar),
      )
      if (eskiNomlar.delete(s.nom)) natija.yangilandi++
      else natija.qoshildi++
    }

    // Manbadan yo'qolgan serverlar — CASCADE o'rnatishlarni ham tozalaydi
    const ochir = d.prepare('DELETE FROM mcp_serverlar WHERE manba_id = ? AND nom = ?')
    for (const nom of eskiNomlar) {
      ochir.run(manbaId, nom)
      natija.ochirildi++
    }

    d.prepare('UPDATE mcp_manbalari SET oxirgi_sinxron = ? WHERE id = ?').run(
      new Date().toISOString(),
      manbaId,
    )
  })()

  return natija
}

/**
 * Serverni o'rnatadi va o'rnatish id'sini qaytaradi.
 *
 * ID QAYTARILADI (skilllardan farqli): maxfiy kredensiallar shu id bo'yicha
 * saqlanadi, ya'ni chaqiruvchiga u kerak.
 *
 * Idempotent: allaqachon o'rnatilgan bo'lsa sozlama qiymatlari YANGILANADI
 * va mavjud id qaytariladi. Sabab — foydalanuvchi uchun "o'rnatish" tugmasi
 * ikkinchi marta bosilganda sozlamani tahrirlash ma'nosini beradi; yangi
 * qator yaratsak eski kredensial yetim qolardi.
 */
export function mcpServerOrnat(
  serverId: string,
  qamrov: McpQamrov,
  projectId: string | null,
  sozlamaQiymatlari: Record<string, string>,
  baza?: Database,
): string {
  const d = baza ?? globalDb()
  const qiymatlar = JSON.stringify(sozlamaQiymatlari)

  const mavjud = d
    .query<{ id: string }, [string, McpQamrov, string | null]>(
      `SELECT id FROM mcp_ornatish
        WHERE server_id = ? AND qamrov = ? AND COALESCE(project_id, '') = COALESCE(?, '')`,
    )
    .get(serverId, qamrov, projectId)

  if (mavjud) {
    d.prepare('UPDATE mcp_ornatish SET sozlama_qiymatlari = ? WHERE id = ?').run(
      qiymatlar,
      mavjud.id,
    )
    return mavjud.id
  }

  const id = crypto.randomUUID()
  d.prepare(
    `INSERT INTO mcp_ornatish (id, server_id, qamrov, project_id, sozlama_qiymatlari, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, serverId, qamrov, projectId, qiymatlar, new Date().toISOString())
  return id
}

/**
 * O'rnatishni bekor qiladi. O'chirilgan qatorning id'sini qaytaradi (yoki
 * null) — chaqiruvchi shu id bo'yicha kredensialni ham tozalaydi.
 */
export function mcpServerOrnatishniOchir(
  serverId: string,
  qamrov: McpQamrov,
  projectId: string | null,
  baza?: Database,
): string | null {
  const d = baza ?? globalDb()
  const mavjud = d
    .query<{ id: string }, [string, McpQamrov, string | null]>(
      `SELECT id FROM mcp_ornatish
        WHERE server_id = ? AND qamrov = ? AND COALESCE(project_id, '') = COALESCE(?, '')`,
    )
    .get(serverId, qamrov, projectId)
  if (!mavjud) return null

  d.prepare('DELETE FROM mcp_ornatish WHERE id = ?').run(mavjud.id)
  return mavjud.id
}

// ---------------------------------------------------------------------------
// Ilovalar
// ---------------------------------------------------------------------------

interface AppQator {
  id: string
  manifest: string
  status: AppRecord['status']
  created_at: string
  updated_at: string
}

/**
 * DB qatorini `AppRecord` ga aylantiradi. Manifest YAROQSIZ bo'lsa `null`.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ NEGA BU YERDA TEKSHIRUV BOR. Avval `JSON.parse(...) as AppManifest` │
 * │ yozilgan edi — ya'ni tip KAFOLATI yo'q, faqat va'da. Manifestni AI  │
 * │ yozadi, ustiga u bazada yotadi va sxema keyinchalik o'zgarishi      │
 * │ mumkin. Buzuq qiymat o'sha kastdan jimgina o'tib, keyin UI'da       │
 * │ render paytida yiqilardi — foydalanuvchi uchun bu "platforma        │
 * │ ishlamayapti" bo'lib ko'rinadi.                                     │
 * │                                                                     │
 * │ Endi buzuq yozuv SHU YERDA to'xtaydi: ilova ro'yxatdan tushadi,     │
 * │ qolgan hammasi ishlayveradi.                                        │
 * └────────────────────────────────────────────────────────────────────┘
 */
function appQatordan(q: AppQator): AppRecord | null {
  let xom: unknown
  try {
    xom = JSON.parse(q.manifest)
  } catch {
    // Buzuq JSON — yozuv o'qib bo'lmaydi. Tashlaymiz, yiqilmaymiz.
    return null
  }

  const natija = manifestniTekshir(xom)
  if (!natija.ok || !natija.qiymat) return null

  return {
    id: q.id,
    manifest: natija.qiymat,
    status: q.status,
    createdAt: q.created_at,
    updatedAt: q.updated_at,
  }
}

export function ilovalarOqi(baza?: Database): AppRecord[] {
  const d = baza ?? globalDb()
  return d
    .query<AppQator, []>('SELECT * FROM apps ORDER BY created_at')
    .all()
    .map(appQatordan)
    .filter((a): a is AppRecord => a !== null)
}

export function ilovaOqi(id: string, baza?: Database): AppRecord | null {
  const d = baza ?? globalDb()
  const q = d.query<AppQator, [string]>('SELECT * FROM apps WHERE id = ?').get(id)
  return q ? appQatordan(q) : null
}

/**
 * Manifestni yozadi yoki yangilaydi (upsert). Yangi ilova o'rnatilganda ham,
 * mavjudi yangilanganda ham shu funksiya ishlatiladi — qaysi biri bo'lganini
 * qaytariladigan `yangi` bayrog'i aytadi (WS eventini tanlash uchun kerak).
 */
export function ilovaSaqla(
  manifest: AppManifest,
  baza?: Database,
): { record: AppRecord; yangi: boolean } {
  const d = baza ?? globalDb()
  const hozir = new Date().toISOString()
  const mavjud = ilovaOqi(manifest.id, d)

  if (mavjud) {
    d.prepare('UPDATE apps SET manifest = ?, status = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(manifest),
      manifest.status,
      hozir,
      manifest.id,
    )
    return {
      record: { ...mavjud, manifest, status: manifest.status, updatedAt: hozir },
      yangi: false,
    }
  }

  d.prepare('INSERT INTO apps (id, manifest, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    manifest.id,
    JSON.stringify(manifest),
    manifest.status,
    hozir,
    hozir,
  )
  return {
    record: { id: manifest.id, manifest, status: manifest.status, createdAt: hozir, updatedAt: hozir },
    yangi: true,
  }
}

// ---------------------------------------------------------------------------
// Loyihalar
// ---------------------------------------------------------------------------

interface LoyihaQator {
  id: string
  name: string
  papka: string
  created_at: string
}

function loyihaQatordan(q: LoyihaQator, chatlarSoni?: number): Project {
  return {
    id: q.id,
    name: q.name,
    papka: q.papka,
    createdAt: q.created_at,
    chatlarSoni,
  }
}

/**
 * Barcha loyihalar, har biriga ulangan chatlar soni bilan.
 *
 * `LEFT JOIN`: chati yo'q loyiha ham ro'yxatda ko'rinadi (0 bilan).
 */
export function loyihalarOqi(baza?: Database): Project[] {
  const d = baza ?? globalDb()
  return d
    .query<LoyihaQator & { chatlar: number }, []>(
      `SELECT p.*, COUNT(s.id) AS chatlar
         FROM projects p
         LEFT JOIN chat_sessions s ON s.project_id = p.id
        GROUP BY p.id
        ORDER BY p.created_at DESC`,
    )
    .all()
    .map((q) => loyihaQatordan(q, q.chatlar))
}

export function loyihaOqi(id: string, baza?: Database): Project | null {
  const d = baza ?? globalDb()
  const q = d.query<LoyihaQator, [string]>('SELECT * FROM projects WHERE id = ?').get(id)
  return q ? loyihaQatordan(q) : null
}

/** Nom bo'yicha izlash — takroriy nomni oldindan ushlash uchun */
export function loyihaNomBoyicha(name: string, baza?: Database): Project | null {
  const d = baza ?? globalDb()
  const q = d.query<LoyihaQator, [string]>('SELECT * FROM projects WHERE name = ?').get(name)
  return q ? loyihaQatordan(q) : null
}

/**
 * Loyiha yozuvini yaratadi. Papkani chaqiruvchi (route) yaratadi va to'liq
 * yo'lini beradi — bu qatlam fayl tizimiga tegmaydi.
 *
 * Nom takrorlansa UNIQUE indeks xato tashlaydi; route uni 409 ga aylantiradi.
 */
export function loyihaYarat(name: string, papka: string, baza?: Database): Project {
  const d = baza ?? globalDb()
  const loyiha: Project = {
    id: crypto.randomUUID(),
    name,
    papka,
    createdAt: new Date().toISOString(),
    chatlarSoni: 0,
  }
  d.prepare('INSERT INTO projects (id, name, papka, created_at) VALUES (?, ?, ?, ?)').run(
    loyiha.id,
    loyiha.name,
    loyiha.papka,
    loyiha.createdAt,
  )
  return loyiha
}

/**
 * Sessiya ulangan loyihaning papkasi. Sessiya loyihasiz bo'lsa (yoki umuman
 * yo'q bo'lsa) `null` — chaqiruvchi sessiya papkasiga qaytadi.
 *
 * Bitta SQL bilan: orchestrator har javob oqizishda chaqiradi, ikkita
 * so'rov ortiqcha.
 */
export function sessiyaLoyihaPapkasi(sessionId: string, baza?: Database): string | null {
  const d = baza ?? globalDb()
  const q = d
    .query<{ papka: string }, [string]>(
      `SELECT p.papka AS papka
         FROM chat_sessions s
         JOIN projects p ON p.id = s.project_id
        WHERE s.id = ?`,
    )
    .get(sessionId)
  return q?.papka ?? null
}

// ---------------------------------------------------------------------------
// Chat sessiyalari
// ---------------------------------------------------------------------------

interface SessiyaQator {
  id: string
  title: string
  provider: string | null
  model: string | null
  project_id: string | null
  created_at: string
  updated_at: string
}

function sessiyaQatordan(q: SessiyaQator): ChatSession {
  return {
    id: q.id,
    title: q.title,
    provider: q.provider ?? undefined,
    model: q.model ?? undefined,
    projectId: q.project_id ?? undefined,
    createdAt: q.created_at,
    updatedAt: q.updated_at,
  }
}

/**
 * Barcha sessiyalar, oxirgi faollik bo'yicha (yangisi tepada).
 *
 * `xabarlarSoni` qo'shiladi — UI "bo'sh suhbat" ni ajrata olsin: sessiya
 * yaratilib, birinchi xabar yuborilmasdan tashlab ketilishi oddiy holat.
 * `LEFT JOIN`: xabarsiz sessiya ham ro'yxatda qoladi (0 bilan).
 */
export function sessiyalarOqi(baza?: Database): ChatSession[] {
  const d = baza ?? globalDb()
  return d
    .query<SessiyaQator & { xabarlar: number }, []>(
      `SELECT s.*, COUNT(m.id) AS xabarlar
         FROM chat_sessions s
         LEFT JOIN chat_messages m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.updated_at DESC`,
    )
    .all()
    .map((q) => ({ ...sessiyaQatordan(q), xabarlarSoni: q.xabarlar }))
}

export function sessiyaOqi(id: string, baza?: Database): ChatSession | null {
  const d = baza ?? globalDb()
  const q = d.query<SessiyaQator, [string]>('SELECT * FROM chat_sessions WHERE id = ?').get(id)
  return q ? sessiyaQatordan(q) : null
}

/**
 * Yangi sessiya. `projectId` berilsa sessiya loyihaga ulanadi — agent
 * tool'lari o'sha loyihaning papkasida ishlaydi.
 *
 * Loyiha MAVJUDLIGI bu yerda tekshirilmaydi: route qatlami tekshirib,
 * foydalanuvchiga tushunarli xato beradi. Bazada baribir foreign key bor,
 * ya'ni yo'q loyiha bilan yozuv hosil bo'lmaydi.
 */
export function sessiyaYarat(
  title?: string,
  baza?: Database,
  projectId?: string,
): ChatSession {
  const d = baza ?? globalDb()
  const hozir = new Date().toISOString()
  const sessiya: ChatSession = {
    id: crypto.randomUUID(),
    title: title?.trim() || 'Yangi suhbat',
    projectId,
    createdAt: hozir,
    updatedAt: hozir,
  }
  d.prepare(
    'INSERT INTO chat_sessions (id, title, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sessiya.id, sessiya.title, projectId ?? null, sessiya.createdAt, sessiya.updatedAt)
  return sessiya
}

/**
 * Sessiyaning modelini qulflaydi — faqat BIRINCHI marta yozadi.
 *
 * `WHERE provider IS NULL` sharti poyga holatini oldini oladi: bir vaqtda
 * ikkita xabar kelsa, ikkinchisi mavjud providerni almashtira olmaydi.
 * Qaytish qiymati: yozildimi (true) yoki allaqachon qulflangan (false).
 */
export function sessiyaModelQulfla(
  id: string,
  provider: string,
  model: string,
  baza?: Database,
): boolean {
  const d = baza ?? globalDb()
  const natija = d
    .prepare('UPDATE chat_sessions SET provider = ?, model = ? WHERE id = ? AND provider IS NULL')
    .run(provider, model, id)
  return natija.changes > 0
}

/**
 * Sessiya ichida modelni almashtiradi (provider O'ZGARMAYDI).
 * Bir provider ichida modelni almashtirish xavfsiz — kontekst formati bir xil.
 */
export function sessiyaModelniOzgart(id: string, model: string, baza?: Database): void {
  const d = baza ?? globalDb()
  d.prepare('UPDATE chat_sessions SET model = ? WHERE id = ?').run(model, id)
}

/**
 * Sarlavhani qo'lda o'zgartiradi.
 *
 * `updated_at` ATAYLAB tegilmaydi: ro'yxat oxirgi FAOLLIK bo'yicha
 * saralanadi, nomni tahrirlash esa suhbatni tepaga ko'tarmasligi kerak.
 *
 * `false` — bunday sessiya yo'q.
 */
export function sessiyaSarlavhaOzgart(id: string, title: string, baza?: Database): boolean {
  const d = baza ?? globalDb()
  const natija = d.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(title, id)
  return natija.changes > 0
}

/**
 * Sessiyani butunlay o'chiradi. Xabarlar `ON DELETE CASCADE` bilan
 * o'zi ketadi (001-migratsiya), `build_sessions.session_id` esa NULL bo'ladi
 * — qurilish tarixi suhbat o'chirilgani uchun yo'qolmasligi kerak.
 *
 * `false` — bunday sessiya yo'q edi.
 */
export function sessiyaOchir(id: string, baza?: Database): boolean {
  const d = baza ?? globalDb()
  const natija = d.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id)
  return natija.changes > 0
}

// ---------------------------------------------------------------------------
// Chat xabarlari
// ---------------------------------------------------------------------------

interface XabarQator {
  id: string
  session_id: string
  role: ChatMessage['role']
  text: string
  tool_card: string | null
  tool_cards: string | null
  agent_messages: string | null
  context_tokens: number | null
  created_at: string
}

function xabarQatordan(q: XabarQator): ChatMessage {
  return {
    id: q.id,
    sessionId: q.session_id,
    role: q.role,
    text: q.text,
    toolCard: q.tool_card ? (JSON.parse(q.tool_card) as ToolCard) : undefined,
    toolCards: q.tool_cards ? (JSON.parse(q.tool_cards) as ToolChaqiruv[]) : undefined,
    // Buzuq JSON butun sessiyani o'qib bo'lmaydigan qilmasin: bu ustun
    // faqat LLM konteksti uchun, u yo'qolsa suhbat `text` bilan davom etadi.
    agentMessages: jsonOqi(q.agent_messages),
    contextTokens: q.context_tokens ?? undefined,
    createdAt: q.created_at,
  }
}

/** Xom JSON ustunini o'qiydi. Buzuq bo'lsa `undefined` — xato tashlamaydi. */
function jsonOqi(xom: string | null): unknown[] | undefined {
  if (!xom) return undefined
  try {
    const tahlil = JSON.parse(xom) as unknown
    return Array.isArray(tahlil) ? tahlil : undefined
  } catch {
    return undefined
  }
}

export function xabarlarOqi(sessionId: string, baza?: Database): ChatMessage[] {
  const d = baza ?? globalDb()
  const xabarlar = d
    .query<XabarQator, [string]>(
      'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at, rowid',
    )
    .all(sessionId)
    .map(xabarQatordan)

  // Tool kartalari `tool_chaqiruvlar` jadvalidan USTUN olinadi.
  //
  // Sabab: u yerga har chaqiruv OQIM DAVOMIDA yoziladi, `tool_cards`
  // ustuniga esa oqim OXIRIDA. Oqim uzilgan bo'lsa (provider xatosi, server
  // qayta ishga tushdi) ustun bo'sh qoladi-yu, jadvalda yozuvlar turadi —
  // ilgari o'sha bajarilgan buyruqlar tarixda umuman ko'rinmasdi.
  //
  // Ruxsat qarori ham faqat shu jadvalda bor, ya'ni "bu buyruq nega
  // bajarildi" ma'lumoti eski ustundan kelmaydi.
  const chaqiruvlar = new Map<string, ToolChaqiruv[]>()
  for (const q of d
    .query<ToolQator, [string]>(
      'SELECT * FROM tool_chaqiruvlar WHERE session_id = ? ORDER BY created_at, rowid',
    )
    .all(sessionId)) {
    const royxat = chaqiruvlar.get(q.message_id)
    if (royxat) royxat.push(toolQatordan(q))
    else chaqiruvlar.set(q.message_id, [toolQatordan(q)])
  }

  // Biriktirmalar — xuddi shu naqsh, lekin ikki FARQ bilan.
  //
  //   1) `message_id IS NOT NULL` sharti. NULL — yuklangan, lekin hali
  //      yuborilmagan fayl; u tarixda ko'rinmasligi kerak (chip UI'da,
  //      mahalliy state'da turadi).
  //   2) Yetim uchun sun'iy xabar QURILMAYDI. Tool chaqiruvida yetim
  //      "yo'qolgan ma'lumot" belgisi edi; bu yerda esa NULL — normal
  //      oraliq holat va uni xabar qilib ko'rsatish yolg'on bo'lardi.
  const biriktirmalar = new Map<string, ChatBiriktirma[]>()
  for (const q of d
    .query<BiriktirmaQator, [string]>(
      `SELECT * FROM chat_biriktirmalar
       WHERE session_id = ? AND message_id IS NOT NULL
       ORDER BY created_at, rowid`,
    )
    .all(sessionId)) {
    // `message_id` NULL emasligi SQL'da tekshirilgan, tip esa buni bilmaydi
    const kalit = q.message_id!
    const royxat = biriktirmalar.get(kalit)
    if (royxat) royxat.push(biriktirmaQatordan(q))
    else biriktirmalar.set(kalit, [biriktirmaQatordan(q)])
  }

  if (chaqiruvlar.size === 0 && biriktirmalar.size === 0) return xabarlar

  const natija = xabarlar.map((x) => {
    const kartalar = chaqiruvlar.get(x.id)
    const fayllar = biriktirmalar.get(x.id)
    if (!kartalar && !fayllar) return x
    chaqiruvlar.delete(x.id)
    return {
      ...x,
      ...(kartalar ? { toolCards: kartalar } : {}),
      ...(fayllar ? { biriktirmalar: fayllar } : {}),
    }
  })

  // YETIM CHAQIRUVLAR — xabari yozilmay qolgan javob.
  //
  // Bunday bo'lishi mumkin: jarayon oqim o'rtasida to'xtasa (server qayta
  // ishga tushdi, quvvat uzildi) assistant xabari YOZILMAYDI, chaqiruvlar
  // esa allaqachon bazada. Ularni tashlab ketsak, foydalanuvchi bajarilgan
  // buyruqlarni umuman ko'rmasdi — bu aynan shu jadval oldini olishi kerak
  // bo'lgan ma'lumot yo'qolishi.
  //
  // Shuning uchun yetimlar uchun sun'iy javob quriladi. `agentMessages`
  // qo'yilmaydi: yarim qolgan kontekst keyingi turn'ni yiqitardi.
  for (const [messageId, kartalar] of chaqiruvlar) {
    natija.push({
      id: messageId,
      sessionId,
      role: 'assistant',
      text: '⚠︎ The response did not finish — the stream was interrupted. The actions that ran are below.',
      toolCards: kartalar,
      createdAt: yetimVaqti(d, messageId),
    })
  }

  // Sun'iy xabarlar oxiriga qo'shildi — vaqt bo'yicha o'z joyiga qaytaramiz
  return natija.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Yetim chaqiruvlar to'plamining birinchi yozuv vaqti — tartib uchun */
function yetimVaqti(d: Database, messageId: string): string {
  const q = d
    .query<{ vaqt: string | null }, [string]>(
      'SELECT MIN(created_at) AS vaqt FROM tool_chaqiruvlar WHERE message_id = ?',
    )
    .get(messageId)
  return q?.vaqt ?? new Date().toISOString()
}

export function xabarYoz(
  xabar: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
  baza?: Database,
): ChatMessage {
  const d = baza ?? globalDb()
  const toliq: ChatMessage = {
    id: xabar.id ?? crypto.randomUUID(),
    sessionId: xabar.sessionId,
    role: xabar.role,
    text: xabar.text,
    toolCard: xabar.toolCard,
    toolCards: xabar.toolCards,
    agentMessages: xabar.agentMessages,
    contextTokens: xabar.contextTokens,
    createdAt: xabar.createdAt ?? new Date().toISOString(),
  }

  d.prepare(
    `INSERT INTO chat_messages
       (id, session_id, role, text, tool_card, tool_cards, agent_messages, context_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    toliq.id,
    toliq.sessionId,
    toliq.role,
    toliq.text,
    toliq.toolCard ? JSON.stringify(toliq.toolCard) : null,
    toliq.toolCards?.length ? JSON.stringify(toliq.toolCards) : null,
    toliq.agentMessages?.length ? JSON.stringify(toliq.agentMessages) : null,
    toliq.contextTokens ?? null,
    toliq.createdAt,
  )

  // Sessiya "oxirgi faollik" vaqti yangilanadi — ro'yxat shu bo'yicha saralanadi
  d.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(toliq.createdAt, toliq.sessionId)

  return toliq
}

// ---------------------------------------------------------------------------
// Tool chaqiruvlari
// ---------------------------------------------------------------------------
//
// Har chaqiruv AVVAL shu yerga yoziladi, KEYIN UI'ga tarqatiladi
// (`orchestrator.ts` dagi `toolYubor`). Tartib ataylab shunday: WS eventi
// yo'qolishi mumkin va oqim o'rtasida uzilishi ham mumkin — bazadagi yozuv
// esa qoladi. Ilgari aksincha edi va uzilgan oqimda bajarilgan buyruqlar
// izsiz yo'qolardi.
//
// `xabarlarOqi` kartalarni SHU JADVALDAN oladi (eski
// `chat_messages.tool_cards` ustunidan emas): u yerga yozuv oqim oxirida
// tushadi, ya'ni uzilgan javobda bo'sh qoladi. Ustun eski xabarlar uchun
// zaxira bo'lib qoladi.

interface ToolQator {
  id: string
  session_id: string
  message_id: string
  nom: string
  args: string
  holat: ToolChaqiruv['holat']
  natija: string | null
  tafsilot: string | null
  ruxsat: string | null
  klassifikator: string | null
  created_at: string
  updated_at: string
}

function toolQatordan(q: ToolQator): ToolChaqiruv {
  return {
    id: q.id,
    nom: q.nom,
    args: q.args,
    holat: q.holat,
    natija: q.natija ?? undefined,
    tafsilot: jsonObyekt<ToolChaqiruv['tafsilot']>(q.tafsilot),
    ruxsat: jsonObyekt<ToolChaqiruv['ruxsat']>(q.ruxsat),
    klassifikator: jsonObyekt<ToolChaqiruv['klassifikator']>(q.klassifikator),
  }
}

/** Buzuq JSON butun javobni o'qib bo'lmaydigan qilmasin — `undefined` qaytadi */
function jsonObyekt<T>(xom: string | null): T | undefined {
  if (!xom) return undefined
  try {
    return JSON.parse(xom) as T
  } catch {
    return undefined
  }
}

/**
 * Tool chaqiruvini yozadi yoki yangilaydi (id bo'yicha UPSERT).
 *
 * Bitta chaqiruv bir necha marta keladi: `ishlamoqda` → natija bo'laklari →
 * `tugadi`. Har safar shu funksiya chaqiriladi va yozuv ustiga yoziladi.
 *
 * `COALESCE` ataylab: keyingi yangilanishda `ruxsat` yoki `klassifikator`
 * berilmagan bo'lsa, allaqachon yozilgani O'CHIRILMAYDI. Ruxsat qarori
 * chaqiruv o'rtasida keladi, tugash eventi esa uni bilmaydi.
 */
export function toolChaqiruvYoz(
  chaqiruv: ToolChaqiruv & { sessionId: string; messageId: string },
  baza?: Database,
): void {
  const d = baza ?? globalDb()
  const hozir = new Date().toISOString()
  d.prepare(
    `INSERT INTO tool_chaqiruvlar
       (id, session_id, message_id, nom, args, holat, natija, tafsilot, ruxsat,
        klassifikator, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       nom           = excluded.nom,
       args          = excluded.args,
       holat         = excluded.holat,
       natija        = excluded.natija,
       tafsilot      = COALESCE(excluded.tafsilot, tool_chaqiruvlar.tafsilot),
       ruxsat        = COALESCE(excluded.ruxsat, tool_chaqiruvlar.ruxsat),
       klassifikator = COALESCE(excluded.klassifikator, tool_chaqiruvlar.klassifikator),
       updated_at    = excluded.updated_at`,
  ).run(
    chaqiruv.id,
    chaqiruv.sessionId,
    chaqiruv.messageId,
    chaqiruv.nom,
    chaqiruv.args,
    chaqiruv.holat,
    chaqiruv.natija ?? null,
    chaqiruv.tafsilot ? JSON.stringify(chaqiruv.tafsilot) : null,
    chaqiruv.ruxsat ? JSON.stringify(chaqiruv.ruxsat) : null,
    chaqiruv.klassifikator ? JSON.stringify(chaqiruv.klassifikator) : null,
    hozir,
    hozir,
  )
}

/** Bitta javobning tool chaqiruvlari, bajarilish tartibida */
export function toolChaqiruvlarOqi(messageId: string, baza?: Database): ToolChaqiruv[] {
  const d = baza ?? globalDb()
  return d
    .query<ToolQator, [string]>(
      'SELECT * FROM tool_chaqiruvlar WHERE message_id = ? ORDER BY created_at, rowid',
    )
    .all(messageId)
    .map(toolQatordan)
}

/** Sessiyadagi hamma tool chaqiruvi — diagnostika va tarixni tiklash uchun */
export function sessiyaToolChaqiruvlariOqi(sessionId: string, baza?: Database): ToolChaqiruv[] {
  const d = baza ?? globalDb()
  return d
    .query<ToolQator, [string]>(
      'SELECT * FROM tool_chaqiruvlar WHERE session_id = ? ORDER BY created_at, rowid',
    )
    .all(sessionId)
    .map(toolQatordan)
}

// ---------------------------------------------------------------------------
// Biriktirmalar — chatga yuklangan fayl va rasmlar
// ---------------------------------------------------------------------------
//
// `tool_chaqiruvlar` bilan bir xil naqsh: alohida jadval, `xabarlarOqi()`
// yozuvlarni xabarga ulab beradi. Farqi — `message_id` NULL bo'lishi mumkin
// (yuklandi, lekin hali yuborilmadi) va bu NORMAL oraliq holat, ya'ni yetim
// uchun sun'iy xabar QURILMAYDI.
//
// Bu qatlam FAYL TIZIMIGA TEGMAYDI (`loyihaYarat` dagi bilan bir xil
// qoida): diskka yozish va o'chirish chaqiruvchining ishi. `yetimlarniOchir`
// shu sababli o'chirilgan yozuvlar ro'yxatini qaytaradi — chaqiruvchi
// fayllarni o'zi tozalaydi.

interface BiriktirmaQator {
  id: string
  session_id: string
  message_id: string | null
  tur: ChatBiriktirma['tur']
  nom: string
  asl_nom: string
  yol: string
  mime: string
  hajm: number
  created_at: string
}

function biriktirmaQatordan(q: BiriktirmaQator): ChatBiriktirma {
  return {
    id: q.id,
    sessionId: q.session_id,
    tur: q.tur,
    aslNom: q.asl_nom,
    yol: q.yol,
    mime: q.mime,
    hajm: q.hajm,
    createdAt: q.created_at,
  }
}

/**
 * Yangi biriktirma yozuvi. `messageId` berilmasa NULL bo'ladi — fayl
 * yuklandi, lekin xabar hali yuborilmagan.
 *
 * `nom` (diskdagi tozalangan nom) tashqi tipda YO'Q: u faqat serverga
 * kerak — yo'lni qurish uchun. Mijoz `aslNom` va `yol` ni ko'radi.
 */
export function biriktirmaYoz(
  biriktirma: Omit<ChatBiriktirma, 'id' | 'createdAt'> & {
    id?: string
    createdAt?: string
    nom: string
    messageId?: string | null
  },
  baza?: Database,
): ChatBiriktirma {
  const d = baza ?? globalDb()
  const toliq: ChatBiriktirma = {
    id: biriktirma.id ?? crypto.randomUUID(),
    sessionId: biriktirma.sessionId,
    tur: biriktirma.tur,
    aslNom: biriktirma.aslNom,
    yol: biriktirma.yol,
    mime: biriktirma.mime,
    hajm: biriktirma.hajm,
    createdAt: biriktirma.createdAt ?? new Date().toISOString(),
  }

  d.prepare(
    `INSERT INTO chat_biriktirmalar
       (id, session_id, message_id, tur, nom, asl_nom, yol, mime, hajm, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    toliq.id,
    toliq.sessionId,
    biriktirma.messageId ?? null,
    toliq.tur,
    biriktirma.nom,
    toliq.aslNom,
    toliq.yol,
    toliq.mime,
    toliq.hajm,
    toliq.createdAt,
  )

  return toliq
}

export function biriktirmaOqi(id: string, baza?: Database): ChatBiriktirma | null {
  const d = baza ?? globalDb()
  const q = d
    .query<BiriktirmaQator, [string]>('SELECT * FROM chat_biriktirmalar WHERE id = ?')
    .get(id)
  return q ? biriktirmaQatordan(q) : null
}

/**
 * Berilgan id'lar bo'yicha biriktirmalarni oladi — FAQAT shu sessiyaga
 * tegishlilarini.
 *
 * Sessiya filtri XAVFSIZLIK CHEGARASI, qulaylik emas: mijoz `chat.send` da
 * ixtiyoriy id yuborishi mumkin va usiz boshqa suhbatning faylini o'z
 * xabariga bog'lab olardi.
 *
 * Qaytgan ro'yxat SO'RALGAN TARTIBDA bo'ladi — foydalanuvchi fayllarni
 * qanday tanlagan bo'lsa, promptda ham shunday ko'rinadi. Topilmagan id
 * jimgina tashlanmaydi: chaqiruvchi soni bo'yicha tekshirib xato beradi.
 */
export function biriktirmalarniOl(
  sessionId: string,
  idlar: string[],
  baza?: Database,
): ChatBiriktirma[] {
  if (idlar.length === 0) return []
  const d = baza ?? globalDb()
  const orinlar = idlar.map(() => '?').join(', ')
  const topilgan = d
    .query<BiriktirmaQator, string[]>(
      `SELECT * FROM chat_biriktirmalar WHERE session_id = ? AND id IN (${orinlar})`,
    )
    .all(sessionId, ...idlar)
    .map(biriktirmaQatordan)

  const xarita = new Map(topilgan.map((b) => [b.id, b]))
  return idlar.map((id) => xarita.get(id)).filter((b): b is ChatBiriktirma => b !== undefined)
}

/** Sessiyadagi hamma biriktirma — papkani tozalash va diagnostika uchun */
export function sessiyaBiriktirmalari(sessionId: string, baza?: Database): ChatBiriktirma[] {
  const d = baza ?? globalDb()
  return d
    .query<BiriktirmaQator, [string]>(
      'SELECT * FROM chat_biriktirmalar WHERE session_id = ? ORDER BY created_at, rowid',
    )
    .all(sessionId)
    .map(biriktirmaQatordan)
}

/**
 * Biriktirmalarni xabarga bog'laydi — xabar yozilgandan keyin chaqiriladi.
 *
 * Faqat SHU SESSIYAGA tegishli va hali bog'lanmagan (`message_id IS NULL`)
 * yozuvlar o'zgaradi. Ikkinchi shart takroriy yuborishdan himoya qiladi:
 * allaqachon bir xabarga tegishli fayl ikkinchisiga ko'chib ketmasin.
 *
 * O'zgargan yozuvlar sonini qaytaradi.
 */
export function biriktirmalarniXabargaBogla(
  sessionId: string,
  messageId: string,
  idlar: string[],
  baza?: Database,
): number {
  if (idlar.length === 0) return 0
  const d = baza ?? globalDb()
  const orinlar = idlar.map(() => '?').join(', ')
  const natija = d
    .prepare(
      `UPDATE chat_biriktirmalar SET message_id = ?
       WHERE session_id = ? AND message_id IS NULL AND id IN (${orinlar})`,
    )
    .run(messageId, sessionId, ...idlar)
  return natija.changes
}

/**
 * Biriktirma xabarga bog'langanmi.
 *
 * `ChatBiriktirma` da `messageId` ATAYLAB yo'q: u mijozga kerak emas va
 * tashqi tipni ichki holat bilan to'ldirmaymiz. Lekin server bir joyda
 * bilishi kerak — yuborilgan biriktirmani o'chirishga ruxsat bermaslik uchun.
 */
export function biriktirmaBoglanganmi(id: string, baza?: Database): boolean {
  const d = baza ?? globalDb()
  const q = d
    .query<{ message_id: string | null }, [string]>(
      'SELECT message_id FROM chat_biriktirmalar WHERE id = ?',
    )
    .get(id)
  return q?.message_id !== null && q?.message_id !== undefined
}

/** Bitta biriktirmani o'chiradi. Fayl chaqiruvchi tomonidan o'chiriladi. */
export function biriktirmaOchir(id: string, baza?: Database): boolean {
  const d = baza ?? globalDb()
  return d.prepare('DELETE FROM chat_biriktirmalar WHERE id = ?').run(id).changes > 0
}

/**
 * Xabarga bog'lanmagan va eskirgan biriktirmalarni o'chiradi.
 *
 * NEGA KERAK: foydalanuvchi fayl yuklab, keyin fikridan qaytishi oddiy
 * holat. Yozuv `message_id IS NULL` bo'lib qolib ketadi va fayl diskda
 * yotadi. Cron kerak emas — `javobOqizi` boshida shu sessiya uchun
 * chaqiriladi (`orchestrator.ts`), ya'ni tozalash tabiiy ravishda
 * foydalanish paytida bo'ladi.
 *
 * Muddat KATTA (standart 24 soat) ataylab: foydalanuvchi chip ko'rib
 * turgan bo'lsa-yu fayli o'chib ketsa, yuborish payti xato bo'lardi.
 *
 * O'chirilgan yozuvlarni QAYTARADI — chaqiruvchi fayllarni tozalaydi.
 */
export function yetimBiriktirmalarniOchir(
  sessionId: string,
  soatOldin = 24,
  baza?: Database,
): ChatBiriktirma[] {
  const d = baza ?? globalDb()
  const chegara = new Date(Date.now() - soatOldin * 60 * 60 * 1000).toISOString()
  const yetimlar = d
    .query<BiriktirmaQator, [string, string]>(
      `SELECT * FROM chat_biriktirmalar
       WHERE session_id = ? AND message_id IS NULL AND created_at < ?`,
    )
    .all(sessionId, chegara)
    .map(biriktirmaQatordan)

  if (yetimlar.length === 0) return []

  const orinlar = yetimlar.map(() => '?').join(', ')
  d.prepare(`DELETE FROM chat_biriktirmalar WHERE id IN (${orinlar})`).run(
    ...yetimlar.map((b) => b.id),
  )
  return yetimlar
}

// ---------------------------------------------------------------------------
// Qurilish sessiyalari — skeleton, keyingi bosqichda orchestrator to'ldiradi
// ---------------------------------------------------------------------------

interface BuildQator {
  id: string
  app_id: string
  session_id: string | null
  status: BuildSessionStatus
  error: string | null
  created_at: string
  updated_at: string
}

function buildQatordan(q: BuildQator): BuildSession {
  return { id: q.id, appId: q.app_id, status: q.status, createdAt: q.created_at }
}

export function buildYarat(
  appId: string,
  sessionId: string | null = null,
  baza?: Database,
): BuildSession {
  const d = baza ?? globalDb()
  const hozir = new Date().toISOString()
  const id = crypto.randomUUID()
  d.prepare(
    `INSERT INTO build_sessions (id, app_id, session_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?)`,
  ).run(id, appId, sessionId, hozir, hozir)
  return { id, appId, status: 'running', createdAt: hozir }
}

export function buildHolatiOzgart(
  id: string,
  status: BuildSessionStatus,
  error?: string,
  baza?: Database,
): void {
  const d = baza ?? globalDb()
  d.prepare('UPDATE build_sessions SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(
    status,
    error ?? null,
    new Date().toISOString(),
    id,
  )
}

export function buildOqi(id: string, baza?: Database): BuildSession | null {
  const d = baza ?? globalDb()
  const q = d.query<BuildQator, [string]>('SELECT * FROM build_sessions WHERE id = ?').get(id)
  return q ? buildQatordan(q) : null
}
