"""Botning konfiguratsiyasi — manbalar va kanal profili.

Umumiy qism (`.env`, `models.yaml`, baza yo'li) `core/config.py` da.
Bu yerda faqat yangiliklar botiga tegishlisi: `sources.yaml` va
`channel.yaml`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from core.config import (
    ConfigError,
    ModelsConfig,
    db_path,
    load_models,
    log_level,
    read_yaml,
)

# Eski import yo'llari saqlanadi: `from bot.config import ConfigError`
# hali ko'p joyda ishlatiladi va bot uchun ma'noli.
__all__ = ["Config", "ConfigError", "Source", "load_config"]


# ─────────────────────────── Manbalar ───────────────────────────


@dataclass(frozen=True, slots=True)
class Source:
    """Bitta yangilik manbasi (`sources.yaml` dagi element)."""

    name: str
    type: str
    enabled: bool = True
    weight: float = 1.0
    max_items: int = 40
    timeout: int = 20
    # Turga xos qolgan maydonlar: url, query, subreddit, categories, ...
    options: dict[str, Any] = field(default_factory=dict)


def _parse_sources(raw: dict[str, Any]) -> list[Source]:
    defaults = raw.get("defaults") or {}
    known = {"name", "type", "enabled", "weight", "max_items", "timeout"}
    sources: list[Source] = []

    for entry in raw.get("sources") or []:
        if not isinstance(entry, dict):
            raise ConfigError(f"sources.yaml: manba obyekt bo'lishi kerak, keldi: {entry!r}")
        for required_key in ("name", "type"):
            if required_key not in entry:
                raise ConfigError(f"sources.yaml: manbada '{required_key}' maydoni yo'q: {entry!r}")

        sources.append(
            Source(
                name=entry["name"],
                type=entry["type"],
                enabled=entry.get("enabled", True),
                weight=float(entry.get("weight", 1.0)),
                max_items=int(entry.get("max_items", defaults.get("max_items", 40))),
                timeout=int(entry.get("timeout", defaults.get("timeout", 20))),
                options={k: v for k, v in entry.items() if k not in known},
            )
        )

    names = [s.name for s in sources]
    duplicates = {n for n in names if names.count(n) > 1}
    if duplicates:
        raise ConfigError(f"sources.yaml: manba nomlari takrorlangan: {sorted(duplicates)}")

    return sources


# ─────────────────────────── Umumiy config ───────────────────────────


@dataclass(frozen=True, slots=True)
class Config:
    sources: list[Source]
    channel: dict[str, Any]
    models: ModelsConfig

    @property
    def enabled_sources(self) -> list[Source]:
        return [s for s in self.sources if s.enabled]

    # Baza va log sozlamalari umumiy — core.config dan keladi
    @property
    def db_path(self) -> Path:
        return db_path()

    @property
    def log_level(self) -> str:
        return log_level()


@lru_cache(maxsize=1)
def load_config() -> Config:
    """Konfiguratsiyani yuklash (jarayon davomida bir marta o'qiladi)."""
    return Config(
        sources=_parse_sources(read_yaml("sources.yaml")),
        channel=read_yaml("channel.yaml"),
        models=load_models(),
    )
