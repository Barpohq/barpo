"""A single check cycle — walk the servers and record the results.

Called from both the scheduler and the CLI, and it never raises: if one
server falls over the rest are still checked (the same rule as in
`bot/scheduler.py`).

`errors.component` always carries the `monitor.*` prefix — the bot's
`_currently_broken_sources()` selects `collector%`, and the two must not
collide.
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
    """The outcome of a single cycle."""

    servers_checked: int = 0
    checks_total: int = 0
    problems: int = 0
    alerts_sent: int = 0
    alerts_resolved: int = 0
    failed_servers: list[str] = field(default_factory=list)
    results: list[CheckResult] = field(default_factory=list)

    def summary(self) -> str:
        """One-line summary for logs and `runs.note` — internal, not Telegram."""
        text = (
            f"{self.servers_checked} servers, {self.checks_total} checks, "
            f"{self.problems} problems"
        )
        if self.alerts_sent:
            text += f", {self.alerts_sent} alerts"
        if self.alerts_resolved:
            text += f", {self.alerts_resolved} recovered"
        if self.failed_servers:
            text += f" (unreachable: {', '.join(self.failed_servers)})"
        return text


def check_one(server: Server) -> list[CheckResult]:
    """Check one server and write the results to the database."""
    started = time.monotonic()
    results = check_server(server)
    elapsed = int((time.monotonic() - started) * 1000)
    record(results, duration_ms=elapsed)
    return results


def _notify(
    results: list[CheckResult], servers: list[Server], *, diagnose: bool
) -> tuple[int, int]:
    """Send alerts and close the ones that have recovered.

    The cycle continues even on error: a message failing to send must not
    stop metric collection.
    """
    from monitor.notify import process_results, resolve_alerts
    from monitor.state import current_states

    sent = resolved = 0
    checked_servers = {s.name for s in servers}

    try:
        sent = process_results(
            results, diagnose=diagnose, servers={s.name: s for s in servers}
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("Error while sending alerts")
        log_error("monitor.notify", str(exc), traceback=traceback.format_exc())

    try:
        # Recovery only covers servers checked in this cycle: an unchecked
        # server's stale state must not be counted as "fixed"
        healthy = [
            s for s in current_states() if s.server in checked_servers and not s.is_problem
        ]
        resolved = resolve_alerts(healthy)
    except Exception as exc:  # noqa: BLE001
        log.exception("Error while sending recovery messages")
        log_error("monitor.notify", str(exc), traceback=traceback.format_exc())

    return sent, resolved


def run_checks(
    servers: list[Server] | None = None,
    *,
    notify: bool = False,
    diagnose: bool = False,
) -> CycleReport:
    """A full cycle: check, persist, and (if asked) send alerts.

    Never raises — the scheduler must not end up disabling the job.
    """
    targets = servers if servers is not None else enabled_servers()
    report = CycleReport()

    if not targets:
        log.warning("No servers to monitor — check servers.yaml")
        return report

    run_id = start_run("monitor")

    for server in targets:
        try:
            results = check_one(server)
        except Exception as exc:  # noqa: BLE001 — one server must not stop the rest
            log.exception("%s: unexpected error while checking", server.name)
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

    if notify:
        report.alerts_sent, report.alerts_resolved = _notify(
            report.results, targets, diagnose=diagnose
        )

    finish_run(
        run_id,
        items_in=len(targets),
        items_out=report.checks_total,
        error_count=report.problems,
        # `ok` means "did the cycle run", not "were problems found": a
        # detected problem must not show up in the bot's "stage failed" report
        ok=not report.failed_servers,
        note=report.summary(),
    )

    log.info("Cycle finished: %s", report.summary())
    return report
