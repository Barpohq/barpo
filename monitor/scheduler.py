"""Doimiy rejim — serverlarni jadval bo'yicha tekshirish.

Bot scheduler'idan alohida jarayon: bot 3 soatda, monitor 10 daqiqada
ishlaydi, va botning deploy'i monitorni to'xtatmasligi kerak.

`run_cycle()` hech qachon exception tashlamaydi — aks holda APScheduler
jobni o'chirib qo'yadi va monitor jimgina o'lib qoladi.
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

# Eski yozuvlarni tozalash vaqti (UTC). 3:00 UTC = 8:00 Toshkent —
# botning kunlik hisobotidan (4:00 UTC) oldin, yuk kam paytda.
PRUNE_HOUR_UTC = 3
KEEP_DAYS = 30


def run_cycle(*, diagnose: bool = True) -> None:
    """Bitta tekshiruv sikli. Hech qachon exception tashlamaydi."""
    started = datetime.now(UTC)

    try:
        from monitor.run import run_checks

        report = run_checks(notify=True, diagnose=diagnose)
        elapsed = (datetime.now(UTC) - started).total_seconds()
        log.info("Sikl: %s (%.1f soniya)", report.summary(), elapsed)
    except Exception as exc:  # noqa: BLE001 — job o'chib qolmasin
        log.exception("Tekshiruv siklida kutilmagan xato")
        log_error("monitor.scheduler", str(exc), traceback=traceback.format_exc())


def prune_old() -> None:
    """Eski tekshiruv yozuvlarini o'chirish."""
    try:
        from monitor.state import prune

        removed = prune(KEEP_DAYS)
        if removed:
            log.info("Tozalandi: %d ta eski yozuv (%d kundan eski)", removed, KEEP_DAYS)
    except Exception as exc:  # noqa: BLE001
        log.exception("Tozalashda xato")
        log_error("monitor.scheduler", str(exc), traceback=traceback.format_exc())


def run_forever(
    interval_minutes: int = DEFAULT_INTERVAL_MINUTES,
    *,
    diagnose: bool = True,
) -> int:
    """Scheduler bilan doimiy ishlash. SIGTERM/SIGINT da toza to'xtaydi."""
    check_schema()

    scheduler = BackgroundScheduler(
        timezone="UTC",
        job_defaults={
            # Sekin sikl keyingisiga qo'shilib ketmasin (SSH timeout 20s × 5 server)
            "max_instances": 1,
            "coalesce": True,
            "misfire_grace_time": 300,
        },
    )

    scheduler.add_job(
        run_cycle,
        CronTrigger(minute=f"*/{interval_minutes}"),
        id="monitor",
        name=f"Tekshiruv (har {interval_minutes} daqiqada)",
        kwargs={"diagnose": diagnose},
    )
    scheduler.add_job(
        prune_old,
        CronTrigger(hour=PRUNE_HOUR_UTC, minute=30),
        id="prune",
        name=f"Eski yozuvlarni tozalash ({PRUNE_HOUR_UTC}:30 UTC)",
    )

    stop_event = threading.Event()

    def handle_signal(signum: int, _frame: object) -> None:
        log.info("Signal %s qabul qilindi, to'xtatilmoqda...", signal.Signals(signum).name)
        stop_event.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    scheduler.start()
    log.info("Monitor scheduler ishga tushdi. Rejadagi ishlar:")
    for job in scheduler.get_jobs():
        log.info("  %-44s keyingi: %s", job.name, job.next_run_time)

    # Ishga tushganda darhol bir sikl — 10 daqiqa kutmaslik uchun
    log.info("Boshlang'ich sikl ishga tushirilmoqda...")
    run_cycle(diagnose=diagnose)

    stop_event.wait()

    log.info("To'xtatilmoqda (joriy sikl tugashini kutmoqda)...")
    scheduler.shutdown(wait=True)
    log.info("To'xtatildi.")
    return 0
