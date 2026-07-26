"""Migratsiya registri: agentlar sxemasini birlashtirish.

Ikki agent bitta bazani ishlatadi va har biri o'z migratsiyalarini
o'z paketida e'lon qiladi. Versiya raqamlari to'qnashsa, migratsiya
jimgina o'tkazib yuboriladi (versiya PRIMARY KEY) — ya'ni jadval
yaratilmaydi va xato faqat ancha keyin, so'rovda ko'rinadi.
Shuning uchun to'qnashuv ishga tushishda aniqlanishi kerak.
"""

from __future__ import annotations

import pytest

from core.db.schema import all_migrations, latest_version


class TestRegistry:
    def test_bot_migrations_present(self) -> None:
        versions = [v for v, _, _ in all_migrations()]

        assert versions[:4] == [1, 2, 3, 4]

    def test_sorted_by_version(self) -> None:
        versions = [v for v, _, _ in all_migrations()]

        assert versions == sorted(versions)

    def test_latest_matches_max(self) -> None:
        versions = [v for v, _, _ in all_migrations()]

        assert latest_version() == max(versions)

    def test_versions_are_unique(self) -> None:
        versions = [v for v, _, _ in all_migrations()]

        assert len(versions) == len(set(versions))


class TestVersionRanges:
    """Har agent o'z diapazonida: bot 1–199, monitor 200–299."""

    def test_bot_within_range(self) -> None:
        from bot.schema import BOT_MIGRATIONS

        assert all(1 <= v <= 199 for v, _, _ in BOT_MIGRATIONS)

    def test_monitor_within_range(self) -> None:
        from monitor.schema import MONITOR_MIGRATIONS

        assert all(200 <= v <= 299 for v, _, _ in MONITOR_MIGRATIONS)


class TestDuplicateDetection:
    def test_duplicate_version_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import core.db.schema as schema_mod

        # Bot allaqachon 1-versiyani ishlatadi
        monkeypatch.setattr(schema_mod, "CORE_MIGRATIONS", [(1, "to'qnashuv", "")])

        with pytest.raises(RuntimeError, match="takrorlangan"):
            all_migrations()
