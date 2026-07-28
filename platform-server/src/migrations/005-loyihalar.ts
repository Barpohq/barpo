import type { Migratsiya } from './index.ts'

// Loyihalar (project / workspace) — nomlangan ish papkasi.
//
// MUAMMO: har sessiya o'z papkasini olardi (`ish-papkasi.ts`), ya'ni
// foydalanuvchi bitta kod bazasi ustida ikkita suhbat ocha olmasdi — ikkinchi
// suhbat bo'sh papkada boshlanardi va birinchisi yaratgan fayllarni ko'rmasdi.
//
// YECHIM: `projects` jadvali nom bilan papkani bog'laydi, sessiya esa
// ixtiyoriy ravishda loyihaga ulanadi. Bir loyihaning HAMMA chatlari BITTA
// papkada ishlaydi.
//
// `papka` to'liq yo'l sifatida saqlanadi (slug'dan qayta hisoblanmaydi):
// ildiz papka `PLATFORMA_LOYIHALAR` env bilan ko'chirilishi mumkin, shunda
// eski yozuvlar qayerda ekanini bilib turamiz.
//
// `project_id` NULL bo'lishi mumkin — loyihaga ulanmagan sessiya hozirgidek
// o'z sessiya papkasida qoladi (eski suhbatlar buzilmaydi).
//
// SQLite ALTER TABLE ADD COLUMN foreign key bilan: yangi ustun NULL
// standartiga ega bo'lgani uchun bu ruxsat etilgan.

export const migratsiya: Migratsiya = {
  raqam: 5,
  nom: 'loyihalar',
  sql: `
    CREATE TABLE projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      papka      TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Nom takrorlanmasin: foydalanuvchi bir xil nomli ikkita loyiha yaratsa,
    -- qaysi papkada ishlayotganini ajrata olmaydi.
    CREATE UNIQUE INDEX idx_projects_name ON projects (name);

    ALTER TABLE chat_sessions ADD COLUMN project_id TEXT REFERENCES projects (id);

    CREATE INDEX idx_sessions_project ON chat_sessions (project_id);
  `,
}
