"""Dedup testlari: sarlavha normalizatsiya, asosiy element tanlash, klasterlash."""

from __future__ import annotations

import json

import numpy as np
import pytest

from bot.dedup.clustering import (
    _is_official,
    _normalize_title,
    _pick_primary,
    publisher_url,
)


class TestNormalizeTitle:
    def test_strips_source_suffix(self) -> None:
        """Google News uslubidagi ' - Manba' qo'shimchasi olib tashlanadi."""
        assert _normalize_title("Introducing Claude Opus 5 - Anthropic") == (
            "introducing claude opus 5"
        )
        assert _normalize_title("AI news | TechCrunch") == "ai news"

    def test_keeps_long_tail(self) -> None:
        """Uzun qism manba nomi emas — saqlanadi."""
        title = "Model released - and here is why it matters for developers everywhere"
        assert _normalize_title(title) == title.lower()

    def test_collapses_whitespace_and_case(self) -> None:
        assert _normalize_title("  Big   NEWS  ") == "big news"


class TestIsOfficial:
    @pytest.mark.parametrize(
        "url",
        [
            "https://www.anthropic.com/news/claude-opus-5",
            "https://openai.com/index/gpt/",
            "https://deepmind.google/discover/blog/x",
            "https://huggingface.co/blog/y",
        ],
    )
    def test_official_domains(self, url: str) -> None:
        assert _is_official({"url": url})

    @pytest.mark.parametrize(
        "url",
        [
            "https://news.google.com/rss/articles/CBMiabc",
            "https://the-decoder.com/claude-opus-5/",
            "https://techcrunch.com/2026/07/26/anthropic/",
        ],
    )
    def test_non_official(self, url: str) -> None:
        assert not _is_official({"url": url})

    def test_missing_url(self) -> None:
        assert not _is_official({})

    def test_aggregator_link_with_official_publisher(self) -> None:
        """Google News havolasi ortidagi rasmiy nashriyot tanilishi kerak.

        Aks holda rasmiy blog e'loni qayta hikoya bilan teng ko'rinadi va
        klasterda asosiy element noto'g'ri tanlanadi.
        """
        item = {
            "url": "https://news.google.com/rss/articles/CBMiabc?oc=5",
            "extra": json.dumps({"publisher_url": "https://www.anthropic.com"}),
        }
        assert _is_official(item)

    def test_aggregator_link_with_non_official_publisher(self) -> None:
        item = {
            "url": "https://news.google.com/rss/articles/CBMiabc?oc=5",
            "extra": json.dumps({"publisher_url": "https://techcrunch.com"}),
        }
        assert not _is_official(item)


class TestPublisherUrl:
    def test_prefers_publisher_over_aggregator_link(self) -> None:
        item = {
            "url": "https://news.google.com/rss/articles/CBMiabc",
            "extra": json.dumps({"publisher_url": "https://www.anthropic.com"}),
        }
        assert publisher_url(item) == "https://www.anthropic.com"

    def test_falls_back_to_url(self) -> None:
        """Oddiy RSS manbada publisher_url yo'q — url o'zi ishlatiladi."""
        item = {"url": "https://openai.com/news/x", "extra": None}
        assert publisher_url(item) == "https://openai.com/news/x"

    def test_accepts_dict_extra(self) -> None:
        """extra bazadan JSON matn, kod ichida dict bo'lishi mumkin."""
        item = {"url": "https://news.google.com/x", "extra": {"publisher_url": "https://x.dev"}}
        assert publisher_url(item) == "https://x.dev"

    @pytest.mark.parametrize("extra", ["{buzuq json", "", "null", "[]"])
    def test_malformed_extra_falls_back(self, extra: str) -> None:
        """Buzuq extra dedup'ni yiqitmasligi kerak."""
        item = {"url": "https://openai.com/x", "extra": extra}
        assert publisher_url(item) == "https://openai.com/x"

    def test_missing_everything(self) -> None:
        assert publisher_url({}) == ""


class TestPickPrimary:
    def _item(self, **kw):
        base = {
            "id": 1,
            "source": "s",
            "title": "T",
            "url": "https://news.google.com/x",
            "content": "",
            "published_at": "2026-07-26T10:00:00+00:00",
            "fetched_at": "2026-07-26T10:00:00+00:00",
        }
        return {**base, **kw}

    def test_official_source_wins(self) -> None:
        """Rasmiy manba uzunroq matnli qayta hikoyadan ustun."""
        official = self._item(id=1, url="https://www.anthropic.com/news/x", content="qisqa")
        aggregator = self._item(id=2, url="https://news.google.com/y", content="juda " * 200)

        assert _pick_primary([aggregator, official], {})["id"] == 1

    def test_official_wins_through_aggregator_link(self) -> None:
        """Google News orqali kelgan rasmiy e'lon qayta hikoyadan ustun.

        Bu real holat: anthropic-news manbasi Google News RSS ishlatadi,
        shuning uchun rasmiy blog posti ham agregator havolasi bilan keladi.
        """
        official_via_gnews = self._item(
            id=1,
            url="https://news.google.com/rss/articles/CBMiabc",
            extra=json.dumps({"publisher_url": "https://www.anthropic.com"}),
            content="qisqa",
        )
        rewrite = self._item(
            id=2,
            url="https://news.google.com/rss/articles/CBMixyz",
            extra=json.dumps({"publisher_url": "https://techcrunch.com"}),
            content="juda " * 200,
        )

        assert _pick_primary([rewrite, official_via_gnews], {})["id"] == 1

    def test_source_weight_breaks_tie(self) -> None:
        """Ikkalasi ham norasmiy bo'lsa — manba weight hal qiladi."""
        low = self._item(id=1, source="reddit")
        high = self._item(id=2, source="openai-blog")

        weights = {"reddit": 0.4, "openai-blog": 1.0}
        assert _pick_primary([low, high], weights)["id"] == 2

    def test_longer_content_breaks_tie(self) -> None:
        short = self._item(id=1, content="oz")
        long = self._item(id=2, content="uzun " * 100)

        assert _pick_primary([short, long], {})["id"] == 2

    def test_earlier_publication_breaks_tie(self) -> None:
        """Teng sharoitda eskiroq nashr — original manba."""
        later = self._item(id=1, published_at="2026-07-26T15:00:00+00:00")
        earlier = self._item(id=2, published_at="2026-07-26T09:00:00+00:00")

        assert _pick_primary([later, earlier], {})["id"] == 2


class TestClusteringIntegration:
    """Klasterlash oqimi — embedding mock qilingan holda."""

    def test_version_conflict_prevents_merge(self, migrated_db, monkeypatch) -> None:
        """Opus 5 va Opus 4.7 bir klasterga tushmasligi kerak.

        Embedding shunday mock qilinganki, ikkala element ham deyarli bir xil
        vektor oladi (real hayotdagidek 0.91 similarity) — faqat versiya
        tekshiruvi ularni ajratishi mumkin.
        """
        from bot.collector.base import CollectedItem, save_items
        from bot.dedup import clustering

        save_items(
            [
                CollectedItem(
                    source="a", url="https://x.com/1", title="Introducing Claude Opus 5"
                ),
                CollectedItem(
                    source="a", url="https://x.com/2", title="Claude Opus 4.7 benchmarks"
                ),
            ]
        )

        # Ikkala element uchun bir xil vektor → similarity = 1.0
        same_vector = np.ones(8, dtype=np.float32) / np.sqrt(8)
        monkeypatch.setattr(
            clustering,
            "embed_items",
            lambda items: {int(i["id"]): same_vector for i in items},
        )

        report = clustering.run_dedup(window_days=7)

        # Versiya konflikti tufayli 2 ta alohida klaster
        assert report.new_clusters == 2

    def test_same_version_merges(self, migrated_db, monkeypatch) -> None:
        """Bir xil reliz haqidagi ikki maqola bitta klasterga birlashadi."""
        from bot.collector.base import CollectedItem, save_items
        from bot.dedup import clustering

        save_items(
            [
                CollectedItem(
                    source="a", url="https://x.com/1", title="Introducing Claude Opus 5"
                ),
                CollectedItem(
                    source="b", url="https://y.com/2", title="Anthropic launches Claude Opus 5"
                ),
            ]
        )

        same_vector = np.ones(8, dtype=np.float32) / np.sqrt(8)
        monkeypatch.setattr(
            clustering,
            "embed_items",
            lambda items: {int(i["id"]): same_vector for i in items},
        )

        report = clustering.run_dedup(window_days=7)
        assert report.new_clusters == 1

        from core.db import query_one

        assert query_one("SELECT item_count FROM clusters")["item_count"] == 2

    def test_items_marked_clustered(self, migrated_db, monkeypatch) -> None:
        from bot.collector.base import CollectedItem, save_items
        from bot.dedup import clustering

        save_items([CollectedItem(source="a", url="https://x.com/1", title="Yangilik")])
        monkeypatch.setattr(
            clustering,
            "embed_items",
            lambda items: {int(i["id"]): np.ones(8, dtype=np.float32) for i in items},
        )

        clustering.run_dedup()

        from core.db import query_one

        assert query_one("SELECT status FROM items")["status"] == "clustered"

    def test_no_pending_items(self, migrated_db) -> None:
        from bot.dedup import clustering

        report = clustering.run_dedup()
        assert report.processed == 0
        assert report.new_clusters == 0
