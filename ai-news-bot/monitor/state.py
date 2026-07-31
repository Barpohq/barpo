"""Persisting check results and reading the current state.

History accumulates in `server_checks`, while "how things are right now"
comes from the latest row for each (server, check) pair.

Note: an alert is only sent after the second consecutive failure. A
one-second network blip can make all 5 servers look "dead" — alerts like
that burn trust fast (04-risks, X4).
"""

from __future__ import annotations

from dataclasses import dataclass

from core.db import execute, query, query_one, utc_now
from core.logging_setup import get_logger
from monitor.checks import CheckResult

log = get_logger(__name__)

# Consecutive failures required before we alert
FAILURES_BEFORE_ALERT = 2


def record(results: list[CheckResult], *, duration_ms: int = 0) -> None:
    """Write the results to the database.

    One INSERT per result — we deliberately avoid a large transaction,
    because we share the database with the bot and a long lock buys nothing.
    """
    now = utc_now()
    for result in results:
        try:
            execute(
                "INSERT INTO server_checks "
                "(checked_at, server, check_name, status, message, value, threshold, duration_ms) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    now,
                    result.server,
                    result.name,
                    result.status,
                    result.message,
                    result.value,
                    result.threshold,
                    duration_ms,
                ),
            )
        except Exception:  # noqa: BLE001 — a write error must not stop the cycle
            log.exception("Could not record check result: %s/%s", result.server, result.name)


@dataclass(frozen=True, slots=True)
class CurrentState:
    """The current state of one (server, check) pair."""

    server: str
    check_name: str
    status: str
    # Uzbek: carried through into Telegram alert and status messages
    message: str
    checked_at: str
    value: float | None = None
    threshold: float | None = None

    @property
    def is_problem(self) -> bool:
        return self.status in ("fail", "error")


def current_states(server: str | None = None) -> list[CurrentState]:
    """The latest row for each (server, check).

    The latest row is found by id — `checked_at` only has second precision
    and is identical across a single cycle.
    """
    sql = """
        SELECT c.server, c.check_name, c.status, c.message, c.checked_at, c.value, c.threshold
        FROM server_checks c
        JOIN (
            SELECT server, check_name, MAX(id) AS last_id
            FROM server_checks
            GROUP BY server, check_name
        ) latest ON latest.last_id = c.id
    """
    params: tuple[str, ...] = ()
    if server:
        sql += " WHERE c.server = ?"
        params = (server,)
    sql += " ORDER BY c.server, c.check_name"

    return [
        CurrentState(
            server=str(row["server"]),
            check_name=str(row["check_name"]),
            status=str(row["status"]),
            message=str(row["message"]),
            checked_at=str(row["checked_at"]),
            value=row["value"],
            threshold=row["threshold"],
        )
        for row in query(sql, params)
    ]


def current_problems(server: str | None = None) -> list[CurrentState]:
    """States that are currently problematic (fail or error)."""
    return [s for s in current_states(server) if s.is_problem]


def consecutive_failures(server: str, check_name: str, *, limit: int = 5) -> int:
    """How many of the most recent checks failed in a row.

    Counting stops at the first `ok`/`warn`.
    """
    rows = query(
        "SELECT status FROM server_checks WHERE server = ? AND check_name = ? "
        "ORDER BY id DESC LIMIT ?",
        (server, check_name, limit),
    )
    count = 0
    for row in rows:
        if str(row["status"]) in ("fail", "error"):
            count += 1
        else:
            break
    return count


def should_alert(server: str, check_name: str) -> bool:
    """Whether it's time to send an alert.

    One failure isn't enough: a network blip or a transient load spike
    would just produce noise.
    """
    return consecutive_failures(server, check_name) >= FAILURES_BEFORE_ALERT


def last_check_time(server: str) -> str | None:
    """When the server was last checked."""
    row = query_one(
        "SELECT MAX(checked_at) AS last FROM server_checks WHERE server = ?", (server,)
    )
    return str(row["last"]) if row and row["last"] else None


def prune(keep_days: int = 30) -> int:
    """Delete old rows. Returns the number of rows removed.

    Roughly 10 rows × 5 servers every 10 minutes ≈ 7000 rows a day.
    Left unbounded the database would grow year over year.
    """
    cursor = execute(
        "DELETE FROM server_checks WHERE checked_at < datetime('now', ?)",
        (f"-{keep_days} days",),
    )
    return cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0
