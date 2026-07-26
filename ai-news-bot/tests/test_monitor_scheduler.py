"""Monitor scheduler: sikl hech qachon exception tashlamasligi kerak.

APScheduler exception ko'targan jobni o'chirib qo'yadi — unda monitor
jimgina o'lib qoladi va aynan shu holatni xabar qilish uchun mo'ljallangan
agent ishlamay turadi.
"""

from __future__ import annotations

import pytest

from core.db import query
from monitor.scheduler import PRUNE_HOUR_UTC, prune_old, run_cycle


class TestRunCycleTolerance:
    def test_survives_check_failure(self, migrated_db, monkeypatch: pytest.MonkeyPatch) -> None:
        import monitor.run as run_mod

        def boom(*a, **kw):
            raise RuntimeError("hamma narsa yiqildi")

        monkeypatch.setattr(run_mod, "run_checks", boom)

        run_cycle()  # exception ko'tarilmasligi kerak

        rows = query("SELECT component FROM errors")
        assert any("monitor.scheduler" in str(r["component"]) for r in rows)

    def test_survives_config_error(self, migrated_db, monkeypatch: pytest.MonkeyPatch) -> None:
        import monitor.run as run_mod
        from core.config import ConfigError

        monkeypatch.setattr(
            run_mod, "run_checks", lambda **kw: (_ for _ in ()).throw(ConfigError("yo'q"))
        )

        run_cycle()

    def test_normal_cycle_logs_no_error(
        self, migrated_db, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import monitor.run as run_mod
        from monitor.run import CycleReport

        monkeypatch.setattr(run_mod, "run_checks", lambda **kw: CycleReport(servers_checked=1))

        run_cycle()

        assert query("SELECT id FROM errors") == []

    def test_diagnose_flag_passed(self, migrated_db, monkeypatch: pytest.MonkeyPatch) -> None:
        import monitor.run as run_mod
        from monitor.run import CycleReport

        seen: dict = {}

        def capture(**kwargs):
            seen.update(kwargs)
            return CycleReport()

        monkeypatch.setattr(run_mod, "run_checks", capture)

        run_cycle(diagnose=False)

        assert seen == {"notify": True, "diagnose": False}


class TestPrune:
    def test_survives_failure(self, migrated_db, monkeypatch: pytest.MonkeyPatch) -> None:
        import monitor.state as state_mod

        monkeypatch.setattr(
            state_mod, "prune", lambda days: (_ for _ in ()).throw(RuntimeError("x"))
        )

        prune_old()

        rows = query("SELECT component FROM errors")
        assert any("monitor.scheduler" in str(r["component"]) for r in rows)

    def test_runs_before_bot_daily_report(self) -> None:
        """Tozalash botning hisobotidan (4:00 UTC) oldin bo'lishi kerak."""
        from bot.scheduler import REPORT_HOUR_UTC

        assert PRUNE_HOUR_UTC < REPORT_HOUR_UTC
