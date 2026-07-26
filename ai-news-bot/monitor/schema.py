"""Monitor agentining baza sxemasi — versiya diapazoni 200–299.

Jadvallar `core/db/schema.py::all_migrations()` orqali botning
migratsiyalari bilan birga qo'llanadi (`bot db migrate`).
"""

from __future__ import annotations

# Har bir element: (versiya, izoh, SQL)
MONITOR_MIGRATIONS: list[tuple[int, str, str]] = [
    (
        200,
        "Monitor: server tekshiruvlari va alert tarixi",
        """
        -- ─── Har bir tekshiruvning natijasi ───
        -- Tarix saqlanadi: "hozir buzilgan" holati oxirgi yozuvni
        -- o'qib aniqlanadi, xatolar tarixidan emas (bot/health dagi
        -- bilan bir xil mantiq — tuzatilgan muammo qizil turmasin).
        CREATE TABLE server_checks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            checked_at  TEXT    NOT NULL,          -- ISO 8601 UTC
            server      TEXT    NOT NULL,          -- servers.yaml dagi nom
            -- load | memory | disk:/var | uptime | service:nginx | ssh
            check_name  TEXT    NOT NULL,
            -- ok: normal | warn: chegaraga yaqin | fail: chegaradan oshdi
            -- error: tekshirib bo'lmadi (SSH yiqildi, chiqish tushunarsiz)
            status      TEXT    NOT NULL,
            message     TEXT    NOT NULL,          -- odam o'qiydigan izoh
            value       REAL,                      -- son ko'rsatkich (foiz, load)
            threshold   REAL,                      -- qaysi chegara bilan solishtirildi
            duration_ms INTEGER
        );

        CREATE INDEX idx_server_checks_at  ON server_checks (checked_at);
        -- Oxirgi holatni tez topish uchun: (server, check) bo'yicha eng katta id
        CREATE INDEX idx_server_checks_key ON server_checks (server, check_name, id);

        -- ─── Yuborilgan alertlar ───
        -- Cooldown kaliti (server, check_name): bitta serverning diski
        -- to'lgani boshqa serverning alertini bosmasligi kerak. Botdagi
        -- global cooldown (runs jadvali) bu yerda yaroqsiz.
        CREATE TABLE server_alerts (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at   TEXT NOT NULL,
            server       TEXT NOT NULL,
            check_name   TEXT NOT NULL,
            status       TEXT NOT NULL,            -- fail | error
            summary      TEXT NOT NULL,            -- alertning asosiy qatori
            diagnosis    TEXT,                     -- LLM izohi (bo'lsa)
            -- Muammo tugagach to'ldiriladi: tiklanish xabari yuboriladi
            -- va keyingi buzilish yangi alert hisoblanadi.
            resolved_at  TEXT
        );

        CREATE INDEX idx_server_alerts_key  ON server_alerts (server, check_name, id);
        CREATE INDEX idx_server_alerts_open ON server_alerts (resolved_at);
        """,
    ),
]
