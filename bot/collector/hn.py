"""Hacker News adapteri (Algolia Search API).

API kalit kerak emas. Ball (points) bo'yicha filtrlab, faqat jamiyat
e'tiboriga tushgan postlarni olamiz.

Hujjat: https://hn.algolia.com/api
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx

from bot.collector.base import CollectedItem, to_iso
from bot.config import Source
from bot.logging_setup import get_logger

log = get_logger(__name__)

SEARCH_URL = "https://hn.algolia.com/api/v1/search"
HN_ITEM_URL = "https://news.ycombinator.com/item?id={}"


def collect(source: Source) -> list[CollectedItem]:
    """Hacker News'dan AI bo'yicha yuqori ballli postlarni olish.

    Diqqat: Algolia `OR` operatorini qo'llab-quvvatlamaydi — uni oddiy so'z
    sifatida qidiradi va natija keskin kamayadi. Shuning uchun har bir
    kalit so'z alohida so'rov bilan yuboriladi, natijalar birlashtiriladi.
    """
    queries = source.options.get("queries")
    if not queries:
        # Eski `query` maydoni bilan moslik
        single = source.options.get("query", "AI")
        queries = [single]
    if isinstance(queries, str):
        queries = [queries]

    min_points = int(source.options.get("min_points", 100))
    # Oxirgi necha kunlik postlar (default 3 kun — sikl har 3 soatda ishlaydi)
    lookback_days = int(source.options.get("lookback_days", 3))
    since = int((datetime.now(UTC) - timedelta(days=lookback_days)).timestamp())

    # objectID bo'yicha dedup: bir post bir necha so'rovga tushishi mumkin
    hits_by_id: dict[str, dict] = {}

    with httpx.Client(timeout=source.timeout) as client:
        for query in queries:
            params = {
                "query": query,
                "tags": "story",
                "numericFilters": f"points>={min_points},created_at_i>{since}",
                "hitsPerPage": min(source.max_items, 100),
            }
            try:
                response = client.get(SEARCH_URL, params=params)
                response.raise_for_status()
            except httpx.HTTPError as exc:
                # Bitta so'rov buzilsa qolganlari davom etadi
                log.warning("HN so'rovi '%s' ishlamadi: %s", query, exc)
                continue

            for hit in response.json().get("hits", []):
                if object_id := hit.get("objectID"):
                    hits_by_id.setdefault(object_id, hit)

    # Eng ko'p ball to'plaganlari birinchi
    ranked = sorted(hits_by_id.values(), key=lambda h: h.get("points", 0), reverse=True)

    items: list[CollectedItem] = []
    for hit in ranked[: source.max_items]:
        object_id = hit.get("objectID")
        title = hit.get("title")
        if not object_id or not title:
            continue

        # Tashqi havola bo'lmasa (Ask HN, Show HN matn posti) HN sahifasi
        url = hit.get("url") or HN_ITEM_URL.format(object_id)

        items.append(
            CollectedItem(
                source=source.name,
                url=url,
                title=title,
                external_id=str(object_id),
                content=hit.get("story_text") or "",
                author=hit.get("author"),
                published_at=to_iso(hit.get("created_at_i")),
                extra={
                    "points": hit.get("points", 0),
                    "num_comments": hit.get("num_comments", 0),
                    "hn_url": HN_ITEM_URL.format(object_id),
                },
            )
        )

    return items
