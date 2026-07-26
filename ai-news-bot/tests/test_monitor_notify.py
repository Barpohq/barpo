"""Monitor: alert yuborish, cooldown va tiklanish.

Telegram qatlami mock qilinadi (`_send`), qolgan mantiq real baza
ustida sinaladi.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from core.db import execute, query, query_one, utc_now
from monitor.checks import CheckResult
from monitor.notify import (
    ALERT_COOLDOWN_HOURS,
    open_alerts,
    process_results,
    recent_alerts,
    resolve_alerts,
    send_alert,
)
from monitor.report import format_alert, format_recovery, format_status
from monitor.state import CurrentState


@pytest.fixture
def sent_messages(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """`_send` ni ushlab, yuborilgan matnlarni to'playdi."""
    import monitor.notify as notify_mod

    messages: list[str] = []

    def fake_send(text: str) -> bool:
        messages.append(text)
        return True

    monkeypatch.setattr(notify_mod, "_send", fake_send)
    return messages


def _problem(server: str = "s1", name: str = "disk:/", status: str = "fail") -> CheckResult:
    return CheckResult(
        server=server,
        name=name,
        status=status,
        message="94% to'lgan",
        value=94.0,
        threshold=90.0,
    )


def _add_check(server: str, name: str, status: str) -> None:
    execute(
        "INSERT INTO server_checks (checked_at, server, check_name, status, message) "
        "VALUES (?, ?, ?, ?, ?)",
        (utc_now(), server, name, status, f"{name}: {status}"),
    )


def _fail_twice(server: str = "s1", name: str = "disk:/") -> None:
    """Alert chegarasiga yetish uchun ikki marta muvaffaqiyatsizlik."""
    _add_check(server, name, "fail")
    _add_check(server, name, "fail")


def _add_alert(server: str, name: str, *, hours_ago: float = 0, resolved: bool = False) -> int:
    when = (datetime.now(UTC) - timedelta(hours=hours_ago)).isoformat(timespec="seconds")
    cursor = execute(
        "INSERT INTO server_alerts (created_at, server, check_name, status, summary, resolved_at) "
        "VALUES (?, ?, ?, 'fail', 'muammo', ?)",
        (when, server, name, utc_now() if resolved else None),
    )
    return int(cursor.lastrowid)


class TestSendAlert:
    def test_records_after_sending(self, migrated_db, sent_messages) -> None:
        assert send_alert(_problem())

        row = query_one("SELECT * FROM server_alerts")
        assert row is not None
        assert row["server"] == "s1"
        assert row["resolved_at"] is None
        assert len(sent_messages) == 1

    def test_no_record_when_sending_fails(
        self, migrated_db, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Telegram tushib qolsa cooldown boshlanmasligi kerak."""
        import monitor.notify as notify_mod

        monkeypatch.setattr(notify_mod, "_send", lambda text: False)

        assert not send_alert(_problem())

        row = query_one("SELECT COUNT(*) AS c FROM server_alerts")
        assert row is not None and row["c"] == 0

    def test_diagnosis_stored(self, migrated_db, sent_messages) -> None:
        send_alert(_problem(), diagnosis="Loglar /var/log da to'planib qolgan")

        row = query_one("SELECT diagnosis FROM server_alerts")
        assert row is not None
        assert "to'planib" in str(row["diagnosis"])


class TestProcessResults:
    def test_healthy_results_send_nothing(self, migrated_db, sent_messages) -> None:
        ok = CheckResult("s1", "load", "ok", "load 0.1")

        assert process_results([ok]) == 0
        assert sent_messages == []

    def test_first_failure_waits(self, migrated_db, sent_messages) -> None:
        """Bitta muvaffaqiyatsizlik yetarli emas — tarmoq shovqini."""
        _add_check("s1", "disk:/", "fail")

        assert process_results([_problem()]) == 0

    def test_second_failure_alerts(self, migrated_db, sent_messages) -> None:
        _fail_twice()

        assert process_results([_problem()]) == 1
        assert len(sent_messages) == 1

    def test_cooldown_blocks_repeat(self, migrated_db, sent_messages) -> None:
        _fail_twice()
        _add_alert("s1", "disk:/", hours_ago=1)

        assert process_results([_problem()]) == 0

    def test_alert_after_cooldown_expires(self, migrated_db, sent_messages) -> None:
        _fail_twice()
        _add_alert("s1", "disk:/", hours_ago=ALERT_COOLDOWN_HOURS + 1)

        assert process_results([_problem()]) == 1


class TestCooldownIsolation:
    """Cooldown (server, check) bo'yicha — bu modulning asosiy talabi.

    Botdagi global cooldown bu yerda yaroqsiz bo'lardi: bitta
    serverning diski to'lgani boshqa serverning xizmati o'lganini
    4 soatga bosib qo'yardi.
    """

    def test_other_server_not_blocked(self, migrated_db, sent_messages) -> None:
        _fail_twice("s1", "disk:/")
        _fail_twice("s2", "disk:/")
        _add_alert("s1", "disk:/", hours_ago=1)

        sent = process_results([_problem("s1"), _problem("s2")])

        assert sent == 1
        assert "s2" in sent_messages[0]

    def test_other_check_not_blocked(self, migrated_db, sent_messages) -> None:
        _fail_twice("s1", "disk:/")
        _fail_twice("s1", "service:nginx")
        _add_alert("s1", "disk:/", hours_ago=1)

        sent = process_results(
            [_problem("s1", "disk:/"), _problem("s1", "service:nginx")]
        )

        assert sent == 1
        assert "service:nginx" in sent_messages[0]

    def test_all_distinct_problems_alert(self, migrated_db, sent_messages) -> None:
        for server in ("s1", "s2", "s3"):
            _fail_twice(server, "disk:/")

        sent = process_results([_problem(s) for s in ("s1", "s2", "s3")])

        assert sent == 3


class TestResolve:
    def test_closes_open_alert_and_notifies(self, migrated_db, sent_messages) -> None:
        alert_id = _add_alert("s1", "disk:/")
        healthy = CurrentState("s1", "disk:/", "ok", "51% to'lgan", utc_now())

        assert resolve_alerts([healthy]) == 1

        row = query_one("SELECT resolved_at FROM server_alerts WHERE id = ?", (alert_id,))
        assert row is not None and row["resolved_at"]
        assert "tiklandi" in sent_messages[0]

    def test_no_open_alert_no_message(self, migrated_db, sent_messages) -> None:
        healthy = CurrentState("s1", "disk:/", "ok", "51%", utc_now())

        assert resolve_alerts([healthy]) == 0
        assert sent_messages == []

    def test_already_resolved_not_reopened(self, migrated_db, sent_messages) -> None:
        _add_alert("s1", "disk:/", resolved=True)
        healthy = CurrentState("s1", "disk:/", "ok", "51%", utc_now())

        assert resolve_alerts([healthy]) == 0

    def test_only_matching_check_closed(self, migrated_db, sent_messages) -> None:
        disk_id = _add_alert("s1", "disk:/")
        _add_alert("s1", "memory")
        healthy = CurrentState("s1", "disk:/", "ok", "51%", utc_now())

        resolve_alerts([healthy])

        all_rows = query("SELECT id, resolved_at FROM server_alerts")
        rows = {r["id"]: r["resolved_at"] for r in all_rows}
        assert rows[disk_id] is not None
        assert len([v for v in rows.values() if v is None]) == 1

    def test_new_alert_after_resolve(self, migrated_db, sent_messages) -> None:
        """Tiklangandan keyin qayta buzilsa yangi alert kelishi kerak."""
        _add_alert("s1", "disk:/", hours_ago=1, resolved=True)
        _fail_twice()

        assert process_results([_problem()]) == 0, "cooldown hali kuchda"

        # Cooldown tugagach yangi alert
        execute("UPDATE server_alerts SET created_at = ?", (
            (datetime.now(UTC) - timedelta(hours=ALERT_COOLDOWN_HOURS + 1)).isoformat(
                timespec="seconds"
            ),
        ))
        assert process_results([_problem()]) == 1


class TestQueries:
    def test_open_alerts_excludes_resolved(self, migrated_db) -> None:
        _add_alert("s1", "disk:/")
        _add_alert("s2", "memory", resolved=True)

        assert [a["server"] for a in open_alerts()] == ["s1"]

    def test_recent_respects_limit(self, migrated_db) -> None:
        for i in range(5):
            _add_alert(f"s{i}", "disk:/")

        assert len(recent_alerts(limit=3)) == 3


class TestFormatting:
    def test_alert_shows_fact_before_diagnosis(self) -> None:
        """O'lchov fakti diagnostikadan oldin — X2 talabi.

        LLM matni chalg'itsa ham, o'quvchi avval raqamni ko'radi.
        """
        text = format_alert(_problem(), diagnosis="Sabab: loglar")

        assert text.index("94%") < text.index("Diagnostika")

    def test_alert_without_diagnosis(self) -> None:
        text = format_alert(_problem())

        assert "Diagnostika" not in text
        assert "94%" in text

    def test_threshold_shown(self) -> None:
        assert "90" in format_alert(_problem())

    def test_html_is_escaped(self) -> None:
        """Serverdan kelgan matn teg sifatida talqin qilinmasligi kerak."""
        result = CheckResult("s1", "service:<b>x</b>", "fail", "<script>alert(1)</script>")
        text = format_alert(result)

        assert "<script>" not in text
        assert "&lt;script&gt;" in text

    def test_recovery_message(self) -> None:
        state = CurrentState("s1", "disk:/", "ok", "51% to'lgan", utc_now())

        assert "tiklandi" in format_recovery(state)
        assert "s1" in format_recovery(state)

    def test_status_groups_by_server(self) -> None:
        states = [
            CurrentState("s1", "load", "ok", "0.1", utc_now()),
            CurrentState("s1", "disk:/", "fail", "94%", utc_now()),
            CurrentState("s2", "load", "ok", "0.2", utc_now()),
        ]
        text = format_status(states)

        assert "s1" in text and "s2" in text
        assert "94%" in text

    def test_status_summarizes_healthy_checks(self) -> None:
        """Normal holat sanaladi, ro'yxat qilinmaydi — 50 qator o'qilmaydi."""
        states = [CurrentState("s1", f"c{i}", "ok", "norm", utc_now()) for i in range(10)]
        text = format_status(states)

        assert "10 ta tekshiruv normal" in text

    def test_status_empty(self) -> None:
        assert "tekshiruv o'tkazilmagan" in format_status([])
