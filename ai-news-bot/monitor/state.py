"""Tekshiruv natijalarini saqlash va joriy holatni o'qish.

Tarix `server_checks` da to'planadi, "hozir qanday" esa har
(server, check) juftligi uchun oxirgi yozuvdan olinadi.

Diqqat: alert faqat ketma-ket ikkinchi muvaffaqiyatsizlikdan keyin
yuboriladi. Tarmoqning bir soniyalik uzilishi 5 serverni ham "o'lgan"
deb ko'rsatishi mumkin — bunday alertlar tez ishonchni yo'qotadi
(04-xavflar, X4).
"""

from __future__ import annotations

from dataclasses import dataclass

from core.db import execute, query, query_one, utc_now
from core.logging_setup import get_logger
from monitor.checks import CheckResult

log = get_logger(__name__)

# Alert uchun kerakli ketma-ket muvaffaqiyatsizlik soni
FAILURES_BEFORE_ALERT = 2


def record(results: list[CheckResult], *, duration_ms: int = 0) -> None:
    """Natijalarni bazaga yozish.

    Har natija alohida INSERT — katta tranzaksiya ochilmaydi, chunki
    bot bilan bitta bazani bo'lishamiz va uzoq qulf keraksiz.
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
        except Exception:  # noqa: BLE001 — yozuv xatosi siklni to'xtatmasin
            log.exception("Tekshiruv natijasini yozib bo'lmadi: %s/%s", result.server, result.name)


@dataclass(frozen=True, slots=True)
class CurrentState:
    """(server, check) juftligining hozirgi holati."""

    server: str
    check_name: str
    status: str
    message: str
    checked_at: str
    value: float | None = None
    threshold: float | None = None

    @property
    def is_problem(self) -> bool:
        return self.status in ("fail", "error")


def current_states(server: str | None = None) -> list[CurrentState]:
    """Har (server, check) uchun eng oxirgi yozuv.

    Oxirgi yozuv id bo'yicha topiladi — `checked_at` soniya aniqligida
    va bitta siklda bir xil bo'ladi.
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
    """Hozir muammoli holatlar (fail yoki error)."""
    return [s for s in current_states(server) if s.is_problem]


def consecutive_failures(server: str, check_name: str, *, limit: int = 5) -> int:
    """Oxirgi nechta tekshiruv ketma-ket muvaffaqiyatsiz bo'lgan.

    Birinchi `ok`/`warn` uchraganda sanoq to'xtaydi.
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
    """Alert yuborish vaqti keldimi.

    Bitta muvaffaqiyatsizlik yetarli emas: tarmoq uzilishi yoki
    o'tkinchi yuk cho'qqisi shovqin beradi.
    """
    return consecutive_failures(server, check_name) >= FAILURES_BEFORE_ALERT


def last_check_time(server: str) -> str | None:
    """Server oxirgi marta qachon tekshirilgan."""
    row = query_one(
        "SELECT MAX(checked_at) AS last FROM server_checks WHERE server = ?", (server,)
    )
    return str(row["last"]) if row and row["last"] else None


def prune(keep_days: int = 30) -> int:
    """Eski yozuvlarni o'chirish. O'chirilgan qatorlar soni qaytadi.

    Har 10 daqiqada ~10 yozuv × 5 server = kuniga ~7000 qator.
    Cheklovsiz baza yildan yilga o'sib boradi.
    """
    cursor = execute(
        "DELETE FROM server_checks WHERE checked_at < datetime('now', ?)",
        (f"-{keep_days} days",),
    )
    return cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0
