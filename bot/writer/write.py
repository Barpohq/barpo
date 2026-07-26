"""Klasterlardan o'zbekcha post yozish.

Boyitilgan klaster → kuchli model → tekshiruv → `posts` jadvali.

Tekshiruvdan o'tmagan post modelga feedback bilan qaytariladi: nima
noto'g'ri bo'lgani aytilib, qayta yozdiriladi. Ikki urinishdan keyin ham
o'tmasa klaster `write_failed` bo'ladi va qo'lda ko'rib chiqiladi.

Idempotentlik: klaster uchun `draft` yoki undan keyingi statusdagi post
bo'lsa qayta yozilmaydi — LLM xarajati takrorlanmasin.
"""

from __future__ import annotations

import traceback
from dataclasses import dataclass, field
from typing import Any

from bot.config import load_config
from bot.enricher import enriched_clusters
from bot.writer.prompts import SYSTEM_PROMPT, build_write_prompt, signature_length
from bot.writer.validator import append_signature, validate_post
from core.db import execute, log_error, query, query_one, transaction, utc_now
from core.llm import CostLimitExceeded, LLMClient, LLMError
from core.logging_setup import get_logger

log = get_logger(__name__)

# Tekshiruvdan o'tmasa nechta marta qayta yozdiriladi
MAX_ATTEMPTS = 2

# Shundan qisqa manba matnidan sifatli post chiqmaydi.
#
# 2026-07-26 kuzatuvi: boyitilmagan klaster (feed anonsi, 119 belgi) uchun
# yozilgan post umumiy gaplardan iborat bo'ldi — "samaradorlik oshirilgan",
# "unumdorlik yuqori", birorta aniq raqamsiz. Model xato qilmagan: bor
# ma'lumotdan maksimal olgan va hech narsa o'ylab topmagan. Muammo kirishda,
# shuning uchun bunday klaster Writer'ga umuman kiritilmaydi.
MIN_SOURCE_TEXT = 400


@dataclass(slots=True)
class WriteReport:
    processed: int = 0
    written: int = 0
    failed: int = 0
    retried: int = 0
    cost_usd: float = 0.0
    problems: list[str] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"{self.processed} klaster: {self.written} post yozildi, "
            f"{self.failed} muvaffaqiyatsiz, {self.retried} qayta urinish, "
            f"${self.cost_usd:.5f}"
        )


# ─────────────────────────── Navbat ───────────────────────────


def _pending_clusters(limit: int, cluster_id: int | None = None) -> list[dict[str, Any]]:
    """Post yozilmagan, boyitilgan klasterlar.

    `enriched_clusters()` navbatni baho bo'yicha tartiblab beradi; bu yerda
    allaqachon posti borlarini chiqarib tashlaymiz.

    `cluster_id` berilsa faqat o'sha klaster qaytariladi (sinov uchun) —
    posti bor bo'lsa ham, chunki bu qasddan qayta yozish.
    """
    if cluster_id is not None:
        found = [c for c in enriched_clusters(limit=1000) if int(c["id"]) == cluster_id]
        if not found:
            log.warning(
                "Klaster %d navbatda yo'q — u `ranked` va boyitilgan bo'lishi kerak",
                cluster_id,
            )
        elif len(str(found[0].get("text") or "").strip()) < MIN_SOURCE_TEXT:
            # Aniq so'ralgani uchun to'xtatmaymiz, faqat ogohlantiramiz
            log.warning(
                "Klaster %d manba matni qisqa — post umumiy chiqishi mumkin",
                cluster_id,
            )
        return found

    candidates = enriched_clusters(limit=limit * 4)
    if not candidates:
        return []

    # Matni yetarli bo'lmagan klasterlar chiqarib tashlanadi — ulardan
    # faqat umumiy gaplardan iborat post chiqadi (MIN_SOURCE_TEXT izohi)
    usable: list[dict[str, Any]] = []
    for cluster in candidates:
        text_length = len(str(cluster.get("text") or "").strip())
        if text_length < MIN_SOURCE_TEXT:
            log.info(
                "Klaster %s o'tkazib yuborildi: manba matni qisqa (%d < %d belgi)",
                cluster.get("id"),
                text_length,
                MIN_SOURCE_TEXT,
            )
            continue
        usable.append(cluster)

    if not usable:
        return []

    ids = [int(c["id"]) for c in usable]
    placeholders = ",".join("?" * len(ids))
    rows = query(
        f"SELECT DISTINCT cluster_id FROM posts WHERE cluster_id IN ({placeholders})",
        ids,
    )
    written = {int(r["cluster_id"]) for r in rows}

    return [c for c in usable if int(c["id"]) not in written][:limit]


# ─────────────────────────── Yozish ───────────────────────────


def _write_one(
    cluster: dict[str, Any],
    channel: dict[str, Any],
    client: LLMClient,
    *,
    budget: int,
    max_length: int,
) -> tuple[str, str, float, int]:
    """Bitta post yozish. (matn, model, xarajat, urinishlar) qaytaradi.

    Tekshiruvdan o'tmasa feedback bilan qayta urinadi. Barcha urinishlar
    muvaffaqiyatsiz bo'lsa LLMError.
    """
    cluster_id = int(cluster["id"])
    feedback = ""
    total_cost = 0.0
    last_errors: list[str] = []
    model = ""

    for attempt in range(1, MAX_ATTEMPTS + 1):
        response = client.complete(
            "write",
            prompt=build_write_prompt(cluster, channel, budget=budget, feedback=feedback),
            system=SYSTEM_PROMPT,
            cluster_id=cluster_id,
        )
        total_cost += response.cost_usd
        model = response.model

        result = validate_post(
            response.text,
            channel=channel,
            max_length=budget,
            expected_link=str(cluster.get("link") or ""),
        )

        for warning in result.warnings:
            log.warning("Klaster %d: %s", cluster_id, warning)

        if result.ok:
            final = append_signature(result.text, channel)
            # Imzo qo'shilgandan keyin ham chegarada qolishi kerak
            if len(final) > max_length:
                last_errors = [
                    f"Imzo bilan birga {len(final)} belgi bo'ldi, ruxsat {max_length}"
                ]
                feedback = "\n".join(f"- {e}" for e in last_errors)
                log.warning("Klaster %d: imzo bilan chegaradan oshdi", cluster_id)
                continue
            return final, model, total_cost, attempt

        last_errors = result.errors
        feedback = result.feedback()
        log.warning(
            "Klaster %d, urinish %d tekshiruvdan o'tmadi: %s",
            cluster_id,
            attempt,
            "; ".join(result.errors),
        )

    raise LLMError(f"{MAX_ATTEMPTS} urinishdan keyin ham: {'; '.join(last_errors)}")


def _save_post(cluster: dict[str, Any], text: str, model: str) -> int:
    """Postni bazaga yozish va klaster statusini yangilash."""
    cluster_id = int(cluster["id"])
    image = cluster.get("article_image") or None

    with transaction():
        cursor = execute(
            "INSERT INTO posts (cluster_id, body, image_url, model, created_at, status) "
            "VALUES (?, ?, ?, ?, ?, 'draft')",
            (cluster_id, text, image, model, utc_now()),
        )
        execute(
            "UPDATE clusters SET status = 'written', updated_at = ? WHERE id = ?",
            (utc_now(), cluster_id),
        )
    return int(cursor.lastrowid or 0)


# ─────────────────────────── Asosiy oqim ───────────────────────────


def run_write(*, limit: int = 5, cluster_id: int | None = None) -> WriteReport:
    """Navbatdagi klasterlar uchun post yozish.

    `limit` — maksimal nechta post (kuchli model qimmat, ehtiyot bo'lamiz).
    `cluster_id` — faqat shu klaster uchun (sinov uchun, qayta yozadi).
    """
    report = WriteReport()
    config = load_config()
    channel = config.channel

    clusters = _pending_clusters(limit, cluster_id)
    if not clusters:
        log.info("Post yozishga klaster yo'q")
        return report

    fmt = channel.get("format") or {}
    max_length = int(fmt.get("max_length", 1024))
    # Imzoni Publisher qo'shadi — model uchun byudjet shuncha kam
    budget = max_length - signature_length(channel)

    log.info(
        "Writer: %d klaster (byudjet %d belgi, imzo %d)",
        len(clusters),
        budget,
        max_length - budget,
    )

    with LLMClient(config.models) as client:
        for cluster in clusters:
            cluster_id = int(cluster["id"])
            report.processed += 1

            try:
                text, model, cost, attempts = _write_one(
                    cluster, channel, client, budget=budget, max_length=max_length
                )
            except CostLimitExceeded as exc:
                log.error("Writer to'xtatildi: %s", exc)
                log_error("writer", str(exc), context=f"cluster {cluster_id}")
                report.problems.append(f"xarajat limiti: {exc}")
                break
            except LLMError as exc:
                log.error("Klaster %d uchun post yozilmadi: %s", cluster_id, exc)
                log_error(
                    "writer",
                    str(exc),
                    context=f"cluster {cluster_id}",
                    traceback=traceback.format_exc(),
                )
                execute(
                    "UPDATE clusters SET status = 'write_failed', updated_at = ? WHERE id = ?",
                    (utc_now(), cluster_id),
                )
                report.failed += 1
                report.problems.append(f"klaster {cluster_id}: {exc}")
                continue
            except Exception as exc:  # noqa: BLE001 — bitta klaster oqimni to'xtatmasin
                log.exception("Klaster %d uchun kutilmagan xato", cluster_id)
                log_error(
                    "writer",
                    str(exc),
                    context=f"cluster {cluster_id}",
                    traceback=traceback.format_exc(),
                )
                report.failed += 1
                continue

            report.cost_usd += cost
            if attempts > 1:
                report.retried += 1

            post_id = _save_post(cluster, text, model)
            report.written += 1
            log.info(
                "Klaster %d → post #%d (%d belgi, %s, %d urinish)",
                cluster_id,
                post_id,
                len(text),
                model,
                attempts,
            )

    log.info("Writer: %s", report.summary())
    return report


def draft_posts(limit: int = 20) -> list[dict[str, Any]]:
    """Tasdiq kutayotgan postlar — Publisher bosqichi uchun navbat."""
    rows = query(
        """
        SELECT p.id, p.cluster_id, p.body, p.image_url, p.model, p.created_at,
               c.title, c.category, c.importance_score
        FROM posts p
        JOIN clusters c ON c.id = p.cluster_id
        WHERE p.status = 'draft'
        ORDER BY c.importance_score DESC, p.created_at
        LIMIT ?
        """,
        (limit,),
    )
    return [dict(r) for r in rows]


def post_detail(post_id: int) -> dict[str, Any] | None:
    """Bitta post haqida to'liq ma'lumot (CLI uchun)."""
    row = query_one(
        """
        SELECT p.*, c.title AS cluster_title, c.category, c.importance_score,
               c.article_url, c.enrich_source
        FROM posts p
        JOIN clusters c ON c.id = p.cluster_id
        WHERE p.id = ?
        """,
        (post_id,),
    )
    return dict(row) if row else None
