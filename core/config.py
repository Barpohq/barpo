"""Umumiy konfiguratsiya — muhit o'zgaruvchilari va model sozlamalari.

Bu yerda ikkala agent (bot va monitor) ishlatadigan qism: YAML o'qish,
`.env`, baza yo'li va `models.yaml`. Agentga xos konfiguratsiya o'z
paketida bo'ladi (`bot/config.py`, `monitor/config.py`).

Maxfiy ma'lumotlar (API kalitlar) faqat muhit o'zgaruvchilarida.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

# Loyiha ildizi: core/config.py -> core/ -> ildiz
ROOT_DIR = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT_DIR / "config"

load_dotenv(ROOT_DIR / ".env")


class ConfigError(RuntimeError):
    """Konfiguratsiya xatosi — yetishmayotgan fayl yoki kalit."""


def read_yaml(name: str) -> dict[str, Any]:
    """`config/` katalogidagi YAML faylni o'qish."""
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


def db_path() -> Path:
    """SQLite fayli. Ikkala agent bitta bazani ishlatadi."""
    raw = env_str("DB_PATH", "data/bot.db")
    path = Path(raw)
    return path if path.is_absolute() else ROOT_DIR / path


def log_level() -> str:
    return env_str("LOG_LEVEL", "INFO").upper()


# ─────────────────────────── Modellar ───────────────────────────


@dataclass(frozen=True, slots=True)
class StageConfig:
    """Bitta vazifa uchun model sozlamalari.

    "Bosqich" — `models.yaml` dagi kalit, kodda qattiq qiymat yo'q.
    Bot uchun rank/enrich/write, monitor uchun diagnostika.
    """

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
    # Bosqich bo'yicha alohida kunlik limit. Ikki agent bitta bazani
    # bo'lishadi — bot pipeline'i limitni to'ldirsa monitor diagnostikasi
    # bloklanmasligi kerak (va aksincha).
    stage_limits: tuple[tuple[str, float], ...] = ()

    def limit_for(self, stage: str) -> tuple[float, str]:
        """Bosqich uchun limit va u qaysi kalitdan kelgani.

        Alohida limiti bo'lmagan bosqichlar umumiy limitni bo'lishadi.
        """
        for name, value in self.stage_limits:
            if name == stage:
                return value, f"stage_limits.{name}"
        return self.daily_cost_usd, "daily_cost_usd"

    def counted_stages(self, stage: str) -> tuple[tuple[str, ...], bool]:
        """Limitga qaysi bosqichlar sanaladi.

        Qaytadi: (bosqichlar, `include`). `include=True` — faqat shu
        ro'yxat sanaladi; `include=False` — ro'yxatdagilar chiqarib
        tashlanadi (umumiy limit alohida limitli bosqichlarni
        o'ziga qo'shmasligi kerak).
        """
        named = tuple(name for name, _ in self.stage_limits)
        if stage in named:
            return (stage,), True
        return named, False


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


def parse_models(raw: dict[str, Any]) -> ModelsConfig:
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
    stage_limits_raw = limits_raw.get("stage_limits") or {}
    if not isinstance(stage_limits_raw, dict):
        raise ConfigError("models.yaml: limits.stage_limits obyekt bo'lishi kerak")

    limits = Limits(
        daily_cost_usd=float(limits_raw.get("daily_cost_usd", 2.0)),
        max_retries=int(limits_raw.get("max_retries", 3)),
        retry_base_delay=float(limits_raw.get("retry_base_delay", 2.0)),
        request_timeout=int(limits_raw.get("request_timeout", 120)),
        stage_limits=tuple(
            (str(name), float(value)) for name, value in sorted(stage_limits_raw.items())
        ),
    )

    return ModelsConfig(
        stages=stages,
        pricing=pricing,
        limits=limits,
        language_test_candidates=tuple(raw.get("language_test_candidates") or ()),
    )


@lru_cache(maxsize=1)
def load_models() -> ModelsConfig:
    """`models.yaml` (jarayon davomida bir marta o'qiladi)."""
    return parse_models(read_yaml("models.yaml"))
