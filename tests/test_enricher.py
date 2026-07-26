"""Enricher testlari: matn ajratish, qidiruv, oqim va fallback mantiqi."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from bot.enricher.enrich import _needs_search, _pick_search_result, _title_matches
from bot.enricher.fetcher import MAX_TEXT_LENGTH, _meta_content, extract_text
from bot.enricher.search import SearchResult

# Qidiruv natijasi matni — tozalashdan o'tishi uchun yetarlicha uzun
# (clean_markdown 80+ belgili qatorlarni oladi, natija 200+ bo'lishi kerak)
SEARCH_TEXT = (
    "Anthropic kompaniyasi yangi modelni rasman e'lon qildi va u avvalgi "
    "avlodga qaraganda sezilarli darajada tezroq hamda arzonroq ishlaydi. "
    "Reliz sohada katta qiziqish uyg'otdi va dasturchilar uni sinab ko'rmoqda."
)


class TestExtractText:
    def test_extracts_paragraphs(self) -> None:
        html = """
        <html><body>
          <p>Bu yetarlicha uzun birinchi paragraf bo'lib, maqolaning asosiy
             mazmunini ochib beradi va matn sifatida hisobga olinadi.</p>
          <p>Ikkinchi paragraf ham xuddi shunday uzun va mazmunli bo'lgani
             uchun natijaga kiritilishi kerak, chunki chegaradan uzun.</p>
        </body></html>
        """
        text = extract_text(html)

        assert "birinchi paragraf" in text
        assert "Ikkinchi paragraf" in text

    def test_drops_scripts_and_styles(self) -> None:
        """Skript ichidagi matn hech qachon natijaga tushmasligi kerak."""
        html = """
        <html><body>
          <script>
            var x = "bu juda uzun skript matni bo'lib natijaga tushmasligi kerak aslida";
          </script>
          <style>
            .cls { content: "uzun stil matni ham natijaga tushmasligi kerak albatta"; }
          </style>
          <p>Bu esa haqiqiy maqola matni bo'lib, yetarlicha uzun va mazmunli
             bo'lgani uchun natijada ko'rinishi kerak.</p>
        </body></html>
        """
        text = extract_text(html)

        assert "haqiqiy maqola matni" in text
        assert "skript matni" not in text
        assert "stil matni" not in text

    def test_drops_navigation_blocks(self) -> None:
        html = """
        <html><body>
          <nav>Bosh sahifa Mahsulotlar Narxlar Aloqa Blog Hujjatlar Kirish</nav>
          <footer>Barcha huquqlar himoyalangan. Maxfiylik siyosati. Foydalanish shartlari.</footer>
          <p>Maqolaning haqiqiy matni shu yerda joylashgan va u yetarlicha
             uzun bo'lgani uchun ajratib olinadi.</p>
        </body></html>
        """
        text = extract_text(html)

        assert "haqiqiy matni" in text
        assert "Maxfiylik siyosati" not in text

    def test_short_fragments_are_dropped(self) -> None:
        """Menyu va tugma matnlari qisqa — tabiiy ravishda tushib qoladi."""
        html = "<body><div>Kirish</div><div>Ro'yxatdan o'tish</div></body>"

        assert extract_text(html) == ""

    def test_deduplicates_repeated_blocks(self) -> None:
        """Bir xil blok bir necha marta uchrasa — bir marta olinadi."""
        para = (
            "<p>Takrorlanuvchi blok matni yetarlicha uzun bo'lib, sahifada "
            "bir necha marta uchraydi va faqat bir marta olinishi kerak.</p>"
        )
        text = extract_text(f"<body>{para}{para}{para}</body>")

        assert text.count("Takrorlanuvchi blok") == 1

    def test_respects_max_length(self) -> None:
        long_para = "<p>" + ("juda uzun matn " * 1000) + "</p>"
        text = extract_text(f"<body>{long_para}</body>")

        assert len(text) <= MAX_TEXT_LENGTH

    def test_empty_input(self) -> None:
        assert extract_text("") == ""
        assert extract_text("<html><body></body></html>") == ""

    def test_preserves_uzbek_characters(self) -> None:
        html = (
            "<p>Sun'iy intellekt sohasidagi o'zgarishlar haqida ma'lumot. "
            "G'oyalar va so'zlar buzilmasligi kerak, diakritika saqlanadi.</p>"
        )
        text = extract_text(html)

        assert "Sun'iy intellekt" in text
        assert "G'oyalar" in text


class TestCleanMarkdown:
    """Tavily'ning markdown matnini tozalash.

    Search yo'li bilan kelgan matn sahifaning to'liq nusxasi — menyu,
    "Skip to content" va havolalar ro'yxati bilan.
    """

    def test_strips_navigation_links(self) -> None:
        from bot.enricher.fetcher import clean_markdown

        raw = (
            "[Skip to content](#main)   [Artificial Intelligence](https://gizmodo.com/tech/ai)\n"
            "# Anthropic Releases New Claude Model\n"
            "Anthropic bugun Claude Opus 5 modelini e'lon qildi va u avvalgi "
            "avlodga qaraganda sezilarli darajada tezroq ishlaydi."
        )
        text = clean_markdown(raw)

        assert "Skip to content" not in text
        assert "Claude Opus 5 modelini" in text

    def test_unwraps_link_text(self) -> None:
        """Havola matni saqlanadi, URL olib tashlanadi."""
        from bot.enricher.fetcher import clean_markdown

        raw = (
            "Kompaniya [Claude Opus 5](https://anthropic.com/news) modelini taqdim etdi "
            "va bu reliz sohada katta qiziqish uyg'otdi, chunki narx ikki barobar past."
        )
        text = clean_markdown(raw)

        assert "Claude Opus 5" in text
        assert "https://anthropic.com" not in text

    def test_drops_short_menu_lines(self) -> None:
        from bot.enricher.fetcher import clean_markdown

        raw = "* Apps\n* AI\n* Claude\n* Guides\n"
        assert clean_markdown(raw) == ""

    def test_deduplicates(self) -> None:
        from bot.enricher.fetcher import clean_markdown

        para = (
            "Anthropic yangi modelni e'lon qildi va u avvalgi avlodga qaraganda "
            "ancha tezroq hamda arzonroq ishlaydi deb ta'kidlanmoqda.\n"
        )
        text = clean_markdown(para * 3)

        assert text.count("Anthropic yangi modelni") == 1

    def test_respects_max_length(self) -> None:
        from bot.enricher.fetcher import MAX_TEXT_LENGTH, clean_markdown

        raw = ("Juda uzun matn qatori bo'lib yetarlicha uzunlikka ega ekanligi aniq. " * 300)
        assert len(clean_markdown(raw)) <= MAX_TEXT_LENGTH

    def test_empty(self) -> None:
        from bot.enricher.fetcher import clean_markdown

        assert clean_markdown("") == ""


class TestMetaContent:
    def test_reads_og_title(self) -> None:
        html = '<meta property="og:title" content="Claude Opus 5 chiqdi">'
        assert _meta_content(html, "og:title") == "Claude Opus 5 chiqdi"

    def test_falls_back_to_second_key(self) -> None:
        html = '<meta name="twitter:image" content="https://x.dev/rasm.png">'
        assert _meta_content(html, "og:image", "twitter:image") == "https://x.dev/rasm.png"

    def test_missing_returns_empty(self) -> None:
        assert _meta_content("<html></html>", "og:title") == ""

    def test_unescapes_entities(self) -> None:
        html = '<meta property="og:title" content="A &amp; B">'
        assert _meta_content(html, "og:title") == "A & B"


class TestNeedsSearch:
    def test_aggregator_url_needs_search(self) -> None:
        cluster = {"url": "https://news.google.com/rss/articles/CBMiabc"}
        assert _needs_search(cluster)

    def test_direct_url_does_not(self) -> None:
        assert not _needs_search({"url": "https://openai.com/index/gpt"})

    def test_missing_url(self) -> None:
        assert not _needs_search({})


class TestTitleMatches:
    """Qidiruv natijasi haqiqatan shu yangilik haqidami."""

    def test_same_article(self) -> None:
        assert _title_matches(
            "Anthropic launches Claude Opus 5 with efficiency improvements",
            "Anthropic launches Claude Opus 5 with efficiency improvements - SiliconANGLE",
        )

    def test_reworded_same_article(self) -> None:
        assert _title_matches("Claude Opus 5", "Introducing Claude Opus 5")

    def test_different_topic_rejected(self) -> None:
        assert not _title_matches(
            "GPT-5.6: Frontier intelligence that scales with your ambition",
            "David Velez and Robin Vince join the boards",
        )

    def test_sibling_model_rejected(self) -> None:
        """Real holat: 'Claude Opus 5' so'roviga Sonnet 5 sahifasi kelgan.

        Tavily uni 0.604 ball bergan — ballga tayanib qolsak, Opus posti
        Sonnet matni bilan yozilardi.
        """
        assert not _title_matches("Claude Opus 5", "Introducing Claude Sonnet 5 - Anthropic")

    def test_older_version_rejected(self) -> None:
        assert not _title_matches("Claude Opus 5", "Claude Opus 4.7 benchmarks and how to try it")


class TestPickSearchResult:
    def _result(self, **kw: Any) -> SearchResult:
        base = {
            "title": "Introducing Claude Opus 5",
            "url": "https://www.anthropic.com/news/claude-opus-5",
            "content": "Qisqacha mazmun",
            "raw_content": "To'liq maqola matni",
            "score": 0.9,
        }
        return SearchResult(**{**base, **kw})

    def _cluster(self, title: str = "Claude Opus 5") -> dict[str, Any]:
        return {"id": 1, "title": title}

    def test_picks_first_good_result(self) -> None:
        results = [self._result(score=0.9), self._result(score=0.8)]
        chosen = _pick_search_result(results, self._cluster())

        assert chosen is not None
        assert chosen.score == 0.9

    def test_skips_low_score(self) -> None:
        """Past balli natija boshqa maqola bo'lishi mumkin."""
        results = [self._result(score=0.2), self._result(score=0.7)]
        chosen = _pick_search_result(results, self._cluster())

        assert chosen is not None
        assert chosen.score == 0.7

    def test_skips_empty_text(self) -> None:
        results = [
            self._result(score=0.9, content="", raw_content=""),
            self._result(score=0.6),
        ]
        chosen = _pick_search_result(results, self._cluster())

        assert chosen is not None
        assert chosen.score == 0.6

    def test_skips_wrong_article_despite_high_score(self) -> None:
        """Yuqori ball ham noto'g'ri maqolani o'tkazmasligi kerak."""
        results = [
            self._result(score=0.95, title="Introducing Claude Sonnet 5 - Anthropic"),
            self._result(score=0.6, title="Introducing Claude Opus 5"),
        ]
        chosen = _pick_search_result(results, self._cluster("Claude Opus 5"))

        assert chosen is not None
        assert chosen.title == "Introducing Claude Opus 5"

    def test_aggregator_suffix_ignored_in_comparison(self) -> None:
        """Klaster sarlavhasidagi ' - Nashriyot' taqqoslashga xalaqit bermasin."""
        results = [self._result(title="Anthropic launches Claude Opus 5")]
        cluster = self._cluster("Anthropic launches Claude Opus 5 - SiliconANGLE")

        assert _pick_search_result(results, cluster) is not None

    def test_all_bad_returns_none(self) -> None:
        assert _pick_search_result([self._result(score=0.1)], self._cluster()) is None

    def test_empty_list(self) -> None:
        assert _pick_search_result([], self._cluster()) is None

    def test_no_cluster_title_skips_check(self) -> None:
        """Sarlavha yo'q bo'lsa faqat ballga tayanamiz."""
        assert _pick_search_result([self._result()], {"id": 1, "title": ""}) is not None


class TestSearchResultText:
    def test_prefers_raw_content(self) -> None:
        result = SearchResult(
            title="T", url="https://x.dev", content="qisqa", raw_content="to'liq matn"
        )
        assert result.best_text == "to'liq matn"

    def test_falls_back_to_content(self) -> None:
        result = SearchResult(title="T", url="https://x.dev", content="qisqa", raw_content="")
        assert result.best_text == "qisqa"


class TestSearchClient:
    """Tavily klienti — HTTP mock bilan."""

    def _client(self, monkeypatch: pytest.MonkeyPatch, response: httpx.Response):
        from bot.enricher import search as search_mod

        monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")

        def fake_post(self, url, **kw):  # noqa: ANN001, ARG001
            return response

        monkeypatch.setattr(httpx.Client, "post", fake_post)
        return search_mod.SearchClient()

    def test_parses_results(self, monkeypatch) -> None:
        payload = {
            "results": [
                {
                    "title": "Claude Opus 5",
                    "url": "https://www.anthropic.com/news/x",
                    "content": "qisqacha",
                    "raw_content": "to'liq matn",
                    "score": 0.95,
                }
            ]
        }
        client = self._client(monkeypatch, httpx.Response(200, json=payload))
        results = client.search("Claude Opus 5")

        assert len(results) == 1
        assert results[0].url == "https://www.anthropic.com/news/x"
        assert results[0].best_text == "to'liq matn"
        assert results[0].score == 0.95

    def test_skips_entries_without_url(self, monkeypatch) -> None:
        payload = {"results": [{"title": "URL yo'q"}, {"url": "https://x.dev", "score": 0.8}]}
        client = self._client(monkeypatch, httpx.Response(200, json=payload))

        assert len(client.search("test")) == 1

    def test_missing_key_raises_unavailable(self, monkeypatch) -> None:
        from bot.enricher.search import SearchClient, SearchUnavailable

        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
        with pytest.raises(SearchUnavailable):
            SearchClient()

    @pytest.mark.parametrize("status", [401, 432, 433])
    def test_limit_errors_are_unavailable(self, monkeypatch, status: int) -> None:
        """Limit tugashi va kalit xatosi — qidiruvsiz davom etish signali."""
        from bot.enricher.search import SearchUnavailable

        client = self._client(monkeypatch, httpx.Response(status, text="limit"))
        with pytest.raises(SearchUnavailable):
            client.search("test")

    @pytest.mark.parametrize("status", [429, 500, 503])
    def test_temporary_errors_are_search_error(self, monkeypatch, status: int) -> None:
        from bot.enricher.search import SearchError

        client = self._client(monkeypatch, httpx.Response(status, text="xato"))
        with pytest.raises(SearchError):
            client.search("test")

    def test_malformed_json(self, monkeypatch) -> None:
        from bot.enricher.search import SearchError

        client = self._client(monkeypatch, httpx.Response(200, text="JSON emas"))
        with pytest.raises(SearchError):
            client.search("test")


class TestEnrichFlow:
    """To'liq oqim — fetch va search mock qilingan holda."""

    def _seed(self, url: str, title: str = "Sinov yangiligi", extra: str | None = None) -> int:
        from bot.db import execute, utc_now

        now = utc_now()
        cursor = execute(
            "INSERT INTO items (source, url, url_normalized, title, content, "
            "fetched_at, status, extra) VALUES (?, ?, ?, ?, ?, ?, 'clustered', ?)",
            ("test", url, url, title, "qisqa feed matni", now, extra),
        )
        item_id = int(cursor.lastrowid)

        cursor = execute(
            "INSERT INTO clusters (primary_item_id, title, created_at, updated_at, "
            "status, importance_score, relevance_score) "
            "VALUES (?, ?, ?, ?, 'ranked', 9, 9)",
            (item_id, title, now, now),
        )
        cluster_id = int(cursor.lastrowid)
        execute(
            "INSERT INTO cluster_items (cluster_id, item_id, is_primary) VALUES (?, ?, 1)",
            (cluster_id, item_id),
        )
        return cluster_id

    def _patch_fetch(self, monkeypatch: pytest.MonkeyPatch, text: str | None) -> None:
        """fetch_article ni mock qilish. text=None → FetchError."""
        from bot.enricher import enrich as enrich_mod
        from bot.enricher.fetcher import Article, FetchError

        def fake_fetch(url: str, **kw: Any) -> Article:
            if text is None:
                raise FetchError("mock: 403")
            return Article(url=url, text=text, title="T", image_url="https://x.dev/i.png")

        monkeypatch.setattr(enrich_mod, "fetch_article", fake_fetch)

    def _patch_search(self, monkeypatch: pytest.MonkeyPatch, results: list[SearchResult]) -> None:
        from bot.enricher import enrich as enrich_mod

        class FakeSearch:
            def __init__(self, *a: Any, **kw: Any) -> None:
                pass

            def search(self, query: str, **kw: Any) -> list[SearchResult]:
                return results

            def close(self) -> None:
                pass

        monkeypatch.setattr(enrich_mod, "SearchClient", FakeSearch)
        monkeypatch.setattr(enrich_mod, "is_configured", lambda: True)

    def test_fetch_path(self, migrated_db, monkeypatch) -> None:
        from bot.db import query_one
        from bot.enricher import run_enrich

        cluster_id = self._seed("https://openai.com/index/gpt")
        self._patch_fetch(monkeypatch, "To'liq maqola matni " * 20)

        report = run_enrich(use_search=False)

        assert report.by_fetch == 1
        row = query_one(
            "SELECT enriched_text, enrich_source, article_url FROM clusters WHERE id = ?",
            (cluster_id,),
        )
        assert row["enrich_source"] == "fetch"
        assert "To'liq maqola matni" in row["enriched_text"]

    def test_aggregator_uses_search(self, migrated_db, monkeypatch) -> None:
        from bot.db import query_one
        from bot.enricher import run_enrich

        cluster_id = self._seed(
            "https://news.google.com/rss/articles/CBMiabc",
            title="Anthropic launches Claude Opus 5 - SiliconANGLE",
            extra=json.dumps({"publisher_url": "https://siliconangle.com"}),
        )
        self._patch_search(
            monkeypatch,
            [
                SearchResult(
                    title="Anthropic launches Claude Opus 5",
                    url="https://siliconangle.com/2026/07/26/opus-5",
                    content="qisqa",
                    raw_content=SEARCH_TEXT,
                    score=0.9,
                )
            ],
        )

        report = run_enrich()

        assert report.by_search == 1
        row = query_one(
            "SELECT enriched_text, enrich_source, article_url FROM clusters WHERE id = ?",
            (cluster_id,),
        )
        assert row["enrich_source"] == "search"
        assert row["article_url"] == "https://siliconangle.com/2026/07/26/opus-5"
        assert "Anthropic kompaniyasi" in row["enriched_text"]

    def test_fetch_failure_falls_back_to_search(self, migrated_db, monkeypatch) -> None:
        """403 bergan sayt (OpenAI kabi) qidiruv orqali boyitiladi."""
        from bot.db import query_one
        from bot.enricher import run_enrich

        cluster_id = self._seed("https://openai.com/index/gpt-5-6", title="GPT-5.6 released")
        self._patch_fetch(monkeypatch, None)  # FetchError
        self._patch_search(
            monkeypatch,
            [
                SearchResult(
                    title="GPT-5.6 released",
                    url="https://openai.com/index/gpt-5-6",
                    content="",
                    raw_content=SEARCH_TEXT,
                    score=0.9,
                )
            ],
        )

        report = run_enrich()

        assert report.by_search == 1
        assert report.by_fetch == 0
        row = query_one("SELECT enrich_source FROM clusters WHERE id = ?", (cluster_id,))
        assert row["enrich_source"] == "search"

    def test_wrong_article_is_not_saved(self, migrated_db, monkeypatch) -> None:
        """Qidiruv boshqa maqolani qaytarsa — boyitmagan yaxshiroq.

        Noto'g'ri matn bilan post yozilsa kanalda xato yangilik chiqadi.
        """
        from bot.db import query_one
        from bot.enricher import run_enrich

        cluster_id = self._seed(
            "https://news.google.com/rss/articles/CBMiabc", title="Claude Opus 5"
        )
        self._patch_search(
            monkeypatch,
            [
                SearchResult(
                    title="Introducing Claude Sonnet 5 - Anthropic",
                    url="https://www.anthropic.com/news/claude-sonnet-5",
                    content="",
                    raw_content=SEARCH_TEXT,
                    score=0.95,
                )
            ],
        )

        report = run_enrich()

        assert report.failed == 1
        assert report.by_search == 0
        row = query_one(
            "SELECT enriched_text, enrich_source FROM clusters WHERE id = ?", (cluster_id,)
        )
        assert row["enrich_source"] == "none"
        assert row["enriched_text"] is None

    def test_short_text_is_not_useful(self, migrated_db, monkeypatch) -> None:
        """Sahifadan qisqa matn chiqsa boyitilmagan deb hisoblanadi."""
        from bot.db import query_one
        from bot.enricher import run_enrich

        cluster_id = self._seed("https://x.dev/a")
        self._patch_fetch(monkeypatch, "juda qisqa")

        report = run_enrich(use_search=False)

        assert report.failed == 1
        assert query_one("SELECT enrich_source FROM clusters WHERE id = ?", (cluster_id,))[
            "enrich_source"
        ] == "none"

    def test_failure_is_marked_not_retried(self, migrated_db, monkeypatch) -> None:
        """Idempotentlik: muvaffaqiyatsiz klaster qayta urinilmaydi."""
        from bot.enricher import run_enrich

        self._seed("https://x.dev/a")
        self._patch_fetch(monkeypatch, None)

        assert run_enrich(use_search=False).processed == 1
        assert run_enrich(use_search=False).processed == 0

    def test_already_enriched_is_skipped(self, migrated_db, monkeypatch) -> None:
        from bot.enricher import run_enrich

        self._seed("https://x.dev/a")
        self._patch_fetch(monkeypatch, "To'liq matn " * 30)

        assert run_enrich(use_search=False).by_fetch == 1
        assert run_enrich(use_search=False).processed == 0

    def test_no_search_skips_aggregator(self, migrated_db, monkeypatch) -> None:
        from bot.enricher import run_enrich

        self._seed("https://news.google.com/rss/articles/CBMiabc")

        report = run_enrich(use_search=False)

        assert report.failed == 1
        assert report.by_search == 0

    def test_search_limit_stops_further_searches(self, migrated_db, monkeypatch) -> None:
        """Kredit tugasa qolgan klasterlar qidiruvsiz qoladi, oqim yiqilmaydi."""
        from bot.enricher import enrich as enrich_mod
        from bot.enricher import run_enrich
        from bot.enricher.search import SearchUnavailable

        for i in range(3):
            self._seed(f"https://news.google.com/rss/articles/CBMi{i}", title=f"Yangilik {i}")

        class LimitedSearch:
            def __init__(self, *a: Any, **kw: Any) -> None:
                pass

            def search(self, query: str, **kw: Any) -> list[SearchResult]:
                raise SearchUnavailable("kredit tugadi")

            def close(self) -> None:
                pass

        monkeypatch.setattr(enrich_mod, "SearchClient", LimitedSearch)
        monkeypatch.setattr(enrich_mod, "is_configured", lambda: True)

        report = run_enrich()

        assert report.failed == 3
        assert report.problems

    def test_enriched_queue_for_writer(self, migrated_db, monkeypatch) -> None:
        """Writer navbati: havola va matn to'g'ri tanlanadi."""
        from bot.enricher import enriched_clusters, run_enrich

        self._seed(
            "https://news.google.com/rss/articles/CBMiabc",
            title="Anthropic launches Claude Opus 5 - SiliconANGLE",
            extra=json.dumps({"publisher_url": "https://siliconangle.com"}),
        )
        self._patch_search(
            monkeypatch,
            [
                SearchResult(
                    title="Anthropic launches Claude Opus 5",
                    url="https://siliconangle.com/2026/07/26/opus-5",
                    content="",
                    raw_content=SEARCH_TEXT,
                    score=0.9,
                )
            ],
        )
        run_enrich()

        queue = enriched_clusters()

        assert len(queue) == 1
        # Havola aniq maqolaga, agregatorga emas
        assert queue[0]["link"] == "https://siliconangle.com/2026/07/26/opus-5"
        assert "Anthropic kompaniyasi" in queue[0]["text"]

    def test_queue_falls_back_to_feed_text(self, migrated_db, monkeypatch) -> None:
        """Boyitilmagan klaster ham navbatga tushadi — feed matni bilan."""
        from bot.enricher import enriched_clusters, run_enrich

        self._seed("https://x.dev/a")
        self._patch_fetch(monkeypatch, None)
        run_enrich(use_search=False)

        queue = enriched_clusters()

        assert len(queue) == 1
        assert queue[0]["text"] == "qisqa feed matni"
        assert queue[0]["link"] == "https://x.dev/a"

    def test_no_pending_clusters(self, migrated_db) -> None:
        from bot.enricher import run_enrich

        assert run_enrich().processed == 0
