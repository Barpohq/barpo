"""Monitor sikli: xato bardoshliligi va `runs` yozuvlari.

Asosiy talab: `run_checks()` hech qachon exception tashlamasligi kerak —
scheduler jobni o'chirib qo'ysa, monitor jimgina o'lib qoladi.
"""

from __future__ import annotations

import pytest

from core.db import query, query_one
from monitor.checks import CheckResult
from monitor.config import parse_servers
from monitor.run import run_checks


def _servers(count: int = 1) -> list:
    entries = [{"name": f"s{i}", "host": f"10.0.0.{i}"} for i in range(1, count + 1)]
    return parse_servers({"servers": entries})


def _ok_results(server: str) -> list[CheckResult]:
    return [
        CheckResult(server, "load", "ok", "load 0.1", value=0.1),
        CheckResult(server, "disk:/", "ok", "51% to'lgan", value=51.0),
    ]


class TestSuccessfulCycle:
    def test_records_checks(self, migrated_db, monkeypatch: pytest.MonkeyPatch) -> None:
        import monitor.run as run_mod

        monkeypatch.setattr(run_mod, "check_server", lambda s: _ok_results(s.name))

        report = run_checks(_servers(2))

        row = query_one("SELECT COUNT(*) AS c FROM server_checks")
        assert report.servers_checked == 2
        assert report.checks_total == 4
        assert row is not None and row["c"] == 4

    def test_counts_problems(self, migrated_db, monkeypatch: pytest.MonkeyPatch) -> None:
        import monitor.run as run_mod

        def results(server):
            return [
                CheckResult(server.name, "disk:/", "fail", "94% to'lgan", value=94.0),
                CheckResult(server.name, "load", "ok", "load 0.1"),
            ]

        monkeypatch.setattr(run_mod, "check_server", results)

        assert run_checks(_servers(1)).problems == 1

    def test_writes_run_record(self, migrated_db, monkeypatch: pytest.MonkeyPatch) -> None:
        import monitor.run as run_mod

        monkeypatch.setattr(run_mod, "check_server", lambda s: _ok_results(s.name))

        run_checks(_servers(1))

        row = query_one("SELECT * FROM runs WHERE stage = 'monitor'")
        assert row is not None
        assert row["ok"] == 1
        assert row["items_out"] == 2

    def test_problems_do_not_mark_run_failed(
        self, migrated_db, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Topilgan muammo — sikl xatosi emas.

        Aks holda disk to'lganda botning hisobotida "monitor bosqichi
        ishlamadi" chiqib, ikki xil muammo aralashib ketardi.
        """
        import monitor.run as run_mod

        monkeypatch.setattr(
            run_mod,
            "check_server",
            lambda s: [CheckResult(s.name, "disk:/", "fail", "to'lgan", value=99.0)],
        )

        run_checks(_servers(1))

        row = query_one("SELECT ok FROM runs WHERE stage = 'monitor'")
        assert row is not None and row["ok"] == 1


class TestErrorTolerance:
    def test_exception_does_not_propagate(
        self, migrated_db, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import monitor.run as run_mod

        def boom(server):
            raise RuntimeError("kutilmagan xato")

        monkeypatch.setattr(run_mod, "check_server", boom)

        report = run_checks(_servers(1))

        assert report.failed_servers == ["s1"]
        assert report.servers_checked == 0

    def test_one_failure_does_not_stop_others(
        self, migrated_db, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import monitor.run as run_mod

        def selective(server):
            if server.name == "s2":
                raise RuntimeError("bu server yiqildi")
            return _ok_results(server.name)

        monkeypatch.setattr(run_mod, "check_server", selective)

        report = run_checks(_servers(3))

        assert report.servers_checked == 2
        assert report.failed_servers == ["s2"]

    def test_error_logged_with_monitor_prefix(
        self, migrated_db, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`errors.component` `collector%` ga tushmasligi kerak."""
        import monitor.run as run_mod

        monkeypatch.setattr(
            run_mod, "check_server", lambda s: (_ for _ in ()).throw(RuntimeError("x"))
        )

        run_checks(_servers(1))

        rows = query("SELECT component, context FROM errors")
        assert rows
        assert all(str(r["component"]).startswith("monitor.") for r in rows)

    def test_failed_server_marks_run_not_ok(
        self, migrated_db, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import monitor.run as run_mod

        monkeypatch.setattr(
            run_mod, "check_server", lambda s: (_ for _ in ()).throw(RuntimeError("x"))
        )

        run_checks(_servers(1))

        row = query_one("SELECT ok FROM runs WHERE stage = 'monitor'")
        assert row is not None and row["ok"] == 0


class TestNoServers:
    def test_empty_list_returns_empty_report(self, migrated_db) -> None:
        report = run_checks([])

        assert report.servers_checked == 0
        assert report.summary()

    def test_no_run_record_when_nothing_to_do(self, migrated_db) -> None:
        run_checks([])

        row = query_one("SELECT COUNT(*) AS c FROM runs")
        assert row is not None and row["c"] == 0
