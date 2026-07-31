import type { Migration } from './index.ts'

// Uzbek → English rename of the whole schema: tables, columns, indexes,
// triggers, CHECK constraint values and the stored values themselves.
//
// WHY IT IS ONE MIGRATION. The TypeScript layer is renamed in the same commit.
// A half-applied rename gives a server whose queries reference columns that do
// not exist, so everything the code touches has to move together.
//
// THREE KINDS OF WORK, in the order they appear below:
//
//   1) Table rebuilds — the five tables whose CHECK constraints list Uzbek
//      values. SQLite cannot alter a CHECK, so the table is recreated. This is
//      the pattern proven in `010-builtin-source.ts`; see the notes there.
//   2) Plain renames — `ALTER TABLE ... RENAME TO` / `RENAME COLUMN` for
//      everything without a CHECK on a renamed value.
//   3) Value rewrites — `UPDATE ... CASE` for stored Uzbek strings, plus
//      inline JSON rewrites for the small flat blobs.
//
// `outsideTransaction` IS REQUIRED. The rebuilds need
// `PRAGMA foreign_keys = OFF` (otherwise `DROP TABLE` on a parent CASCADEs its
// children away) and a PRAGMA is silently ignored inside a transaction. The
// SQL below carries its own BEGIN/COMMIT, so atomicity is preserved — only the
// PRAGMAs sit outside it. See `db.ts`.
//
// REBUILD ORDER IS PARENTS BEFORE CHILDREN. `skills` has an FK to
// `skill_sources`; `skill_installs` has FKs to `skills` and `projects`; the
// same shape repeats for MCP. Foreign keys stay off for the whole block, so a
// child temporarily pointing at a dropped parent is fine.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ ACCEPTED DATA LOSS — `apps.manifest` and `chat_messages.tool_cards`. │
// │                                                                      │
// │ Both hold deeply nested JSON produced by the TypeScript types that   │
// │ this refactor renames (`AppManifest` with its settings/actions/view/ │
// │ states tree, and the legacy `ToolChaqiruv[]` blob). Rewriting those  │
// │ shapes in SQL would be long and unreadable, and the realistic blast  │
// │ radius is one developer's local, gitignored database: `apps` is      │
// │ seeded empty and `tool_cards` has already been superseded by the     │
// │ `tool_calls` table (see `009-tool-calls.ts`).                        │
// │                                                                      │
// │ Old rows are therefore left as-is. They fail validation and          │
// │ `repo.ts` drops them from the list rather than crashing, so the      │
// │ platform still boots. The flat blobs below ARE rewritten, because    │
// │ their SQL is short.                                                  │
// │                                                                      │
// │ `chat_messages.agent_messages` is pi-agent-core's own format and is  │
// │ deliberately NOT touched.                                            │
// └──────────────────────────────────────────────────────────────────────┘
//
// `schema_version.raqam`/`nom` are NOT renamed here. The migration runner
// reads that table to decide what to run, so renaming those columns mid-run
// would break the query driving the loop — `db.ts` does it before the loop
// starts instead.
//
// STORED PATHS ARE NOT REWRITTEN. `projects.folder` holds absolute paths and
// `chat_attachments.path` holds paths relative to the work dir; both embed the
// literal `.platforma` directory name. That directory is not renamed in this
// pass, so the stored values stay valid as they are.

export const migration: Migration = {
  number: 13,
  name: 'english-rename',
  outsideTransaction: true,
  sql: `
    PRAGMA foreign_keys = OFF;

    BEGIN;

    -- ======================================================================
    -- 1) Rebuilds — tables whose CHECK constraints name Uzbek values
    -- ======================================================================

    -- skill_manbalari → skill_sources    CHECK: 'platforma' → 'builtin'
    CREATE TABLE skill_sources_new (
      id         TEXT PRIMARY KEY,
      -- 'builtin' — skills that ship with the platform. When the repo is
      -- opened they move to 'github', but the kind stays: records in old
      -- databases must not break.
      kind       TEXT NOT NULL CHECK (kind IN ('github', 'builtin')),
      url        TEXT NOT NULL,
      owner      TEXT NOT NULL,
      repo       TEXT NOT NULL,
      ref        TEXT NOT NULL DEFAULT '',
      commit_sha TEXT,
      last_sync  TEXT,
      created_at TEXT NOT NULL
    );

    INSERT INTO skill_sources_new
      SELECT id,
             CASE tur WHEN 'platforma' THEN 'builtin' ELSE tur END,
             url, owner, repo, ref, commit_sha, oxirgi_sinxron, created_at
        FROM skill_manbalari;

    DROP TABLE skill_manbalari;
    ALTER TABLE skill_sources_new RENAME TO skill_sources;

    CREATE UNIQUE INDEX idx_skill_source_repo ON skill_sources (owner, repo, ref);

    -- skilllar → skills    (no CHECK, but its FK must point at the new parent,
    -- and an FK target cannot be re-pointed with ALTER — so it is rebuilt too)
    CREATE TABLE skills_new (
      id            TEXT PRIMARY KEY,
      source_id     TEXT NOT NULL REFERENCES skill_sources (id) ON DELETE CASCADE,
      -- Path inside the repo: 'document-skills/pdf/SKILL.md'
      path          TEXT NOT NULL,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL,
      license       TEXT,
      -- JSON array. Shown in the UI only, not enforced.
      allowed_tools TEXT,
      -- JSON array: spec violations (the skill still loads)
      warnings      TEXT NOT NULL DEFAULT '[]'
    );

    INSERT INTO skills_new
      SELECT id, manba_id, yol, nom, tavsif, litsenziya, allowed_tools, ogohlantirishlar
        FROM skilllar;

    DROP TABLE skilllar;
    ALTER TABLE skills_new RENAME TO skills;

    CREATE UNIQUE INDEX idx_skill_path ON skills (source_id, path);

    -- skill_ornatish → skill_installs    CHECK: 'loyiha' → 'project'
    CREATE TABLE skill_installs_new (
      id         TEXT PRIMARY KEY,
      skill_id   TEXT NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
      scope      TEXT NOT NULL CHECK (scope IN ('global', 'project')),
      -- Required for 'project', NULL for 'global' — the CHECK enforces it
      project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((scope = 'project' AND project_id IS NOT NULL)
          OR (scope = 'global'  AND project_id IS NULL))
    );

    INSERT INTO skill_installs_new
      SELECT id, skill_id,
             CASE qamrov WHEN 'loyiha' THEN 'project' ELSE qamrov END,
             project_id, created_at
        FROM skill_ornatish;

    DROP TABLE skill_ornatish;
    ALTER TABLE skill_installs_new RENAME TO skill_installs;

    -- COALESCE is required: global rows have project_id NULL and NULLs count
    -- as distinct for UNIQUE, so without it a global install could repeat.
    CREATE UNIQUE INDEX idx_skill_install_unique
      ON skill_installs (skill_id, scope, COALESCE(project_id, ''));

    CREATE INDEX idx_skill_install_project ON skill_installs (project_id);

    -- mcp_manbalari → mcp_sources    CHECK: 'qolda' → 'manual', 'standart' → 'builtin'
    CREATE TABLE mcp_sources_new (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL
                  CHECK (kind IN ('registry', 'github', 'manual', 'builtin')),
      -- Means something different per kind: registry server name / owner+repo /
      -- the name the user gave / the builtin folder name.
      source_name TEXT NOT NULL,
      -- Only filled for 'github' (same as skill_sources).
      owner       TEXT,
      repo        TEXT,
      -- Empty string = default branch. NOT NULL: a UNIQUE index does not treat
      -- NULLs as duplicates, so a source could be connected twice.
      ref         TEXT NOT NULL DEFAULT '',
      last_sync   TEXT,
      created_at  TEXT NOT NULL
    );

    INSERT INTO mcp_sources_new
      SELECT id,
             CASE tur
               WHEN 'qolda'    THEN 'manual'
               WHEN 'standart' THEN 'builtin'
               ELSE tur
             END,
             manba_nomi, owner, repo, ref, oxirgi_sinxron, created_at
        FROM mcp_manbalari;

    DROP TABLE mcp_manbalari;
    ALTER TABLE mcp_sources_new RENAME TO mcp_sources;

    CREATE UNIQUE INDEX idx_mcp_source_name ON mcp_sources (kind, source_name, ref);

    -- mcp_serverlar → mcp_servers    (rebuilt so its FK points at mcp_sources)
    CREATE TABLE mcp_servers_new (
      id          TEXT PRIMARY KEY,
      source_id   TEXT NOT NULL REFERENCES mcp_sources (id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      transport   TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
      -- For stdio: 'npx' | 'uvx' | 'docker' etc.
      command     TEXT,
      -- JSON array (string[]). Placeholders ({token}) are not substituted yet —
      -- that happens inside the Bun.spawn argv.
      args        TEXT,
      -- For http: the server address
      url         TEXT,
      -- JSON array (McpSettingField[]) — SCHEMA ONLY, never values
      settings    TEXT NOT NULL DEFAULT '[]',
      -- Enforces that the field matching the transport is filled in: stdio does
      -- not start without a command, http does not connect without a url.
      CHECK (
        (transport = 'stdio' AND command IS NOT NULL) OR
        (transport = 'http'  AND url     IS NOT NULL)
      )
    );

    INSERT INTO mcp_servers_new
      SELECT id, manba_id, nom, tavsif, transport, buyruq, argumentlar, url, sozlamalar
        FROM mcp_serverlar;

    DROP TABLE mcp_serverlar;
    ALTER TABLE mcp_servers_new RENAME TO mcp_servers;

    CREATE UNIQUE INDEX idx_mcp_server_name ON mcp_servers (source_id, name);

    -- mcp_ornatish → mcp_installs    CHECK: 'loyiha' → 'project'
    CREATE TABLE mcp_installs_new (
      id             TEXT PRIMARY KEY,
      server_id      TEXT NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
      scope          TEXT NOT NULL CHECK (scope IN ('global', 'project')),
      -- Required for 'project', NULL for 'global' — the CHECK enforces it
      project_id     TEXT REFERENCES projects (id) ON DELETE CASCADE,
      -- JSON: { [envName]: value }. NON-SECRET fields only.
      setting_values TEXT NOT NULL DEFAULT '{}',
      created_at     TEXT NOT NULL,
      CHECK ((scope = 'project' AND project_id IS NOT NULL)
          OR (scope = 'global'  AND project_id IS NULL))
    );

    INSERT INTO mcp_installs_new
      SELECT id, server_id,
             CASE qamrov WHEN 'loyiha' THEN 'project' ELSE qamrov END,
             project_id, sozlama_qiymatlari, created_at
        FROM mcp_ornatish;

    DROP TABLE mcp_ornatish;
    ALTER TABLE mcp_installs_new RENAME TO mcp_installs;

    CREATE UNIQUE INDEX idx_mcp_install_unique
      ON mcp_installs (server_id, scope, COALESCE(project_id, ''));

    CREATE INDEX idx_mcp_install_project ON mcp_installs (project_id);

    -- audit_log    CHECK: the level and result value sets both change.
    --
    -- The append-only triggers must be dropped FIRST: they fire BEFORE
    -- UPDATE/DELETE on the table, and DROP TABLE below would otherwise leave
    -- them dangling. They are recreated with English names at the end.
    DROP TRIGGER audit_log_ozgartirish_taqiq;
    DROP TRIGGER audit_log_ochirish_taqiq;

    CREATE TABLE audit_log_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      time       TEXT NOT NULL,
      actor      TEXT NOT NULL,
      action     TEXT NOT NULL,
      target     TEXT NOT NULL,
      level      TEXT NOT NULL CHECK (level IN ('read', 'write', 'dangerous')),
      result     TEXT NOT NULL CHECK (result IN ('OK', 'approved', 'denied', 'pending')),
      created_at TEXT NOT NULL
    );

    -- The id is carried over so the log keeps its original ordering.
    INSERT INTO audit_log_new (id, time, actor, action, target, level, result, created_at)
      SELECT id, time, actor, action, target,
             CASE level
               WHEN 'o''qish'        THEN 'read'
               WHEN 'o''zgartirish'  THEN 'write'
               WHEN 'xavfli'         THEN 'dangerous'
               ELSE level
             END,
             CASE result
               WHEN 'tasdiqlandi' THEN 'approved'
               WHEN 'rad etildi'  THEN 'denied'
               WHEN 'kutmoqda'    THEN 'pending'
               ELSE result
             END,
             created_at
        FROM audit_log;

    DROP TABLE audit_log;
    ALTER TABLE audit_log_new RENAME TO audit_log;

    CREATE INDEX idx_audit_level   ON audit_log (level);
    CREATE INDEX idx_audit_actor   ON audit_log (actor);
    CREATE INDEX idx_audit_created ON audit_log (created_at DESC);

    -- Append-only guarantee: attempts to update or delete raise an error
    CREATE TRIGGER audit_log_no_update
      BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE is forbidden');
    END;

    CREATE TRIGGER audit_log_no_delete
      BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only: DELETE is forbidden');
    END;

    -- ======================================================================
    -- 2) Plain renames — no CHECK on a renamed value
    -- ======================================================================

    ALTER TABLE tool_chaqiruvlar RENAME TO tool_calls;
    ALTER TABLE tool_calls RENAME COLUMN nom           TO name;
    ALTER TABLE tool_calls RENAME COLUMN holat         TO status;
    ALTER TABLE tool_calls RENAME COLUMN natija        TO result;
    ALTER TABLE tool_calls RENAME COLUMN tafsilot      TO detail;
    ALTER TABLE tool_calls RENAME COLUMN ruxsat        TO permission;
    ALTER TABLE tool_calls RENAME COLUMN klassifikator TO classifier;

    -- Indexes do not follow a RENAME TO, they keep their old names.
    DROP INDEX tool_chaqiruvlar_message;
    DROP INDEX tool_chaqiruvlar_session;
    CREATE INDEX idx_tool_calls_message ON tool_calls (message_id, created_at);
    CREATE INDEX idx_tool_calls_session ON tool_calls (session_id, created_at);

    ALTER TABLE chat_biriktirmalar RENAME TO chat_attachments;
    ALTER TABLE chat_attachments RENAME COLUMN tur     TO kind;
    ALTER TABLE chat_attachments RENAME COLUMN nom     TO name;
    ALTER TABLE chat_attachments RENAME COLUMN asl_nom TO original_name;
    ALTER TABLE chat_attachments RENAME COLUMN yol     TO path;
    ALTER TABLE chat_attachments RENAME COLUMN hajm    TO size;

    DROP INDEX chat_biriktirmalar_message;
    DROP INDEX chat_biriktirmalar_session;
    CREATE INDEX idx_chat_attachments_message ON chat_attachments (message_id, created_at);
    CREATE INDEX idx_chat_attachments_session ON chat_attachments (session_id, created_at);

    ALTER TABLE projects RENAME COLUMN papka TO folder;

    -- ======================================================================
    -- 3) Stored value rewrites
    -- ======================================================================

    UPDATE tool_calls SET status = CASE status
      WHEN 'ishlamoqda' THEN 'running'
      WHEN 'tugadi'     THEN 'done'
      WHEN 'xato'       THEN 'error'
      WHEN 'rad etildi' THEN 'denied'
      ELSE status
    END;

    UPDATE chat_attachments SET kind = CASE kind
      WHEN 'rasm' THEN 'image'
      WHEN 'fayl' THEN 'file'
      ELSE kind
    END;

    -- Flat JSON blobs — shallow enough that plain string replacement on the
    -- KEY TOKEN (including the quotes and the colon) is unambiguous. Only our
    -- own keys are touched; the values are left alone except for the
    -- permission origin and classifier verdict enums, which are ours too.

    -- mcp_servers.settings — McpSettingField[]
    UPDATE mcp_servers SET settings =
      replace(replace(replace(replace(replace(settings,
        '"nom":',       '"name":'),
        '"izoh":',      '"hint":'),
        '"majburiy":',  '"required":'),
        '"maxfiy":',    '"secret":'),
        '"standart":',  '"default":')
      WHERE settings IS NOT NULL AND settings <> '[]';

    -- tool_calls.detail — { diff, qisqartirilgan }
    UPDATE tool_calls SET detail =
      replace(detail, '"qisqartirilgan":', '"truncated":')
      WHERE detail IS NOT NULL;

    -- tool_calls.permission — PermissionDecision, keys and origin values
    UPDATE tool_calls SET permission =
      replace(replace(replace(replace(replace(replace(
      replace(replace(replace(replace(replace(replace(replace(permission,
        '"sorovId":',  '"requestId":'),
        '"manba":',    '"origin":'),
        '"berildi":',  '"granted":'),
        '"naqsh":',    '"pattern":'),
        '"vaqt":',     '"time":'),
        '"origin":"hardoim"',              '"origin":"always"'),
        '"origin":"auto-blok"',            '"origin":"auto-block"'),
        '"origin":"foydalanuvchi-hardoim"','"origin":"user-always"'),
        '"origin":"foydalanuvchi"',        '"origin":"user"'),
        '"origin":"rad"',                  '"origin":"denied"'),
        '"origin":"muddat"',               '"origin":"timeout"'),
        '"origin":"bekor"',                '"origin":"cancelled"'),
        '"origin":"taqiqlangan"',          '"origin":"forbidden"')
      WHERE permission IS NOT NULL;

    -- tool_calls.classifier — ClassifierVerdict, keys and verdict values
    UPDATE tool_calls SET classifier =
      replace(replace(replace(replace(classifier,
        '"qaror":', '"verdict":'),
        '"izoh":',  '"note":'),
        '"verdict":"ruxsat"', '"verdict":"allow"'),
        '"verdict":"blok"',   '"verdict":"block"')
      WHERE classifier IS NOT NULL;

    COMMIT;

    PRAGMA foreign_keys = ON;
  `,
}
