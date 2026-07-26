"""Doimiy rejim — pipeline'ni jadval bo'yicha ishga tushirish.

To'liq pipeline: collect → dedup → rank → enrich → write → publish.

`run_forever()` qo'shimcha ravishda Telegram approval tinglovchisini
alohida threadda ishga tushiradi — busiz ✅/✏️/❌ tugmalari javob bermaydi.

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

from core.db import check_schema, log_error
from core.logging_setup import get_logger

log = get_logger(__name__)

# Har necha soatda pipeline ishga tushadi
DEFAULT_INTERVAL_HOURS = 3

# Kunlik hisobot vaqti (UTC). 4:00 UTC = 9:00 Toshkent (UTC+5) —
# ish kuni boshida kelsin.
REPORT_HOUR_UTC = 4


def run_pipeline() -> None:
    """Bitta to'liq sikl: yig'ish → ... → yozish → tasdiqqa yuborish.

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

    try:
        from bot.enricher import run_enrich

        enrich_report = run_enrich()
        log.info("Enricher: %s", enrich_report.summary())
    except Exception as exc:  # noqa: BLE001
        log.exception("Enricher bosqichida xato")
        log_error("scheduler.enrich", str(exc), traceback=traceback.format_exc())
        return

    try:
        from bot.writer import run_write

        write_report = run_write()
        log.info("Writer: %s", write_report.summary())
    except Exception as exc:  # noqa: BLE001
        log.exception("Writer bosqichida xato")
        log_error("scheduler.write", str(exc), traceback=traceback.format_exc())
        return

    try:
        from bot.publisher import is_configured, run_publish

        if is_configured():
            publish_report = run_publish()
            log.info("Publisher: %s", publish_report.summary())
        else:
            log.info("Telegram sozlanmagan — publish bosqichi o'tkazib yuborildi")
    except Exception as exc:  # noqa: BLE001
        log.exception("Publisher bosqichida xato")
        log_error("scheduler.publish", str(exc), traceback=traceback.format_exc())
        return

    elapsed = (datetime.now(UTC) - started).total_seconds()
    log.info("─── Sikl tugadi (%.1f soniya) ───", elapsed)

    # Sikl oxirida holatni tekshiramiz — muammo bo'lsa darhol alert.
    # Kunlik hisobotni kutish uzoq: manba buzilsa 24 soat bilinmay qoladi.
    health_check()


def daily_report() -> None:
    """Kunlik hisobot — Telegram'ga yuboriladi.

    Hammasi joyida bo'lsa ham keladi: bot ishlayotganini ko'rish va
    tendensiyani kuzatish uchun (04-xavflar, X4).
    """
    try:
        from bot.health.notify import send_daily_report

        send_daily_report()
    except Exception as exc:  # noqa: BLE001 — hisobot xatosi botni to'xtatmasin
        log.exception("Kunlik hisobot yuborilmadi")
        log_error("scheduler.report", str(exc), traceback=traceback.format_exc())


def health_check() -> None:
    """Muammo bo'lsa darhol alert yuborish.

    Pipeline har siklidan keyin chaqiriladi. Alert cooldown bilan —
    bir xil muammo haqida har safar xabar kelmaydi.
    """
    try:
        from bot.health.notify import send_alert_if_needed

        send_alert_if_needed()
    except Exception as exc:  # noqa: BLE001
        log.exception("Sog'liq tekshiruvida xato")
        log_error("scheduler.health", str(exc), traceback=traceback.format_exc())


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
        daily_report,
        CronTrigger(hour=REPORT_HOUR_UTC, minute=0),
        id="report",
        name=f"Kunlik hisobot ({REPORT_HOUR_UTC}:00 UTC)",
    )

    stop_event = threading.Event()

    def handle_signal(signum: int, _frame: object) -> None:
        log.info("Signal %s qabul qilindi, to'xtatilmoqda...", signal.Signals(signum).name)
        stop_event.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    # Telegram approval tugmalarini tinglash — alohida threadda.
    # Busiz ✅/✏️/❌ tugmalari javob bermaydi.
    try:
        from bot.publisher import is_configured

        if is_configured():
            from bot.publisher.bot_app import start_in_background

            start_in_background()
            log.info("Telegram approval tinglovchisi ishga tushdi")
        else:
            log.warning(
                "Telegram sozlanmagan — approval tugmalari ishlamaydi. "
                ".env da TELEGRAM_BOT_TOKEN va TELEGRAM_CHANNEL_ID ni to'ldiring"
            )
    except Exception:  # noqa: BLE001 — polling yiqilsa ham pipeline ishlasin
        log.exception("Telegram tinglovchisi ishga tushmadi")

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
