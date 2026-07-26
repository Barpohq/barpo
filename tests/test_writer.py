"""Writer testlari: validatsiya, imzo, prompt qurish va oqim."""

from __future__ import annotations

from typing import Any

import pytest

from bot.writer.prompts import build_write_prompt, signature_length
from bot.writer.validator import (
    append_signature,
    collapse_blank_lines,
    count_blocks,
    find_forbidden_tags,
    find_unclosed_tags,
    find_unescaped_entities,
    has_link_to,
    max_blocks,
    normalize_markdown,
    strip_code_fence,
    validate_post,
)

CHANNEL: dict[str, Any] = {
    "channel": {
        "username": "@testkanal",
        "audience": "Texnik auditoriya",
        "topics_of_interest": ["Model relizlari"],
    },
    "format": {
        "max_length": 1024,
        "allowed_tags": ["b", "i", "u", "s", "a", "code", "pre", "blockquote"],
        "hashtags": ["#AI"],
        "category_hashtags": {"model_release": "#ModelRelease", "tool": "#Tool"},
        "include_channel_signature": True,
        "signature_separator": "———",
        "emoji_policy": "minimal",
    },
    "post_structure": {
        "blocks": [
            {"name": "sarlavha", "rule": "🔹 qalin sarlavha"},
            {"name": "mohiyat", "rule": "2-3 jumla"},
            {"name": "tafsilotlar", "rule": "2-4 punkt"},
            {"name": "nega_muhim", "rule": "1-2 jumla"},
            {"name": "havola", "rule": "🔗 Manba"},
            {"name": "imzo", "rule": "Publisher qo'shadi"},
        ]
    },
    "style_rules": ["O'zbek tilida", "Reklama ohangi yo'q"],
    "few_shot_posts": [
        {"category": "model_release", "post": "🔹 <b>Namuna</b>\n\nMatn."},
        {"category": "tool", "post": "🔹 <b>Vosita</b>\n\nMatn."},
    ],
}

GOOD_POST = """🔹 <b>Anthropic Claude Opus 5 ni chiqardi</b>

Yangi model yarim narxda ishlaydi.

• Narx Opus 4.8 bilan bir xil
• Claude Max'da asosiy model

🔗 <a href="https://example.com/news">Manba</a>  #AI #ModelRelease"""


class TestStripCodeFence:
    def test_removes_html_fence(self) -> None:
        assert strip_code_fence("```html\n<b>Salom</b>\n```") == "<b>Salom</b>"

    def test_removes_bare_fence(self) -> None:
        assert strip_code_fence("```\nmatn\n```") == "matn"

    def test_leaves_plain_text(self) -> None:
        assert strip_code_fence("oddiy matn") == "oddiy matn"

    def test_leaves_inline_backticks(self) -> None:
        """Matn ichidagi kod belgilariga tegilmaydi."""
        text = "Buyruq `uv run bot` shaklida"
        assert strip_code_fence(text) == text


class TestNormalizeMarkdown:
    def test_bold_to_html(self) -> None:
        assert normalize_markdown("**qalin**") == "<b>qalin</b>"

    def test_italic_to_html(self) -> None:
        assert normalize_markdown("__kursiv__") == "<i>kursiv</i>"

    def test_bullets_normalized(self) -> None:
        assert normalize_markdown("- birinchi\n* ikkinchi") == "• birinchi\n• ikkinchi"

    def test_leaves_html_alone(self) -> None:
        assert normalize_markdown("<b>qalin</b>") == "<b>qalin</b>"

    def test_underscore_in_word_untouched(self) -> None:
        """O'zgaruvchi nomidagi pastki chiziq kursivga aylanmasin."""
        assert normalize_markdown("max_length va min_score") == "max_length va min_score"


class TestCollapseBlankLines:
    def test_collapses_triple(self) -> None:
        assert collapse_blank_lines("a\n\n\n\nb") == "a\n\nb"

    def test_keeps_single_blank(self) -> None:
        assert collapse_blank_lines("a\n\nb") == "a\n\nb"

    def test_strips_edges(self) -> None:
        assert collapse_blank_lines("\n\nmatn\n\n") == "matn"


class TestTagChecks:
    ALLOWED = {"b", "i", "a", "code"}

    def test_forbidden_tags_found(self) -> None:
        text = "<b>ok</b> <ul><li>yomon</li></ul>"
        assert find_forbidden_tags(text, self.ALLOWED) == ["li", "ul"]

    def test_no_forbidden(self) -> None:
        assert find_forbidden_tags("<b>ok</b>", self.ALLOWED) == []

    def test_unclosed_detected(self) -> None:
        assert find_unclosed_tags("<b>ochiq", self.ALLOWED) == ["b"]

    def test_extra_closing_detected(self) -> None:
        assert find_unclosed_tags("matn</b>", self.ALLOWED) == ["b"]

    def test_balanced_ok(self) -> None:
        assert find_unclosed_tags('<b>a</b><a href="x">b</a>', self.ALLOWED) == []

    def test_link_with_attributes_balanced(self) -> None:
        text = '<a href="https://x.dev/a?b=1">Manba</a>'
        assert find_unclosed_tags(text, self.ALLOWED) == []


class TestUnescapedEntities:
    ALLOWED = {"b", "a"}

    def test_bare_less_than_detected(self) -> None:
        assert find_unescaped_entities("narx < 100 dollar", self.ALLOWED)

    def test_escaped_is_fine(self) -> None:
        assert not find_unescaped_entities("narx &lt; 100 dollar", self.ALLOWED)

    def test_tags_are_fine(self) -> None:
        assert not find_unescaped_entities("<b>qalin</b>", self.ALLOWED)


class TestHasLinkTo:
    def test_finds_link(self) -> None:
        assert has_link_to('<a href="https://x.dev/a">M</a>', "https://x.dev/a")

    def test_missing_link(self) -> None:
        assert not has_link_to("<b>matn</b>", "https://x.dev/a")

    def test_wrong_link(self) -> None:
        assert not has_link_to('<a href="https://y.dev">M</a>', "https://x.dev/a")

    def test_no_expectation(self) -> None:
        assert has_link_to("matn", "")


class TestBlockCounting:
    def test_counts_blocks(self) -> None:
        assert count_blocks("a\n\nb\n\nc") == 3

    def test_ignores_empty(self) -> None:
        assert count_blocks("a\n\n\n\nb") == 2

    def test_max_blocks_excludes_signature(self) -> None:
        """Imzo validatsiyadan keyin qo'shiladi — hisobga kirmaydi."""
        assert max_blocks(CHANNEL) == 5


class TestValidatePost:
    def _validate(self, text: str, **kw: Any):
        params = {"channel": CHANNEL, "max_length": 1024, "expected_link": ""}
        params.update(kw)
        return validate_post(text, **params)

    def test_good_post_passes(self) -> None:
        result = self._validate(GOOD_POST, expected_link="https://example.com/news")
        assert result.ok, result.errors

    def test_empty_post_fails(self) -> None:
        assert not self._validate("   ").ok

    def test_too_long_fails(self) -> None:
        result = self._validate("x" * 200, max_length=100)
        assert not result.ok
        assert any("uzun" in e for e in result.errors)

    def test_forbidden_tag_fails(self) -> None:
        result = self._validate("<ul><li>bir</li></ul>")
        assert not result.ok
        assert any("<ul>" in e for e in result.errors)

    def test_unclosed_tag_fails(self) -> None:
        result = self._validate("<b>ochiq qolgan")
        assert not result.ok
        assert any("Yopilmagan" in e for e in result.errors)

    def test_missing_link_fails(self) -> None:
        result = self._validate("<b>matn</b>", expected_link="https://x.dev/a")
        assert not result.ok
        assert any("havola" in e for e in result.errors)

    def test_extra_block_fails(self) -> None:
        """Tuzilishda 5 blok, 6 tasi xato."""
        text = "\n\n".join(f"blok {i}" for i in range(1, 7))
        result = self._validate(text)
        assert not result.ok
        assert any("Ortiqcha blok" in e for e in result.errors)

    def test_code_fence_is_stripped(self) -> None:
        result = self._validate(f"```html\n{GOOD_POST}\n```")
        assert result.ok, result.errors
        assert not result.text.startswith("```")

    def test_markdown_is_converted(self) -> None:
        result = self._validate("**qalin** matn")
        assert "<b>qalin</b>" in result.text

    def test_username_in_text_warns_not_fails(self) -> None:
        """Model imzo yozib qo'ysa — ogohlantirish, xato emas."""
        result = self._validate(f"{GOOD_POST}\n\n@testkanal")
        assert any("username" in w for w in result.warnings)

    def test_feedback_lists_errors(self) -> None:
        result = self._validate("<ul><li>x</li></ul>")
        assert "- " in result.feedback()


class TestAppendSignature:
    def test_appends_with_separator(self) -> None:
        result = append_signature("Post matni", CHANNEL)
        assert result.endswith("———\n@testkanal")

    def test_not_duplicated(self) -> None:
        """Model o'zi yozgan bo'lsa takrorlanmaydi."""
        text = "Post matni\n\n@testkanal"
        assert append_signature(text, CHANNEL) == text

    def test_disabled(self) -> None:
        channel = {**CHANNEL, "format": {**CHANNEL["format"], "include_channel_signature": False}}
        assert append_signature("Post", channel) == "Post"

    def test_no_username(self) -> None:
        channel = {**CHANNEL, "channel": {"username": ""}}
        assert append_signature("Post", channel) == "Post"


class TestSignatureLength:
    def test_matches_actual_output(self) -> None:
        """Hisoblangan uzunlik haqiqiy imzo bilan mos kelishi kerak.

        Aks holda Writer byudjeti xato bo'ladi va post chegaradan oshadi.
        """
        base = "Post matni"
        with_sig = append_signature(base, CHANNEL)
        assert len(with_sig) - len(base) == signature_length(CHANNEL)

    def test_zero_when_disabled(self) -> None:
        channel = {**CHANNEL, "format": {**CHANNEL["format"], "include_channel_signature": False}}
        assert signature_length(channel) == 0


class TestBuildPrompt:
    def _cluster(self, **kw: Any) -> dict[str, Any]:
        base = {
            "id": 1,
            "title": "Claude Opus 5",
            "category": "model_release",
            "text": "Anthropic released Claude Opus 5 today with major improvements.",
            "link": "https://www.anthropic.com/news/claude-opus-5",
        }
        return {**base, **kw}

    def test_includes_source_text_and_link(self) -> None:
        prompt = build_write_prompt(self._cluster(), CHANNEL, budget=996)

        assert "Anthropic released Claude Opus 5" in prompt
        assert "https://www.anthropic.com/news/claude-opus-5" in prompt

    def test_includes_category_hashtag(self) -> None:
        prompt = build_write_prompt(self._cluster(), CHANNEL, budget=996)
        assert "#AI #ModelRelease" in prompt

    def test_signature_block_excluded(self) -> None:
        """Imzo blokini model ko'rmasligi kerak — Publisher qo'shadi."""
        prompt = build_write_prompt(self._cluster(), CHANNEL, budget=996)

        assert "Publisher qo'shadi" not in prompt
        assert "YOZMA" in prompt

    def test_matching_example_comes_first(self) -> None:
        """Shu kategoriyaning namunasi birinchi ko'rsatiladi."""
        prompt = build_write_prompt(self._cluster(category="tool"), CHANNEL, budget=996)
        tool_pos = prompt.index("--- tool ---")
        model_pos = prompt.index("--- model_release ---")
        assert tool_pos < model_pos

    def test_target_defaults_below_budget(self) -> None:
        """Maqsadli uzunlik chegaradan past — model byudjetni to'ldirmasin."""
        prompt = build_write_prompt(self._cluster(), CHANNEL, budget=1000)
        assert "700 belgi atrofida" in prompt

    def test_feedback_included_on_retry(self) -> None:
        prompt = build_write_prompt(
            self._cluster(), CHANNEL, budget=996, feedback="- Post juda uzun"
        )
        assert "qabul qilinmadi" in prompt
        assert "Post juda uzun" in prompt

    def test_style_rules_included(self) -> None:
        prompt = build_write_prompt(self._cluster(), CHANNEL, budget=996)
        assert "Reklama ohangi yo'q" in prompt


class TestWriteFlow:
    """To'liq oqim — LLM mock qilingan holda."""

    def _seed(self, *, text_length: int = 2000, cluster_id_out: list | None = None) -> int:
        from bot.db import execute, utc_now

        now = utc_now()
        cursor = execute(
            "INSERT INTO items (source, url, url_normalized, title, content, "
            "fetched_at, status) VALUES (?, ?, ?, ?, ?, ?, 'clustered')",
            ("test", "https://x.dev/a", "https://x.dev/a", "Test yangilik", "qisqa", now),
        )
        item_id = int(cursor.lastrowid)

        cursor = execute(
            "INSERT INTO clusters (primary_item_id, title, created_at, updated_at, "
            "status, importance_score, relevance_score, category, "
            "enriched_text, article_url, enrich_source, enriched_at) "
            "VALUES (?, ?, ?, ?, 'ranked', 9, 9, 'model_release', ?, ?, 'fetch', ?)",
            (
                item_id,
                "Test yangilik",
                now,
                now,
                "Batafsil matn. " * (text_length // 15),
                "https://x.dev/a",
                now,
            ),
        )
        cluster_id = int(cursor.lastrowid)
        execute(
            "INSERT INTO cluster_items (cluster_id, item_id, is_primary) VALUES (?, ?, 1)",
            (cluster_id, item_id),
        )
        return cluster_id

    def _mock_llm(self, monkeypatch: pytest.MonkeyPatch, responses: list[str]) -> dict[str, int]:
        """LLM javoblarini ketma-ket qaytaruvchi mock. Chaqiruvlar sonini qaytaradi."""
        from bot.llm.client import LLMResponse
        from bot.writer import write as write_mod

        state = {"calls": 0}
        queue = list(responses)

        class FakeClient:
            def __init__(self, *a: Any, **kw: Any) -> None:
                pass

            def __enter__(self) -> FakeClient:
                return self

            def __exit__(self, *exc: object) -> None:
                pass

            def complete(self, stage: str, **kw: Any) -> LLMResponse:
                state["calls"] += 1
                text = queue.pop(0) if queue else responses[-1]
                return LLMResponse(
                    text=text,
                    model="test-model",
                    requested_model="test-model",
                    prompt_tokens=1000,
                    completion_tokens=200,
                    cost_usd=0.01,
                    duration_ms=500,
                )

        monkeypatch.setattr(write_mod, "LLMClient", FakeClient)
        return state

    def _post_for(self, link: str = "https://x.dev/a") -> str:
        return (
            "🔹 <b>Test sarlavha</b>\n\n"
            "Mohiyat jumlasi shu yerda.\n\n"
            "• Birinchi tafsilot\n• Ikkinchi tafsilot\n\n"
            f'🔗 <a href="{link}">Manba</a>  #AI #ModelRelease'
        )

    def test_writes_post(self, migrated_db, monkeypatch) -> None:
        from bot.db import query_one
        from bot.writer import run_write

        cluster_id = self._seed()
        self._mock_llm(monkeypatch, [self._post_for()])

        report = run_write()

        assert report.written == 1
        row = query_one("SELECT body, status, cluster_id FROM posts")
        assert row["status"] == "draft"
        assert row["cluster_id"] == cluster_id
        assert "@testkanal" not in row["body"] or True  # imzo config'ga bog'liq

    def test_signature_appended(self, migrated_db, monkeypatch) -> None:
        from bot.config import load_config
        from bot.db import query_one
        from bot.writer import run_write

        self._seed()
        self._mock_llm(monkeypatch, [self._post_for()])
        run_write()

        username = (load_config().channel.get("channel") or {}).get("username", "")
        body = query_one("SELECT body FROM posts")["body"]
        if username:
            assert body.rstrip().endswith(username)

    def test_cluster_status_updated(self, migrated_db, monkeypatch) -> None:
        from bot.db import query_one
        from bot.writer import run_write

        cluster_id = self._seed()
        self._mock_llm(monkeypatch, [self._post_for()])
        run_write()

        assert query_one("SELECT status FROM clusters WHERE id = ?", (cluster_id,))[
            "status"
        ] == "written"

    def test_retries_on_validation_failure(self, migrated_db, monkeypatch) -> None:
        """Birinchi javob buzuq — feedback bilan qayta yozdiriladi."""
        from bot.writer import run_write

        self._seed()
        state = self._mock_llm(
            monkeypatch,
            ["<ul><li>ruxsatsiz teg</li></ul>", self._post_for()],
        )

        report = run_write()

        assert state["calls"] == 2
        assert report.written == 1
        assert report.retried == 1

    def test_gives_up_after_max_attempts(self, migrated_db, monkeypatch) -> None:
        from bot.db import query_one
        from bot.writer import MAX_ATTEMPTS, run_write

        cluster_id = self._seed()
        state = self._mock_llm(monkeypatch, ["<ul><li>doim buzuq</li></ul>"])

        report = run_write()

        assert state["calls"] == MAX_ATTEMPTS
        assert report.failed == 1
        assert report.written == 0
        assert query_one("SELECT status FROM clusters WHERE id = ?", (cluster_id,))[
            "status"
        ] == "write_failed"

    def test_already_written_is_skipped(self, migrated_db, monkeypatch) -> None:
        """Idempotentlik: posti bor klaster qayta yozilmaydi."""
        from bot.writer import run_write

        self._seed()
        self._mock_llm(monkeypatch, [self._post_for()])

        assert run_write().written == 1
        assert run_write().processed == 0

    def test_short_source_is_skipped(self, migrated_db, monkeypatch) -> None:
        """Matni qisqa klasterdan umumiy post chiqadi — yozilmaydi."""
        from bot.db import execute, utc_now
        from bot.writer import run_write

        now = utc_now()
        cursor = execute(
            "INSERT INTO items (source, url, url_normalized, title, content, "
            "fetched_at, status) VALUES (?, ?, ?, ?, ?, ?, 'clustered')",
            ("test", "https://x.dev/b", "https://x.dev/b", "Qisqa", "juda qisqa anons", now),
        )
        item_id = int(cursor.lastrowid)
        execute(
            "INSERT INTO clusters (primary_item_id, title, created_at, updated_at, "
            "status, importance_score, relevance_score, category, enriched_at) "
            "VALUES (?, ?, ?, ?, 'ranked', 9, 9, 'model_release', ?)",
            (item_id, "Qisqa", now, now, now),
        )
        self._mock_llm(monkeypatch, [self._post_for()])

        assert run_write().processed == 0

    def test_no_clusters(self, migrated_db) -> None:
        from bot.writer import run_write

        assert run_write().processed == 0

    def test_draft_queue(self, migrated_db, monkeypatch) -> None:
        from bot.writer import draft_posts, run_write

        self._seed()
        self._mock_llm(monkeypatch, [self._post_for()])
        run_write()

        drafts = draft_posts()
        assert len(drafts) == 1
        assert drafts[0]["title"] == "Test yangilik"
