"""Monitor agentining baza sxemasi — versiya diapazoni 200–299.

Jadvallar `core/db/schema.py::all_migrations()` orqali botning
migratsiyalari bilan birga qo'llanadi (`bot db migrate`).
"""

from __future__ import annotations

# Har bir element: (versiya, izoh, SQL)
MONITOR_MIGRATIONS: list[tuple[int, str, str]] = []
