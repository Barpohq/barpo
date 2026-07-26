"""Testlar uchun umumiy fixture'lar."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest

# Klient qurishda kerak — haqiqiy chaqiruvlar mock transport orqali ketadi
os.environ.setdefault("OPENROUTER_API_KEY", "test-key")


@pytest.fixture
def migrated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Har test uchun toza, migratsiya qilingan vaqtinchalik baza."""
    from bot import config as config_module
    from bot.db import database
    from core import config as core_config

    db_path = tmp_path / "test.db"
    monkeypatch.setenv("DB_PATH", str(db_path))
    # Ikkala kesh ham tozalanishi kerak: bot konfiguratsiyasi va
    # models.yaml alohida keshlanadi, aks holda oldingi testning
    # bazasi keyingisiga o'tib ketadi.
    config_module.load_config.cache_clear()
    core_config.load_models.cache_clear()

    database.close_connection()
    database.migrate()

    yield db_path

    database.close_connection()
    config_module.load_config.cache_clear()
    core_config.load_models.cache_clear()
