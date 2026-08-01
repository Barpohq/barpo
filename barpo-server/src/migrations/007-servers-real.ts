import type { Migration } from './index.ts'

// Serverlar jadvalini mock sxemadan haqiqiy sxemaga o'tkazish.
//
// Eski jadval demo uchun edi: cpu/ram/disk kabi qiymatlar bazada qotib
// turardi. Haqiqiy modelda baza faqat ULANISH ma'lumotini saqlaydi
// (host, port, user) — jonli holat (metrikalar, online/offline) har safar
// SSH orqali so'raladi va saqlanmaydi: saqlansa "eski, lekin ishonchli
// ko'ringan" qiymat ko'rsatib qo'yish xavfi bor.
//
// DROP qilinadi, ko'chirilmaydi: eski qatorlar faqat seed'dan kelgan
// o'ylab topilgan ma'lumot, haqiqiy serverga ishora qilmaydi.
//
// `name` — ssh alias (`ssh <name>` shu nom bilan ishlaydi), shuning uchun
// UNIQUE va faqat xavfsiz belgilardan iborat (route qatlamida tekshiriladi).

export const migration: Migration = {
  number: 7,
  name: 'serverlar-haqiqiy',
  sql: `
    DROP TABLE servers;

    CREATE TABLE servers (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      host       TEXT NOT NULL,
      port       INTEGER NOT NULL DEFAULT 22,
      username   TEXT NOT NULL DEFAULT 'root',
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX idx_servers_name ON servers (name);
  `,
}
