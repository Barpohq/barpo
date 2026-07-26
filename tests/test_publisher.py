"""Publisher testlari: takror filtri, vaqt cheklovlari, holat o'zgarishlari."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from bot.publisher.queue import (
    QueueBlocked,
    check_can_publish,
    duplicate_of,
    minutes_since_last_post,
    next_in_queue,
    published_today,
    unsent_drafts,
)


def _seed_cluster(title: str, *, score: float = 9.0, category: str = "model_release") -> int:
    """Klaster yaratish (ranked, boyitilgan)."""
    from bot.db import execute, utc_now

    now = utc_now()
    cursor = execute(
        "INSERT INTO items (source, url, url_normalized, title, fetched_at, status) "
        "VALUES (?, ?, ?, ?, ?, 'clustered')",
        ("test", f"https://x.dev/{title[:20]}", f"https://x.dev/{title[:20]}", title, now),
    )
    item_id = int(cursor.lastrowid)
    cursor = execute(
        "INSERT INTO clusters (primary_item_id, title, created_at, updated_at, "
        "status, importance_score, relevance_score, category, enriched_at) "
        "VALUES (?, ?, ?, ?, 'ranked', ?, ?, ?, ?)",
        (item_id, title, now, now, score, score, category, now),
    )
    return int(cursor.lastrowid)


def _seed_post(
    cluster_id: int,
    *,
    status: str = "draft",
    published_at: str | None = None,
    body: str = "Post matni",
) -> int:
    from bot.db import execute, utc_now

    cursor = execute(
        "INSERT INTO posts (cluster_id, body, model, created_at, status, published_at) "
        "VALUES (?, ?, 'test-model', ?, ?, ?)",
        (cluster_id, body, utc_now(), status, published_at),
    )
    return int(cursor.lastrowid)


class TestDuplicateDetection:
    def test_same_model_is_duplicate(self, migrated_db) -> None:
        """Real muammo: rasmiy blog va qayta hikoya — bir voqea."""
        cluster = _seed_cluster("Claude Opus 5")
        _seed_post(cluster, status="published", published_at=_now())

        found = duplicate_of("Anthropic launches Claude Opus 5 with efficiency")

        assert found is not None
        assert found["title"] == "Claude Opus 5"

    def test_sibling_model_is_not_duplicate(self, migrated_db) -> None:
        """Opus 5 va Sonnet 5 — turli relizlar, ikkalasi ham chiqishi mumkin."""
        cluster = _seed_cluster("Claude Opus 5")
        _seed_post(cluster, status="published", published_at=_now())

        assert duplicate_of("Introducing Claude Sonnet 5") is None

    def test_older_version_is_not_duplicate(self, migrated_db) -> None:
        cluster = _seed_cluster("Claude Opus 5")
        _seed_post(cluster, status="published", published_at=_now())

        assert duplicate_of("Claude Opus 4.7 benchmarks") is None

    def test_unpublished_does_not_count(self, migrated_db) -> None:
        """Faqat chiqarilgan postlar takror hisoblanadi."""
        cluster = _seed_cluster("Claude Opus 5")
        _seed_post(cluster, status="draft")

        assert duplicate_of("Anthropic launches Claude Opus 5") is None

    def test_outside_window_is_not_duplicate(self, migrated_db) -> None:
        old = (datetime.now(UTC) - timedelta(hours=100)).isoformat(timespec="seconds")
        cluster = _seed_cluster("Claude Opus 5")
        _seed_post(cluster, status="published", published_at=old)

        assert duplicate_of("Claude Opus 5 review", hours=48) is None

    def test_no_model_name_skips_check(self, migrated_db) -> None:
        """Model nomi yo'q yangilikda taqqoslash ishonchsiz — o'tkazamiz."""
        cluster = _seed_cluster("Mistral AI raises funding")
        _seed_post(cluster, status="published", published_at=_now())

        assert duplicate_of("OpenAI announces new partnership") is None


class TestUnsentDrafts:
    def test_filters_published_duplicate(self, migrated_db) -> None:
        published = _seed_cluster("Claude Opus 5")
        _seed_post(published, status="published", published_at=_now())

        draft = _seed_cluster("Anthropic launches Claude Opus 5 today")
        _seed_post(draft, status="draft")

        assert unsent_drafts() == []

    def test_filters_within_batch(self, migrated_db) -> None:
        """Bir partiyada ikkita bir xil mavzu bo'lsa bittasi qoladi."""
        first = _seed_cluster("Claude Opus 5", score=10)
        _seed_post(first)
        second = _seed_cluster("Anthropic launches Claude Opus 5", score=9)
        _seed_post(second)

        result = unsent_drafts()

        assert len(result) == 1
        assert result[0]["title"] == "Claude Opus 5"

    def test_different_topics_both_kept(self, migrated_db) -> None:
        _seed_post(_seed_cluster("Claude Opus 5"))
        _seed_post(_seed_cluster("Introducing Gemini 3.6 Flash"))

        assert len(unsent_drafts()) == 2

    def test_respects_limit(self, migrated_db) -> None:
        for name in ("Claude Opus 5", "Gemini 3.6", "GPT-5.6", "Mistral 3"):
            _seed_post(_seed_cluster(name))

        assert len(unsent_drafts(limit=2)) == 2

    def test_orders_by_importance(self, migrated_db) -> None:
        _seed_post(_seed_cluster("Gemini 3.6 Flash", score=7))
        _seed_post(_seed_cluster("Claude Opus 5", score=10))

        result = unsent_drafts()

        assert result[0]["title"] == "Claude Opus 5"

    def test_only_drafts(self, migrated_db) -> None:
        _seed_post(_seed_cluster("Claude Opus 5"), status="pending")

        assert unsent_drafts() == []


class TestTimeConstraints:
    def test_no_posts_yet(self, migrated_db) -> None:
        assert minutes_since_last_post() is None
        assert published_today() == 0

    def test_counts_today(self, migrated_db) -> None:
        cluster = _seed_cluster("Claude Opus 5")
        _seed_post(cluster, status="published", published_at=_now())

        assert published_today() == 1

    def test_minutes_since_last(self, migrated_db) -> None:
        past = (datetime.now(UTC) - timedelta(minutes=30)).isoformat(timespec="seconds")
        cluster = _seed_cluster("Claude Opus 5")
        _seed_post(cluster, status="published", published_at=past)

        elapsed = minutes_since_last_post()
        assert elapsed is not None
        assert 29 <= elapsed <= 31

    def test_blocks_when_too_soon(self, migrated_db) -> None:
        recent = (datetime.now(UTC) - timedelta(minutes=5)).isoformat(timespec="seconds")
        cluster = _seed_cluster("Claude Opus 5")
        _seed_post(cluster, status="published", published_at=recent)

        with pytest.raises(QueueBlocked, match="daqiqa"):
            check_can_publish()

    def test_allows_after_interval(self, migrated_db) -> None:
        past = (datetime.now(UTC) - timedelta(minutes=90)).isoformat(timespec="seconds")
        cluster = _seed_cluster("Claude Opus 5")
        _seed_post(cluster, status="published", published_at=past)

        check_can_publish()  # xato bermasligi kerak

    def test_blocks_on_daily_limit(self, migrated_db, monkeypatch) -> None:
        from bot.config import load_config
        from bot.publisher import queue as queue_mod

        cfg = load_config()
        # Interval 0 — faqat kunlik limit tekshirilsin
        patched = type(cfg)(
            cfg.sources,
            {**cfg.channel, "posting": {"max_posts_per_day": 2, "min_interval_minutes": 0}},
            cfg.models,
        )
        monkeypatch.setattr(queue_mod, "load_config", lambda: patched)

        for name in ("Claude Opus 5", "Gemini 3.6"):
            _seed_post(_seed_cluster(name), status="published", published_at=_now())

        with pytest.raises(QueueBlocked, match="limit"):
            check_can_publish()

    def test_allows_below_daily_limit(self, migrated_db, monkeypatch) -> None:
        from bot.config import load_config
        from bot.publisher import queue as queue_mod

        cfg = load_config()
        patched = type(cfg)(
            cfg.sources,
            {**cfg.channel, "posting": {"max_posts_per_day": 6, "min_interval_minutes": 0}},
            cfg.models,
        )
        monkeypatch.setattr(queue_mod, "load_config", lambda: patched)

        _seed_post(_seed_cluster("Claude Opus 5"), status="published", published_at=_now())

        check_can_publish()  # xato bermasligi kerak

    def test_blocks_on_duplicate(self, migrated_db) -> None:
        old = (datetime.now(UTC) - timedelta(hours=3)).isoformat(timespec="seconds")
        cluster = _seed_cluster("Claude Opus 5")
        _seed_post(cluster, status="published", published_at=old)

        with pytest.raises(QueueBlocked, match="allaqachon"):
            check_can_publish("Anthropic launches Claude Opus 5")


class TestNextInQueue:
    def test_picks_approved_by_importance(self, migrated_db) -> None:
        _seed_post(_seed_cluster("Gemini 3.6", score=7), status="approved")
        _seed_post(_seed_cluster("Claude Opus 5", score=10), status="approved")

        post = next_in_queue()

        assert post is not None
        assert post["title"] == "Claude Opus 5"

    def test_ignores_drafts(self, migrated_db) -> None:
        _seed_post(_seed_cluster("Claude Opus 5"), status="draft")

        assert next_in_queue() is None

    def test_empty_queue(self, migrated_db) -> None:
        assert next_in_queue() is None


class TestStateTransitions:
    def test_approve(self, migrated_db) -> None:
        from bot.db import query_one
        from bot.publisher import mark_approved

        post_id = _seed_post(_seed_cluster("Claude Opus 5"))
        mark_approved(post_id)

        row = query_one("SELECT status, reviewed_at FROM posts WHERE id = ?", (post_id,))
        assert row["status"] == "approved"
        assert row["reviewed_at"] is not None

    def test_reject_saves_reason_and_cluster(self, migrated_db) -> None:
        """Rad etish sababi Faza 3 da prompt tuning uchun kerak."""
        from bot.db import query_one
        from bot.publisher import mark_rejected

        cluster_id = _seed_cluster("Claude Opus 5")
        post_id = _seed_post(cluster_id)
        mark_rejected(post_id, "Sarlavha juda quruq")

        row = query_one("SELECT status, reject_reason FROM posts WHERE id = ?", (post_id,))
        assert row["status"] == "rejected"
        assert row["reject_reason"] == "Sarlavha juda quruq"
        assert query_one("SELECT status FROM clusters WHERE id = ?", (cluster_id,))[
            "status"
        ] == "rejected"

    def test_publish_updates_both(self, migrated_db) -> None:
        from bot.db import query_one
        from bot.publisher import mark_published

        cluster_id = _seed_cluster("Claude Opus 5")
        post_id = _seed_post(cluster_id, status="approved")
        mark_published(post_id, 4242)

        row = query_one(
            "SELECT status, message_id, published_at FROM posts WHERE id = ?", (post_id,)
        )
        assert row["status"] == "published"
        assert row["message_id"] == 4242
        assert row["published_at"] is not None
        assert query_one("SELECT status FROM clusters WHERE id = ?", (cluster_id,))[
            "status"
        ] == "published"

    def test_edit_preserves_original(self, migrated_db) -> None:
        """Asl matn saqlanadi — model nima yozgani prompt tuning signali."""
        from bot.db import query_one
        from bot.publisher import apply_edit

        post_id = _seed_post(_seed_cluster("Claude Opus 5"), body="Asl matn")
        apply_edit(post_id, "Tuzatilgan matn")

        row = query_one("SELECT body, original_body FROM posts WHERE id = ?", (post_id,))
        assert row["body"] == "Tuzatilgan matn"
        assert row["original_body"] == "Asl matn"

    def test_second_edit_keeps_first_original(self, migrated_db) -> None:
        from bot.db import query_one
        from bot.publisher import apply_edit

        post_id = _seed_post(_seed_cluster("Claude Opus 5"), body="Asl matn")
        apply_edit(post_id, "Birinchi tahrir")
        apply_edit(post_id, "Ikkinchi tahrir")

        row = query_one("SELECT body, original_body FROM posts WHERE id = ?", (post_id,))
        assert row["body"] == "Ikkinchi tahrir"
        assert row["original_body"] == "Asl matn"


class TestChannelLink:
    def test_builds_link(self) -> None:
        from bot.publisher import channel_link

        link = channel_link(42)
        assert link == "" or link.endswith("/42")


class TestApprovalKeyboard:
    def test_has_three_buttons(self) -> None:
        from bot.publisher.telegram import approval_keyboard

        keyboard = approval_keyboard(7)
        buttons = keyboard.inline_keyboard[0]

        assert len(buttons) == 3
        assert all(str(b.callback_data).endswith(":7") for b in buttons)

    def test_callback_prefixes_distinct(self) -> None:
        from bot.publisher.telegram import CB_APPROVE, CB_EDIT, CB_REJECT

        assert len({CB_APPROVE, CB_EDIT, CB_REJECT}) == 3


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")
