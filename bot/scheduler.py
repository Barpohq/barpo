"""Doimiy rejim — pipeline'ni jadval bo'yicha ishga tushirish.

Hozirgi holat: collect → dedup → rank. Writer/Publisher qo'shilganda shu
yerga ulanadi.

Har bosqich idempotent: qayta ishga tushirilsa qayerda qolgan bo'lsa
o'sha yerdan davom etadi (holat bazada). Bitta sikl xato bersa keyingisi
rejaga muvofiq ishlaydi.
"""

from __future__ import annotations

import signal
import threading
import traceback
from datetime import UTC, datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from bot.db import check_schema, log_error, query_one
from bot.logging_setup import get_logger

log = get_logger(__name__)

# Har necha soatda pipeline ishga tushadi
DEFAULT_INTERVAL_HOURS = 3


def run_pipeline() -> None:
    """Bitta to'liq sikl: yig'ish → klasterlash → baholash.

    Bu funksiya hech qachon exception tashlamasligi kerak — aks holda
    scheduler jobni o'chirib qo'yadi va bot jimgina o'lib qoladi.
    """
    started = datetime.now(UTC)
    log.info("─── Pipeline sikli boshlandi ───")

    try:
        from bot.collector import collect_all

        report = collect_all()
        log.info("Yig'ish: %s", report.summary())
    except Exception as exc:  # noqa: BLE001 — sikl to'xtamasligi kerak
        log.exception("Yig'ish bosqichida xato")
        log_error("scheduler.collect", str(exc), traceback=traceback.format_exc())
        return

    try:
        from bot.dedup import run_dedup

        dedup_report = run_dedup()
        log.info("Dedup: %s", dedup_report.summary())
    except Exception as exc:  # noqa: BLE001
        log.exception("Dedup bosqichida xato")
        log_error("scheduler.dedup", str(exc), traceback=traceback.format_exc())
        return

    try:
        from bot.rank import run_rank

        rank_report = run_rank()
        log.info("Rank: %s", rank_report.summary())
    except Exception as exc:  # noqa: BLE001
        log.exception("Rank bosqichida xato")
        log_error("scheduler.rank", str(exc), traceback=traceback.format_exc())
        return

    elapsed = (datetime.now(UTC) - started).total_seconds()
    log.info("─── Sikl tugadi (%.1f soniya) ───", elapsed)


def health_check() -> None:
    """Kunlik holat tekshiruvi.

    24 soat davomida hech narsa yig'ilmasa — nimadir buzilgan (04-xavflar X4).
    Faza 2'da bu Telegram'ga alert yuboradi.
    """
    row = query_one(
        "SELECT COUNT(*) AS c FROM items WHERE fetched_at >= datetime('now', '-24 hours')"
    )
    collected = row["c"] if row else 0

    errors_row = query_one(
        "SELECT COUNT(*) AS c FROM errors WHERE created_at >= datetime('now', '-24 hours')"
    )
    errors = errors_row["c"] if errors_row else 0

    if collected == 0:
        message = "24 soat davomida bitta ham yangilik yig'ilmadi — manbalarni tekshiring"
        log.error("SOG'LIQ TEKSHIRUVI: %s", message)
        log_error("scheduler.health", message)
    else:
        log.info("Sog'liq tekshiruvi: 24 soatda %d element, %d xato", collected, errors)


def run_forever(interval_hours: int = DEFAULT_INTERVAL_HOURS) -> int:
    """Scheduler bilan doimiy ishlash. SIGTERM/SIGINT da toza to'xtaydi."""
    check_schema()

    scheduler = BackgroundScheduler(
        timezone="UTC",
        job_defaults={
            # Bir vaqtda bitta sikl — sekin ishlagan sikl keyingisiga qo'shilib ketmasin
            "max_instances": 1,
            # Kechikkan ishlarni birlashtirib bitta marta bajaradi
            "coalesce": True,
            "misfire_grace_time": 600,
        },
    )

    scheduler.add_job(
        run_pipeline,
        CronTrigger(hour=f"*/{interval_hours}", minute=5),
        id="pipeline",
        name=f"Pipeline (har {interval_hours} soatda)",
    )
    scheduler.add_job(
        health_check,
        CronTrigger(hour=9, minute=0),
        id="health",
        name="Kunlik sog'liq tekshiruvi",
    )

    stop_event = threading.Event()

    def handle_signal(signum: int, _frame: object) -> None:
        log.info("Signal %s qabul qilindi, to'xtatilmoqda...", signal.Signals(signum).name)
        stop_event.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    scheduler.start()
    log.info("Scheduler ishga tushdi. Rejadagi ishlar:")
    for job in scheduler.get_jobs():
        log.info("  %-40s keyingi: %s", job.name, job.next_run_time)

    # Ishga tushganda darhol bir sikl — kutib o'tirmaslik uchun
    log.info("Boshlang'ich sikl ishga tushirilmoqda...")
    run_pipeline()

    stop_event.wait()

    log.info("Scheduler to'xtatilmoqda (joriy ishlar tugashini kutmoqda)...")
    scheduler.shutdown(wait=True)
    log.info("To'xtatildi.")
    return 0
