"""Collector uchun umumiy asos: element modeli, URL normalizatsiya, saqlash.

Har bir manba adapteri `CollectedItem` ro'yxatini qaytaradi; saqlash va
dublikatlarni birlamchi filtrlash shu modulda markazlashgan.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from bot.config import Source
from bot.db import execute, query_one, utc_now
from core.logging_setup import get_logger

log = get_logger(__name__)

# Kuzatuv parametrlari — URL normalizatsiyada olib tashlanadi
TRACKING_PARAMS = re.compile(
    r"^(utm_\w+|fbclid|gclid|msclkid|mc_[ce]id|ref|referrer|source|"
    r"campaign|igshid|si|s_cid|__twitter_impression|_hsenc|_hsmi)$",
    re.IGNORECASE,
)


@dataclass(slots=True)
class CollectedItem:
    """Manbadan olingan bitta yangilik elementi (bazaga yozilishdan oldin)."""

    source: str
    url: str
    title: str
    external_id: str | None = None
    content: str | None = None
    summary: str | None = None
    author: str | None = None
    image_url: str | None = None
    published_at: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.title = clean_text(self.title)
        if self.content:
            self.content = clean_text(self.content)
        if self.summary:
            self.summary = clean_text(self.summary)


class SourceAdapter(Protocol):
    """Manba adapteri interfeysi.

    Yangi manba turi qo'shish: shu protokolni qanoatlantiruvchi funksiya
    yozib, `bot/collector/__init__.py` dagi ADAPTERS ga ro'yxatdan o'tkazish.
    """

    def __call__(self, source: Source) -> list[CollectedItem]: ...


# ─────────────────────────── Matn va URL tozalash ───────────────────────────

_HTML_TAG = re.compile(r"<[^>]+>")
_WHITESPACE = re.compile(r"\s+")


def clean_text(text: str | None) -> str:
    """HTML teglarni olib tashlash va bo'shliqlarni normallashtirish."""
    if not text:
        return ""
    import html

    text = _HTML_TAG.sub(" ", text)
    text = html.unescape(text)
    return _WHITESPACE.sub(" ", text).strip()


def normalize_url(url: str) -> str:
    """URL'ni dedup uchun kanonik ko'rinishga keltirish.

    - sxema va domen kichik harfda, `www.` olib tashlanadi
    - kuzatuv parametrlari (utm_*, fbclid, ...) olib tashlanadi
    - qolgan parametrlar alifbo tartibida
    - fragment (#...) olib tashlanadi
    - oxiridagi `/` olib tashlanadi
    """
    if not url:
        return ""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip().lower()

    scheme = (parts.scheme or "https").lower()
    netloc = parts.netloc.lower()
    if netloc.startswith("www."):
        netloc = netloc[4:]
    # standart portlarni olib tashlash
    netloc = netloc.removesuffix(":443") if scheme == "https" else netloc.removesuffix(":80")

    path = parts.path.rstrip("/") or "/"

    kept = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=False)
            if not TRACKING_PARAMS.match(k)]
    query = urlencode(sorted(kept))

    return urlunsplit((scheme, netloc, path, query, ""))


def to_iso(value: Any) -> str | None:
    """Turli sana formatlarini ISO 8601 (UTC) ga keltirish."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=UTC)
        return dt.astimezone(UTC).isoformat(timespec="seconds")
    if isinstance(value, (int, float)):  # unix timestamp
        return datetime.fromtimestamp(value, tz=UTC).isoformat(timespec="seconds")
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        # feedparser struct_time emas, oddiy string kelsa
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            from email.utils import parsedate_to_datetime

            try:
                dt = parsedate_to_datetime(text)
            except (TypeError, ValueError):
                return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt.astimezone(UTC).isoformat(timespec="seconds")
    # feedparser time.struct_time
    if hasattr(value, "tm_year"):
        import calendar

        return datetime.fromtimestamp(calendar.timegm(value), tz=UTC).isoformat(timespec="seconds")
    return None


# ─────────────────────────── Saqlash ───────────────────────────


@dataclass(slots=True)
class SaveResult:
    inserted: int = 0
    duplicates: int = 0
    invalid: int = 0

    @property
    def total(self) -> int:
        return self.inserted + self.duplicates + self.invalid


def save_items(items: list[CollectedItem]) -> SaveResult:
    """Elementlarni bazaga yozish. Dublikatlar jimgina o'tkazib yuboriladi.

    Dublikat aniqlash: (source, url_normalized) — bir manbada bir xil maqola
    ikki marta yozilmaydi. Manbalararo dublikatlar dedup bosqichida hal qilinadi.
    """
    result = SaveResult()
    now = utc_now()

    for item in items:
        url_norm = normalize_url(item.url)
        if not url_norm or not item.title:
            log.debug("Yaroqsiz element o'tkazib yuborildi: %s / %r", item.source, item.title[:60])
            result.invalid += 1
            continue

        # Bir xil normalizatsiyalangan URL boshqa manbada bo'lsa ham
        # shu manba uchun yangi yozuv — dedup bosqichi klasterlaydi
        exists = query_one(
            "SELECT id FROM items WHERE source = ? AND url_normalized = ?",
            (item.source, url_norm),
        )
        if exists:
            result.duplicates += 1
            continue

        execute(
            """
            INSERT INTO items (
                source, external_id, url, url_normalized, title, content, summary,
                author, image_url, published_at, fetched_at, status, extra
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'raw', ?)
            """,
            (
                item.source,
                item.external_id,
                item.url,
                url_norm,
                item.title,
                item.content,
                item.summary,
                item.author,
                item.image_url,
                item.published_at,
                now,
                json.dumps(item.extra, ensure_ascii=False) if item.extra else None,
            ),
        )
        result.inserted += 1

    return result
