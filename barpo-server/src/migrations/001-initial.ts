import type { Migration } from './index.ts'

// Boshlang'ich sxema: serverlar, skilllar, audit log, ilovalar, chat va
// qurilish sessiyalari. Vaqt maydonlari ISO-8601 satr sifatida saqlanadi
// (SQLite'da native date yo'q, satr leksikografik tartibda ham to'g'ri saralanadi).

export const migration: Migration = {
  number: 1,
  name: 'boshlangich-sxema',
  sql: `
    -- Serverlar: platforma boshqaradigan mashinalar
    CREATE TABLE servers (
      id      TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      role    TEXT NOT NULL,
      region  TEXT NOT NULL,
      status  TEXT NOT NULL CHECK (status IN ('healthy', 'warning', 'offline')),
      cpu     INTEGER NOT NULL,
      ram     INTEGER NOT NULL,
      disk    INTEGER NOT NULL,
      daemon  TEXT NOT NULL,
      uptime  TEXT NOT NULL,
      note    TEXT
    );

    -- Skill do'koni: ruxsatlar JSON massiv sifatida
    CREATE TABLE skills (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      desc        TEXT NOT NULL,
      version     TEXT NOT NULL,
      installed   INTEGER NOT NULL DEFAULT 0,
      category    TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '[]'
    );

    -- Audit log: APPEND-ONLY. UPDATE/DELETE trigger bilan bloklangan.
    CREATE TABLE audit_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      time    TEXT NOT NULL,
      actor   TEXT NOT NULL,
      action  TEXT NOT NULL,
      target  TEXT NOT NULL,
      level   TEXT NOT NULL CHECK (level IN ('o''qish', 'o''zgartirish', 'xavfli')),
      result  TEXT NOT NULL CHECK (result IN ('OK', 'tasdiqlandi', 'rad etildi', 'kutmoqda')),
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_audit_level   ON audit_log (level);
    CREATE INDEX idx_audit_actor   ON audit_log (actor);
    CREATE INDEX idx_audit_created ON audit_log (created_at DESC);

    -- Append-only kafolati: o'zgartirish va o'chirish urinishi xato beradi
    CREATE TRIGGER audit_log_ozgartirish_taqiq
      BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log append-only: UPDATE taqiqlangan');
    END;

    CREATE TRIGGER audit_log_ochirish_taqiq
      BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log append-only: DELETE taqiqlangan');
    END;

    -- Ilovalar: manifest to'liq JSON sifatida saqlanadi (server-driven UI)
    CREATE TABLE apps (
      id         TEXT PRIMARY KEY,
      manifest   TEXT NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('running', 'idle')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Chat sessiyalari
    CREATE TABLE chat_sessions (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Chat xabarlari; tool_card ixtiyoriy JSON
    CREATE TABLE chat_messages (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      text       TEXT NOT NULL DEFAULT '',
      tool_card  TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_messages_session ON chat_messages (session_id, created_at);

    -- Qurilish sessiyalari: keyingi bosqichda orchestrator to'ldiradi
    CREATE TABLE build_sessions (
      id         TEXT PRIMARY KEY,
      app_id     TEXT NOT NULL,
      session_id TEXT REFERENCES chat_sessions (id) ON DELETE SET NULL,
      status     TEXT NOT NULL CHECK (status IN ('running', 'waiting_choice', 'done', 'failed')),
      error      TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX idx_builds_app ON build_sessions (app_id);
  `,
}
