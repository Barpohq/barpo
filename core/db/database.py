"""SQLite ulanishi va migratsiya runner.

Barcha modullar bazaga shu yerdan kiradi. Ulanish thread-local — APScheduler
turli threadlarda ishlatgani uchun.

Baza ikkala agent uchun bitta: `llm_calls` bo'linmasligi kerak (qaysi
agent qancha sarflayapti), `errors` va `runs` ham umumiy. Migratsiyalar
agent bo'yicha ajratilgan — `core/db/schema.py` ga qarang.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from core.config import db_path
from core.db.schema import all_migrations, latest_version
from core.logging_setup import get_logger

log = get_logger(__name__)

_local = threading.local()


def utc_now() -> str:
    """Hozirgi vaqt ISO 8601 formatida (UTC). Barcha sanalar shu formatda."""
    return datetime.now(UTC).isoformat(timespec="seconds")


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    # WAL: o'qish va yozish bir-birini bloklamaydi
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def get_connection() -> sqlite3.Connection:
    """Joriy thread uchun ulanish (kerak bo'lsa yaratiladi)."""
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _connect(db_path())
        _local.conn = conn
    return conn


def close_connection() -> None:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """Tranzaksiya konteksti — xato bo'lsa rollback."""
    conn = get_connection()
    conn.execute("BEGIN")
    try:
        yield conn
    except Exception:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def query(sql: str, params: Any = ()) -> list[sqlite3.Row]:
    return get_connection().execute(sql, params).fetchall()


def query_one(sql: str, params: Any = ()) -> sqlite3.Row | None:
    return get_connection().execute(sql, params).fetchone()


def execute(sql: str, params: Any = ()) -> sqlite3.Cursor:
    return get_connection().execute(sql, params)


# ─────────────────────────── Migratsiyalar ───────────────────────────


def _ensure_migrations_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            note       TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )
        """
    )


def current_version() -> int:
    conn = get_connection()
    _ensure_migrations_table(conn)
    row = conn.execute("SELECT MAX(version) AS v FROM schema_migrations").fetchone()
    return row["v"] or 0


def migrate() -> int:
    """Qo'llanilmagan migratsiyalarni ishga tushirish.

    Qo'llanilgan migratsiyalar soni qaytariladi.
    """
    conn = get_connection()
    _ensure_migrations_table(conn)

    applied = {r["version"] for r in conn.execute("SELECT version FROM schema_migrations")}
    pending = [(v, note, sql) for v, note, sql in all_migrations() if v not in applied]

    if not pending:
        log.info("Baza yangi (versiya %d), migratsiya kerak emas", current_version())
        return 0

    for version, note, sql in sorted(pending):
        log.info("Migratsiya %d qo'llanmoqda: %s", version, note)
        # Diqqat: executescript() o'zi ochiq tranzaksiyani commit qiladi, shuning
        # uchun BEGIN/COMMIT ni skript ichiga qo'yamiz — bitta atomik blok bo'lishi uchun.
        try:
            conn.executescript(f"BEGIN;\n{sql}\nCOMMIT;")
            conn.execute(
                "INSERT INTO schema_migrations (version, note, applied_at) VALUES (?, ?, ?)",
                (version, note, utc_now()),
            )
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            log.error("Migratsiya %d muvaffaqiyatsiz — o'zgarishlar qaytarildi", version)
            raise

    log.info("Migratsiya tugadi. Baza versiyasi: %d", current_version())
    return len(pending)


def check_schema() -> None:
    """Sxema eng so'nggi versiyada ekanini tekshirish. Bo'lmasa xato."""
    version = current_version()
    latest = latest_version()
    if version < latest:
        raise RuntimeError(
            f"Baza sxemasi eskirgan (versiya {version}, kerak {latest}). "
            f"`bot db migrate` ni ishga tushiring."
        )


# ─────────────────────────── Yordamchi yozuvchilar ───────────────────────────


def log_error(component: str, message: str, *, context: str = "", traceback: str = "") -> None:
    """Xatoni bazaga yozish — health report va debug uchun."""
    try:
        execute(
            "INSERT INTO errors (created_at, component, context, message, traceback) "
            "VALUES (?, ?, ?, ?, ?)",
            (utc_now(), component, context or None, message, traceback or None),
        )
    except Exception:  # noqa: BLE001 — log yozish hech qachon pipeline'ni to'xtatmasin
        log.exception("Xatoni bazaga yozib bo'lmadi")


def start_run(stage: str) -> int:
    """Pipeline bosqichi boshlanishini qayd etish. Run id qaytaradi."""
    cur = execute(
        "INSERT INTO runs (started_at, stage) VALUES (?, ?)",
        (utc_now(), stage),
    )
    return int(cur.lastrowid or 0)


def finish_run(
    run_id: int,
    *,
    items_in: int = 0,
    items_out: int = 0,
    error_count: int = 0,
    ok: bool = True,
    note: str = "",
) -> None:
    execute(
        "UPDATE runs SET finished_at = ?, items_in = ?, items_out = ?, "
        "error_count = ?, ok = ?, note = ? WHERE id = ?",
        (utc_now(), items_in, items_out, error_count, int(ok), note or None, run_id),
    )
