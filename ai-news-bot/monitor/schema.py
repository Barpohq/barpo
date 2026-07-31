"""Monitor agent database schema — version range 200–299.

The tables are applied alongside the bot's own migrations through
`core/db/schema.py::all_migrations()` (`bot db migrate`).
"""

from __future__ import annotations

# Each entry: (version, description, SQL)
MONITOR_MIGRATIONS: list[tuple[int, str, str]] = [
    (
        200,
        "Monitor: server checks and alert history",
        """
        -- ─── Result of every check ───
        -- History is kept, but "currently broken" is derived from the
        -- latest row rather than from the error history (same logic as
        -- bot/health — a fixed problem must not stay red).
        CREATE TABLE server_checks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            checked_at  TEXT    NOT NULL,          -- ISO 8601 UTC
            server      TEXT    NOT NULL,          -- name from servers.yaml
            -- load | memory | disk:/var | uptime | service:nginx | ssh
            check_name  TEXT    NOT NULL,
            -- ok: normal | warn: near the threshold | fail: over the threshold
            -- error: could not be checked (SSH failed, output unparseable)
            status      TEXT    NOT NULL,
            message     TEXT    NOT NULL,          -- human-readable description
            value       REAL,                      -- numeric metric (percent, load)
            threshold   REAL,                      -- which threshold it was compared against
            duration_ms INTEGER
        );

        CREATE INDEX idx_server_checks_at  ON server_checks (checked_at);
        -- Fast lookup of the latest state: highest id per (server, check)
        CREATE INDEX idx_server_checks_key ON server_checks (server, check_name, id);

        -- ─── Alerts that were sent ───
        -- Cooldown key is (server, check_name): one server's full disk must
        -- not suppress another server's alert. The bot's global cooldown
        -- (runs table) would be wrong here.
        CREATE TABLE server_alerts (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at   TEXT NOT NULL,
            server       TEXT NOT NULL,
            check_name   TEXT NOT NULL,
            status       TEXT NOT NULL,            -- fail | error
            summary      TEXT NOT NULL,            -- the alert's headline row
            diagnosis    TEXT,                     -- LLM explanation (if any)
            -- Filled in once the problem clears: a recovery message is sent
            -- and any later breakage counts as a new alert.
            resolved_at  TEXT
        );

        CREATE INDEX idx_server_alerts_key  ON server_alerts (server, check_name, id);
        CREATE INDEX idx_server_alerts_open ON server_alerts (resolved_at);
        """,
    ),
]
