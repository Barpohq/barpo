"""Bot configuration — sources and channel profile.

The shared pieces (`.env`, `models.yaml`, database path) live in
`core/config.py`. Only what is specific to the news bot is here:
`sources.yaml` and `channel.yaml`.
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

# The old import paths are kept: `from bot.config import ConfigError` is
# still used in many places and makes sense for the bot.
__all__ = ["Config", "ConfigError", "Source", "load_config"]


# ─────────────────────────── Sources ───────────────────────────


@dataclass(frozen=True, slots=True)
class Source:
    """A single news source (an entry in `sources.yaml`)."""

    name: str
    type: str
    enabled: bool = True
    weight: float = 1.0
    max_items: int = 40
    timeout: int = 20
    # Remaining type-specific fields: url, query, subreddit, categories, ...
    options: dict[str, Any] = field(default_factory=dict)


def _parse_sources(raw: dict[str, Any]) -> list[Source]:
    defaults = raw.get("defaults") or {}
    known = {"name", "type", "enabled", "weight", "max_items", "timeout"}
    sources: list[Source] = []

    for entry in raw.get("sources") or []:
        if not isinstance(entry, dict):
            raise ConfigError(f"sources.yaml: a source must be an object, got: {entry!r}")
        for required_key in ("name", "type"):
            if required_key not in entry:
                raise ConfigError(f"sources.yaml: source is missing the '{required_key}' field: {entry!r}")

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
        raise ConfigError(f"sources.yaml: duplicate source names: {sorted(duplicates)}")

    return sources


# ─────────────────────────── Shared config ───────────────────────────


@dataclass(frozen=True, slots=True)
class Config:
    sources: list[Source]
    channel: dict[str, Any]
    models: ModelsConfig

    @property
    def enabled_sources(self) -> list[Source]:
        return [s for s in self.sources if s.enabled]

    # Database and logging settings are shared — they come from core.config
    @property
    def db_path(self) -> Path:
        return db_path()

    @property
    def log_level(self) -> str:
        return log_level()


@lru_cache(maxsize=1)
def load_config() -> Config:
    """Load the configuration (read once per process)."""
    return Config(
        sources=_parse_sources(read_yaml("sources.yaml")),
        channel=read_yaml("channel.yaml"),
        models=load_models(),
    )
