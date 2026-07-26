"""Server tekshiruvlari — buyruqlar va natija tahlili.

Buyruqlar shu yerda qat'iy belgilangan (konfiguratsiyadan kelmaydi) va
barchasi faqat o'qish. Bitta SSH ulanishida hammasi bajariladi:
5 server × 1 ulanish, har check uchun alohida emas.

Parserlar sof funksiyalar — real `df`/`free`/`/proc` chiqishi bilan
sinaladi, SSH mock'siz.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from core.logging_setup import get_logger
from monitor.config import Server, Thresholds
from monitor.ssh import SshResult, run

log = get_logger(__name__)

# Buyruqlar chiqishini ajratuvchi belgilar — kod konstantasi
SEP = "___MONITOR_SEP___"

# df da ko'rinadigan, lekin kuzatishga arzimaydigan fayl tizimlari.
# Real serverda 15 qator df'dan 11 tasi shular (tmpfs va Docker overlay) —
# filtrsiz alertlar shovqinga aylanardi.
VIRTUAL_FS = frozenset({"tmpfs", "devtmpfs", "overlay", "squashfs", "efivarfs", "none"})

# Natija darajalari
OK = "ok"
WARN = "warn"
FAIL = "fail"
ERROR = "error"


@dataclass(frozen=True, slots=True)
class CheckResult:
    """Bitta tekshiruv natijasi."""

    server: str
    name: str
    status: str
    message: str
    value: float | None = None
    threshold: float | None = None
    # Xom chiqish — diagnostika uchun saqlanadi
    output: str = ""

    @property
    def is_problem(self) -> bool:
        return self.status in (FAIL, ERROR)


def build_remote_command(server: Server) -> str:
    """Barcha o'lchovlarni bitta buyruqda yig'ish.

    Har bo'lim ajratgich bilan belgilanadi. `2>/dev/null` — buyruq
    yo'q bo'lsa (masalan systemctl konteynerda) bo'lim bo'sh qoladi,
    qolganlari ishlayveradi.
    """
    parts = [
        f"echo {SEP}loadavg; cat /proc/loadavg 2>/dev/null",
        f"echo {SEP}nproc; nproc 2>/dev/null",
        f"echo {SEP}mem; free -b 2>/dev/null",
        f"echo {SEP}disk; df -P -B1 2>/dev/null",
        f"echo {SEP}uptime; cat /proc/uptime 2>/dev/null",
    ]
    if server.services:
        # Xizmat nomlari config.py da regex bilan tekshirilgan
        units = " ".join(server.services)
        parts.append(f"echo {SEP}services; systemctl is-active {units} 2>/dev/null")
    return "; ".join(parts)


def split_sections(stdout: str) -> dict[str, str]:
    """Ajratgichlar bo'yicha bo'limlarga ajratish."""
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


# ─────────────────────────── Parserlar ───────────────────────────


def parse_load(loadavg: str, nproc: str) -> tuple[float, int] | None:
    """`/proc/loadavg` va `nproc` → (load1, yadrolar soni)."""
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
    """`free -b` → band RAM foizi.

    Diqqat: `used` ustuni emas, `total - available` ishlatiladi.
    Linux'da buff/cache "band" ko'rinadi, lekin kerak bo'lganda darhol
    bo'shatiladi — real serverda farq 57% va 4% orasida bo'lishi mumkin.
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
    """`df -P -B1` → mount bo'yicha band foiz.

    Virtual fayl tizimlari (tmpfs, Docker overlay) tashlab yuboriladi —
    ular disk to'lishini ko'rsatmaydi.
    """
    result: list[DiskUsage] = []
    for line in df_output.splitlines()[1:]:  # birinchi qator — sarlavha
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
    """`/proc/uptime` → soniyalarda ishlash vaqti."""
    fields = uptime_output.split()
    if not fields:
        return None
    try:
        return float(fields[0])
    except ValueError:
        return None


def parse_services(output: str, names: tuple[str, ...]) -> dict[str, str]:
    """`systemctl is-active a b c` → {nom: holat}.

    Chiqish tartibi so'ralgan tartibga mos keladi (systemd shunday).
    """
    states = [line.strip() for line in output.splitlines() if line.strip()]
    return {name: states[i] if i < len(states) else "unknown" for i, name in enumerate(names)}


# ─────────────────────────── Baholash ───────────────────────────


def _grade(value: float, thresholds: Thresholds) -> str:
    """Qiymatni chegaralar bilan solishtirish."""
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
    """Bo'limlardan tekshiruv natijalarini hosil qilish."""
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

    # ── xizmatlar ──
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
    """Serverni to'liq tekshirish — bitta SSH ulanishi.

    SSH ishlamasa bitta `ssh` natijasi qaytadi (ERROR), qolgan
    checklar hosil qilinmaydi: ular haqida hech narsa ma'lum emas.
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
    """Diagnostika uchun xizmat loglari.

    Faqat alert bo'lganda chaqiriladi. Natija LLM'ga "ma'lumot"
    sifatida uzatiladi — hech qachon buyruq sifatida emas.
    """
    if unit not in server.journal_units and unit not in server.services:
        # Konfiguratsiyada e'lon qilinmagan birlik so'ralmaydi
        return ""
    result = run(server, f"journalctl -u {unit} -n {lines} --no-pager 2>&1 | tail -n {lines}")
    return result.stdout if result.ok else ""


# Sarlavhada ishlatiladigan, checkni turkumga ajratuvchi regex
_DISK_RE = re.compile(r"^disk:(?P<mount>/.*)$")
_SERVICE_RE = re.compile(r"^service:(?P<unit>.+)$")


def check_kind(name: str) -> str:
    """Check nomidan turini aniqlash (`disk:/var` → `disk`)."""
    if _DISK_RE.match(name):
        return "disk"
    if _SERVICE_RE.match(name):
        return "service"
    return name
