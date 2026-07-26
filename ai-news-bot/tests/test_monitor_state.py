"""Monitor: holat saqlash, joriy holat va alert chegarasi."""

from __future__ import annotations

from bot.health.metrics import collect_metrics
from core.db import execute, query_one, utc_now
from monitor.checks import CheckResult
from monitor.state import (
    FAILURES_BEFORE_ALERT,
    consecutive_failures,
    current_problems,
    current_states,
    last_check_time,
    prune,
    record,
    should_alert,
)


def _result(
    server: str = "s1",
    name: str = "disk:/",
    status: str = "ok",
    message: str = "51% to'lgan",
    value: float | None = 51.0,
) -> CheckResult:
    return CheckResult(
        server=server, name=name, status=status, message=message, value=value, threshold=90.0
    )


def _add_check(server: str, name: str, status: str, *, checked_at: str | None = None) -> None:
    execute(
        "INSERT INTO server_checks (checked_at, server, check_name, status, message) "
        "VALUES (?, ?, ?, ?, ?)",
        (checked_at or utc_now(), server, name, status, f"{name}: {status}"),
    )


class TestRecord:
    def test_writes_all_fields(self, migrated_db) -> None:
        record([_result(status="fail", value=94.0)], duration_ms=1200)

        row = query_one("SELECT * FROM server_checks")
        assert row is not None
        assert row["server"] == "s1"
        assert row["check_name"] == "disk:/"
        assert row["status"] == "fail"
        assert row["value"] == 94.0
        assert row["duration_ms"] == 1200

    def test_multiple_results(self, migrated_db) -> None:
        record([_result(name="load"), _result(name="memory"), _result(name="disk:/")])

        row = query_one("SELECT COUNT(*) AS c FROM server_checks")
        assert row is not None and row["c"] == 3

    def test_empty_list_is_noop(self, migrated_db) -> None:
        record([])

        row = query_one("SELECT COUNT(*) AS c FROM server_checks")
        assert row is not None and row["c"] == 0


class TestCurrentStates:
    def test_returns_latest_per_check(self, migrated_db) -> None:
        _add_check("s1", "disk:/", "ok")
        _add_check("s1", "disk:/", "warn")
        _add_check("s1", "disk:/", "fail")

        states = current_states()

        assert len(states) == 1
        assert states[0].status == "fail"

    def test_separates_checks_and_servers(self, migrated_db) -> None:
        _add_check("s1", "disk:/", "ok")
        _add_check("s1", "memory", "fail")
        _add_check("s2", "disk:/", "warn")

        states = {(s.server, s.check_name): s.status for s in current_states()}

        assert states == {
            ("s1", "disk:/"): "ok",
            ("s1", "memory"): "fail",
            ("s2", "disk:/"): "warn",
        }

    def test_server_filter(self, migrated_db) -> None:
        _add_check("s1", "disk:/", "ok")
        _add_check("s2", "disk:/", "fail")

        assert all(s.server == "s2" for s in current_states("s2"))

    def test_problems_only_fail_and_error(self, migrated_db) -> None:
        _add_check("s1", "load", "ok")
        _add_check("s1", "memory", "warn")
        _add_check("s1", "disk:/", "fail")
        _add_check("s1", "ssh", "error")

        names = {p.check_name for p in current_problems()}

        assert names == {"disk:/", "ssh"}

    def test_empty_database(self, migrated_db) -> None:
        assert current_states() == []


class TestConsecutiveFailures:
    """Alert faqat ketma-ket ikkinchi muvaffaqiyatsizlikdan keyin.

    Real muammo: tarmoqning bir soniyalik uzilishi 5 serverni ham
    "o'lgan" deb ko'rsatishi mumkin. Bunday alertlar tez ishonchni
    yo'qotadi (04-xavflar, X4).
    """

    def test_single_failure_does_not_alert(self, migrated_db) -> None:
        _add_check("s1", "ssh", "ok")
        _add_check("s1", "ssh", "error")

        assert consecutive_failures("s1", "ssh") == 1
        assert not should_alert("s1", "ssh")

    def test_two_failures_alert(self, migrated_db) -> None:
        _add_check("s1", "ssh", "error")
        _add_check("s1", "ssh", "error")

        assert should_alert("s1", "ssh")

    def test_success_resets_counter(self, migrated_db) -> None:
        _add_check("s1", "ssh", "error")
        _add_check("s1", "ssh", "error")
        _add_check("s1", "ssh", "ok")
        _add_check("s1", "ssh", "error")

        assert consecutive_failures("s1", "ssh") == 1
        assert not should_alert("s1", "ssh")

    def test_warn_resets_counter(self, migrated_db) -> None:
        """warn — muammo emas, sanoqni uzadi."""
        _add_check("s1", "memory", "fail")
        _add_check("s1", "memory", "warn")
        _add_check("s1", "memory", "fail")

        assert consecutive_failures("s1", "memory") == 1

    def test_counts_are_per_check(self, migrated_db) -> None:
        _add_check("s1", "disk:/", "fail")
        _add_check("s1", "memory", "fail")

        assert consecutive_failures("s1", "disk:/") == 1
        assert consecutive_failures("s1", "memory") == 1

    def test_counts_are_per_server(self, migrated_db) -> None:
        _add_check("s1", "ssh", "error")
        _add_check("s2", "ssh", "error")

        assert consecutive_failures("s1", "ssh") == 1

    def test_threshold_is_two(self) -> None:
        assert FAILURES_BEFORE_ALERT == 2


class TestLastCheckTime:
    def test_returns_latest(self, migrated_db) -> None:
        _add_check("s1", "load", "ok", checked_at="2026-07-01T00:00:00+00:00")
        _add_check("s1", "load", "ok", checked_at="2026-07-02T00:00:00+00:00")

        assert last_check_time("s1") == "2026-07-02T00:00:00+00:00"

    def test_unknown_server_returns_none(self, migrated_db) -> None:
        assert last_check_time("yoq") is None


class TestPrune:
    def test_removes_old_keeps_recent(self, migrated_db) -> None:
        _add_check("s1", "load", "ok", checked_at="2020-01-01T00:00:00+00:00")
        _add_check("s1", "load", "ok")

        removed = prune(keep_days=30)

        row = query_one("SELECT COUNT(*) AS c FROM server_checks")
        assert removed == 1
        assert row is not None and row["c"] == 1


class TestBotIsolation:
    """Monitor yozuvlari botning hisobotiga aralashmasligi kerak."""

    def test_monitor_run_not_a_bot_stage(self, migrated_db) -> None:
        from core.db import finish_run, start_run

        run_id = start_run("monitor")
        finish_run(run_id, ok=False, note="ulanmadi")

        assert collect_metrics(24).failed_stages == []

    def test_monitor_errors_not_broken_sources(self, migrated_db) -> None:
        """`errors.component` monitor.* prefiksi bilan — collector% ga tushmaydi."""
        from core.db import log_error

        log_error("monitor.check", "ulanib bo'lmadi", context="s1")

        assert collect_metrics(24).failed_sources == []
