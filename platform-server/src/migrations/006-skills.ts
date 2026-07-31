import type { Migration } from './index.ts'

// Skilllar — mock do'kondan haqiqiy `SKILL.md` tizimiga o'tish.
//
// ESKI `skills` JADVALI TASHLANADI. U demo uchun edi: qatorlar seed'dan
// kelardi, `installed` bitta boolean edi va hech qanday fayl bilan bog'lanmagan
// edi. Yangi modelda skill — diskdagi haqiqiy papka, shuning uchun eski
// qatorlarni ko'chirishning ma'nosi yo'q (ular hech qayerga ishora qilmaydi).
//
// Uch jadval, chunki uchta boshqa-boshqa narsa:
//
//   skill_manbalari — ulangan repo. Bir repo → ko'p skill.
//   skilllar        — repo ichida topilgan `SKILL.md`. KATALOG yozuvi:
//                     "bunday skill bor" degani, "o'rnatilgan" degani emas.
//   skill_ornatish  — skill qayerda ishlaydi. Bitta skill bir vaqtda global
//                     VA bir necha loyihada bo'lishi mumkin — shuning uchun
//                     bu `skilllar` ichidagi ustun emas, alohida jadval.
//
// Diskdagi holat bu jadvallardan KELIB CHIQADI (haqiqat manbai — baza):
// ombor `~/.platforma/skills-ombor/`, loyiha nusxasi esa har sessiya boshida
// `skill_ornatish` ga qarab qayta quriladi.

export const migration: Migration = {
  number: 6,
  name: 'skilllar',
  sql: `
    DROP TABLE IF EXISTS skills;

    CREATE TABLE skill_manbalari (
      id            TEXT PRIMARY KEY,
      tur           TEXT NOT NULL CHECK (tur IN ('github')),
      url           TEXT NOT NULL,
      owner         TEXT NOT NULL,
      repo          TEXT NOT NULL,
      -- Branch/tag. Bo'sh satr = repo'ning standart branch'i (API o'zi hal
      -- qiladi). NULL emas: UNIQUE indeks NULL'larni takrorlanish deb
      -- hisoblamaydi, ya'ni bir repo ikki marta ulanib ketardi.
      ref           TEXT NOT NULL DEFAULT '',
      commit_sha    TEXT,
      oxirgi_sinxron TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE UNIQUE INDEX idx_manba_repo ON skill_manbalari (owner, repo, ref);

    CREATE TABLE skilllar (
      id            TEXT PRIMARY KEY,
      manba_id      TEXT NOT NULL REFERENCES skill_manbalari (id) ON DELETE CASCADE,
      -- Repo ichidagi yo'l: 'document-skills/pdf/SKILL.md'
      yol           TEXT NOT NULL,
      nom           TEXT NOT NULL,
      tavsif        TEXT NOT NULL,
      litsenziya    TEXT,
      -- JSON massiv. Hozircha faqat UI'da ko'rsatiladi, majburlanmaydi.
      allowed_tools TEXT,
      -- JSON massiv: spec buzilishlari (skill baribir yuklangan)
      ogohlantirishlar TEXT NOT NULL DEFAULT '[]'
    );

    -- Bir repo'da bir yo'l bitta bo'ladi. Qayta sinxronlashda shu indeks
    -- yordamida UPSERT qilinadi — id o'zgarmaydi, ya'ni o'rnatishlar saqlanadi.
    CREATE UNIQUE INDEX idx_skill_yol ON skilllar (manba_id, yol);

    CREATE TABLE skill_ornatish (
      id         TEXT PRIMARY KEY,
      skill_id   TEXT NOT NULL REFERENCES skilllar (id) ON DELETE CASCADE,
      qamrov     TEXT NOT NULL CHECK (qamrov IN ('global', 'loyiha')),
      -- 'loyiha' uchun majburiy, 'global' uchun NULL — CHECK buni majburlaydi
      project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((qamrov = 'loyiha' AND project_id IS NOT NULL)
          OR (qamrov = 'global' AND project_id IS NULL))
    );

    -- Bir skill bir loyihaga ikki marta o'rnatilmasin. COALESCE kerak:
    -- global qatorlarda project_id NULL va NULL'lar UNIQUE uchun har xil
    -- hisoblanadi, ya'ni usiz global o'rnatish takrorlanib ketardi.
    CREATE UNIQUE INDEX idx_ornatish_bir
      ON skill_ornatish (skill_id, qamrov, COALESCE(project_id, ''));

    CREATE INDEX idx_ornatish_loyiha ON skill_ornatish (project_id);
  `,
}
