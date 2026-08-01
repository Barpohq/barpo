// Skill manbasiga `platforma` turini qo'shish.
//
// NEGA KERAK. Platforma bilan birga keladigan standart skilllar (dashboard
// yozishni o'rgatuvchilar) katalogdan o'tishi kerak — shunda ular "Skill
// do'koni" da ko'rinadi va foydalanuvchi ularni oddiy skill kabi o'rnatadi.
// 006-migratsiyada esa `CHECK (tur IN ('github'))` turgan edi.
//
// NEGA JADVAL QAYTA QURILADI. SQLite `ALTER TABLE ... DROP CONSTRAINT` ni
// qo'llab-quvvatlamaydi va `CHECK` ni o'zgartirishning boshqa yo'li yo'q.
// Standart usul: yangi jadval → ma'lumot ko'chirish → eskisini o'chirish →
// nomini almashtirish.
//
// FOREIGN KEY EHTIYOTKORLIGI. `skilllar.manba_id` bu jadvalga
// `ON DELETE CASCADE` bilan bog'langan. `DROP TABLE` paytida cheklov
// yoqilgan bo'lsa bog'langan skilllar O'CHIB KETARDI, shuning uchun
// migratsiya davomida `foreign_keys` o'chiriladi va oxirida qaytariladi.
//
// `PRAGMA foreign_keys` TRANZAKSIYA ICHIDA ISHLAMAYDI (jimgina e'tiborsiz
// qoldiriladi), shuning uchun migratsiya yurituvchisi buni tranzaksiyadan
// TASHQARIDA bajaradi — `db.ts` dagi `pragmaTashqarida` bayrog'iga q.

import type { Migration } from './index.ts'

export const migration: Migration = {
  number: 10,
  name: 'standart-manba',
  outsideTransaction: true,
  sql: `
    PRAGMA foreign_keys = OFF;

    BEGIN;

    CREATE TABLE skill_manbalari_yangi (
      id            TEXT PRIMARY KEY,
      -- 'platforma' — platforma bilan birga kelgan standart skilllar.
      -- Repo ochilganda ular 'github' ga ko'chadi, tur esa qoladi:
      -- eski bazalarda yozuv buzilmasin.
      tur           TEXT NOT NULL CHECK (tur IN ('github', 'platforma')),
      url           TEXT NOT NULL,
      owner         TEXT NOT NULL,
      repo          TEXT NOT NULL,
      ref           TEXT NOT NULL DEFAULT '',
      commit_sha    TEXT,
      oxirgi_sinxron TEXT,
      created_at    TEXT NOT NULL
    );

    INSERT INTO skill_manbalari_yangi
      SELECT id, tur, url, owner, repo, ref, commit_sha, oxirgi_sinxron, created_at
      FROM skill_manbalari;

    DROP TABLE skill_manbalari;
    ALTER TABLE skill_manbalari_yangi RENAME TO skill_manbalari;

    -- Indeks jadval bilan birga o'chgan — qayta yaratamiz.
    CREATE UNIQUE INDEX idx_manba_repo ON skill_manbalari (owner, repo, ref);

    COMMIT;

    PRAGMA foreign_keys = ON;
  `,
}
