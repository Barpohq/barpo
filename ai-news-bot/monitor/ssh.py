"""SSH layer — collecting metrics from a server.

The system `ssh` binary is used rather than a library (paramiko/asyncssh):
the key file is never read into the Python process, `~/.ssh/config` and
`known_hosts` behave as usual, and no new dependency is added.

Security: the command is passed as a list (`shell=False`), no password is
ever prompted for (`BatchMode=yes`), and an unknown host is an error rather
than a question. Every command is read-only — nothing is ever modified.
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

# Cap on how much text we take from a server. This is both cost control
# (the text feeds into the LLM diagnosis) and a smaller injection surface.
MAX_OUTPUT = 8000

SSH_BASE_ARGS = (
    # Never prompt for a password — the process must not hang
    "-o", "BatchMode=yes",
    # Unknown host is an error, not an interactive prompt (MITM protection)
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2",
    # stdin from /dev/null — the remote command must not read stdin
    "-n",
)


@dataclass(frozen=True, slots=True)
class SshResult:
    """Result of a single SSH invocation."""

    ok: bool
    stdout: str
    stderr: str
    exit_code: int
    duration_ms: int

    @property
    def error_message(self) -> str:
        """Short error description (for alerts and logs)."""
        if self.ok:
            return ""
        text = self.stderr.strip() or self.stdout.strip()
        first_line = text.splitlines()[0] if text else ""
        # Telegram-facing: ends up in the alert body via CheckResult.message
        return first_line[:200] or f"ssh xato kodi {self.exit_code}"


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT:
        return text
    # Uzbek marker: truncated stderr can reach the Telegram alert
    return text[:MAX_OUTPUT] + "\n… (chiqish qisqartirildi)"


def build_command(server: Server, remote_command: str) -> list[str]:
    """Build the SSH command. This same function is what the tests exercise."""
    args = ["ssh", *SSH_BASE_ARGS]
    if server.port != 22:
        args += ["-p", str(server.port)]
    if server.key_file:
        key = Path(server.key_file).expanduser()
        # IdentitiesOnly: don't let the agent try its other keys
        args += ["-i", str(key), "-o", "IdentitiesOnly=yes"]
    args.append(f"{server.user}@{server.host}")
    args.append(remote_command)
    return args


def run(server: Server, remote_command: str) -> SshResult:
    """Run the command on the server and return the result.

    Never raises — a connection failure is itself a result (ok=False),
    because that is also a state worth monitoring.
    """
    if shutil.which("ssh") is None:
        return SshResult(
            ok=False,
            stdout="",
            # Uzbek: surfaces in the Telegram alert through error_message
            stderr="`ssh` buyrug'i topilmadi (openssh-client o'rnatilmagan)",
            exit_code=127,
            duration_ms=0,
        )

    command = build_command(server, remote_command)
    started = time.monotonic()

    try:
        completed = subprocess.run(  # noqa: S603 — passed as a list, no shell
            command,
            capture_output=True,
            text=True,
            timeout=server.timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        elapsed = int((time.monotonic() - started) * 1000)
        log.warning("%s: SSH timed out after %ds", server.name, server.timeout)
        return SshResult(
            ok=False,
            stdout="",
            # Uzbek: surfaces in the Telegram alert through error_message
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
    """Probe the connection — used to verify the setup is correct."""
    return run(server, "echo ok")
