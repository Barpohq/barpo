"""SSH qatlami — serverdan o'lchov olish.

Tizimning `ssh` buyrug'i ishlatiladi, kutubxona emas (paramiko/asyncssh):
kalit fayli Python jarayoniga hech qachon o'qilmaydi, `~/.ssh/config` va
`known_hosts` odatdagidek ishlaydi, va yangi bog'liqlik qo'shilmaydi.

Xavfsizlik: buyruq ro'yxat sifatida uzatiladi (`shell=False`), parol
so'ralmaydi (`BatchMode=yes`), noma'lum host xato beradi (savol emas).
Barcha buyruqlar faqat o'qish — hech narsa o'zgartirilmaydi.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from core.logging_setup import get_logger
from monitor.config import Server

log = get_logger(__name__)

# Serverdan olinadigan matn chegarasi. Ham xarajat nazorati (bu matn
# LLM diagnostikasiga kiradi), ham injection yuzasini kichraytirish.
MAX_OUTPUT = 8000

SSH_BASE_ARGS = (
    # Parol so'ramaydi — jarayon osilib qolmaydi
    "-o", "BatchMode=yes",
    # Noma'lum host — xato, interaktiv savol emas (MITM himoyasi)
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2",
    # stdin /dev/null — masofadagi buyruq stdin so'ramasin
    "-n",
)


@dataclass(frozen=True, slots=True)
class SshResult:
    """Bitta SSH chaqiruvining natijasi."""

    ok: bool
    stdout: str
    stderr: str
    exit_code: int
    duration_ms: int

    @property
    def error_message(self) -> str:
        """Xato haqida qisqa xabar (alert va log uchun)."""
        if self.ok:
            return ""
        text = self.stderr.strip() or self.stdout.strip()
        first_line = text.splitlines()[0] if text else ""
        return first_line[:200] or f"ssh xato kodi {self.exit_code}"


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT:
        return text
    return text[:MAX_OUTPUT] + "\n… (chiqish qisqartirildi)"


def build_command(server: Server, remote_command: str) -> list[str]:
    """SSH buyrug'ini qurish. Testlarda ham shu funksiya tekshiriladi."""
    args = ["ssh", *SSH_BASE_ARGS]
    if server.port != 22:
        args += ["-p", str(server.port)]
    if server.key_file:
        key = Path(server.key_file).expanduser()
        # IdentitiesOnly: agent'dagi boshqa kalitlar sinalmasin
        args += ["-i", str(key), "-o", "IdentitiesOnly=yes"]
    args.append(f"{server.user}@{server.host}")
    args.append(remote_command)
    return args


def run(server: Server, remote_command: str) -> SshResult:
    """Serverda buyruqni bajarib, natijani qaytarish.

    Hech qachon exception tashlamaydi — ulanish muammosi ham natija
    (ok=False), chunki u ham kuzatiladigan holat.
    """
    if shutil.which("ssh") is None:
        return SshResult(
            ok=False,
            stdout="",
            stderr="`ssh` buyrug'i topilmadi (openssh-client o'rnatilmagan)",
            exit_code=127,
            duration_ms=0,
        )

    command = build_command(server, remote_command)
    started = time.monotonic()

    try:
        completed = subprocess.run(  # noqa: S603 — ro'yxat sifatida, shell'siz
            command,
            capture_output=True,
            text=True,
            timeout=server.timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        elapsed = int((time.monotonic() - started) * 1000)
        log.warning("%s: SSH timeout (%d soniya)", server.name, server.timeout)
        return SshResult(
            ok=False,
            stdout="",
            stderr=f"{server.timeout} soniyada javob bermadi",
            exit_code=124,
            duration_ms=elapsed,
        )
    except OSError as exc:
        elapsed = int((time.monotonic() - started) * 1000)
        return SshResult(ok=False, stdout="", stderr=str(exc), exit_code=1, duration_ms=elapsed)

    elapsed = int((time.monotonic() - started) * 1000)
    return SshResult(
        ok=completed.returncode == 0,
        stdout=_truncate(completed.stdout),
        stderr=_truncate(completed.stderr),
        exit_code=completed.returncode,
        duration_ms=elapsed,
    )


def check_connection(server: Server) -> SshResult:
    """Ulanishni sinash — sozlash to'g'riligini tekshirish uchun."""
    return run(server, "echo ok")
