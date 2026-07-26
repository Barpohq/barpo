"""Model versiyalarini ajratish testlari.

Bu modul embedding'ning zaif joyini to'ldiradi: real o'lchovda
"Claude Opus 5" ↔ "Claude Opus 4.7" = 0.910 similarity, ya'ni haqiqiy
dublikatlardan ham yuqori. Shuning uchun versiya konflikti alohida
tekshiriladi.
"""

from __future__ import annotations

import pytest

from bot.dedup.versions import extract_versions, versions_conflict


class TestExtractVersions:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("Introducing Claude Opus 5", {("claude", "5")}),
            ("Claude Opus 4.7 released", {("claude", "4.7")}),
            ("GPT-5 is here", {("gpt", "5")}),
            ("Gemini 3.5 Flash launch", {("gemini", "3.5")}),
            ("Llama 4 weights", {("llama", "4")}),
            ("Mistral 3 benchmarks", {("mistral", "3")}),
            # Bir matnda ikkita versiya
            (
                "Gemini 3.5 Flash vs Gemini 2.5 Flash",
                {("gemini", "3.5"), ("gemini", "2.5")},
            ),
            # Versiyasiz matn
            ("New AI research published", set()),
            ("Anthropic hires new staff", set()),
        ],
    )
    def test_extraction(self, text: str, expected: set) -> None:
        assert extract_versions(text) == expected

    def test_opus_sonnet_map_to_claude(self) -> None:
        """Opus/Sonnet/Haiku — Claude oilasi, alohida mahsulot emas."""
        assert extract_versions("Opus 5 review") == {("claude", "5")}
        assert extract_versions("Sonnet 4.6 pricing") == {("claude", "4.6")}


class TestVersionsConflict:
    def test_different_versions_conflict(self) -> None:
        """Asosiy holat: turli relizlar birlashmasligi kerak."""
        assert versions_conflict(
            "Introducing Claude Opus 5",
            "Anthropic releases Claude Opus 4.7: benchmarks",
        )

    def test_same_version_no_conflict(self) -> None:
        """Bir xil reliz haqidagi turli maqolalar — birlashishi kerak."""
        assert not versions_conflict(
            "Introducing Claude Opus 5 - Anthropic",
            "Anthropic launches Claude Opus 5 with efficiency improvements",
        )

    def test_no_versions_no_conflict(self) -> None:
        assert not versions_conflict("AI research news", "Another AI paper")

    def test_one_side_versionless_no_conflict(self) -> None:
        """Bir tomonda versiya yo'q — konflikt deb hisoblanmaydi."""
        assert not versions_conflict("Claude Opus 5 released", "Anthropic company news")

    def test_different_products_no_conflict(self) -> None:
        """Turli mahsulotlar — versiyalari farq qilsa ham konflikt emas.

        (Semantik o'xshashlik baribir past bo'ladi, bu yerda faqat versiya
        mantiqi tekshiriladi.)
        """
        assert not versions_conflict("GPT-5 launch", "Gemini 3 launch")

    def test_gemini_generations_conflict(self) -> None:
        """Real muammo: Gemini 3.5 va 2.5 similarity 0.966 edi."""
        assert versions_conflict("Gemini 3.5 Flash launch", "Gemini 2.5 Flash launch")

    def test_gpt_generations_conflict(self) -> None:
        assert versions_conflict("GPT-5 released today", "GPT-4 released last year")

    def test_shared_version_among_several(self) -> None:
        """Bir necha versiya bo'lsa, kamida bittasi umumiy bo'lsa — konflikt yo'q."""
        assert not versions_conflict(
            "Claude Opus 5 vs Claude Opus 4.7 comparison",
            "Claude Opus 5 benchmarks",
        )


class TestExtractModelIds:
    """To'liq model identifikatori — Claude variantlari alohida."""

    def test_claude_variant_kept(self) -> None:
        from bot.dedup.versions import extract_model_ids

        assert extract_model_ids("Introducing Claude Opus 5") == {"claude-opus-5"}

    def test_bare_variant_normalized(self) -> None:
        """'Opus 5' ham 'Claude Opus 5' bilan bir xil id berishi kerak."""
        from bot.dedup.versions import extract_model_ids

        assert extract_model_ids("Anthropic releases Opus 5") == {"claude-opus-5"}

    def test_siblings_are_distinct(self) -> None:
        from bot.dedup.versions import extract_model_ids

        ids = extract_model_ids("Claude Sonnet 5 vs Claude Opus 5")
        assert ids == {"claude-opus-5", "claude-sonnet-5"}

    def test_no_model_returns_empty(self) -> None:
        from bot.dedup.versions import extract_model_ids

        assert extract_model_ids("AI funding round news") == set()


class TestModelsConflict:
    def test_siblings_conflict(self) -> None:
        """Opus 5 va Sonnet 5 — turli relizlar."""
        from bot.dedup.versions import models_conflict

        assert models_conflict("Claude Opus 5 released", "Introducing Claude Sonnet 5")

    def test_same_model_no_conflict(self) -> None:
        from bot.dedup.versions import models_conflict

        assert not models_conflict(
            "Anthropic launches Claude Opus 5", "Introducing Claude Opus 5"
        )

    def test_bare_variant_matches_full_name(self) -> None:
        from bot.dedup.versions import models_conflict

        assert not models_conflict("Claude Opus 5", "Anthropic releases Opus 5")

    def test_no_model_no_conflict(self) -> None:
        """Model topilmasa konflikt yo'q — boshqa signal hal qiladi."""
        from bot.dedup.versions import models_conflict

        assert not models_conflict("AI funding news", "Another AI story")

    def test_dedup_still_treats_siblings_as_same_product(self) -> None:
        """versions_conflict dedup uchun eski xatti-harakatini saqlaydi.

        Dedup uchun Opus/Sonnet bir mahsulot (Claude oilasi) — bu ataylab
        shunday. Enricher esa aniqroq ajratish uchun models_conflict
        ishlatadi.
        """
        from bot.dedup.versions import versions_conflict

        assert not versions_conflict("Claude Opus 5", "Claude Sonnet 5")
