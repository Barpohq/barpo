"""Ikki bosqichli deduplication.

1-bosqich (arzon): URL normalizatsiya + sarlavha fuzzy match.
   Aynan bir xil elementlar shu yerda tushib qoladi — embedding hisoblanmaydi.

2-bosqich (semantik): embedding + cosine similarity klasterlash.
   "GPT-5 chiqdi" haqidagi turli manbalardagi postlar bitta klasterga tushadi.

Muhim: dedup faqat bugungi emas, oxirgi N kunlik yangiliklar bilan
solishtiradi — eski yangilikni yangi deb chiqarish xatosining oldini olish uchun
(04-xavflar.md, X3).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
from rapidfuzz import fuzz

from bot.db import execute, query, query_one, utc_now
from bot.dedup.embeddings import embed_items
from bot.dedup.versions import versions_conflict
from core.logging_setup import get_logger

log = get_logger(__name__)

# Sarlavhalar shu foizdan yuqori o'xshash bo'lsa — aynan bir xil deb qaraladi
TITLE_FUZZY_THRESHOLD = 90.0
# Cosine similarity shu qiymatdan yuqori bo'lsa — bitta klasterga
SEMANTIC_THRESHOLD = 0.82
# Manbaning ishonchliligi: klaster ichida asosiy elementni tanlashda
DEFAULT_WEIGHT = 0.5


@dataclass(slots=True)
class DedupReport:
    processed: int = 0
    new_clusters: int = 0
    merged_into_existing: int = 0
    exact_duplicates: int = 0

    def summary(self) -> str:
        return (
            f"{self.processed} element ishlandi, {self.new_clusters} yangi klaster, "
            f"{self.merged_into_existing} mavjudga qo'shildi, "
            f"{self.exact_duplicates} aynan dublikat"
        )


def _normalize_title(title: str) -> str:
    """Fuzzy taqqoslash uchun sarlavhani soddalashtirish.

    Google News uslubidagi " - Manba nomi" qo'shimchasi olib tashlanadi —
    aks holda bir xil maqola turli nashrlarda boshqacha ko'rinadi.
    """
    text = title.strip().lower()
    # " - CNN", " | TechCrunch" kabi qo'shimchalar
    for sep in (" - ", " | ", " — "):
        if sep in text:
            head, _, tail = text.rpartition(sep)
            # Faqat qisqa qo'shimcha bo'lsa kesamiz (manba nomi, sarlavha emas)
            if head and len(tail) < 30:
                text = head
    return " ".join(text.split())


def _recent_window(days: int) -> str:
    return (datetime.now(UTC) - timedelta(days=days)).isoformat(timespec="seconds")


def _fetch_unclustered() -> list[dict[str, Any]]:
    rows = query(
        """
        SELECT i.id, i.source, i.title, i.content, i.summary, i.url, i.extra,
               i.published_at, i.fetched_at
        FROM items i
        WHERE i.status = 'raw'
          AND NOT EXISTS (SELECT 1 FROM cluster_items ci WHERE ci.item_id = i.id)
        ORDER BY COALESCE(i.published_at, i.fetched_at) DESC
        """
    )
    return [dict(r) for r in rows]


def _fetch_window_items(days: int) -> list[dict[str, Any]]:
    """Klasterlangan, oynadagi elementlar — yangi kelganlar shular bilan solishtiriladi."""
    since = _recent_window(days)
    rows = query(
        """
        SELECT i.id, i.title, ci.cluster_id
        FROM items i
        JOIN cluster_items ci ON ci.item_id = i.id
        JOIN clusters c ON c.id = ci.cluster_id
        WHERE COALESCE(i.published_at, i.fetched_at) >= ?
        """,
        (since,),
    )
    return [dict(r) for r in rows]


def _source_weight(source: str, weights: dict[str, float]) -> float:
    return weights.get(source, DEFAULT_WEIGHT)


# Rasmiy e'lon manbalari — klaster ichida shular asosiy bo'lishi afzal.
# Google News agregatsiyasida rasmiy blog va qayta hikoya qiluvchi nashrlar
# aralash keladi; o'quvchiga birlamchi manbani ko'rsatgan ma'qul.
OFFICIAL_DOMAINS = (
    "anthropic.com",
    "openai.com",
    "deepmind.google",
    "blog.google",
    "ai.meta.com",
    "mistral.ai",
    "huggingface.co",
)


def publisher_url(item: dict[str, Any]) -> str:
    """Elementning haqiqiy nashriyot URL'i.

    Agregatordan (Google News) kelgan elementda `url` — redirect havolasi,
    haqiqiy nashriyot esa collector saqlagan `extra.publisher_url` da.
    """
    raw_extra = item.get("extra")
    if raw_extra:
        try:
            extra = json.loads(raw_extra) if isinstance(raw_extra, str) else raw_extra
        except (TypeError, ValueError, json.JSONDecodeError):
            extra = None
        if isinstance(extra, dict) and (found := extra.get("publisher_url")):
            return str(found)
    return str(item.get("url") or "")


def _is_official(item: dict[str, Any]) -> bool:
    url = publisher_url(item).lower()
    return any(domain in url for domain in OFFICIAL_DOMAINS)


def _pick_primary(
    members: list[dict[str, Any]], weights: dict[str, float]
) -> dict[str, Any]:
    """Klaster ichida "asosiy" elementni tanlash.

    Tartib: rasmiy manba → manba ishonchliligi (weight) → matn to'liqligi →
    eskiroq nashr (original odatda birinchi chiqaradi).
    """

    def sort_key(item: dict[str, Any]) -> tuple[int, float, int, float]:
        return (
            int(_is_official(item)),
            _source_weight(item["source"], weights),
            len(item.get("content") or item.get("summary") or ""),
            -_date_key(item),  # eskiroq = kattaroq qiymat
        )

    return max(members, key=sort_key)


def _date_key(item: dict[str, Any]) -> float:
    raw = item.get("published_at") or item.get("fetched_at")
    if not raw:
        return 0.0
    try:
        return datetime.fromisoformat(raw).timestamp()
    except ValueError:
        return 0.0


# ─────────────────────────── Klaster yozish ───────────────────────────


def _create_cluster(members: list[dict[str, Any]], weights: dict[str, float]) -> int:
    """Yangi klaster yaratish va elementlarni bog'lash."""
    primary = _pick_primary(members, weights)
    now = utc_now()

    cursor = execute(
        "INSERT INTO clusters (primary_item_id, title, created_at, updated_at, item_count) "
        "VALUES (?, ?, ?, ?, ?)",
        (primary["id"], primary["title"], now, now, len(members)),
    )
    cluster_id = int(cursor.lastrowid or 0)

    for member in members:
        execute(
            "INSERT OR IGNORE INTO cluster_items (cluster_id, item_id, similarity, is_primary) "
            "VALUES (?, ?, ?, ?)",
            (
                cluster_id,
                member["id"],
                member.get("_similarity"),
                int(member["id"] == primary["id"]),
            ),
        )
        execute("UPDATE items SET status = 'clustered' WHERE id = ?", (member["id"],))

    return cluster_id


def _add_to_cluster(cluster_id: int, item: dict[str, Any], similarity: float | None) -> None:
    execute(
        "INSERT OR IGNORE INTO cluster_items (cluster_id, item_id, similarity, is_primary) "
        "VALUES (?, ?, ?, 0)",
        (cluster_id, item["id"], similarity),
    )
    execute("UPDATE items SET status = 'clustered' WHERE id = ?", (item["id"],))
    execute(
        "UPDATE clusters SET item_count = ("
        "  SELECT COUNT(*) FROM cluster_items WHERE cluster_id = ?"
        "), updated_at = ? WHERE id = ?",
        (cluster_id, utc_now(), cluster_id),
    )


# ─────────────────────────── Asosiy oqim ───────────────────────────


def run_dedup(window_days: int = 7) -> DedupReport:
    """Klasterlanmagan elementlarni klasterlash.

    `window_days` — necha kunlik tarix bilan solishtiriladi.
    """
    from bot.config import load_config

    report = DedupReport()
    pending = _fetch_unclustered()
    if not pending:
        log.info("Klasterlanmagan element yo'q")
        return report

    report.processed = len(pending)
    weights = {s.name: s.weight for s in load_config().sources}

    # ── 1-bosqich: oynadagi mavjud klasterlar bilan fuzzy taqqoslash ──
    window_items = _fetch_window_items(window_days)
    window_titles = [(w["cluster_id"], _normalize_title(w["title"])) for w in window_items]

    remaining: list[dict[str, Any]] = []
    for item in pending:
        norm_title = _normalize_title(item["title"])
        matched_cluster = None
        for cluster_id, other_title in window_titles:
            if fuzz.token_set_ratio(norm_title, other_title) < TITLE_FUZZY_THRESHOLD:
                continue
            # Turli model versiyalari (Opus 5 vs Opus 4.7) birlashmasligi kerak
            if versions_conflict(item["title"], other_title):
                continue
            matched_cluster = cluster_id
            break

        if matched_cluster is not None:
            _add_to_cluster(matched_cluster, item, similarity=None)
            report.exact_duplicates += 1
            # Yangi qo'shilgan element ham keyingi taqqoslashlarda qatnashadi
            window_titles.append((matched_cluster, norm_title))
        else:
            remaining.append(item)

    if not remaining:
        log.info("Dedup: %s", report.summary())
        return report

    # ── 2-bosqich: semantik klasterlash ──
    vectors = embed_items(remaining)
    # Mavjud klasterlar bilan ham semantik taqqoslash uchun ularning vektorlari
    existing_vectors, existing_cluster_ids, existing_titles = _load_window_vectors(window_days)

    # Yangi elementlar orasida klasterlash (greedy: birinchi mos kelganga qo'shiladi)
    groups: list[list[dict[str, Any]]] = []
    group_vectors: list[np.ndarray] = []
    group_titles: list[str] = []

    for item in remaining:
        vec = vectors.get(int(item["id"]))
        if vec is None:
            groups.append([item])
            continue

        title = item["title"]

        # Avval mavjud klasterlarga tegishlimi? (versiya konflikti bo'lmaganlar orasidan)
        if existing_vectors.size:
            sims = existing_vectors @ vec
            # O'xshashlik bo'yicha kamayish tartibida ko'rib chiqamiz — eng yaqini
            # versiya konflikti tufayli rad etilsa, keyingisi tekshiriladi
            merged = False
            for idx in np.argsort(-sims):
                score = float(sims[idx])
                if score < SEMANTIC_THRESHOLD:
                    break
                if versions_conflict(title, existing_titles[int(idx)]):
                    continue
                _add_to_cluster(existing_cluster_ids[int(idx)], item, similarity=score)
                report.merged_into_existing += 1
                merged = True
                break
            if merged:
                continue

        # Shu siklda yaratilgan guruhlarga tegishlimi?
        placed = False
        for idx, centroid in enumerate(group_vectors):
            score = float(centroid @ vec)
            if score < SEMANTIC_THRESHOLD:
                continue
            if versions_conflict(title, group_titles[idx]):
                continue
            item["_similarity"] = score
            groups[idx].append(item)
            placed = True
            break

        if not placed:
            groups.append([item])
            group_vectors.append(vec)
            group_titles.append(title)

    for members in groups:
        _create_cluster(members, weights)
        report.new_clusters += 1

    log.info("Dedup: %s", report.summary())
    return report


def _load_window_vectors(window_days: int) -> tuple[np.ndarray, list[int], list[str]]:
    """Oynadagi klasterlarning asosiy elementlari: vektor, klaster id, sarlavha."""
    since = _recent_window(window_days)
    rows = query(
        """
        SELECT c.id AS cluster_id, c.title, e.vector
        FROM clusters c
        JOIN items i ON i.id = c.primary_item_id
        JOIN embeddings e ON e.item_id = i.id
        WHERE COALESCE(i.published_at, i.fetched_at) >= ?
        """,
        (since,),
    )
    if not rows:
        return np.empty((0, 0), dtype=np.float32), [], []

    vectors = np.stack([np.frombuffer(r["vector"], dtype=np.float32) for r in rows])
    cluster_ids = [int(r["cluster_id"]) for r in rows]
    titles = [r["title"] for r in rows]
    return vectors, cluster_ids, titles


def cluster_summary(cluster_id: int) -> dict[str, Any] | None:
    """Bitta klaster haqida to'liq ma'lumot (CLI uchun)."""
    cluster = query_one(
        """
        SELECT c.*, i.title AS primary_title, i.url AS primary_url, i.source AS primary_source
        FROM clusters c
        JOIN items i ON i.id = c.primary_item_id
        WHERE c.id = ?
        """,
        (cluster_id,),
    )
    if cluster is None:
        return None

    members = query(
        """
        SELECT i.id, i.source, i.title, i.url, i.extra, i.published_at,
               ci.similarity, ci.is_primary
        FROM cluster_items ci
        JOIN items i ON i.id = ci.item_id
        WHERE ci.cluster_id = ?
        ORDER BY ci.is_primary DESC, ci.similarity DESC NULLS LAST
        """,
        (cluster_id,),
    )
    rows = [dict(m) for m in members]
    for row in rows:
        # Agregator havolasi o'rniga nashriyot URL'i — CLI va Writer uchun
        row["publisher_url"] = publisher_url(row)
    return {"cluster": dict(cluster), "members": rows}
