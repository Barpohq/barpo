"""Klasterlarni LLM bilan baholash.

Har bir `new` statusdagi klaster arzon model orqali baholanadi:
muhimlik, kanalga moslik, kategoriya, spam belgisi.

Natija `clusters` jadvaliga yoziladi va status `ranked` ga o'tadi.
Spam yoki past baholi klasterlar `rejected` bo'ladi — ular Writer'ga
umuman bormaydi.

Idempotentlik: faqat `status = 'new'` klasterlar olinadi, shuning uchun
qayta ishga tushirilsa allaqachon baholanganlar ikkinchi marta
baholanmaydi (04-xavflar, X5 — LLM xarajatini takrorlamaslik).
"""

from __future__ import annotations

import traceback
from dataclasses import dataclass, field
from typing import Any

from bot.config import load_config
from bot.db import execute, log_error, query, transaction, utc_now
from bot.llm import CostLimitExceeded, LLMClient, LLMError
from bot.logging_setup import get_logger
from bot.rank.prompts import CATEGORIES, SYSTEM_PROMPT, build_rank_prompt

log = get_logger(__name__)

# Bir chaqiruvda nechta klaster baholanadi.
# Katta batch arzonroq, lekin model diqqati susayadi va JSON uzilib qolishi
# mumkin (max_tokens=2000). 8 ta — sinovda barqaror ishlagan qiymat.
DEFAULT_BATCH_SIZE = 8


@dataclass(slots=True)
class RankReport:
    processed: int = 0
    ranked: int = 0
    rejected: int = 0
    spam: int = 0
    failed: int = 0
    cost_usd: float = 0.0
    failed_batches: list[str] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"{self.processed} klaster baholandi: {self.ranked} qabul, "
            f"{self.rejected} rad ({self.spam} spam), {self.failed} xato, "
            f"${self.cost_usd:.5f}"
        )


# ─────────────────────────── Ma'lumot olish ───────────────────────────


def _fetch_new_clusters(limit: int) -> list[dict[str, Any]]:
    """Baholanmagan klasterlar — eng ko'p manbali va yangilari birinchi.

    Tartib muhim: limit qo'yilganda eng istiqbolli klasterlar baholansin.
    Ko'p manbada chiqqan yangilik odatda muhimroq.
    """
    rows = query(
        """
        SELECT c.id, c.title, c.item_count,
               i.content, i.summary, i.published_at, i.url
        FROM clusters c
        JOIN items i ON i.id = c.primary_item_id
        WHERE c.status = 'new'
        ORDER BY c.item_count DESC, COALESCE(i.published_at, i.fetched_at) DESC
        LIMIT ?
        """,
        (limit,),
    )
    clusters = [dict(r) for r in rows]

    # Klaster ichidagi manbalar ro'yxati — promptga signal sifatida kiradi
    for cluster in clusters:
        source_rows = query(
            """
            SELECT DISTINCT i.source
            FROM cluster_items ci
            JOIN items i ON i.id = ci.item_id
            WHERE ci.cluster_id = ?
            """,
            (cluster["id"],),
        )
        cluster["sources"] = [r["source"] for r in source_rows]

    return clusters


# ─────────────────────────── Javobni tekshirish ───────────────────────────


def _clamp_score(value: Any, field_name: str, cluster_id: int) -> float | None:
    """Bahoni 1-10 oralig'iga keltirish. Yaroqsiz bo'lsa None."""
    try:
        score = float(value)
    except (TypeError, ValueError):
        log.warning("Klaster %d: '%s' son emas: %r", cluster_id, field_name, value)
        return None
    if not 1.0 <= score <= 10.0:
        log.warning(
            "Klaster %d: '%s' oraliqdan tashqari (%s), qisqartirildi",
            cluster_id,
            field_name,
            score,
        )
        score = max(1.0, min(10.0, score))
    return score


def _parse_results(
    payload: Any, expected_ids: set[int]
) -> tuple[dict[int, dict[str, Any]], list[str]]:
    """Model javobini tekshirib, klaster id → baho lug'atiga aylantirish.

    Yaroqsiz elementlar tashlab yuboriladi — bitta buzuq element butun
    batchni yo'qotmasligi kerak. Muammolar ro'yxati ham qaytariladi.
    """
    problems: list[str] = []

    if not isinstance(payload, dict):
        return {}, [f"javob obyekt emas: {type(payload).__name__}"]

    results = payload.get("results")
    if not isinstance(results, list):
        return {}, ["javobda 'results' ro'yxati yo'q"]

    parsed: dict[int, dict[str, Any]] = {}
    for entry in results:
        if not isinstance(entry, dict):
            problems.append(f"element obyekt emas: {entry!r}")
            continue

        try:
            cluster_id = int(entry["id"])
        except (KeyError, TypeError, ValueError):
            problems.append(f"element 'id' siz yoki yaroqsiz: {entry!r}")
            continue

        if cluster_id not in expected_ids:
            problems.append(f"kutilmagan id: {cluster_id}")
            continue
        if cluster_id in parsed:
            problems.append(f"id takrorlandi: {cluster_id}")
            continue

        importance = _clamp_score(entry.get("importance"), "importance", cluster_id)
        relevance = _clamp_score(entry.get("relevance"), "relevance", cluster_id)
        if importance is None or relevance is None:
            problems.append(f"id {cluster_id}: baho yaroqsiz")
            continue

        category = str(entry.get("category") or "other").strip().lower()
        if category not in CATEGORIES:
            log.warning("Klaster %d: noma'lum kategoriya %r → other", cluster_id, category)
            category = "other"

        reason = str(entry.get("reason") or "").strip()[:500]

        parsed[cluster_id] = {
            "importance_score": importance,
            "relevance_score": relevance,
            "category": category,
            "is_spam": bool(entry.get("is_spam")),
            "rank_reason": reason,
        }

    missing = expected_ids - parsed.keys()
    if missing:
        problems.append(f"javobda yo'q id'lar: {sorted(missing)}")

    return parsed, problems


# ─────────────────────────── Bazaga yozish ───────────────────────────


def _verdict(score: dict[str, Any], min_importance: float) -> str:
    """Bahodan yakuniy qaror: ranked yoki rejected.

    Rad etish qoidasi: spam bo'lsa yoki muhimlik chegaradan past bo'lsa
    klaster keyingi bosqichlarga bormaydi.
    """
    if score["is_spam"] or score["importance_score"] < min_importance:
        return "rejected"
    return "ranked"


def _apply_scores(
    scores: dict[int, dict[str, Any]], *, min_importance: float
) -> tuple[int, int, int]:
    """Baholarni bazaga yozish. (ranked, rejected, spam) qaytaradi."""
    ranked = rejected = spam = 0
    now = utc_now()

    with transaction():
        for cluster_id, score in scores.items():
            is_spam = score["is_spam"]
            status = _verdict(score, min_importance)

            if status == "rejected":
                rejected += 1
                if is_spam:
                    spam += 1
            else:
                ranked += 1

            execute(
                """
                UPDATE clusters
                SET importance_score = ?, relevance_score = ?, category = ?,
                    is_spam = ?, rank_reason = ?, ranked_at = ?,
                    status = ?, updated_at = ?
                WHERE id = ? AND status = 'new'
                """,
                (
                    score["importance_score"],
                    score["relevance_score"],
                    score["category"],
                    int(is_spam),
                    score["rank_reason"] or None,
                    now,
                    status,
                    now,
                    cluster_id,
                ),
            )

    return ranked, rejected, spam


# ─────────────────────────── Asosiy oqim ───────────────────────────


def _batches(items: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def run_rank(
    *,
    limit: int = 100,
    batch_size: int = DEFAULT_BATCH_SIZE,
    dry_run: bool = False,
) -> RankReport:
    """Baholanmagan klasterlarni baholash.

    `limit` — maksimal nechta klaster baholanadi (xarajat nazorati).
    `dry_run` — baholaydi va ko'rsatadi, lekin bazaga yozmaydi.
    """
    report = RankReport()
    config = load_config()

    clusters = _fetch_new_clusters(limit)
    if not clusters:
        log.info("Baholanmagan klaster yo'q")
        return report

    posting = config.channel.get("posting") or {}
    min_importance = float(posting.get("min_importance_score", 6))

    log.info(
        "Rank: %d klaster, %d ta batch (chegara: muhimlik >= %.1f)%s",
        len(clusters),
        -(-len(clusters) // batch_size),
        min_importance,
        " [dry-run]" if dry_run else "",
    )

    with LLMClient(config.models) as client:
        for index, batch in enumerate(_batches(clusters, batch_size), start=1):
            batch_ids = {int(c["id"]) for c in batch}
            try:
                response = client.complete(
                    "rank",
                    prompt=build_rank_prompt(batch, config.channel),
                    system=SYSTEM_PROMPT,
                    json_mode=True,
                )
            except CostLimitExceeded as exc:
                # Limit oshdi — qolgan batchlarni urinish behuda
                log.error("Rank to'xtatildi: %s", exc)
                log_error("rank", str(exc), context=f"batch {index}")
                report.failed += len(batch)
                report.failed_batches.append(f"batch {index}: xarajat limiti")
                break
            except LLMError as exc:
                log.error("Batch %d baholanmadi: %s", index, exc)
                log_error(
                    "rank",
                    str(exc),
                    context=f"batch {index}",
                    traceback=traceback.format_exc(),
                )
                report.failed += len(batch)
                report.failed_batches.append(f"batch {index}: {exc}")
                continue

            report.cost_usd += response.cost_usd

            try:
                payload = response.json()
            except LLMError as exc:
                log.error("Batch %d javobi JSON emas: %s", index, exc)
                log_error("rank", str(exc), context=f"batch {index} JSON")
                report.failed += len(batch)
                report.failed_batches.append(f"batch {index}: JSON xatosi")
                continue

            scores, problems = _parse_results(payload, batch_ids)
            for problem in problems:
                log.warning("Batch %d: %s", index, problem)

            # Javobga tushmagan klasterlar `new` bo'lib qoladi — keyingi
            # ishga tushishda qayta urinib ko'riladi
            report.failed += len(batch_ids - scores.keys())

            if not scores:
                report.failed_batches.append(f"batch {index}: yaroqli natija yo'q")
                continue

            if dry_run:
                _print_dry_run(batch, scores, min_importance)
                report.processed += len(scores)
                # Bazaga yozilmaydi, lekin hisobot haqiqiy natijani ko'rsatsin
                for score in scores.values():
                    if _verdict(score, min_importance) == "rejected":
                        report.rejected += 1
                        report.spam += int(score["is_spam"])
                    else:
                        report.ranked += 1
                continue

            ranked, rejected, spam = _apply_scores(scores, min_importance=min_importance)
            report.processed += len(scores)
            report.ranked += ranked
            report.rejected += rejected
            report.spam += spam

            log.info(
                "Batch %d/%d: %d baholandi (%d qabul, %d rad), $%.5f",
                index,
                -(-len(clusters) // batch_size),
                len(scores),
                ranked,
                rejected,
                response.cost_usd,
            )

    log.info("Rank: %s", report.summary())
    return report


def _print_dry_run(
    batch: list[dict[str, Any]], scores: dict[int, dict[str, Any]], min_importance: float
) -> None:
    """Dry-run rejimida natijani ekranga chiqarish."""
    titles = {int(c["id"]): c["title"] for c in batch}
    for cluster_id, score in scores.items():
        if score["is_spam"]:
            verdict = "SPAM"
        else:
            verdict = "RAD" if _verdict(score, min_importance) == "rejected" else "QABUL"
        print(
            f"[{cluster_id:>5}] {verdict:<5} "
            f"muh {score['importance_score']:>4.1f} / mos {score['relevance_score']:>4.1f} "
            f"{score['category']:<14} {titles.get(cluster_id, '')[:44]}"
        )
        if score["rank_reason"]:
            print(f"         └ {score['rank_reason']}")


def ranked_clusters(limit: int = 20, *, min_relevance: float = 0.0) -> list[dict[str, Any]]:
    """Baholangan va qabul qilingan klasterlar — Writer bosqichi uchun navbat.

    Tartib: muhimlik va moslik yig'indisi bo'yicha.
    """
    rows = query(
        """
        SELECT c.id, c.title, c.importance_score, c.relevance_score,
               c.category, c.rank_reason, c.item_count, i.url, i.source
        FROM clusters c
        JOIN items i ON i.id = c.primary_item_id
        WHERE c.status = 'ranked' AND c.relevance_score >= ?
        ORDER BY (c.importance_score + c.relevance_score) DESC, c.created_at DESC
        LIMIT ?
        """,
        (min_relevance, limit),
    )
    return [dict(r) for r in rows]
