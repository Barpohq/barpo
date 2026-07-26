"""Hisobot va alertlarni Telegram orqali yuborish.

Alert takrorlanishining oldini olish: bir xil muammo haqida har siklda
xabar kelmasligi kerak. Oxirgi alert vaqti `runs` jadvalida saqlanadi —
alohida jadval yaratmaslik uchun (bu ham "bosqich ishga tushdi" yozuvi).
"""

from __future__ import annotations

import asyncio

from bot.db import execute, query_one, utc_now
from bot.health.metrics import collect_metrics
from bot.health.report import format_alert, format_daily_report
from bot.logging_setup import get_logger

log = get_logger(__name__)

# Bir xil alert shu soatlar ichida takrorlanmaydi
ALERT_COOLDOWN_HOURS = 6


def _last_alert_at() -> str | None:
    row = query_one(
        "SELECT started_at FROM runs WHERE stage = 'alert' ORDER BY id DESC LIMIT 1"
    )
    return str(row["started_at"]) if row else None


def _record_alert(note: str) -> None:
    execute(
        "INSERT INTO runs (started_at, finished_at, stage, ok, note) "
        "VALUES (?, ?, 'alert', 1, ?)",
        (utc_now(), utc_now(), note[:200]),
    )


def _alert_recently_sent() -> bool:
    from datetime import UTC, datetime, timedelta

    last = _last_alert_at()
    if not last:
        return False
    try:
        sent_at = datetime.fromisoformat(last)
    except ValueError:
        return False
    if sent_at.tzinfo is None:
        sent_at = sent_at.replace(tzinfo=UTC)
    return datetime.now(UTC) - sent_at < timedelta(hours=ALERT_COOLDOWN_HOURS)


def _send(text: str) -> bool:
    """Xabarni admin chatga yuborish. Muvaffaqiyatli bo'lsa True."""
    from bot.publisher.telegram import TelegramClient, admin_chat_id, is_configured, with_client

    if not is_configured():
        log.info("Telegram sozlanmagan — xabar yuborilmadi")
        return False

    chat = admin_chat_id()
    if not chat:
        log.warning("TELEGRAM_ADMIN_CHAT_ID belgilanmagan")
        return False

    async def work(client: TelegramClient) -> None:
        await client.send_notice(chat, text)

    try:
        asyncio.run(with_client(work))
        return True
    except Exception:  # noqa: BLE001 — xabar yuborilmasligi botni to'xtatmasin
        log.exception("Xabar yuborilmadi")
        return False


def send_daily_report() -> bool:
    """Kunlik hisobotni yuborish."""
    metrics = collect_metrics(24)
    text = format_daily_report(metrics)
    sent = _send(text)
    if sent:
        log.info("Kunlik hisobot yuborildi")
    return sent


def send_alert_if_needed() -> bool:
    """Muammo bo'lsa alert yuborish.

    Cooldown: bir xil muammo haqida har siklda xabar kelmasligi kerak,
    aks holda foydalanuvchi alertlarni e'tiborsiz qoldira boshlaydi.
    """
    text = format_alert()
    if text is None:
        return False

    if _alert_recently_sent():
        log.info("Muammo bor, lekin alert yaqinda yuborilgan — takrorlanmaydi")
        return False

    if _send(text):
        _record_alert(text.split("\n")[0])
        log.warning("Alert yuborildi")
        return True
    return False
