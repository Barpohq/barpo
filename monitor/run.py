"""Bitta tekshiruv sikli — serverlarni aylanib, natijani yozish.

Bu funksiya scheduler'dan ham, CLI'dan ham chaqiriladi va hech qachon
exception tashlamaydi: bitta server yiqilsa qolganlari tekshirilaveradi
(`bot/scheduler.py` dagi qoida bilan bir xil).

`errors.component` har doim `monitor.*` prefiksi bilan — botning
`_currently_broken_sources()` funksiyasi `collector%` ni tortadi,
to'qnashuv bo'lmasligi kerak.
"""

from __future__ import annotations

import time
import traceback
from dataclasses import dataclass, field

from core.db import finish_run, log_error, start_run
from core.logging_setup import get_logger
from monitor.checks import CheckResult, check_server
from monitor.config import Server, enabled_servers
from monitor.state import record

log = get_logger(__name__)


@dataclass(slots=True)
class CycleReport:
    """Bitta siklning natijasi."""

    servers_checked: int = 0
    checks_total: int = 0
    problems: int = 0
    failed_servers: list[str] = field(default_factory=list)
    results: list[CheckResult] = field(default_factory=list)

    def summary(self) -> str:
        text = (
            f"{self.servers_checked} server, {self.checks_total} tekshiruv, "
            f"{self.problems} muammo"
        )
        if self.failed_servers:
            text += f" (ulanmadi: {', '.join(self.failed_servers)})"
        return text


def check_one(server: Server) -> list[CheckResult]:
    """Bitta serverni tekshirib, natijani bazaga yozish."""
    started = time.monotonic()
    results = check_server(server)
    elapsed = int((time.monotonic() - started) * 1000)
    record(results, duration_ms=elapsed)
    return results


def run_checks(servers: list[Server] | None = None) -> CycleReport:
    """To'liq sikl: har serverni tekshirish va holatni saqlash.

    Exception tashlamaydi — scheduler jobni o'chirib qo'ymasligi kerak.
    """
    targets = servers if servers is not None else enabled_servers()
    report = CycleReport()

    if not targets:
        log.warning("Kuzatiladigan server yo'q — servers.yaml ni tekshiring")
        return report

    run_id = start_run("monitor")

    for server in targets:
        try:
            results = check_one(server)
        except Exception as exc:  # noqa: BLE001 — bitta server qolganlarini to'xtatmasin
            log.exception("%s: tekshirishda kutilmagan xato", server.name)
            log_error(
                "monitor.check",
                str(exc),
                context=server.name,
                traceback=traceback.format_exc(),
            )
            report.failed_servers.append(server.name)
            continue

        report.servers_checked += 1
        report.checks_total += len(results)
        report.results.extend(results)

        problems = [r for r in results if r.is_problem]
        report.problems += len(problems)
        for problem in problems:
            log.warning("%s/%s: %s", server.name, problem.name, problem.message)

    finish_run(
        run_id,
        items_in=len(targets),
        items_out=report.checks_total,
        error_count=report.problems,
        # `ok` — sikl bajarildimi, muammo topilganmi emas: topilgan
        # muammo botning "bosqich ishlamadi" hisobotiga tushmasligi kerak
        ok=not report.failed_servers,
        note=report.summary(),
    )

    log.info("Sikl tugadi: %s", report.summary())
    return report
