"""Migration registry — every agent's schema in one place.

Each agent declares its own migrations in its own package; here they
are merged into a single list. Version numbers are global and unique,
split into ranges:

    1–199    bot       (`bot/schema.py`)
    200–299  monitor   (`monitor/schema.py`)
    300–399  shared    (this file, CORE_MIGRATIONS)

The range convention stands in for a namespace: no extra column is
needed in the `schema_migrations` table, because the version is the
PRIMARY KEY and an applied migration never runs again.

Never modify an existing migration — add a new one instead.
"""

from __future__ import annotations

Migration = tuple[int, str, str]

# New migrations for shared tables go here (starting at 300).
# For historical reasons the current shared tables (llm_calls, errors,
# runs) are created by bot migration 1 — see `bot/schema.py`.
CORE_MIGRATIONS: list[Migration] = []


def all_migrations() -> list[Migration]:
    """Every agent's migrations, sorted by version.

    The imports are inside the function: the `core` package must not
    depend on `bot`/`monitor` at module load time (circular import).
    """
    from bot.schema import BOT_MIGRATIONS
    from monitor.schema import MONITOR_MIGRATIONS

    merged = [*CORE_MIGRATIONS, *BOT_MIGRATIONS, *MONITOR_MIGRATIONS]

    versions = [v for v, _, _ in merged]
    duplicates = sorted({v for v in versions if versions.count(v) > 1})
    if duplicates:
        raise RuntimeError(
            f"Duplicate migration version: {duplicates}. "
            f"Each agent must stay within its own range (bot 1–199, monitor 200–299)."
        )

    return sorted(merged)


def latest_version() -> int:
    """The latest migration version."""
    migrations = all_migrations()
    return max(v for v, _, _ in migrations) if migrations else 0
