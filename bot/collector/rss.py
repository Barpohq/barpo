"""RSS/Atom manba adapteri.

Rasmiy bloglar (Anthropic, OpenAI, Google AI, ...) uchun. Eng ishonchli manba:
API kalit kerak emas, struktura barqaror.
"""

from __future__ import annotations

from typing import Any

import feedparser
import httpx

from bot.collector.base import CollectedItem, to_iso
from bot.config import Source
from bot.logging_setup import get_logger

log = get_logger(__name__)

USER_AGENT = "ai-news-bot/0.1 (+https://github.com/ai-news-bot)"


def _pick_image(entry: Any) -> str | None:
    """Elementdan rasm URL'ini topish (OG image o'rniga feed'dagi rasm)."""
    # media:content / media:thumbnail
    for key in ("media_content", "media_thumbnail"):
        media = entry.get(key)
        if media and isinstance(media, list) and media[0].get("url"):
            return str(media[0]["url"])
    # enclosure
    for link in entry.get("links", []):
        if link.get("rel") == "enclosure" and str(link.get("type", "")).startswith("image/"):
            return str(link.get("href"))
    return None


def _pick_content(entry: Any) -> str:
    """Eng to'liq matnni tanlash: content > summary > description."""
    content = entry.get("content")
    if content and isinstance(content, list):
        values = [c.get("value", "") for c in content if c.get("value")]
        if values:
            return max(values, key=len)
    return entry.get("summary") or entry.get("description") or ""


def publisher_of(entry: Any) -> tuple[str | None, str | None]:
    """Elementning haqiqiy nashriyoti: (URL, nom).

    Agregatorlarda (Google News) `link` agregatorning redirect havolasi
    bo'ladi — u JavaScript orqali ochiladi, HTTP redirect bermaydi va
    base64 id ichida haqiqiy URL yo'q (2024 dan keyingi format).

    Lekin `<source url="...">` tegida nashriyot domeni turadi. Uni
    saqlaymiz: dedup shu asosda birlamchi manbani aniqlaydi, aks holda
    rasmiy blog e'loni oddiy qayta hikoya bilan teng ko'rinadi.
    """
    source_tag = entry.get("source")
    if not isinstance(source_tag, dict):
        return None, None
    return source_tag.get("href"), source_tag.get("title")


def collect(source: Source) -> list[CollectedItem]:
    """Bitta RSS manbadan elementlarni olish."""
    url = source.options.get("url")
    if not url:
        raise ValueError(f"RSS manbasi '{source.name}' uchun 'url' belgilanmagan")

    # feedparser o'zi ham yuklay oladi, lekin httpx bilan timeout va
    # User-Agent'ni aniq boshqaramiz
    with httpx.Client(
        timeout=source.timeout,
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        response = client.get(url)
        response.raise_for_status()
        feed = feedparser.parse(response.content)

    if feed.bozo and not feed.entries:
        reason = getattr(feed, "bozo_exception", None) or "sabab noaniq"
        raise ValueError(f"Feed o'qib bo'lmadi: {reason}")

    if feed.bozo:
        log.debug("%s: feed qisman buzuq, %d element o'qildi", source.name, len(feed.entries))

    items: list[CollectedItem] = []
    for entry in feed.entries[: source.max_items]:
        link = entry.get("link")
        title = entry.get("title")
        if not link or not title:
            continue

        published = to_iso(
            entry.get("published_parsed")
            or entry.get("updated_parsed")
            or entry.get("published")
            or entry.get("updated")
        )

        extra: dict[str, Any] = {"feed_title": feed.feed.get("title", "")}
        publisher_url, publisher_name = publisher_of(entry)
        if publisher_url:
            extra["publisher_url"] = publisher_url
        if publisher_name:
            extra["publisher_name"] = publisher_name

        items.append(
            CollectedItem(
                source=source.name,
                url=link,
                title=title,
                external_id=entry.get("id") or entry.get("guid"),
                content=_pick_content(entry),
                summary=entry.get("summary"),
                author=entry.get("author"),
                image_url=_pick_image(entry),
                published_at=published,
                extra=extra,
            )
        )

    return items
