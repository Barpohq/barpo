"""Sending alerts to the Telegram admin chat.

The cooldown key is (server, check_name): the bot's global cooldown would
be wrong here — one server's full disk would suppress another server's dead
service for 4 hours.

An open alert sits in `server_alerts` with `resolved_at IS NULL`. Once the
problem clears it is closed and a recovery message is sent — without that
the user never learns how the situation ended.
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

# We don't re-notify about the same problem (server + check) within this window
ALERT_COOLDOWN_HOURS = 4


def _send(text: str) -> bool:
    """Send a message to the admin chat. True on success.

    No channel is needed — `has_token()` is enough (the bot's
    `is_configured()` also requires a channel, which would be wrong here).
    """
    from core.telegram import TelegramClient, admin_chat_id, has_token, with_client

    if not has_token():
        log.info("Telegram is not configured — alert not sent")
        return False

    chat = admin_chat_id()
    if not chat:
        log.warning("TELEGRAM_ADMIN_CHAT_ID is not set — alert not sent")
        return False

    async def work(client: TelegramClient) -> None:
        await client.send_notice(chat, text)

    try:
        asyncio.run(with_client(work))
        return True
    except Exception:  # noqa: BLE001 — a failed send must not stop the cycle
        log.exception("Alert could not be sent")
        return False


def _open_alert(server: str, check_name: str) -> dict | None:
    """The unresolved alert for this (server, check), if any."""
    row = query_one(
        "SELECT id, created_at FROM server_alerts "
        "WHERE server = ? AND check_name = ? AND resolved_at IS NULL "
        "ORDER BY id DESC LIMIT 1",
        (server, check_name),
    )
    return dict(row) if row else None


def _recently_alerted(server: str, check_name: str) -> bool:
    """Whether an alert was recently sent for this pair."""
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
        # If the date won't parse we don't block the alert — better a
        # message that arrives than one that never does
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
    """Send a message about a problem (without checking the cooldown).

    The cooldown and repeat logic live in `process_results()` — this
    function is also used for manual testing.
    """
    text = format_alert(result, diagnosis=diagnosis)
    if not _send(text):
        return False
    # Record only after a successful send: if Telegram is down the
    # cooldown must not start
    _record_alert(result, result.message, diagnosis)
    log.info("Alert sent: %s/%s", result.server, result.name)
    return True


def resolve_alerts(healthy: list[CurrentState]) -> int:
    """Close open alerts whose problems have cleared.

    Returns the number closed, sending a recovery message for each.
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
            log.info("Recovered: %s/%s", state.server, state.check_name)
    return closed


def process_results(
    results: list[CheckResult],
    *,
    diagnose: bool = False,
    servers: dict[str, Server] | None = None,
) -> int:
    """Send alerts based on the check results.

    Returns the number of alerts sent. The sequence is:
      1. Has the problem now repeated twice in a row (`should_alert`)
      2. Are we outside the cooldown window
      3. Diagnosis (if enabled) — on failure the alert still goes out

    `servers` is needed for diagnosis: fetching logs requires connecting
    to the server.
    """
    sent = 0
    for result in results:
        if not result.is_problem:
            continue
        if not should_alert(result.server, result.name):
            log.debug("%s/%s: first failure, waiting", result.server, result.name)
            continue
        if _recently_alerted(result.server, result.name):
            log.debug("%s/%s: within cooldown", result.server, result.name)
            continue

        diagnosis = ""
        if diagnose:
            from monitor.diagnose import diagnose_problem

            diagnosis = diagnose_problem(result, (servers or {}).get(result.server))

        if send_alert(result, diagnosis=diagnosis):
            sent += 1

    return sent


def open_alerts() -> list[dict]:
    """Currently open (unresolved) alerts — for the CLI."""
    rows = query(
        "SELECT id, created_at, server, check_name, status, summary, diagnosis "
        "FROM server_alerts WHERE resolved_at IS NULL ORDER BY id DESC"
    )
    return [dict(row) for row in rows]


def recent_alerts(limit: int = 20) -> list[dict]:
    """The most recent alerts, resolved ones included — for the CLI."""
    rows = query(
        "SELECT id, created_at, server, check_name, status, summary, diagnosis, resolved_at "
        "FROM server_alerts ORDER BY id DESC LIMIT ?",
        (limit,),
    )
    return [dict(row) for row in rows]
