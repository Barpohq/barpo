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
                extra={"feed_title": feed.feed.get("title", "")},
            )
        )

    return items
