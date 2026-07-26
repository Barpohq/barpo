"""Klasterlarni to'liq matn bilan boyitish.

Feed'lardagi matn qisqa (o'rtacha ~130 belgi), Writer uchun yetarli emas.
Bu bosqich har bir `ranked` klaster uchun to'liq maqola matnini topadi.

Ikki yo'l — klaster turiga qarab avtomatik tanlanadi:

  fetch   Aniq maqola URL'i bor (rasmiy bloglar, HN) → sahifa ochiladi.
  search  Faqat nashriyot domeni bor (Google News agregatori) → sarlavha
          bo'yicha qidiriladi, natijadan aniq URL va matn olinadi.

Idempotentlik: `enriched_at` to'ldirilgan klaster qayta ishlanmaydi.
Boyitib bo'lmagan klaster ham `enriched` bo'ladi (`enrich_source='none'`)
— aks holda har siklda qayta urinib, xarajat va vaqt behuda ketadi.
"""

from __future__ import annotations

import traceback
from dataclasses import dataclass, field
from typing import Any

from rapidfuzz import fuzz

from bot.db import execute, log_error, query, utc_now
from bot.dedup import publisher_url
from bot.dedup.versions import extract_model_ids, models_conflict, versions_conflict
from bot.enricher.fetcher import MIN_USEFUL_TEXT, FetchError, clean_markdown, fetch_article
from bot.enricher.search import (
    SearchClient,
    SearchError,
    SearchResult,
    SearchUnavailable,
    is_configured,
)
from bot.logging_setup import get_logger

log = get_logger(__name__)

# Agregator havolasi — aniq maqola emas, qidiruv kerak
AGGREGATOR_MARKER = "news.google.com"

# Qidiruv natijasi shu balldan past bo'lsa ishonchsiz deb qaraladi
MIN_SEARCH_SCORE = 0.5

# Sarlavhalar umuman aloqasiz bo'lsa rad etiladi. Chegara past qo'yilgan:
# bir voqea haqidagi qayta hikoyalar butunlay boshqacha yoziladi
# ("launches Claude Opus 5" ↔ "releases new model, Opus 5" = 53 ball),
# shuning uchun sarlavha o'xshashligi faqat qo'pol filtr bo'la oladi.
# Aniq ajratishni model identifikatori qiladi (_model_conflict).
MIN_TITLE_MATCH = 45.0


@dataclass(slots=True)
class EnrichReport:
    processed: int = 0
    by_fetch: int = 0
    by_search: int = 0
    failed: int = 0
    search_credits: int = 0
    problems: list[str] = field(default_factory=list)

    @property
    def enriched(self) -> int:
        return self.by_fetch + self.by_search

    def summary(self) -> str:
        return (
            f"{self.processed} klaster ishlandi: {self.enriched} boyitildi "
            f"({self.by_fetch} fetch, {self.by_search} search), "
            f"{self.failed} muvaffaqiyatsiz"
        )


# ─────────────────────────── Ma'lumot olish ───────────────────────────


def _fetch_pending(limit: int) -> list[dict[str, Any]]:
    """Boyitilmagan `ranked` klasterlar — eng yuqori baholilar birinchi."""
    rows = query(
        """
        SELECT c.id, c.title, c.importance_score, c.relevance_score,
               i.url, i.extra, i.content, i.summary, i.image_url, i.published_at
        FROM clusters c
        JOIN items i ON i.id = c.primary_item_id
        WHERE c.status = 'ranked' AND c.enriched_at IS NULL
        ORDER BY (c.importance_score + c.relevance_score) DESC, c.created_at DESC
        LIMIT ?
        """,
        (limit,),
    )
    return [dict(r) for r in rows]


def _needs_search(cluster: dict[str, Any]) -> bool:
    """Klasterda aniq maqola URL'i bormi.

    Agregator havolasi maqolaga olib bormaydi (redirect JavaScript orqali),
    nashriyot esa faqat domen sifatida ma'lum — ikkalasi ham fetch uchun
    yaroqsiz.
    """
    url = str(cluster.get("url") or "")
    return AGGREGATOR_MARKER in url


# ─────────────────────────── Boyitish usullari ───────────────────────────


def _enrich_by_fetch(cluster: dict[str, Any]) -> tuple[str, str, str] | None:
    """Sahifani ochib matn olish. (matn, url, rasm) yoki None."""
    url = str(cluster["url"])
    try:
        article = fetch_article(url)
    except FetchError as exc:
        log.debug("Klaster %s: fetch xatosi: %s", cluster["id"], exc)
        return None

    if not article.is_useful:
        log.debug("Klaster %s: sahifadan yetarli matn chiqmadi", cluster["id"])
        return None

    return article.text, article.url, article.image_url


def _title_matches(cluster_title: str, result_title: str) -> bool:
    """Natija sarlavhasi klasterning yangiligiga tegishlimi.

    Sarlavha o'xshashligining o'zi bu vazifani hal qilmaydi — 2026-07-26
    kalibrlashida to'g'ri juftliklar 50-64 ball, noto'g'rilari 72-76 ball
    olgan, ya'ni ular ustma-ust tushadi. Sabab: bir voqea haqidagi qayta
    hikoyalar boshqacha yoziladi, "Opus 5" va "Sonnet 5" esa leksik
    jihatdan deyarli bir xil.

    Shuning uchun asosiy signal — model identifikatori:
      1. Model konflikti — Opus 5 o'rniga Sonnet 5 kelishini rad etadi
      2. Versiya konflikti — Opus 5 o'rniga Opus 4.7 kelishini rad etadi
      3. Fuzzy o'xshashlik — modeli yo'q yangiliklar uchun qo'pol filtr
    """
    if models_conflict(cluster_title, result_title):
        return False
    if versions_conflict(cluster_title, result_title):
        return False

    # Ikkalasida ham bir xil model — bu yetarli dalil, sarlavha qanday
    # yozilganidan qat'i nazar ("GPT-5.6: Frontier intelligence" ↔
    # "GPT-5.6 is here" atigi 39 ball oladi, lekin bir voqea haqida).
    if extract_model_ids(cluster_title) & extract_model_ids(result_title):
        return True

    return fuzz.token_set_ratio(cluster_title, result_title) >= MIN_TITLE_MATCH


def _pick_search_result(
    results: list[SearchResult], cluster: dict[str, Any]
) -> SearchResult | None:
    """Qidiruv natijalaridan eng mosini tanlash.

    Tavily balli o'zi yetarli emas (yuqoridagi MIN_TITLE_MATCH izohiga
    qarang) — sarlavha mosligini ham talab qilamiz. Noto'g'ri maqola
    matni bilan post yozilgandan ko'ra boyitmasdan qoldirgan yaxshiroq.
    """
    cluster_title = str(cluster.get("title") or "")
    # Agregator sarlavhasidagi " - Nashriyot" qo'shimchasi taqqoslashga xalaqit
    if " - " in cluster_title:
        cluster_title = cluster_title.rsplit(" - ", 1)[0]

    for result in results:
        if result.score < MIN_SEARCH_SCORE:
            continue
        if not result.best_text.strip():
            continue
        if cluster_title and not _title_matches(cluster_title, result.title):
            log.debug(
                "Klaster %s: natija rad etildi (sarlavha mos emas): %r",
                cluster.get("id"),
                result.title[:60],
            )
            continue
        return result
    return None


def _enrich_by_search(
    cluster: dict[str, Any], client: SearchClient
) -> tuple[str, str, str] | None:
    """Sarlavha bo'yicha qidirib matn olish. (matn, url, rasm) yoki None."""
    title = str(cluster["title"])
    # Google News sarlavhasi " - Nashriyot" bilan tugaydi — qidiruvga xalaqit
    query_text = title.rsplit(" - ", 1)[0] if " - " in title else title

    # Domen cheklovisiz qidiramiz. `include_domains` bilan Tavily o'sha
    # domendagi eng yaqin maqolani qaytaradi — mavzu boshqa bo'lsa ham
    # (sinovda "Claude Opus 5" so'roviga Sonnet 5 sahifasi kelgan).
    # To'g'ri maqolani sarlavha mosligi ajratadi, domen emas.
    results = client.search(query_text)
    chosen = _pick_search_result(results, cluster)

    if chosen is None:
        return None

    # Tavily sahifaning to'liq markdown nusxasini beradi — navigatsiya va
    # havolalar ro'yxati bilan. Fetch yo'lidagi kabi tozalash kerak.
    text = clean_markdown(chosen.best_text)
    if len(text) < MIN_USEFUL_TEXT:
        log.debug("Klaster %s: qidiruv matni tozalashdan keyin qisqa", cluster["id"])
        return None

    return text, chosen.url, ""


# ─────────────────────────── Bazaga yozish ───────────────────────────


def _save(
    cluster_id: int,
    *,
    text: str,
    article_url: str,
    image_url: str,
    source: str,
) -> None:
    execute(
        """
        UPDATE clusters
        SET enriched_text = ?, article_url = ?, article_image = ?,
            enrich_source = ?, enriched_at = ?, updated_at = ?
        WHERE id = ?
        """,
        (
            text or None,
            article_url or None,
            image_url or None,
            source,
            utc_now(),
            utc_now(),
            cluster_id,
        ),
    )


def _mark_failed(cluster_id: int) -> None:
    """Boyitib bo'lmadi — belgilab qo'yamiz, qayta urinilmasin.

    Klaster `ranked` bo'lib qoladi: Writer uni feed'dagi qisqa matn bilan
    ham yoza oladi, faqat sifati pastroq bo'ladi.
    """
    _save(cluster_id, text="", article_url="", image_url="", source="none")


# ─────────────────────────── Asosiy oqim ───────────────────────────


def run_enrich(*, limit: int = 20, use_search: bool = True) -> EnrichReport:
    """Boyitilmagan klasterlarni to'liq matn bilan to'ldirish.

    `limit` — maksimal nechta klaster (qidiruv krediti nazorati).
    `use_search` — False bo'lsa faqat fetch ishlaydi, agregator
    klasterlari o'tkazib yuboriladi.
    """
    report = EnrichReport()

    pending = _fetch_pending(limit)
    if not pending:
        log.info("Boyitishga klaster yo'q")
        return report

    search_client: SearchClient | None = None

    if use_search:
        if not is_configured():
            needs = sum(1 for c in pending if _needs_search(c))
            log.warning(
                "TAVILY_API_KEY yo'q — %d ta agregator klasteri boyitilmaydi va "
                "fetch ishlamagan holatlarda zaxira yo'q. Kalitni .env ga qo'shing.",
                needs,
            )
        else:
            try:
                search_client = SearchClient()
            except SearchUnavailable as exc:
                log.warning("Qidiruv ishlamaydi: %s", exc)

    log.info("Enricher: %d klaster (qidiruv: %s)", len(pending), "ha" if search_client else "yo'q")

    try:
        for cluster in pending:
            cluster_id = int(cluster["id"])
            report.processed += 1
            result: tuple[str, str, str] | None = None
            method = "none"

            try:
                if not _needs_search(cluster):
                    result = _enrich_by_fetch(cluster)
                    method = "fetch"

                # Aniq URL bo'lmasa yoki fetch ishlamasa (403, JS render,
                # matn qisqa) — qidiruvga tushamiz. Ko'p rasmiy sayt
                # botlarni bloklaydi, qidiruv esa ularning matnini biladi.
                if result is None and search_client is not None:
                    result = _enrich_by_search(cluster, search_client)
                    method = "search"
                    report.search_credits += 1
            except SearchUnavailable as exc:
                # Limit tugadi — qolgan klasterlar uchun qidiruvni o'chiramiz
                log.warning("Qidiruv to'xtatildi: %s", exc)
                report.problems.append(f"qidiruv to'xtadi: {exc}")
                search_client.close() if search_client else None
                search_client = None
                result = None
            except SearchError as exc:
                log.warning("Klaster %d: qidiruv xatosi: %s", cluster_id, exc)
                report.problems.append(f"klaster {cluster_id}: {exc}")
                result = None
            except Exception as exc:  # noqa: BLE001 — bitta klaster oqimni to'xtatmasin
                log.exception("Klaster %d boyitilmadi", cluster_id)
                log_error(
                    "enricher",
                    str(exc),
                    context=f"cluster {cluster_id}",
                    traceback=traceback.format_exc(),
                )
                result = None

            if result is None:
                _mark_failed(cluster_id)
                report.failed += 1
                continue

            text, article_url, image_url = result
            _save(
                cluster_id,
                text=text,
                article_url=article_url,
                # Feed'dagi rasm bo'lsa uni afzal ko'ramiz (odatda aniqroq)
                image_url=image_url or str(cluster.get("image_url") or ""),
                source=method,
            )
            if method == "search":
                report.by_search += 1
            else:
                report.by_fetch += 1

            log.info(
                "Klaster %d boyitildi (%s): %d belgi",
                cluster_id,
                method,
                len(text),
            )
    finally:
        if search_client is not None:
            search_client.close()

    log.info("Enricher: %s", report.summary())
    return report


def enriched_clusters(limit: int = 20) -> list[dict[str, Any]]:
    """Boyitilgan klasterlar — Writer bosqichi uchun navbat."""
    rows = query(
        """
        SELECT c.id, c.title, c.importance_score, c.relevance_score, c.category,
               c.enriched_text, c.article_url, c.article_image, c.enrich_source,
               c.item_count, i.url, i.extra, i.content, i.summary
        FROM clusters c
        JOIN items i ON i.id = c.primary_item_id
        WHERE c.status = 'ranked' AND c.enriched_at IS NOT NULL
        ORDER BY (c.importance_score + c.relevance_score) DESC, c.created_at DESC
        LIMIT ?
        """,
        (limit,),
    )
    queue = [dict(r) for r in rows]
    for cluster in queue:
        # Post havolasi: aniq maqola > nashriyot > asl havola
        cluster["link"] = cluster["article_url"] or publisher_url(cluster)
        # Writer uchun matn: boyitilgan > feed matni
        cluster["text"] = cluster["enriched_text"] or cluster["content"] or cluster["summary"] or ""
    return queue
