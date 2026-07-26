"""Til sinovi — bir xil yangilikni turli modellarga yozdirib taqqoslash.

Maqsad: o'zbekcha post sifati uchun qaysi model yetarli. Narx farqi
katta (Opus 5 — $5/$25, GPT-5.6 Luna — $1/$6), shuning uchun arzonrog'i
yetarli sifat bersa oylik xarajat bir necha barobar tushadi.

Nomzodlar `models.yaml` dagi `language_test_candidates` ro'yxatidan.

Sinov natijasi avtomatik "g'olib" e'lon qilmaydi: o'zbekcha sifatini
faqat odam baholay oladi. Vosita postlarni yonma-yon ko'rsatadi va
o'lchanadigan narsalarni (narx, uzunlik, tekshiruvdan o'tish) sanaydi.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from bot.config import load_config
from bot.llm import LLMClient, LLMError
from bot.logging_setup import get_logger
from bot.writer.prompts import SYSTEM_PROMPT, build_write_prompt, signature_length
from bot.writer.validator import append_signature, count_bullets, validate_post

log = get_logger(__name__)


@dataclass(slots=True)
class Attempt:
    """Bitta modelning bitta yangilik uchun urinishi."""

    model: str
    cluster_id: int
    cluster_title: str
    text: str = ""
    cost_usd: float = 0.0
    duration_ms: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    valid: bool = False
    errors: list[str] = field(default_factory=list)
    failed: str = ""

    @property
    def length(self) -> int:
        return len(self.text)

    @property
    def bullets(self) -> int:
        return count_bullets(self.text)


@dataclass(slots=True)
class ModelSummary:
    """Bitta model bo'yicha umumiy natija."""

    model: str
    attempts: list[Attempt] = field(default_factory=list)

    @property
    def ok_count(self) -> int:
        return sum(1 for a in self.attempts if a.valid)

    @property
    def total_cost(self) -> float:
        return sum(a.cost_usd for a in self.attempts)

    @property
    def avg_cost(self) -> float:
        return self.total_cost / len(self.attempts) if self.attempts else 0.0

    @property
    def avg_duration_ms(self) -> float:
        done = [a for a in self.attempts if a.duration_ms]
        return sum(a.duration_ms for a in done) / len(done) if done else 0.0

    @property
    def avg_length(self) -> float:
        done = [a for a in self.attempts if a.text]
        return sum(a.length for a in done) / len(done) if done else 0.0

    def monthly_cost(self, posts_per_day: int = 6) -> float:
        """Oylik prognoz shu model bilan."""
        return self.avg_cost * posts_per_day * 30


def _write_with_model(
    client: LLMClient,
    model: str,
    cluster: dict[str, Any],
    channel: dict[str, Any],
    *,
    budget: int,
    max_length: int,
) -> Attempt:
    """Bitta model bilan bitta post yozish va tekshirish."""
    attempt = Attempt(
        model=model,
        cluster_id=int(cluster["id"]),
        cluster_title=str(cluster.get("title") or ""),
    )

    prompt = build_write_prompt(cluster, channel, budget=budget)
    started = time.monotonic()

    try:
        # `stage` sifatida "write" beriladi (narx jadvali va log uchun),
        # lekin model aniq ko'rsatiladi — fallback zanjiri ishlamaydi,
        # aks holda qaysi model yozganini bilib bo'lmaydi.
        response = client.complete_with_model(
            model,
            stage="lang_test",
            prompt=prompt,
            system=SYSTEM_PROMPT,
            cluster_id=int(cluster["id"]),
        )
    except LLMError as exc:
        attempt.failed = str(exc)
        attempt.duration_ms = int((time.monotonic() - started) * 1000)
        log.warning("%s ishlamadi: %s", model, exc)
        return attempt

    attempt.cost_usd = response.cost_usd
    attempt.duration_ms = response.duration_ms
    attempt.prompt_tokens = response.prompt_tokens
    attempt.completion_tokens = response.completion_tokens

    result = validate_post(
        response.text,
        channel=channel,
        max_length=budget,
        expected_link=str(cluster.get("link") or ""),
    )
    attempt.valid = result.ok
    attempt.errors = list(result.errors)
    attempt.text = append_signature(result.text, channel) if result.ok else result.text

    return attempt


def run_comparison(
    clusters: list[dict[str, Any]],
    models: list[str] | None = None,
) -> list[ModelSummary]:
    """Har bir klasterni har bir modelga yozdirish.

    Chaqiruvlar soni = klasterlar × modellar, shuning uchun ehtiyot
    bo'lish kerak: 3 klaster × 4 model = 12 chaqiruv.
    """
    config = load_config()
    channel = config.channel

    candidates = list(models or config.models.language_test_candidates)
    if not candidates:
        raise ValueError(
            "Nomzod model yo'q. models.yaml da `language_test_candidates` ni to'ldiring."
        )

    fmt = channel.get("format") or {}
    max_length = int(fmt.get("max_length", 1024))
    budget = max_length - signature_length(channel)

    summaries = [ModelSummary(model=m) for m in candidates]

    log.info(
        "Til sinovi: %d klaster × %d model = %d chaqiruv",
        len(clusters),
        len(candidates),
        len(clusters) * len(candidates),
    )

    with LLMClient(config.models) as client:
        for cluster in clusters:
            log.info("── Klaster %s: %s", cluster["id"], str(cluster["title"])[:60])
            for summary in summaries:
                attempt = _write_with_model(
                    client,
                    summary.model,
                    cluster,
                    channel,
                    budget=budget,
                    max_length=max_length,
                )
                summary.attempts.append(attempt)
                status = "ok" if attempt.valid else ("XATO" if attempt.failed else "tekshiruv")
                log.info(
                    "   %-32s %-9s %4d belgi  $%.5f  %5d ms",
                    summary.model,
                    status,
                    attempt.length,
                    attempt.cost_usd,
                    attempt.duration_ms,
                )

    return summaries


def format_comparison(summaries: list[ModelSummary], *, posts_per_day: int = 6) -> str:
    """Taqqoslash jadvali (CLI uchun)."""
    if not summaries:
        return "Natija yo'q."

    lines = [
        f"{'MODEL':<32} {'OK':>5} {'BELGI':>6} {'VAQT':>7} {'POST':>9} {'OYLIK':>8}",
        "─" * 74,
    ]

    # Eng arzon ishlaydigan model ajratib ko'rsatiladi
    working = [s for s in summaries if s.ok_count]
    cheapest = min(working, key=lambda s: s.avg_cost).model if working else ""

    for summary in sorted(summaries, key=lambda s: s.avg_cost):
        mark = " ←arzon" if summary.model == cheapest else ""
        lines.append(
            f"{summary.model[:32]:<32} "
            f"{summary.ok_count}/{len(summary.attempts):<3} "
            f"{summary.avg_length:>6.0f} "
            f"{summary.avg_duration_ms / 1000:>6.1f}s "
            f"${summary.avg_cost:>8.5f} "
            f"${summary.monthly_cost(posts_per_day):>7.2f}{mark}"
        )

    lines.append("")
    lines.append(f"Oylik prognoz: kuniga {posts_per_day} post × 30 kun")
    return "\n".join(lines)
