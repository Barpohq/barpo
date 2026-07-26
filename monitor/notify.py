"""Alert yuborish — Telegram admin chatga.

Cooldown kaliti (server, check_name): botdagi global cooldown bu
yerda yaroqsiz bo'lardi — bitta serverning diski to'lgani boshqa
serverning xizmati o'lganini 4 soatga bosib qo'yardi.

Ochiq alert `server_alerts` da `resolved_at IS NULL` bilan turadi.
Muammo tugagach u yopiladi va tiklanish xabari yuboriladi — busiz
foydalanuvchi holat qanday tugaganini bilmaydi.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from core.db import execute, query, query_one, utc_now
from core.logging_setup import get_logger
from monitor.checks import CheckResult
from monitor.config import Server
from monitor.report import format_alert, format_recovery
from monitor.state import CurrentState, should_alert

log = get_logger(__name__)

# Bir xil muammo (server + check) haqida shu muddat ichida takror xabar bermaymiz
ALERT_COOLDOWN_HOURS = 4


def _send(text: str) -> bool:
    """Xabarni admin chatga yuborish. Muvaffaqiyatli bo'lsa True.

    Kanal kerak emas — `has_token()` yetadi (bot uchun `is_configured()`
    kanalni ham talab qiladi, monitor uchun bu noto'g'ri bo'lardi).
    """
    from core.telegram import TelegramClient, admin_chat_id, has_token, with_client

    if not has_token():
        log.info("Telegram sozlanmagan — alert yuborilmadi")
        return False

    chat = admin_chat_id()
    if not chat:
        log.warning("TELEGRAM_ADMIN_CHAT_ID belgilanmagan — alert yuborilmadi")
        return False

    async def work(client: TelegramClient) -> None:
        await client.send_notice(chat, text)

    try:
        asyncio.run(with_client(work))
        return True
    except Exception:  # noqa: BLE001 — xabar yuborilmasligi siklni to'xtatmasin
        log.exception("Alert yuborilmadi")
        return False


def _open_alert(server: str, check_name: str) -> dict | None:
    """Shu (server, check) uchun yopilmagan alert."""
    row = query_one(
        "SELECT id, created_at FROM server_alerts "
        "WHERE server = ? AND check_name = ? AND resolved_at IS NULL "
        "ORDER BY id DESC LIMIT 1",
        (server, check_name),
    )
    return dict(row) if row else None


def _recently_alerted(server: str, check_name: str) -> bool:
    """Shu juftlik uchun yaqinda alert yuborilganmi."""
    row = query_one(
        "SELECT created_at FROM server_alerts WHERE server = ? AND check_name = ? "
        "ORDER BY id DESC LIMIT 1",
        (server, check_name),
    )
    if not row or not row["created_at"]:
        return False

    try:
        sent_at = datetime.fromisoformat(str(row["created_at"]))
    except ValueError:
        # Sana o'qilmasa alertni bloklamaymiz — xabar kelmagandan ko'ra kelgani yaxshi
        return False
    if sent_at.tzinfo is None:
        sent_at = sent_at.replace(tzinfo=UTC)

    return datetime.now(UTC) - sent_at < timedelta(hours=ALERT_COOLDOWN_HOURS)


def _record_alert(result: CheckResult, summary: str, diagnosis: str) -> None:
    execute(
        "INSERT INTO server_alerts (created_at, server, check_name, status, summary, diagnosis) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (utc_now(), result.server, result.name, result.status, summary[:300], diagnosis or None),
    )


def send_alert(result: CheckResult, *, diagnosis: str = "") -> bool:
    """Muammo haqida xabar yuborish (cooldown tekshiruvisiz).

    Cooldown va takror mantiqi `process_results()` da — bu funksiya
    qo'lda sinash uchun ham ishlatiladi.
    """
    text = format_alert(result, diagnosis=diagnosis)
    if not _send(text):
        return False
    # Yozuv faqat yuborilgandan keyin: Telegram tushib qolsa
    # cooldown boshlanmasligi kerak
    _record_alert(result, result.message, diagnosis)
    log.info("Alert yuborildi: %s/%s", result.server, result.name)
    return True


def resolve_alerts(healthy: list[CurrentState]) -> int:
    """Tuzalgan muammolar bo'yicha ochiq alertlarni yopish.

    Yopilgan alertlar soni qaytadi. Har biri uchun tiklanish xabari.
    """
    closed = 0
    for state in healthy:
        alert = _open_alert(state.server, state.check_name)
        if not alert:
            continue

        if _send(format_recovery(state)):
            execute(
                "UPDATE server_alerts SET resolved_at = ? WHERE id = ?",
                (utc_now(), alert["id"]),
            )
            closed += 1
            log.info("Tiklandi: %s/%s", state.server, state.check_name)
    return closed


def process_results(
    results: list[CheckResult],
    *,
    diagnose: bool = False,
    servers: dict[str, Server] | None = None,
) -> int:
    """Tekshiruv natijalaridan alertlarni yuborish.

    Yuborilgan alertlar soni qaytadi. Ketma-ketlik:
      1. Muammo ketma-ket ikkinchi marta takrorlandimi (`should_alert`)
      2. Cooldown ichida emasmi
      3. Diagnostika (yoqilgan bo'lsa) — xato bo'lsa alert baribir ketadi

    `servers` diagnostika uchun: loglarni olish serverga ulanishni
    talab qiladi.
    """
    sent = 0
    for result in results:
        if not result.is_problem:
            continue
        if not should_alert(result.server, result.name):
            log.debug("%s/%s: birinchi muammo, kutamiz", result.server, result.name)
            continue
        if _recently_alerted(result.server, result.name):
            log.debug("%s/%s: cooldown ichida", result.server, result.name)
            continue

        diagnosis = ""
        if diagnose:
            from monitor.diagnose import diagnose_problem

            diagnosis = diagnose_problem(result, (servers or {}).get(result.server))

        if send_alert(result, diagnosis=diagnosis):
            sent += 1

    return sent


def open_alerts() -> list[dict]:
    """Hozir ochiq (yopilmagan) alertlar — CLI uchun."""
    rows = query(
        "SELECT id, created_at, server, check_name, status, summary, diagnosis "
        "FROM server_alerts WHERE resolved_at IS NULL ORDER BY id DESC"
    )
    return [dict(row) for row in rows]


def recent_alerts(limit: int = 20) -> list[dict]:
    """Oxirgi alertlar (yopilganlari ham) — CLI uchun."""
    rows = query(
        "SELECT id, created_at, server, check_name, status, summary, diagnosis, resolved_at "
        "FROM server_alerts ORDER BY id DESC LIMIT ?",
        (limit,),
    )
    return [dict(row) for row in rows]
