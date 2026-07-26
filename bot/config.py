"""Konfiguratsiya yuklash — YAML fayllar va muhit o'zgaruvchilari.

Barcha modullar sozlamalarni shu yerdan oladi. YAML fayllar `config/`
katalogida, maxfiy ma'lumotlar (API kalitlar) faqat muhit o'zgaruvchilarida.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

# Loyiha ildizi: bot/config.py -> bot/ -> ildiz
ROOT_DIR = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT_DIR / "config"

load_dotenv(ROOT_DIR / ".env")


class ConfigError(RuntimeError):
    """Konfiguratsiya xatosi — yetishmayotgan fayl yoki kalit."""


def _read_yaml(name: str) -> dict[str, Any]:
    path = CONFIG_DIR / name
    if not path.exists():
        raise ConfigError(f"Konfiguratsiya fayli topilmadi: {path}")
    with path.open(encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ConfigError(f"{name} ildizida obyekt (mapping) kutilgan edi")
    return data


def env_str(key: str, default: str | None = None, *, required: bool = False) -> str:
    """Muhit o'zgaruvchisini o'qish.

    `required=True` bo'lsa va qiymat yo'q bo'lsa ConfigError.
    """
    value = os.getenv(key, default)
    if required and not value:
        raise ConfigError(
            f"{key} muhit o'zgaruvchisi belgilanmagan. .env.example dan nusxa oling."
        )
    return value or ""


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


# ─────────────────────────── Modellar ───────────────────────────


@dataclass(frozen=True, slots=True)
class StageConfig:
    """Pipeline bosqichi uchun model sozlamalari."""

    name: str
    model: str
    fallbacks: tuple[str, ...] = ()
    max_tokens: int = 1000
    temperature: float = 0.0

    @property
    def chain(self) -> tuple[str, ...]:
        """Asosiy model + fallbacklar — urinish tartibida."""
        return (self.model, *self.fallbacks)


@dataclass(frozen=True, slots=True)
class Price:
    """Model narxi, $/1M token."""

    input: float
    output: float

    def cost_usd(self, prompt_tokens: int, completion_tokens: int) -> float:
        return (prompt_tokens * self.input + completion_tokens * self.output) / 1_000_000


@dataclass(frozen=True, slots=True)
class Limits:
    daily_cost_usd: float = 2.0
    max_retries: int = 3
    retry_base_delay: float = 2.0
    request_timeout: int = 120


@dataclass(frozen=True, slots=True)
class ModelsConfig:
    stages: dict[str, StageConfig]
    pricing: dict[str, Price]
    limits: Limits
    language_test_candidates: tuple[str, ...] = ()

    def stage(self, name: str) -> StageConfig:
        try:
            return self.stages[name]
        except KeyError:
            raise ConfigError(
                f"models.yaml: '{name}' bosqichi topilmadi. "
                f"Mavjud bosqichlar: {sorted(self.stages)}"
            ) from None

    def price(self, model: str) -> Price | None:
        """Model narxi. Noma'lum model uchun None — xarajat 0 deb hisoblanadi."""
        return self.pricing.get(model)


def _parse_models(raw: dict[str, Any]) -> ModelsConfig:
    stages: dict[str, StageConfig] = {}
    for name, cfg in (raw.get("stages") or {}).items():
        if "model" not in cfg:
            raise ConfigError(f"models.yaml: '{name}' bosqichida 'model' maydoni yo'q")
        stages[name] = StageConfig(
            name=name,
            model=cfg["model"],
            fallbacks=tuple(cfg.get("fallbacks") or ()),
            max_tokens=int(cfg.get("max_tokens", 1000)),
            temperature=float(cfg.get("temperature", 0.0)),
        )

    pricing = {
        model: Price(input=float(p["input"]), output=float(p["output"]))
        for model, p in (raw.get("pricing") or {}).items()
    }

    limits_raw = raw.get("limits") or {}
    limits = Limits(
        daily_cost_usd=float(limits_raw.get("daily_cost_usd", 2.0)),
        max_retries=int(limits_raw.get("max_retries", 3)),
        retry_base_delay=float(limits_raw.get("retry_base_delay", 2.0)),
        request_timeout=int(limits_raw.get("request_timeout", 120)),
    )

    return ModelsConfig(
        stages=stages,
        pricing=pricing,
        limits=limits,
        language_test_candidates=tuple(raw.get("language_test_candidates") or ()),
    )


# ─────────────────────────── Umumiy config ───────────────────────────


@dataclass(frozen=True, slots=True)
class Config:
    sources: list[Source]
    channel: dict[str, Any]
    models: ModelsConfig

    @property
    def enabled_sources(self) -> list[Source]:
        return [s for s in self.sources if s.enabled]

    # Telegram / baza sozlamalari — maxfiy bo'lgani uchun env'dan
    @property
    def db_path(self) -> Path:
        raw = env_str("DB_PATH", "data/bot.db")
        path = Path(raw)
        return path if path.is_absolute() else ROOT_DIR / path

    @property
    def log_level(self) -> str:
        return env_str("LOG_LEVEL", "INFO").upper()


@lru_cache(maxsize=1)
def load_config() -> Config:
    """Konfiguratsiyani yuklash (jarayon davomida bir marta o'qiladi)."""
    return Config(
        sources=_parse_sources(_read_yaml("sources.yaml")),
        channel=_read_yaml("channel.yaml"),
        models=_parse_models(_read_yaml("models.yaml")),
    )
