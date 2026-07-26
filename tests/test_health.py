"""Health testlari: ko'rsatkichlar, tiklanish mantiqi, hisobot."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from bot.health.metrics import (
    APPROVAL_AUTO_THRESHOLD,
    collect_metrics,
    lifetime_stats,
    source_health,
)
from bot.health.report import format_alert, format_daily_report, format_stats


def _ago(hours: float = 0, minutes: float = 0) -> str:
    return (datetime.now(UTC) - timedelta(hours=hours, minutes=minutes)).isoformat(
        timespec="seconds"
    )


def _add_item(source: str = "rss-a", *, fetched_at: str | None = None) -> int:
    from bot.db import execute, utc_now

    when = fetched_at or utc_now()
    cursor = execute(
        "INSERT INTO items (source, url, url_normalized, title, fetched_at, status) "
        "VALUES (?, ?, ?, ?, ?, 'raw')",
        (source, f"https://x.dev/{when}{source}", f"https://x.dev/{when}{source}", "T", when),
    )
    return int(cursor.lastrowid)


def _add_error(component: str, context: str, *, created_at: str | None = None) -> None:
    from bot.db import execute, utc_now

    execute(
        "INSERT INTO errors (created_at, component, context, message) VALUES (?, ?, ?, ?)",
        (created_at or utc_now(), component, context, "404 Not Found"),
    )


def _add_run(stage: str, *, ok: bool, started_at: str | None = None) -> None:
    from bot.db import execute, utc_now

    execute(
        "INSERT INTO runs (started_at, finished_at, stage, ok) VALUES (?, ?, ?, ?)",
        (started_at or utc_now(), utc_now(), stage, int(ok)),
    )


_post_counter = 0


def _add_post(
    *,
    status: str = "draft",
    reviewed: bool = False,
    published: bool = False,
    edited: bool = False,
) -> int:
    from bot.db import execute, utc_now

    # URL noyob bo'lishi kerak: utc_now() soniya aniqligida, bir siklda
    # yaratilgan postlar bir xil vaqt oladi
    global _post_counter
    _post_counter += 1
    url = f"https://x.dev/p{_post_counter}"

    now = utc_now()
    cursor = execute(
        "INSERT INTO items (source, url, url_normalized, title, fetched_at, status) "
        "VALUES ('rss-a', ?, ?, 'T', ?, 'clustered')",
        (url, url, now),
    )
    item_id = int(cursor.lastrowid)
    cursor = execute(
        "INSERT INTO clusters (primary_item_id, title, created_at, updated_at, status) "
        "VALUES (?, 'Claude Opus 5', ?, ?, 'ranked')",
        (item_id, now, now),
    )
    cluster_id = int(cursor.lastrowid)
    cursor = execute(
        "INSERT INTO posts (cluster_id, body, model, created_at, status, "
        "reviewed_at, published_at, original_body) VALUES (?, 'matn', 'm', ?, ?, ?, ?, ?)",
        (
            cluster_id,
            now,
            status,
            now if reviewed else None,
            now if published else None,
            "asl" if edited else None,
        ),
    )
    return int(cursor.lastrowid)


class TestSourceRecovery:
    """Manba buzilgan-tuzatilgan holatini to'g'ri aniqlash.

    Real muammo: ertalab buzilib, keyin tuzatilgan manba kun bo'yi
    "buzilgan" bo'lib ko'rinardi va alert ma'nosini yo'qotardi.
    """

    def test_error_then_success_is_recovered(self, migrated_db) -> None:
        _add_error("collector.rss", "rss-a", created_at=_ago(hours=10))
        _add_item("rss-a", fetched_at=_ago(hours=2))

        assert collect_metrics(24).failed_sources == []

    def test_error_without_recovery_is_broken(self, migrated_db) -> None:
        _add_item("rss-a", fetched_at=_ago(hours=10))
        _add_error("collector.rss", "rss-a", created_at=_ago(hours=2))

        assert collect_metrics(24).failed_sources == ["rss-a"]

    def test_only_broken_source_listed(self, migrated_db) -> None:
        _add_error("collector.rss", "rss-a", created_at=_ago(hours=5))
        _add_item("rss-a", fetched_at=_ago(hours=1))
        _add_error("collector.rss", "rss-b", created_at=_ago(hours=1))

        assert collect_metrics(24).failed_sources == ["rss-b"]

    def test_old_error_outside_window_ignored(self, migrated_db) -> None:
        _add_error("collector.rss", "rss-a", created_at=_ago(hours=100))

        assert collect_metrics(24).failed_sources == []


class TestStageRecovery:
    def test_failed_then_ok_is_recovered(self, migrated_db) -> None:
        _add_run("collect", ok=False, started_at=_ago(hours=10))
        _add_run("collect", ok=True, started_at=_ago(hours=1))

        assert collect_metrics(24).failed_stages == []

    def test_still_failing_is_listed(self, migrated_db) -> None:
        _add_run("collect", ok=True, started_at=_ago(hours=10))
        _add_run("collect", ok=False, started_at=_ago(hours=1))

        assert collect_metrics(24).failed_stages == ["collect"]

    def test_never_succeeded_is_listed(self, migrated_db) -> None:
        _add_run("write", ok=False, started_at=_ago(hours=2))

        assert collect_metrics(24).failed_stages == ["write"]


class TestOtherAgentsIgnored:
    """`runs` jadvali umumiy — botning hisoboti begona yozuvlarni olmasin.

    Server monitor ham shu jadvalga yozadi. Filtrsiz uning xatosi
    botning alertida "pipeline bosqichi ishlamadi" bo'lib chiqardi.
    """

    def test_monitor_failure_is_not_a_bot_problem(self, migrated_db) -> None:
        _add_run("monitor", ok=False, started_at=_ago(hours=1))

        assert collect_metrics(24).failed_stages == []

    def test_alert_records_are_ignored(self, migrated_db) -> None:
        # notify.py cooldown uchun `runs` ga stage='alert' yozadi
        _add_run("alert", ok=False, started_at=_ago(hours=1))

        assert collect_metrics(24).failed_stages == []

    def test_bot_stage_still_detected_alongside(self, migrated_db) -> None:
        _add_run("monitor", ok=False, started_at=_ago(hours=2))
        _add_run("rank", ok=False, started_at=_ago(hours=1))

        assert collect_metrics(24).failed_stages == ["rank"]


class TestApprovalRate:
    def test_no_reviews_returns_none(self, migrated_db) -> None:
        _add_post(status="draft")

        assert collect_metrics(24).approval_rate is None

    def test_all_approved(self, migrated_db) -> None:
        _add_post(status="published", reviewed=True, published=True)
        _add_post(status="approved", reviewed=True)

        assert collect_metrics(24).approval_rate == 100.0

    def test_mixed(self, migrated_db) -> None:
        _add_post(status="published", reviewed=True, published=True)
        _add_post(status="rejected", reviewed=True)

        assert collect_metrics(24).approval_rate == 50.0

    def test_published_counts_as_approved(self, migrated_db) -> None:
        """Chiqarilgan post ham tasdiqlangan hisoblanadi."""
        _add_post(status="published", reviewed=True, published=True)

        m = collect_metrics(24)
        assert m.posts_approved == 1
        assert m.approval_rate == 100.0


class TestStaleDetection:
    def test_no_items_is_stale(self, migrated_db) -> None:
        assert collect_metrics(24).is_stale

    def test_recent_items_not_stale(self, migrated_db) -> None:
        _add_item(fetched_at=_ago(hours=1))

        assert not collect_metrics(24).is_stale

    def test_old_items_are_stale(self, migrated_db) -> None:
        _add_item(fetched_at=_ago(hours=48))

        assert collect_metrics(24).is_stale


class TestProblemDetection:
    def test_healthy_has_no_problems(self, migrated_db) -> None:
        _add_item(fetched_at=_ago(hours=1))
        _add_post(status="published", reviewed=True, published=True)

        assert not collect_metrics(24).has_problems

    def test_historical_errors_do_not_flag(self, migrated_db) -> None:
        """Tuzatilgan xato muammo hisoblanmaydi."""
        _add_item(fetched_at=_ago(hours=1))
        _add_error("collector.rss", "rss-a", created_at=_ago(hours=10))
        _add_item("rss-a", fetched_at=_ago(hours=2))

        m = collect_metrics(24)
        assert m.errors == 1  # tarixda bor
        assert not m.has_problems  # lekin muammo emas

    def test_broken_source_flags(self, migrated_db) -> None:
        _add_item(fetched_at=_ago(hours=1))
        _add_error("collector.rss", "rss-b", created_at=_ago(minutes=30))

        assert collect_metrics(24).has_problems


class TestAlert:
    def test_no_alert_when_healthy(self, migrated_db) -> None:
        _add_item(fetched_at=_ago(hours=1))

        assert format_alert(collect_metrics(24)) is None

    def test_alert_on_stale(self, migrated_db) -> None:
        alert = format_alert(collect_metrics(24))

        assert alert is not None
        assert "yangilik yig'ilmadi" in alert

    def test_alert_on_failing_stage(self, migrated_db) -> None:
        _add_item(fetched_at=_ago(hours=1))
        _add_run("write", ok=False, started_at=_ago(hours=1))

        alert = format_alert(collect_metrics(24))

        assert alert is not None
        assert "write" in alert

    def test_recovered_stage_no_alert(self, migrated_db) -> None:
        _add_item(fetched_at=_ago(hours=1))
        _add_run("write", ok=False, started_at=_ago(hours=5))
        _add_run("write", ok=True, started_at=_ago(hours=1))

        assert format_alert(collect_metrics(24)) is None


class TestDailyReport:
    def test_contains_key_numbers(self, migrated_db) -> None:
        _add_item(fetched_at=_ago(hours=1))
        _add_post(status="published", reviewed=True, published=True)

        report = format_daily_report(collect_metrics(24))

        assert "Kunlik hisobot" in report
        assert "Yig'ildi" in report
        assert "Approval" in report
        assert "Xarajat" in report

    def test_healthy_report_has_no_warning_section(self, migrated_db) -> None:
        _add_item(fetched_at=_ago(hours=1))

        assert "Diqqat" not in format_daily_report(collect_metrics(24))

    def test_problem_report_has_warning(self, migrated_db) -> None:
        report = format_daily_report(collect_metrics(24))

        assert "Diqqat" in report


class TestLifetimeStats:
    def test_empty(self, migrated_db) -> None:
        stats = lifetime_stats()

        assert stats.total_written == 0
        assert stats.approval_rate is None
        assert not stats.ready_for_auto

    def test_not_ready_with_few_samples(self, migrated_db) -> None:
        """Namuna kam bo'lsa 100% ham yetarli emas."""
        for _ in range(3):
            _add_post(status="published", reviewed=True, published=True)

        stats = lifetime_stats()

        assert stats.approval_rate == 100.0
        assert not stats.ready_for_auto

    def test_ready_with_enough_samples(self, migrated_db) -> None:
        for _ in range(12):
            _add_post(status="published", reviewed=True, published=True)

        stats = lifetime_stats()

        assert stats.reviewed >= 10
        assert stats.approval_rate >= APPROVAL_AUTO_THRESHOLD
        assert stats.ready_for_auto

    def test_low_rate_blocks_auto(self, migrated_db) -> None:
        for _ in range(10):
            _add_post(status="published", reviewed=True, published=True)
        for _ in range(5):
            _add_post(status="rejected", reviewed=True)

        assert not lifetime_stats().ready_for_auto

    def test_edit_rate(self, migrated_db) -> None:
        _add_post(status="published", reviewed=True, published=True, edited=True)
        _add_post(status="published", reviewed=True, published=True)

        assert lifetime_stats().edit_rate == 50.0

    def test_reject_reasons_collected(self, migrated_db) -> None:
        from bot.db import execute

        post_id = _add_post(status="rejected", reviewed=True)
        execute("UPDATE posts SET reject_reason = ? WHERE id = ?", ("Sarlavha quruq", post_id))

        reasons = lifetime_stats().reject_reasons

        assert len(reasons) == 1
        assert reasons[0][0] == "Sarlavha quruq"


class TestStatsReport:
    def test_shows_progress_to_auto(self, migrated_db) -> None:
        _add_post(status="published", reviewed=True, published=True)

        report = format_stats()

        assert "Approval rate" in report
        assert "yana" in report  # yana N ta post kerak

    def test_shows_ready_when_qualified(self, migrated_db) -> None:
        for _ in range(12):
            _add_post(status="published", reviewed=True, published=True)

        assert "Avtonom rejimga tayyor" in format_stats()


class TestSourceHealth:
    def test_lists_sources_with_counts(self, migrated_db) -> None:
        _add_item("rss-a", fetched_at=_ago(hours=1))
        _add_item("rss-a", fetched_at=_ago(hours=2))
        _add_item("rss-b", fetched_at=_ago(hours=1))

        rows = {r["source"]: r["items"] for r in source_health(48)}

        assert rows["rss-a"] == 2
        assert rows["rss-b"] == 1

    def test_silent_source_shows_zero(self, migrated_db) -> None:
        """Eski element bergan, hozir jim manba 0 bilan ko'rinadi."""
        _add_item("rss-old", fetched_at=_ago(hours=100))

        rows = {r["source"]: r["items"] for r in source_health(48)}

        assert rows["rss-old"] == 0
