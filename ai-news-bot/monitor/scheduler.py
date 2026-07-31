"""Continuous mode — checking servers on a schedule.

A separate process from the bot's scheduler: the bot runs every 3 hours,
the monitor every 10 minutes, and deploying the bot must not take the
monitor down with it.

`run_cycle()` never raises — otherwise APScheduler would disable the job
and the monitor would die silently.
"""

from __future__ import annotations

import signal
import threading
import traceback
from datetime import UTC, datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from core.db import check_schema, log_error
from core.logging_setup import get_logger
from monitor.config import DEFAULT_INTERVAL_MINUTES

log = get_logger(__name__)

# When old rows are pruned (UTC). 3:00 UTC = 8:00 Tashkent — before the
# bot's daily report (4:00 UTC), during a quiet period.
PRUNE_HOUR_UTC = 3
KEEP_DAYS = 30


def run_cycle(*, diagnose: bool = True) -> None:
    """A single check cycle. Never raises."""
    started = datetime.now(UTC)

    try:
        from monitor.run import run_checks

        report = run_checks(notify=True, diagnose=diagnose)
        elapsed = (datetime.now(UTC) - started).total_seconds()
        log.info("Cycle: %s (%.1fs)", report.summary(), elapsed)
    except Exception as exc:  # noqa: BLE001 — the job must not get disabled
        log.exception("Unexpected error in the check cycle")
        log_error("monitor.scheduler", str(exc), traceback=traceback.format_exc())


def prune_old() -> None:
    """Delete old check rows."""
    try:
        from monitor.state import prune

        removed = prune(KEEP_DAYS)
        if removed:
            log.info("Pruned %d old rows (older than %d days)", removed, KEEP_DAYS)
    except Exception as exc:  # noqa: BLE001
        log.exception("Error while pruning")
        log_error("monitor.scheduler", str(exc), traceback=traceback.format_exc())


def run_forever(
    interval_minutes: int = DEFAULT_INTERVAL_MINUTES,
    *,
    diagnose: bool = True,
) -> int:
    """Run continuously under the scheduler. Shuts down cleanly on SIGTERM/SIGINT."""
    check_schema()

    scheduler = BackgroundScheduler(
        timezone="UTC",
        job_defaults={
            # Don't let a slow cycle overlap the next one (SSH timeout 20s × 5 servers)
            "max_instances": 1,
            "coalesce": True,
            "misfire_grace_time": 300,
        },
    )

    scheduler.add_job(
        run_cycle,
        CronTrigger(minute=f"*/{interval_minutes}"),
        id="monitor",
        name=f"Check (every {interval_minutes} minutes)",
        kwargs={"diagnose": diagnose},
    )
    scheduler.add_job(
        prune_old,
        CronTrigger(hour=PRUNE_HOUR_UTC, minute=30),
        id="prune",
        name=f"Prune old rows ({PRUNE_HOUR_UTC}:30 UTC)",
    )

    stop_event = threading.Event()

    def handle_signal(signum: int, _frame: object) -> None:
        log.info("Received signal %s, shutting down...", signal.Signals(signum).name)
        stop_event.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    scheduler.start()
    log.info("Monitor scheduler started. Scheduled jobs:")
    for job in scheduler.get_jobs():
        log.info("  %-44s next: %s", job.name, job.next_run_time)

    # Run one cycle immediately on startup so we don't wait 10 minutes
    log.info("Running initial cycle...")
    run_cycle(diagnose=diagnose)

    stop_event.wait()

    log.info("Shutting down (waiting for the current cycle to finish)...")
    scheduler.shutdown(wait=True)
    log.info("Stopped.")
    return 0
