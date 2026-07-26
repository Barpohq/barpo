"""Migratsiyalar registri — barcha agentlarning sxemasi bir joyda.

Har agent o'z migratsiyalarini o'z paketida e'lon qiladi, bu yerda
ular bitta ro'yxatga birlashtiriladi. Versiya raqamlari global va
noyob — diapazonlar bo'yicha taqsimlangan:

    1–199    bot       (`bot/schema.py`)
    200–299  monitor   (`monitor/schema.py`)
    300–399  umumiy    (shu fayl, CORE_MIGRATIONS)

Diapazon konvensiyasi namespace o'rnini bosadi: `schema_migrations`
jadvaliga ustun qo'shish shart emas, chunki versiya PRIMARY KEY va
qo'llangan migratsiya qayta ishga tushmaydi.

Mavjud migratsiyani hech qachon o'zgartirmang — yangisini qo'shing.
"""

from __future__ import annotations

Migration = tuple[int, str, str]

# Umumiy jadvallar uchun yangi migratsiyalar shu yerga (300 dan boshlab).
# Hozirgi umumiy jadvallar (llm_calls, errors, runs) tarixiy sabablarga
# ko'ra bot migratsiyasi 1 da yaratiladi — `bot/schema.py` ga qarang.
CORE_MIGRATIONS: list[Migration] = []


def all_migrations() -> list[Migration]:
    """Barcha agentlarning migratsiyalari, versiya bo'yicha tartiblangan.

    Import funksiya ichida: `core` paketi `bot`/`monitor` ga modul
    yuklanish vaqtida bog'lanmasligi kerak (sirkulyar import).
    """
    from bot.schema import BOT_MIGRATIONS
    from monitor.schema import MONITOR_MIGRATIONS

    merged = [*CORE_MIGRATIONS, *BOT_MIGRATIONS, *MONITOR_MIGRATIONS]

    versions = [v for v, _, _ in merged]
    duplicates = sorted({v for v in versions if versions.count(v) > 1})
    if duplicates:
        raise RuntimeError(
            f"Migratsiya versiyasi takrorlangan: {duplicates}. "
            f"Har agent o'z diapazonida bo'lishi kerak (bot 1–199, monitor 200–299)."
        )

    return sorted(merged)


def latest_version() -> int:
    """Eng so'nggi migratsiya versiyasi."""
    migrations = all_migrations()
    return max(v for v, _, _ in migrations) if migrations else 0
