"""Shared configuration — environment variables and model settings.

This holds what both agents (bot and monitor) need: YAML loading,
`.env`, the database path and `models.yaml`. Agent-specific
configuration lives in its own package (`bot/config.py`,
`monitor/config.py`).

Secrets (API keys) live in environment variables only.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

# Project root: core/config.py -> core/ -> root
ROOT_DIR = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT_DIR / "config"

load_dotenv(ROOT_DIR / ".env")


class ConfigError(RuntimeError):
    """Configuration error — a missing file or key."""


def read_yaml(name: str) -> dict[str, Any]:
    """Read a YAML file from the `config/` directory."""
    path = CONFIG_DIR / name
    if not path.exists():
        raise ConfigError(f"Configuration file not found: {path}")
    with path.open(encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ConfigError(f"expected an object (mapping) at the root of {name}")
    return data


def env_str(key: str, default: str | None = None, *, required: bool = False) -> str:
    """Read an environment variable.

    Raises ConfigError if `required=True` and the value is missing.
    """
    value = os.getenv(key, default)
    if required and not value:
        raise ConfigError(
            f"The {key} environment variable is not set. Copy it from .env.example."
        )
    return value or ""


def db_path() -> Path:
    """The SQLite file. Both agents share a single database."""
    raw = env_str("DB_PATH", "data/bot.db")
    path = Path(raw)
    return path if path.is_absolute() else ROOT_DIR / path


def log_level() -> str:
    return env_str("LOG_LEVEL", "INFO").upper()


# ──────────────────────────── Models ────────────────────────────


@dataclass(frozen=True, slots=True)
class StageConfig:
    """Model settings for a single task.

    A "stage" is just a key in `models.yaml` — nothing is hardcoded here.
    The bot uses rank/enrich/write, the monitor uses diagnostics.
    """

    name: str
    model: str
    fallbacks: tuple[str, ...] = ()
    max_tokens: int = 1000
    temperature: float = 0.0

    @property
    def chain(self) -> tuple[str, ...]:
        """Primary model plus fallbacks, in the order they are tried."""
        return (self.model, *self.fallbacks)


@dataclass(frozen=True, slots=True)
class Price:
    """Model price, in $ per 1M tokens."""

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
    # Per-stage daily limit. The two agents share one database — if the
    # bot's pipeline uses up the limit, that must not block the monitor's
    # diagnostics (and vice versa).
    stage_limits: tuple[tuple[str, float], ...] = ()

    def limit_for(self, stage: str) -> tuple[float, str]:
        """The limit for a stage, and which key it came from.

        Stages without a dedicated limit share the global one.
        """
        for name, value in self.stage_limits:
            if name == stage:
                return value, f"stage_limits.{name}"
        return self.daily_cost_usd, "daily_cost_usd"

    def counted_stages(self, stage: str) -> tuple[tuple[str, ...], bool]:
        """Which stages count toward the limit.

        Returns (stages, `include`). With `include=True` only the listed
        stages are counted; with `include=False` they are excluded (the
        global limit must not absorb stages that have their own limit).
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
                f"models.yaml: stage '{name}' not found. "
                f"Available stages: {sorted(self.stages)}"
            ) from None

    def price(self, model: str) -> Price | None:
        """Model price. None for an unknown model — its cost counts as 0."""
        return self.pricing.get(model)


def parse_models(raw: dict[str, Any]) -> ModelsConfig:
    stages: dict[str, StageConfig] = {}
    for name, cfg in (raw.get("stages") or {}).items():
        if "model" not in cfg:
            raise ConfigError(f"models.yaml: stage '{name}' has no 'model' field")
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
        raise ConfigError("models.yaml: limits.stage_limits must be an object")

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
    """`models.yaml` (read once per process)."""
    return parse_models(read_yaml("models.yaml"))
