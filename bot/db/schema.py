"""Baza sxemasi — versiyalangan migratsiyalar.

Yangi migratsiya qo'shish: MIGRATIONS ro'yxatiga (versiya, izoh, SQL) qo'shiladi.
Mavjud migratsiyani hech qachon o'zgartirmang — yangisini qo'shing.
"""

from __future__ import annotations

# Har bir element: (versiya, izoh, SQL)
MIGRATIONS: list[tuple[int, str, str]] = [
    (
        1,
        "Boshlang'ich sxema: items, clusters, cluster_items, posts, llm_calls, errors",
        """
        -- ─── Xom yangilik elementlari ───
        -- Har bir manbadan kelgan element shu yerga tushadi.
        CREATE TABLE items (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            source          TEXT    NOT NULL,          -- sources.yaml dagi manba nomi
            external_id     TEXT,                      -- manbadagi id (HN objectID va h.k.)
            url             TEXT    NOT NULL,
            url_normalized  TEXT    NOT NULL,          -- dedup uchun: utm va h.k. olib tashlangan
            title           TEXT    NOT NULL,
            content         TEXT,                      -- to'liq matn yoki qisqacha
            summary         TEXT,                      -- manbadagi qisqacha (agar bo'lsa)
            author          TEXT,
            image_url       TEXT,                      -- OG image, post uchun
            published_at    TEXT,                      -- ISO 8601, manbadagi sana
            fetched_at      TEXT    NOT NULL,          -- ISO 8601, biz olgan vaqt
            -- raw: yangi | clustered: klasterga tushgan | skipped: filtrdan o'tmagan
            status          TEXT    NOT NULL DEFAULT 'raw',
            extra           TEXT,                      -- JSON: turga xos qo'shimcha maydonlar
            UNIQUE (source, url_normalized)
        );

        CREATE INDEX idx_items_status       ON items (status);
        CREATE INDEX idx_items_fetched_at   ON items (fetched_at);
        CREATE INDEX idx_items_url_norm     ON items (url_normalized);
        CREATE INDEX idx_items_published_at ON items (published_at);

        -- ─── Klasterlar: bir xil yangilikning turli manbalardagi versiyalari ───
        CREATE TABLE clusters (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            primary_item_id  INTEGER NOT NULL,         -- eng to'liq/original manba
            title            TEXT    NOT NULL,         -- odatda primary item sarlavhasi
            created_at       TEXT    NOT NULL,
            updated_at       TEXT    NOT NULL,
            -- new: baholanmagan | ranked: baholangan | enriched | written | published | rejected
            status           TEXT    NOT NULL DEFAULT 'new',
            item_count       INTEGER NOT NULL DEFAULT 1,

            -- Rank bosqichi natijalari
            importance_score REAL,                     -- 1-10
            -- model_release | research | tool | business | other
            category         TEXT,
            relevance_score  REAL,                     -- kanalga moslik, 1-10
            is_spam          INTEGER NOT NULL DEFAULT 0,
            rank_reason      TEXT,                     -- model izohi (debug uchun)
            ranked_at        TEXT,

            FOREIGN KEY (primary_item_id) REFERENCES items (id) ON DELETE CASCADE
        );

        CREATE INDEX idx_clusters_status     ON clusters (status);
        CREATE INDEX idx_clusters_created_at ON clusters (created_at);
        CREATE INDEX idx_clusters_importance ON clusters (importance_score);

        -- ─── Klaster ↔ element bog'lanishi ───
        CREATE TABLE cluster_items (
            cluster_id  INTEGER NOT NULL,
            item_id     INTEGER NOT NULL,
            similarity  REAL,                          -- primary item bilan cosine o'xshashlik
            is_primary  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (cluster_id, item_id),
            FOREIGN KEY (cluster_id) REFERENCES clusters (id) ON DELETE CASCADE,
            FOREIGN KEY (item_id)    REFERENCES items (id)    ON DELETE CASCADE
        );

        CREATE INDEX idx_cluster_items_item ON cluster_items (item_id);

        -- ─── Embeddinglar (dedup uchun, item bo'yicha keshlangan) ───
        CREATE TABLE embeddings (
            item_id    INTEGER PRIMARY KEY,
            model      TEXT NOT NULL,                  -- masalan BAAI/bge-small-en-v1.5
            dim        INTEGER NOT NULL,
            vector     BLOB NOT NULL,                  -- float32 array
            created_at TEXT NOT NULL,
            FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
        );

        -- ─── Tayyor postlar ───
        CREATE TABLE posts (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            cluster_id     INTEGER NOT NULL,
            body           TEXT    NOT NULL,           -- Telegram formatidagi matn
            image_url      TEXT,
            model          TEXT,                       -- qaysi model yozgan
            created_at     TEXT    NOT NULL,
            -- draft: yozildi | pending: tasdiq kutilmoqda | approved | rejected
            -- published: kanalga chiqdi | deleted: kanaldan o'chirildi | failed
            status         TEXT    NOT NULL DEFAULT 'draft',
            -- Approval flow
            approval_msg_id INTEGER,                   -- shaxsiy chatdagi xabar id
            reviewed_at    TEXT,
            reject_reason  TEXT,                       -- rad etish sababi -> prompt tuning uchun
            -- Publish
            published_at   TEXT,
            message_id     INTEGER,                    -- kanaldagi xabar id
            FOREIGN KEY (cluster_id) REFERENCES clusters (id) ON DELETE CASCADE
        );

        CREATE INDEX idx_posts_status       ON posts (status);
        CREATE INDEX idx_posts_cluster      ON posts (cluster_id);
        CREATE INDEX idx_posts_published_at ON posts (published_at);

        -- ─── LLM chaqiruvlar: xarajat hisobi va debug ───
        CREATE TABLE llm_calls (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at        TEXT    NOT NULL,
            stage             TEXT    NOT NULL,        -- rank | enrich | write | test
            model             TEXT    NOT NULL,        -- haqiqatda ishlagan model
            -- so'ralgan model (fallback ishlagan bo'lsa `model` dan farq qiladi)
            requested_model   TEXT    NOT NULL,
            prompt_tokens     INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd          REAL    NOT NULL DEFAULT 0.0,
            duration_ms       INTEGER,
            attempt           INTEGER NOT NULL DEFAULT 1,
            success           INTEGER NOT NULL DEFAULT 1,
            error             TEXT,
            cluster_id        INTEGER                  -- qaysi klaster uchun (bo'lsa)
        );

        CREATE INDEX idx_llm_calls_created ON llm_calls (created_at);
        CREATE INDEX idx_llm_calls_stage   ON llm_calls (stage);

        -- ─── Xatolar: manba buzildi, API ishlamadi va h.k. ───
        CREATE TABLE errors (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            component  TEXT NOT NULL,                  -- collector.rss | llm | publisher | ...
            context    TEXT,                           -- manba nomi, cluster id va h.k.
            message    TEXT NOT NULL,
            traceback  TEXT
        );

        CREATE INDEX idx_errors_created   ON errors (created_at);
        CREATE INDEX idx_errors_component ON errors (component);

        -- ─── Pipeline ishga tushishlari: health report uchun ───
        CREATE TABLE runs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at   TEXT NOT NULL,
            finished_at  TEXT,
            stage        TEXT NOT NULL,                -- collect | dedup | rank | write | publish
            items_in     INTEGER NOT NULL DEFAULT 0,
            items_out    INTEGER NOT NULL DEFAULT 0,
            error_count  INTEGER NOT NULL DEFAULT 0,
            ok           INTEGER NOT NULL DEFAULT 1,
            note         TEXT
        );

        CREATE INDEX idx_runs_started ON runs (started_at);
        CREATE INDEX idx_runs_stage   ON runs (stage);
        """,
    ),
    (
        2,
        "Enricher: klasterga boyitilgan matn va manba havolasi",
        """
        -- Enricher bosqichi natijalari.
        -- Matn klasterga yoziladi (itemga emas): boyitish klaster darajasida
        -- bir marta bajariladi, qaysi a'zodan olinganidan qat'i nazar.
        ALTER TABLE clusters ADD COLUMN enriched_text   TEXT;
        -- Maqolaning aniq URL'i. Agregatordan kelgan klasterda item.url
        -- faqat redirect havolasi bo'ladi — post shu ustunga tayanadi.
        ALTER TABLE clusters ADD COLUMN article_url     TEXT;
        ALTER TABLE clusters ADD COLUMN article_image   TEXT;
        -- fetch | search | none — matn qayerdan olindi (debug va statistika)
        ALTER TABLE clusters ADD COLUMN enrich_source   TEXT;
        ALTER TABLE clusters ADD COLUMN enriched_at     TEXT;
        """,
    ),
    (
        3,
        "Writer: klaster statusiga written/write_failed qo'shildi (izoh)",
        """
        -- SQLite'da CHECK constraint yo'q, shuning uchun bu migratsiya
        -- faqat hujjat vazifasini bajaradi. clusters.status qiymatlari:
        --   new → ranked → written → published
        --   rejected      (Rank: spam yoki past baho)
        --   write_failed  (Writer: tekshiruvdan o'tmadi, qo'lda ko'rish kerak)
        --
        -- Yangi indeks: Publisher navbatini tez topish uchun.
        CREATE INDEX IF NOT EXISTS idx_posts_status_created
            ON posts (status, created_at);
        """,
    ),
]

LATEST_VERSION = max(v for v, _, _ in MIGRATIONS) if MIGRATIONS else 0
