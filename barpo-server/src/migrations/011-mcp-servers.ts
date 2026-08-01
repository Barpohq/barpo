import type { Migration } from './index.ts'

// MCP (Model Context Protocol) serverlar — katalog va o'rnatish.
//
// UCH JADVAL, `006-skilllar.ts` bilan AYNAN BIR XIL naqsh:
//
//   mcp_manbalari — katalog qayerdan kelgan. Bir manba → ko'p server.
//   mcp_serverlar — katalog yozuvi: "bunday MCP server bor" degani,
//                   "ulangan" degani EMAS.
//   mcp_ornatish  — server qayerda faol. Bitta server global VA bir necha
//                   loyihada bo'lishi mumkin — shuning uchun alohida jadval.
//
// Skilllardan farqli, bu yerda DISK QATLAMI YO'Q. Skill o'rnatilganda fayl
// ombor ga ko'chadi va sessiya boshida loyihaga nusxalanadi; MCP server esa
// har sessiyada JARAYON bo'lib ko'tariladi (yoki masofaviy manzilga
// ulanadi). Ya'ni bu jadvallar diskdagi holatni tavsiflamaydi — ular
// "sessiya boshlanganda nimaga ulanish kerak" degan ro'yxat.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ KREDENSIALLAR BU JADVALLARDA YO'Q.                                   │
// │                                                                      │
// │ `mcp_serverlar.sozlamalar` — FAQAT SXEMA: "bu server GITHUB_TOKEN    │
// │ so'raydi" degan tavsif, qiymat emas.                                 │
// │ `mcp_ornatish.sozlama_qiymatlari` — faqat MAXFIY BO'LMAGAN qiymatlar │
// │ (masalan BASE_URL).                                                  │
// │                                                                      │
// │ Maxfiy qiymatlar (token, API kalit) alohida faylda:                  │
// │ `mcp-kredensial.ts` → `~/.barpo/mcp-kredensiallar.json` (600).   │
// │ Sabab: baza fayli backup/eksport qilinadi va SELECT natijasi logga   │
// │ tushishi mumkin — token u yerda yotmasligi kerak. Bu `kredensial.ts` │
// │ dagi FaylKredensialOmbori qarori bilan bir xil.                      │
// └──────────────────────────────────────────────────────────────────────┘

export const migration: Migration = {
  number: 11,
  name: 'mcp-serverlar',
  sql: `
    CREATE TABLE mcp_manbalari (
      id            TEXT PRIMARY KEY,
      tur           TEXT NOT NULL
                    CHECK (tur IN ('registry', 'github', 'qolda', 'standart')),
      -- Turga qarab boshqa ma'no: registry server nomi / owner/repo /
      -- foydalanuvchi bergan nom / standart papka nomi.
      manba_nomi    TEXT NOT NULL,
      -- Faqat 'github' turida to'ladi (skill_manbalari bilan bir xil).
      owner         TEXT,
      repo          TEXT,
      -- Bo'sh satr = standart branch. NULL EMAS: UNIQUE indeks NULL'larni
      -- takrorlanish deb hisoblamaydi, ya'ni bir manba ikki marta ulanardi
      -- (skill_manbalari.ref dagi bilan aynan bir xil sabab).
      ref           TEXT NOT NULL DEFAULT '',
      oxirgi_sinxron TEXT,
      created_at    TEXT NOT NULL
    );

    -- Bir manba ikki marta ulanmasin. 'registry' uchun manba_nomi server
    -- nomi bo'lgani uchun bu "bir serverni ikki marta qo'shib bo'lmaydi"
    -- degan ma'noni ham beradi.
    CREATE UNIQUE INDEX idx_mcp_manba_nomi
      ON mcp_manbalari (tur, manba_nomi, ref);

    CREATE TABLE mcp_serverlar (
      id            TEXT PRIMARY KEY,
      manba_id      TEXT NOT NULL REFERENCES mcp_manbalari (id) ON DELETE CASCADE,
      nom           TEXT NOT NULL,
      tavsif        TEXT NOT NULL DEFAULT '',
      transport     TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
      -- stdio uchun: 'npx' | 'uvx' | 'docker' va h.k.
      buyruq        TEXT,
      -- JSON massiv (string[]). O'rin egallovchilar ({token}) hali
      -- almashtirilmagan — ular Bun.spawn argv ichida almashtiriladi.
      argumentlar   TEXT,
      -- http uchun: server manzili
      url           TEXT,
      -- JSON massiv (McpSozlamaMaydoni[]) — FAQAT SXEMA, qiymat emas
      sozlamalar    TEXT NOT NULL DEFAULT '[]',
      -- Transport bilan mos maydon to'ldirilganini majburlaydi: stdio
      -- buyruqsiz ishga tushmaydi, http url'siz ulanmaydi. Bu shart
      -- SQL darajasida ifodalanadi, chunki u BUZILGANDA sessiya
      -- boshlanishida jimgina yiqilardi — bazaga tushmasligi arzonroq.
      CHECK (
        (transport = 'stdio' AND buyruq IS NOT NULL) OR
        (transport = 'http'  AND url    IS NOT NULL)
      )
    );

    -- Bir manbada bir nom bitta bo'ladi. Qayta sinxronlashda UPSERT shu
    -- indeks bo'yicha ketadi — id O'ZGARMAYDI, ya'ni o'rnatishlar va ular
    -- bilan bog'langan kredensiallar saqlanib qoladi (skilllar.yol bilan
    -- bir xil qoida).
    CREATE UNIQUE INDEX idx_mcp_server_nom ON mcp_serverlar (manba_id, nom);

    CREATE TABLE mcp_ornatish (
      id                 TEXT PRIMARY KEY,
      server_id          TEXT NOT NULL REFERENCES mcp_serverlar (id) ON DELETE CASCADE,
      qamrov             TEXT NOT NULL CHECK (qamrov IN ('global', 'loyiha')),
      -- 'loyiha' uchun majburiy, 'global' uchun NULL — CHECK majburlaydi
      project_id         TEXT REFERENCES projects (id) ON DELETE CASCADE,
      -- JSON: { [envNomi]: qiymat }. FAQAT maxfiy=false maydonlar.
      --
      -- NEGA O'RNATISHDA, SERVERDA EMAS: bitta server bir necha joyga
      -- o'rnatilishi mumkin va har birining o'z sozlamasi bo'lishi kerak
      -- (masalan ikki loyiha bir xil GitHub MCP serverni turli tokenlar
      -- bilan ishlatadi). Serverda bo'lsa ular bir-birini bosib ketardi.
      sozlama_qiymatlari TEXT NOT NULL DEFAULT '{}',
      created_at         TEXT NOT NULL,
      CHECK ((qamrov = 'loyiha' AND project_id IS NOT NULL)
          OR (qamrov = 'global' AND project_id IS NULL))
    );

    -- Bir server bir loyihaga ikki marta o'rnatilmasin. COALESCE kerak:
    -- global qatorlarda project_id NULL va NULL'lar UNIQUE uchun har xil
    -- hisoblanadi, ya'ni usiz global o'rnatish takrorlanib ketardi
    -- (skill_ornatish dagi bilan aynan bir xil).
    CREATE UNIQUE INDEX idx_mcp_ornatish_bir
      ON mcp_ornatish (server_id, qamrov, COALESCE(project_id, ''));

    CREATE INDEX idx_mcp_ornatish_loyiha ON mcp_ornatish (project_id);
  `,
}
