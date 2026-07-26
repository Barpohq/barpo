"""Rank testlari: javob tekshiruvi, filtrlash qoidasi, oqim idempotentligi."""

from __future__ import annotations

from typing import Any

import pytest

from bot.rank.prompts import CATEGORIES, build_rank_prompt
from bot.rank.scorer import _clamp_score, _parse_results


class TestClampScore:
    def test_valid_score(self) -> None:
        assert _clamp_score(7, "importance", 1) == 7.0
        assert _clamp_score("8.5", "importance", 1) == 8.5

    def test_out_of_range_is_clamped(self) -> None:
        """Model 0 yoki 15 qaytarsa — chegaraga keltiriladi, tashlanmaydi."""
        assert _clamp_score(0, "importance", 1) == 1.0
        assert _clamp_score(15, "importance", 1) == 10.0

    @pytest.mark.parametrize("value", [None, "yuqori", {}, []])
    def test_non_numeric_is_rejected(self, value: Any) -> None:
        assert _clamp_score(value, "importance", 1) is None


class TestParseResults:
    def _entry(self, cluster_id: int, **kw: Any) -> dict[str, Any]:
        base = {
            "id": cluster_id,
            "importance": 7,
            "relevance": 8,
            "category": "model_release",
            "is_spam": False,
            "reason": "Muhim reliz.",
        }
        return {**base, **kw}

    def test_valid_payload(self) -> None:
        payload = {"results": [self._entry(1), self._entry(2)]}
        scores, problems = _parse_results(payload, {1, 2})

        assert set(scores) == {1, 2}
        assert not problems
        assert scores[1]["importance_score"] == 7.0
        assert scores[1]["category"] == "model_release"
        assert scores[1]["is_spam"] is False

    def test_unknown_category_falls_back_to_other(self) -> None:
        """Model o'ylab topgan kategoriya bazaga tushmasligi kerak."""
        payload = {"results": [self._entry(1, category="hallucinated")]}
        scores, _ = _parse_results(payload, {1})

        assert scores[1]["category"] == "other"

    def test_category_is_case_insensitive(self) -> None:
        payload = {"results": [self._entry(1, category="Model_Release")]}
        scores, _ = _parse_results(payload, {1})

        assert scores[1]["category"] == "model_release"

    def test_unexpected_id_is_dropped(self) -> None:
        """Model o'zi o'ylab topgan id boshqa klasterni buzmasligi kerak."""
        payload = {"results": [self._entry(1), self._entry(999)]}
        scores, problems = _parse_results(payload, {1})

        assert set(scores) == {1}
        assert any("999" in p for p in problems)

    def test_duplicate_id_keeps_first(self) -> None:
        payload = {"results": [self._entry(1, importance=9), self._entry(1, importance=2)]}
        scores, problems = _parse_results(payload, {1})

        assert scores[1]["importance_score"] == 9.0
        assert any("takrorlandi" in p for p in problems)

    def test_missing_id_reported(self) -> None:
        """Javobga tushmagan klaster xato sifatida qayd etiladi."""
        payload = {"results": [self._entry(1)]}
        scores, problems = _parse_results(payload, {1, 2, 3})

        assert set(scores) == {1}
        assert any("[2, 3]" in p for p in problems)

    def test_one_broken_entry_does_not_kill_batch(self) -> None:
        """Bitta buzuq element qolganlarini yo'qotmaydi."""
        payload = {
            "results": [
                self._entry(1),
                {"id": 2, "importance": "yaroqsiz"},
                self._entry(3),
            ]
        }
        scores, problems = _parse_results(payload, {1, 2, 3})

        assert set(scores) == {1, 3}
        assert problems

    @pytest.mark.parametrize(
        "payload",
        [
            [],
            "matn",
            {"natijalar": []},
            {"results": "ro'yxat emas"},
        ],
    )
    def test_malformed_payload(self, payload: Any) -> None:
        scores, problems = _parse_results(payload, {1})

        assert scores == {}
        assert problems

    def test_reason_is_truncated(self) -> None:
        payload = {"results": [self._entry(1, reason="a" * 900)]}
        scores, _ = _parse_results(payload, {1})

        assert len(scores[1]["rank_reason"]) == 500


class TestBuildPrompt:
    def _cluster(self, cluster_id: int = 1, **kw: Any) -> dict[str, Any]:
        base = {
            "id": cluster_id,
            "title": "Claude Opus 5 chiqdi",
            "content": "Anthropic yangi modelni e'lon qildi.",
            "sources": ["anthropic-blog", "hn"],
            "published_at": "2026-07-26T10:00:00+00:00",
        }
        return {**base, **kw}

    def test_includes_channel_context(self) -> None:
        channel = {
            "channel": {
                "audience": "Dasturchilar va IT mutaxassislari",
                "topics_of_interest": ["Yangi model relizlari"],
                "topics_to_avoid": ["Kripto loyihalari"],
            }
        }
        prompt = build_rank_prompt([self._cluster()], channel)

        assert "Dasturchilar va IT mutaxassislari" in prompt
        assert "Yangi model relizlari" in prompt
        assert "Kripto loyihalari" in prompt

    def test_includes_all_cluster_ids(self) -> None:
        clusters = [self._cluster(i) for i in (11, 22, 33)]
        prompt = build_rank_prompt(clusters, {})

        for cluster_id in (11, 22, 33):
            assert f"id: {cluster_id}" in prompt
        assert "3 ta" in prompt

    def test_long_content_is_truncated(self) -> None:
        """Rank arzon bosqich — to'liq matn promptga tushmaydi."""
        prompt = build_rank_prompt([self._cluster(content="so'z " * 5000)], {})

        assert len(prompt) < 4000
        assert "…" in prompt

    def test_source_count_is_signal(self) -> None:
        """Nechta manbada chiqqani modelga ko'rsatiladi."""
        prompt = build_rank_prompt([self._cluster(sources=["a", "b", "c"])], {})

        assert "manbalar (3)" in prompt

    def test_empty_channel_config(self) -> None:
        """channel.yaml bo'sh bo'lsa ham prompt quriladi."""
        prompt = build_rank_prompt([self._cluster()], {})

        assert "id: 1" in prompt
        for category in CATEGORIES:
            assert category in prompt


class TestRankFlow:
    """To'liq oqim — LLM javobi mock qilingan holda."""

    def _seed_cluster(self, title: str = "Yangilik") -> int:
        from bot.collector.base import CollectedItem, save_items
        from core.db import execute, query_one, utc_now

        save_items([CollectedItem(source="a", url=f"https://x.com/{title}", title=title)])
        item_id = query_one("SELECT id FROM items ORDER BY id DESC LIMIT 1")["id"]

        now = utc_now()
        cursor = execute(
            "INSERT INTO clusters (primary_item_id, title, created_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
            (item_id, title, now, now),
        )
        cluster_id = int(cursor.lastrowid)
        execute(
            "INSERT INTO cluster_items (cluster_id, item_id, is_primary) VALUES (?, ?, 1)",
            (cluster_id, item_id),
        )
        return cluster_id

    def _mock_llm(self, monkeypatch: pytest.MonkeyPatch, results: list[dict[str, Any]]) -> None:
        """LLMClient.complete ni tayyor javob bilan almashtirish."""
        import json

        from bot.llm.client import LLMResponse
        from bot.rank import scorer

        class FakeClient:
            def __init__(self, *a: Any, **kw: Any) -> None:
                pass

            def __enter__(self) -> FakeClient:
                return self

            def __exit__(self, *exc: object) -> None:
                pass

            def complete(self, stage: str, **kw: Any) -> LLMResponse:
                return LLMResponse(
                    text=json.dumps({"results": results}),
                    model="test-model",
                    requested_model="test-model",
                    prompt_tokens=100,
                    completion_tokens=50,
                    cost_usd=0.0001,
                    duration_ms=200,
                )

        monkeypatch.setattr(scorer, "LLMClient", FakeClient)

    def test_high_score_is_accepted(self, migrated_db, monkeypatch) -> None:
        from bot.rank import run_rank
        from core.db import query_one

        cluster_id = self._seed_cluster()
        self._mock_llm(
            monkeypatch,
            [
                {
                    "id": cluster_id,
                    "importance": 9,
                    "relevance": 9,
                    "category": "model_release",
                    "is_spam": False,
                    "reason": "Katta reliz.",
                }
            ],
        )

        report = run_rank()

        assert report.ranked == 1
        assert report.rejected == 0
        row = query_one("SELECT status, importance_score FROM clusters WHERE id = ?", (cluster_id,))
        assert row["status"] == "ranked"
        assert row["importance_score"] == 9.0

    def test_low_score_is_rejected(self, migrated_db, monkeypatch) -> None:
        """Chegaradan past baho — Writer'ga bormaydi."""
        from bot.rank import run_rank
        from core.db import query_one

        cluster_id = self._seed_cluster()
        self._mock_llm(
            monkeypatch,
            [
                {
                    "id": cluster_id,
                    "importance": 3,
                    "relevance": 4,
                    "category": "other",
                    "is_spam": False,
                    "reason": "Ahamiyatsiz.",
                }
            ],
        )

        report = run_rank()

        assert report.rejected == 1
        assert report.spam == 0
        assert query_one("SELECT status FROM clusters WHERE id = ?", (cluster_id,))["status"] == (
            "rejected"
        )

    def test_spam_is_rejected_despite_high_score(self, migrated_db, monkeypatch) -> None:
        """Spam belgisi yuqori bahodan ustun."""
        from bot.rank import run_rank
        from core.db import query_one

        cluster_id = self._seed_cluster()
        self._mock_llm(
            monkeypatch,
            [
                {
                    "id": cluster_id,
                    "importance": 9,
                    "relevance": 9,
                    "category": "business",
                    "is_spam": True,
                    "reason": "Reklama posti.",
                }
            ],
        )

        report = run_rank()

        assert report.rejected == 1
        assert report.spam == 1
        row = query_one("SELECT status, is_spam FROM clusters WHERE id = ?", (cluster_id,))
        assert row["status"] == "rejected"
        assert row["is_spam"] == 1

    def test_already_ranked_is_skipped(self, migrated_db, monkeypatch) -> None:
        """Idempotentlik: ikkinchi ishga tushishda qayta baholanmaydi."""
        from bot.rank import run_rank

        cluster_id = self._seed_cluster()
        self._mock_llm(
            monkeypatch,
            [
                {
                    "id": cluster_id,
                    "importance": 9,
                    "relevance": 9,
                    "category": "tool",
                    "is_spam": False,
                    "reason": "Foydali.",
                }
            ],
        )

        assert run_rank().processed == 1
        assert run_rank().processed == 0

    def test_dry_run_does_not_write(self, migrated_db, monkeypatch) -> None:
        from bot.rank import run_rank
        from core.db import query_one

        cluster_id = self._seed_cluster()
        self._mock_llm(
            monkeypatch,
            [
                {
                    "id": cluster_id,
                    "importance": 9,
                    "relevance": 9,
                    "category": "tool",
                    "is_spam": False,
                    "reason": "Foydali.",
                }
            ],
        )

        report = run_rank(dry_run=True)

        assert query_one("SELECT status FROM clusters WHERE id = ?", (cluster_id,))["status"] == (
            "new"
        )
        # Bazaga yozilmasa ham hisobot nima bo'lishini ko'rsatadi
        assert report.ranked == 1
        assert report.processed == 1

    def test_dry_run_counts_rejections(self, migrated_db, monkeypatch) -> None:
        from bot.rank import run_rank

        spam_id = self._seed_cluster("Reklama")
        low_id = self._seed_cluster("Kichik")

        self._mock_llm(
            monkeypatch,
            [
                {
                    "id": spam_id,
                    "importance": 9,
                    "relevance": 9,
                    "category": "other",
                    "is_spam": True,
                    "reason": "Reklama.",
                },
                {
                    "id": low_id,
                    "importance": 2,
                    "relevance": 3,
                    "category": "other",
                    "is_spam": False,
                    "reason": "Ahamiyatsiz.",
                },
            ],
        )

        report = run_rank(dry_run=True)

        assert report.rejected == 2
        assert report.spam == 1
        assert report.ranked == 0

    def test_llm_failure_leaves_cluster_new(self, migrated_db, monkeypatch) -> None:
        """LLM ishlamasa klaster `new` bo'lib qoladi — keyingi siklda qayta urinadi."""
        from bot.llm import LLMError
        from bot.rank import run_rank, scorer
        from core.db import query_one

        cluster_id = self._seed_cluster()

        class FailingClient:
            def __init__(self, *a: Any, **kw: Any) -> None:
                pass

            def __enter__(self) -> FailingClient:
                return self

            def __exit__(self, *exc: object) -> None:
                pass

            def complete(self, *a: Any, **kw: Any) -> None:
                raise LLMError("model ishlamadi")

        monkeypatch.setattr(scorer, "LLMClient", FailingClient)

        report = run_rank()

        assert report.failed == 1
        assert report.ranked == 0
        assert report.failed_batches
        assert query_one("SELECT status FROM clusters WHERE id = ?", (cluster_id,))["status"] == (
            "new"
        )

    def test_no_clusters_to_rank(self, migrated_db) -> None:
        from bot.rank import run_rank

        report = run_rank()
        assert report.processed == 0

    def test_ranked_clusters_queue(self, migrated_db, monkeypatch) -> None:
        """Writer navbati: qabul qilinganlar baho bo'yicha tartiblanadi."""
        from bot.rank import ranked_clusters, run_rank

        low_id = self._seed_cluster("Kichik yangilik")
        high_id = self._seed_cluster("Katta reliz")

        self._mock_llm(
            monkeypatch,
            [
                {
                    "id": low_id,
                    "importance": 6,
                    "relevance": 6,
                    "category": "tool",
                    "is_spam": False,
                    "reason": "O'rtacha.",
                },
                {
                    "id": high_id,
                    "importance": 10,
                    "relevance": 9,
                    "category": "model_release",
                    "is_spam": False,
                    "reason": "Katta reliz.",
                },
            ],
        )

        run_rank()
        queue = ranked_clusters()

        assert [c["id"] for c in queue] == [high_id, low_id]
