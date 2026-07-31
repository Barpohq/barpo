"""Server checks — the commands and the parsing of their output.

The commands are hardcoded here (they never come from configuration) and
all of them are read-only. Everything runs over a single SSH connection:
5 servers × 1 connection, not one connection per check.

The parsers are pure functions — they are tested against real `df`/`free`/
`/proc` output, with no SSH mocking.

Note: `CheckResult.message` is Uzbek on purpose. Those strings become the
body of the Telegram alert (`monitor/report.py::format_alert`), so they are
user-facing product text rather than developer-facing logging.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from core.logging_setup import get_logger
from monitor.config import Server, Thresholds
from monitor.ssh import SshResult, run

log = get_logger(__name__)

# Separator between command output sections — a code constant
SEP = "___MONITOR_SEP___"

# Filesystems that show up in df but aren't worth monitoring. On a real
# server 11 of df's 15 rows are these (tmpfs and Docker overlay) — without
# the filter the alerts would just be noise.
VIRTUAL_FS = frozenset({"tmpfs", "devtmpfs", "overlay", "squashfs", "efivarfs", "none"})

# Result levels
OK = "ok"
WARN = "warn"
FAIL = "fail"
ERROR = "error"


@dataclass(frozen=True, slots=True)
class CheckResult:
    """The result of a single check."""

    server: str
    name: str
    status: str
    # Uzbek: rendered into the Telegram alert body
    message: str
    value: float | None = None
    threshold: float | None = None
    # Raw output — retained for diagnosis
    output: str = ""

    @property
    def is_problem(self) -> bool:
        return self.status in (FAIL, ERROR)


def build_remote_command(server: Server) -> str:
    """Collect every metric in a single command.

    Each section is marked with a separator. The `2>/dev/null` means that
    if a command is missing (systemctl inside a container, say) its section
    is simply empty and the rest still work.
    """
    parts = [
        f"echo {SEP}loadavg; cat /proc/loadavg 2>/dev/null",
        f"echo {SEP}nproc; nproc 2>/dev/null",
        f"echo {SEP}mem; free -b 2>/dev/null",
        f"echo {SEP}disk; df -P -B1 2>/dev/null",
        f"echo {SEP}uptime; cat /proc/uptime 2>/dev/null",
    ]
    if server.services:
        # Service names were validated against a regex in config.py
        units = " ".join(server.services)
        parts.append(f"echo {SEP}services; systemctl is-active {units} 2>/dev/null")
    return "; ".join(parts)


def split_sections(stdout: str) -> dict[str, str]:
    """Split the output into sections on the separators."""
    sections: dict[str, str] = {}
    current = ""
    lines: list[str] = []

    for line in stdout.splitlines():
        if line.startswith(SEP):
            if current:
                sections[current] = "\n".join(lines).strip()
            current = line[len(SEP) :].strip()
            lines = []
        elif current:
            lines.append(line)

    if current:
        sections[current] = "\n".join(lines).strip()
    return sections


# ─────────────────────────── Parsers ─────────────────────────────


def parse_load(loadavg: str, nproc: str) -> tuple[float, int] | None:
    """`/proc/loadavg` and `nproc` → (load1, core count)."""
    fields = loadavg.split()
    if not fields:
        return None
    try:
        load1 = float(fields[0])
    except ValueError:
        return None

    cores = 1
    if nproc.strip().isdigit():
        cores = max(1, int(nproc.strip()))
    return load1, cores


def parse_memory(free_output: str) -> float | None:
    """`free -b` → percentage of RAM in use.

    Note: this uses `total - available`, not the `used` column. On Linux
    buff/cache looks "used" but is reclaimed the moment it's needed — on a
    real server the difference can be as wide as 57% versus 4%.
    """
    for line in free_output.splitlines():
        if not line.lower().startswith("mem:"):
            continue
        fields = line.split()
        # Mem: total used free shared buff/cache available
        if len(fields) < 7:
            return None
        try:
            total = float(fields[1])
            available = float(fields[6])
        except ValueError:
            return None
        if total <= 0:
            return None
        return (total - available) / total * 100
    return None


@dataclass(frozen=True, slots=True)
class DiskUsage:
    mount: str
    percent: float
    used_bytes: int
    total_bytes: int


def parse_disk(df_output: str) -> list[DiskUsage]:
    """`df -P -B1` → percentage used per mount.

    Virtual filesystems (tmpfs, Docker overlay) are skipped — they don't
    tell you anything about a disk filling up.
    """
    result: list[DiskUsage] = []
    for line in df_output.splitlines()[1:]:  # first line is the header
        fields = line.split()
        if len(fields) < 6:
            continue
        filesystem, blocks, used, _avail, capacity, mount = fields[:6]
        if filesystem in VIRTUAL_FS:
            continue
        try:
            total_bytes = int(blocks)
            used_bytes = int(used)
            percent = float(capacity.rstrip("%"))
        except ValueError:
            continue
        if total_bytes <= 0:
            continue
        result.append(
            DiskUsage(
                mount=mount, percent=percent, used_bytes=used_bytes, total_bytes=total_bytes
            )
        )
    return result


def parse_uptime(uptime_output: str) -> float | None:
    """`/proc/uptime` → uptime in seconds."""
    fields = uptime_output.split()
    if not fields:
        return None
    try:
        return float(fields[0])
    except ValueError:
        return None


def parse_services(output: str, names: tuple[str, ...]) -> dict[str, str]:
    """`systemctl is-active a b c` → {name: state}.

    The output order matches the order asked for (systemd guarantees this).
    """
    states = [line.strip() for line in output.splitlines() if line.strip()]
    return {name: states[i] if i < len(states) else "unknown" for i, name in enumerate(names)}


# ─────────────────────────── Grading ─────────────────────────────


def _grade(value: float, thresholds: Thresholds) -> str:
    """Compare a value against the thresholds."""
    if thresholds.fail is not None and value >= thresholds.fail:
        return FAIL
    if thresholds.warn is not None and value >= thresholds.warn:
        return WARN
    return OK


def _human_bytes(value: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(value) < 1024 or unit == "TB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{value:.1f} TB"


def evaluate(server: Server, sections: dict[str, str]) -> list[CheckResult]:
    """Turn the parsed sections into check results.

    Every `message` below stays Uzbek: it is rendered straight into the
    Telegram alert.
    """
    results: list[CheckResult] = []

    # ── load ──
    parsed = parse_load(sections.get("loadavg", ""), sections.get("nproc", ""))
    if parsed is None:
        results.append(
            CheckResult(server.name, "load", ERROR, "load average o'qib bo'lmadi")
        )
    else:
        load1, cores = parsed
        per_core = load1 / cores
        thresholds = server.threshold("load")
        results.append(
            CheckResult(
                server=server.name,
                name="load",
                status=_grade(per_core, thresholds),
                message=f"load {load1:.2f} / {cores} yadro = {per_core:.2f}",
                value=round(per_core, 3),
                threshold=thresholds.fail,
                output=sections.get("loadavg", ""),
            )
        )

    # ── memory ──
    mem_pct = parse_memory(sections.get("mem", ""))
    if mem_pct is None:
        results.append(CheckResult(server.name, "memory", ERROR, "xotira o'qib bo'lmadi"))
    else:
        thresholds = server.threshold("memory")
        results.append(
            CheckResult(
                server=server.name,
                name="memory",
                status=_grade(mem_pct, thresholds),
                message=f"RAM {mem_pct:.0f}% band",
                value=round(mem_pct, 1),
                threshold=thresholds.fail,
                output=sections.get("mem", ""),
            )
        )

    # ── disk ──
    thresholds = server.threshold("disk")
    disks = parse_disk(sections.get("disk", ""))
    wanted = set(thresholds.mounts)
    selected = [d for d in disks if not wanted or d.mount in wanted]

    if not selected:
        results.append(
            CheckResult(server.name, "disk", ERROR, "disk ma'lumoti topilmadi")
        )
    else:
        for disk in selected:
            results.append(
                CheckResult(
                    server=server.name,
                    name=f"disk:{disk.mount}",
                    status=_grade(disk.percent, thresholds),
                    message=(
                        f"{disk.mount} {disk.percent:.0f}% to'lgan "
                        f"({_human_bytes(disk.used_bytes)} / {_human_bytes(disk.total_bytes)})"
                    ),
                    value=disk.percent,
                    threshold=thresholds.fail,
                    output=sections.get("disk", ""),
                )
            )

    # ── uptime ──
    uptime = parse_uptime(sections.get("uptime", ""))
    if uptime is not None:
        days = uptime / 86400
        results.append(
            CheckResult(
                server=server.name,
                name="uptime",
                status=OK,
                message=f"{days:.1f} kun ishlayapti",
                value=round(uptime, 0),
                output=sections.get("uptime", ""),
            )
        )

    # ── services ──
    if server.services:
        states = parse_services(sections.get("services", ""), server.services)
        for name, state in states.items():
            results.append(
                CheckResult(
                    server=server.name,
                    name=f"service:{name}",
                    status=OK if state == "active" else FAIL,
                    message=f"{name}: {state}",
                    output=state,
                )
            )

    return results


def check_server(server: Server) -> list[CheckResult]:
    """Run the full check for one server over a single SSH connection.

    If SSH fails we return just one `ssh` result (ERROR) and produce no
    other checks: we genuinely know nothing about them.
    """
    result: SshResult = run(server, build_remote_command(server))

    if not result.ok:
        return [
            CheckResult(
                server=server.name,
                name="ssh",
                status=ERROR,
                message=f"ulanib bo'lmadi: {result.error_message}",
                output=result.stderr[:1000],
            )
        ]

    sections = split_sections(result.stdout)
    if not sections:
        return [
            CheckResult(
                server=server.name,
                name="ssh",
                status=ERROR,
                message="server javobi tushunarsiz (bo'limlar topilmadi)",
                output=result.stdout[:1000],
            )
        ]

    return evaluate(server, sections)


def fetch_logs(server: Server, unit: str, lines: int = 40) -> str:
    """Service logs for diagnosis.

    Only called when there is an alert. The result is handed to the LLM as
    "data" — never as instructions.
    """
    if unit not in server.journal_units and unit not in server.services:
        # We never ask for a unit that wasn't declared in the configuration
        return ""
    result = run(server, f"journalctl -u {unit} -n {lines} --no-pager 2>&1 | tail -n {lines}")
    return result.stdout if result.ok else ""


# Regexes that classify a check by its name, as used in headings
_DISK_RE = re.compile(r"^disk:(?P<mount>/.*)$")
_SERVICE_RE = re.compile(r"^service:(?P<unit>.+)$")


def check_kind(name: str) -> str:
    """Derive the kind of check from its name (`disk:/var` → `disk`)."""
    if _DISK_RE.match(name):
        return "disk"
    if _SERVICE_RE.match(name):
        return "service"
    return name
