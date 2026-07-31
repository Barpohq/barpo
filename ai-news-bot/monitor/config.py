"""Monitor configuration — reading and validating `servers.yaml`.

Key principle: there are NO COMMANDS here. The configuration only says
"which server, which check, which threshold" — the command strings are
hardcoded in `monitor/checks.py`. Otherwise the config file would become
a remote code execution channel.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

from core.config import ConfigError, read_yaml

# systemd unit name. We validate the name even though the command is passed
# without a shell — a bad config value must not do something unexpected
# on the remote host.
SERVICE_NAME_RE = re.compile(r"^[A-Za-z0-9_.@:-]{1,64}$")
# Mount path: absolute, safe characters only
MOUNT_PATH_RE = re.compile(r"^/[A-Za-z0-9_./-]*$")
# Server name — used in reports and as a database key
SERVER_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")

# Check interval in continuous mode (minutes). It lives here so the CLI help
# text does not have to pull in `monitor.scheduler` (and apscheduler with it).
DEFAULT_INTERVAL_MINUTES = 10

DEFAULT_THRESHOLDS: dict[str, dict[str, Any]] = {
    "load": {"warn": 2.0, "fail": 4.0},
    "memory": {"warn": 85.0, "fail": 95.0},
    "disk": {"warn": 80.0, "fail": 90.0, "mounts": ["/"]},
    "uptime": {},
}


@dataclass(frozen=True, slots=True)
class Thresholds:
    """Thresholds for a single check."""

    warn: float | None = None
    fail: float | None = None
    # Disk only: which mounts to check
    mounts: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Server:
    """A monitored server (one entry in `servers.yaml`)."""

    name: str
    host: str
    user: str = "root"
    port: int = 22
    key_file: str = ""
    timeout: int = 20
    enabled: bool = True
    # Services checked with systemctl is-active
    services: tuple[str, ...] = ()
    # Units whose journal logs are pulled for diagnosis
    journal_units: tuple[str, ...] = ()
    checks: dict[str, Thresholds] = field(default_factory=dict)

    def threshold(self, check: str) -> Thresholds:
        return self.checks.get(check, Thresholds())


def _parse_thresholds(check: str, raw: Any, base: dict[str, Any]) -> Thresholds:
    """Merge thresholds: server values layered over the defaults."""
    merged = dict(base)
    if raw:
        if not isinstance(raw, dict):
            raise ConfigError(f"servers.yaml: '{check}' thresholds must be an object")
        merged.update(raw)

    mounts: list[str] = []
    for path in merged.get("mounts") or ():
        path = str(path)
        if not MOUNT_PATH_RE.match(path):
            raise ConfigError(f"servers.yaml: invalid mount path: {path!r}")
        mounts.append(path)

    return Thresholds(
        warn=float(merged["warn"]) if merged.get("warn") is not None else None,
        fail=float(merged["fail"]) if merged.get("fail") is not None else None,
        mounts=tuple(mounts),
    )


def _parse_checks(raw: Any, defaults: dict[str, Any]) -> dict[str, Thresholds]:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ConfigError("servers.yaml: 'checks' must be an object")

    unknown = set(raw) - set(DEFAULT_THRESHOLDS)
    if unknown:
        raise ConfigError(
            f"servers.yaml: unknown check: {sorted(unknown)}. "
            f"Available: {sorted(DEFAULT_THRESHOLDS)}"
        )

    result: dict[str, Thresholds] = {}
    for check, base in DEFAULT_THRESHOLDS.items():
        # defaults.checks layers over DEFAULT_THRESHOLDS, then server values
        combined = {**base, **(defaults.get(check) or {})}
        result[check] = _parse_thresholds(check, raw.get(check), combined)
    return result


def parse_servers(raw: dict[str, Any]) -> list[Server]:
    defaults = raw.get("defaults") or {}
    default_checks = defaults.get("checks") or {}
    servers: list[Server] = []

    for entry in raw.get("servers") or []:
        if not isinstance(entry, dict):
            raise ConfigError(f"servers.yaml: server must be an object, got: {entry!r}")
        for required in ("name", "host"):
            if required not in entry:
                raise ConfigError(f"servers.yaml: server is missing the '{required}' field: {entry!r}")

        name = str(entry["name"])
        if not SERVER_NAME_RE.match(name):
            raise ConfigError(f"servers.yaml: invalid server name: {name!r}")

        services = tuple(str(s) for s in (entry.get("services") or ()))
        journal_units = tuple(str(s) for s in (entry.get("journal_units") or ()))
        for unit in (*services, *journal_units):
            if not SERVICE_NAME_RE.match(unit):
                raise ConfigError(f"servers.yaml: invalid service name: {unit!r}")

        servers.append(
            Server(
                name=name,
                host=str(entry["host"]),
                user=str(entry.get("user", defaults.get("user", "root"))),
                port=int(entry.get("port", defaults.get("port", 22))),
                key_file=str(entry.get("key_file", defaults.get("key_file", ""))),
                timeout=int(entry.get("timeout", defaults.get("timeout", 20))),
                enabled=bool(entry.get("enabled", True)),
                services=services,
                journal_units=journal_units,
                checks=_parse_checks(entry.get("checks"), default_checks),
            )
        )

    names = [s.name for s in servers]
    duplicates = sorted({n for n in names if names.count(n) > 1})
    if duplicates:
        raise ConfigError(f"servers.yaml: duplicate server names: {duplicates}")

    return servers


@lru_cache(maxsize=1)
def load_servers() -> list[Server]:
    """`servers.yaml` (read once per process)."""
    return parse_servers(read_yaml("servers.yaml"))


def enabled_servers() -> list[Server]:
    return [s for s in load_servers() if s.enabled]


def find_server(name: str) -> Server:
    for server in load_servers():
        if server.name == name:
            return server
    raise ConfigError(
        f"servers.yaml: server '{name}' not found. "
        f"Available: {sorted(s.name for s in load_servers())}"
    )
