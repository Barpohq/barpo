"""Collector testlari: URL normalizatsiya, matn tozalash, saqlash."""

from __future__ import annotations

import pytest

from bot.collector.base import CollectedItem, clean_text, normalize_url, save_items, to_iso


class TestNormalizeUrl:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            # Kuzatuv parametrlari olib tashlanadi
            (
                "https://example.com/post?utm_source=twitter&utm_medium=social",
                "https://example.com/post",
            ),
            ("https://example.com/post?fbclid=abc123", "https://example.com/post"),
            ("https://example.com/post?ref=hn", "https://example.com/post"),
            # Foydali parametrlar saqlanadi
            ("https://example.com/p?id=42", "https://example.com/p?id=42"),
            # utm bilan foydali parametr aralash
            ("https://example.com/p?id=42&utm_source=x", "https://example.com/p?id=42"),
            # www va katta harf
            ("https://WWW.Example.COM/Post", "https://example.com/Post"),
            # oxiridagi slash
            ("https://example.com/post/", "https://example.com/post"),
            # fragment
            ("https://example.com/post#section-2", "https://example.com/post"),
            # standart port
            ("https://example.com:443/post", "https://example.com/post"),
            # parametrlar tartibi muhim emas
            ("https://example.com/p?b=2&a=1", "https://example.com/p?a=1&b=2"),
        ],
    )
    def test_normalization(self, raw: str, expected: str) -> None:
        assert normalize_url(raw) == expected

    def test_same_article_different_tracking_normalizes_equal(self) -> None:
        """Bir maqolaning turli kuzatuv havolalari bir xil normalizatsiyalanadi."""
        a = normalize_url("https://openai.com/blog/gpt?utm_source=twitter")
        b = normalize_url("https://www.openai.com/blog/gpt/?fbclid=xyz#top")
        assert a == b

    def test_different_articles_stay_different(self) -> None:
        assert normalize_url("https://x.com/a") != normalize_url("https://x.com/b")

    def test_empty_and_malformed(self) -> None:
        assert normalize_url("") == ""
        # Buzuq URL ham xato bermasligi kerak
        assert normalize_url("not a url") != ""


class TestCleanText:
    def test_strips_html_tags(self) -> None:
        assert clean_text("<p>Salom <b>dunyo</b></p>") == "Salom dunyo"

    def test_unescapes_entities(self) -> None:
        assert clean_text("A &amp; B &lt;test&gt;") == "A & B <test>"

    def test_collapses_whitespace(self) -> None:
        assert clean_text("ko'p    bo'shliq\n\nva\tqator") == "ko'p bo'shliq va qator"

    def test_handles_none_and_empty(self) -> None:
        assert clean_text(None) == ""
        assert clean_text("") == ""

    def test_preserves_uzbek_characters(self) -> None:
        """O'zbekcha diakritik belgilar buzilmasligi kerak."""
        text = "Sun'iy intellekt — o'zbek tilidagi qo'llanma. G'oya va so'zlar."
        assert clean_text(text) == text


class TestToIso:
    def test_iso_string(self) -> None:
        assert to_iso("2026-07-26T12:00:00Z") == "2026-07-26T12:00:00+00:00"

    def test_rfc822_string(self) -> None:
        result = to_iso("Sat, 26 Jul 2026 12:00:00 GMT")
        assert result is not None and result.startswith("2026-07-26T12:00:00")

    def test_unix_timestamp(self) -> None:
        result = to_iso(1785000000)
        assert result is not None and result.startswith("2026-")

    def test_struct_time(self) -> None:
        import time

        st = time.gmtime(1785000000)
        result = to_iso(st)
        assert result is not None and result.startswith("2026-")

    def test_invalid_returns_none(self) -> None:
        assert to_iso(None) is None
        assert to_iso("") is None
        assert to_iso("umuman sana emas") is None


class TestSaveItems:
    def _item(self, **kwargs) -> CollectedItem:
        defaults = {
            "source": "test-source",
            "url": "https://example.com/article",
            "title": "Sinov sarlavhasi",
        }
        return CollectedItem(**{**defaults, **kwargs})

    def test_inserts_new_item(self, migrated_db) -> None:
        result = save_items([self._item()])
        assert result.inserted == 1
        assert result.duplicates == 0

        from bot.db import query_one

        row = query_one("SELECT source, title, status, url_normalized FROM items")
        assert row["source"] == "test-source"
        assert row["status"] == "raw"
        assert row["url_normalized"] == "https://example.com/article"

    def test_duplicate_by_normalized_url(self, migrated_db) -> None:
        """Bir xil maqola turli kuzatuv havolalari bilan kelsa — bitta yozuv."""
        save_items([self._item(url="https://example.com/a?utm_source=x")])
        result = save_items([self._item(url="https://www.example.com/a/#top")])

        assert result.inserted == 0
        assert result.duplicates == 1

        from bot.db import query_one

        assert query_one("SELECT COUNT(*) c FROM items")["c"] == 1

    def test_same_url_different_source_both_saved(self, migrated_db) -> None:
        """Turli manbalardagi bir xil URL — ikkalasi ham saqlanadi (dedup keyin)."""
        save_items([self._item(source="a")])
        result = save_items([self._item(source="b")])

        assert result.inserted == 1
        from bot.db import query_one

        assert query_one("SELECT COUNT(*) c FROM items")["c"] == 2

    def test_invalid_items_skipped(self, migrated_db) -> None:
        result = save_items(
            [
                self._item(title=""),  # sarlavhasiz
                self._item(url=""),  # URL'siz
            ]
        )
        assert result.inserted == 0
        assert result.invalid == 2

    def test_extra_stored_as_json(self, migrated_db) -> None:
        save_items([self._item(extra={"points": 250, "num_comments": 42})])

        import json

        from bot.db import query_one

        row = query_one("SELECT extra FROM items")
        assert json.loads(row["extra"])["points"] == 250

    def test_html_in_title_cleaned_on_construction(self) -> None:
        item = self._item(title="<b>Qalin</b> sarlavha")
        assert item.title == "Qalin sarlavha"


class TestRssPublisher:
    """Agregator feed'idan haqiqiy nashriyotni ajratish.

    Google News RSS'da `link` — redirect havolasi (JavaScript orqali
    ochiladi, base64 id ichida URL yo'q). Haqiqiy nashriyot faqat
    `<source url="...">` tegida bo'ladi.
    """

    def _feed(self, item_xml: str) -> bytes:
        return f"""<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"><channel>
          <title>Test feed</title>
          {item_xml}
        </channel></rss>""".encode()

    def _collect(self, feed_bytes: bytes, monkeypatch: pytest.MonkeyPatch) -> list:
        """RSS adapterini tarmoqsiz ishga tushirish."""
        import httpx

        from bot.collector import rss
        from bot.config import Source

        def fake_get(self, url, **kw):  # noqa: ANN001, ARG001
            return httpx.Response(200, content=feed_bytes, request=httpx.Request("GET", url))

        monkeypatch.setattr(httpx.Client, "get", fake_get)
        source = Source(name="test", type="rss", options={"url": "https://example.com/feed"})
        return rss.collect(source)

    def test_extracts_publisher_from_source_tag(self, monkeypatch) -> None:
        feed = self._feed(
            """<item>
              <title>Introducing Claude Opus 5 - Anthropic</title>
              <link>https://news.google.com/rss/articles/CBMiabc?oc=5</link>
              <source url="https://www.anthropic.com">Anthropic</source>
            </item>"""
        )
        items = self._collect(feed, monkeypatch)

        assert len(items) == 1
        assert items[0].extra["publisher_url"] == "https://www.anthropic.com"
        assert items[0].extra["publisher_name"] == "Anthropic"
        # Asl havola saqlanadi — nashriyot alohida maydonda
        assert items[0].url.startswith("https://news.google.com/")

    def test_plain_feed_has_no_publisher(self, monkeypatch) -> None:
        """Oddiy rasmiy blog feed'ida `source` tegi yo'q — extra ham bo'sh."""
        feed = self._feed(
            """<item>
              <title>Yangi model</title>
              <link>https://openai.com/news/x</link>
            </item>"""
        )
        items = self._collect(feed, monkeypatch)

        assert "publisher_url" not in items[0].extra

    def test_publisher_flows_into_official_detection(self, migrated_db, monkeypatch) -> None:
        """Uchidan-uchiga: agregator orqali kelgan rasmiy e'lon tanilishi kerak."""
        import json

        from bot.collector.base import save_items
        from bot.db import query_one
        from bot.dedup.clustering import _is_official

        feed = self._feed(
            """<item>
              <title>Introducing Claude Opus 5 - Anthropic</title>
              <link>https://news.google.com/rss/articles/CBMiabc?oc=5</link>
              <source url="https://www.anthropic.com">Anthropic</source>
            </item>"""
        )
        items = self._collect(feed, monkeypatch)
        save_items(items)

        row = dict(query_one("SELECT url, extra FROM items"))
        assert json.loads(row["extra"])["publisher_url"] == "https://www.anthropic.com"
        assert _is_official(row)


class TestBackfillPublishers:
    """Eski agregator elementlariga nashriyotni keyinchalik qo'shish."""

    def _insert(self, external_id: str, extra: str | None = None) -> int:
        from bot.db import execute, utc_now

        cursor = execute(
            "INSERT INTO items (source, external_id, url, url_normalized, title, "
            "fetched_at, status, extra) VALUES (?, ?, ?, ?, ?, ?, 'raw', ?)",
            (
                "anthropic-news",
                external_id,
                f"https://news.google.com/rss/articles/{external_id}",
                f"https://news.google.com/rss/articles/{external_id}",
                "Test sarlavha",
                utc_now(),
                extra,
            ),
        )
        return int(cursor.lastrowid)

    def _patch_feed(self, monkeypatch: pytest.MonkeyPatch, mapping: dict) -> None:
        from bot.collector import backfill
        from bot.config import Source

        monkeypatch.setattr(
            backfill,
            "_aggregator_sources",
            lambda: [
                Source(
                    name="anthropic-news",
                    type="rss",
                    options={"url": "https://news.google.com/rss/search?q=x"},
                )
            ],
        )
        monkeypatch.setattr(backfill, "_guid_to_publisher", lambda source: mapping)

    def test_fills_missing_publisher(self, migrated_db, monkeypatch) -> None:
        import json

        from bot.collector.backfill import backfill_publishers
        from bot.db import query_one

        item_id = self._insert("GUID1")
        self._patch_feed(monkeypatch, {"GUID1": ("https://www.anthropic.com", "Anthropic")})

        report = backfill_publishers()

        assert report.updated == 1
        extra = json.loads(query_one("SELECT extra FROM items WHERE id = ?", (item_id,))["extra"])
        assert extra["publisher_url"] == "https://www.anthropic.com"
        assert extra["publisher_name"] == "Anthropic"

    def test_preserves_existing_extra_fields(self, migrated_db, monkeypatch) -> None:
        """Mavjud extra maydonlari yo'qolmasligi kerak."""
        import json

        from bot.collector.backfill import backfill_publishers
        from bot.db import query_one

        item_id = self._insert("GUID1", extra=json.dumps({"feed_title": "Eski qiymat"}))
        self._patch_feed(monkeypatch, {"GUID1": ("https://www.anthropic.com", "Anthropic")})

        backfill_publishers()

        extra = json.loads(query_one("SELECT extra FROM items WHERE id = ?", (item_id,))["extra"])
        assert extra["feed_title"] == "Eski qiymat"
        assert extra["publisher_url"] == "https://www.anthropic.com"

    def test_item_not_in_feed_is_left_alone(self, migrated_db, monkeypatch) -> None:
        """Feed oynasidan eski element o'zgarmaydi — url ga fallback qiladi."""
        from bot.collector.backfill import backfill_publishers
        from bot.db import query_one

        item_id = self._insert("ESKI")
        self._patch_feed(monkeypatch, {"BOSHQA": ("https://x.dev", "X")})

        report = backfill_publishers()

        assert report.not_found == 1
        assert report.updated == 0
        assert query_one("SELECT extra FROM items WHERE id = ?", (item_id,))["extra"] is None

    def test_already_filled_is_not_candidate(self, migrated_db, monkeypatch) -> None:
        """Ikkinchi marta ishga tushirish ortiqcha ish qilmaydi (idempotent)."""
        import json

        from bot.collector.backfill import backfill_publishers

        self._insert("GUID1", extra=json.dumps({"publisher_url": "https://www.anthropic.com"}))
        self._patch_feed(monkeypatch, {"GUID1": ("https://www.anthropic.com", "Anthropic")})

        report = backfill_publishers()

        assert report.candidates == 0
        assert report.updated == 0

    def test_feed_failure_does_not_crash(self, migrated_db, monkeypatch) -> None:
        """Feed o'qilmasa backfill xato bermay, hisobotda qayd etadi."""
        from bot.collector import backfill
        from bot.config import Source

        self._insert("GUID1")

        def boom(source):  # noqa: ANN001, ARG001
            raise RuntimeError("tarmoq yo'q")

        monkeypatch.setattr(
            backfill,
            "_aggregator_sources",
            lambda: [Source(name="anthropic-news", type="rss", options={"url": "https://x/y"})],
        )
        monkeypatch.setattr(backfill, "_guid_to_publisher", boom)

        report = backfill.backfill_publishers()

        assert report.failed_sources == ["anthropic-news"]
        assert report.updated == 0
