"""Agregator elementlariga nashriyot ma'lumotini keyinchalik qo'shish.

Google News RSS'dan yig'ilgan eski elementlarda `extra.publisher_url` yo'q —
u collector'ga keyinroq qo'shildi. Bu modul ularni jonli feed'dan GUID
bo'yicha topib to'ldiradi.

Bir martalik emas, takrorlanuvchi: feed'da faqat oxirgi ~7 kunlik yozuvlar
turadi, shuning uchun undan eski elementlar to'ldirilmasdan qoladi. Ular
`publisher_url` siz ishlaydi — kod `url` ga fallback qiladi.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import feedparser
import httpx

from bot.collector.rss import USER_AGENT, publisher_of
from bot.config import Source, load_config
from bot.db import execute, query, transaction
from core.logging_setup import get_logger

log = get_logger(__name__)

AGGREGATOR_MARKER = "news.google.com"


@dataclass(slots=True)
class BackfillReport:
    candidates: int = 0
    updated: int = 0
    not_found: int = 0
    failed_sources: list[str] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"{self.candidates} nomzoddan {self.updated} tasi to'ldirildi, "
            f"{self.not_found} tasi feed'da topilmadi"
        )


def _aggregator_sources() -> list[Source]:
    """Agregator (Google News) ishlatadigan RSS manbalar."""
    return [
        s
        for s in load_config().sources
        if s.type == "rss" and AGGREGATOR_MARKER in str(s.options.get("url", ""))
    ]


def _guid_to_publisher(source: Source) -> dict[str, tuple[str, str | None]]:
    """Feed'ni o'qib GUID → (nashriyot URL, nomi) jadvalini qurish."""
    url = str(source.options["url"])
    with httpx.Client(
        timeout=source.timeout,
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        response = client.get(url)
        response.raise_for_status()
        feed = feedparser.parse(response.content)

    mapping: dict[str, tuple[str, str | None]] = {}
    for entry in feed.entries:
        guid = entry.get("id") or entry.get("guid")
        publisher_url, publisher_name = publisher_of(entry)
        if guid and publisher_url:
            mapping[str(guid)] = (publisher_url, publisher_name)
    return mapping


def _pending_items() -> list[dict[str, Any]]:
    """Agregatordan kelgan, nashriyoti noma'lum elementlar."""
    rows = query(
        """
        SELECT id, source, external_id, extra
        FROM items
        WHERE url LIKE ?
          AND (extra IS NULL OR extra NOT LIKE '%publisher_url%')
        """,
        (f"%{AGGREGATOR_MARKER}%",),
    )
    return [dict(r) for r in rows]


def _merged_extra(raw_extra: Any, publisher_url: str, publisher_name: str | None) -> str:
    """Mavjud `extra` ni saqlab, nashriyot maydonlarini qo'shish."""
    extra: dict[str, Any] = {}
    if raw_extra:
        try:
            loaded = json.loads(raw_extra)
        except (TypeError, ValueError):
            loaded = None
        if isinstance(loaded, dict):
            extra = loaded

    extra["publisher_url"] = publisher_url
    if publisher_name:
        extra["publisher_name"] = publisher_name
    return json.dumps(extra, ensure_ascii=False)


def backfill_publishers() -> BackfillReport:
    """Eski agregator elementlariga nashriyot ma'lumotini qo'shish."""
    report = BackfillReport()

    pending = _pending_items()
    report.candidates = len(pending)
    if not pending:
        log.info("To'ldirishga nomzod yo'q")
        return report

    # Har manba uchun feed bir marta o'qiladi
    mappings: dict[str, dict[str, tuple[str, str | None]]] = {}
    for source in _aggregator_sources():
        try:
            mappings[source.name] = _guid_to_publisher(source)
            log.info("%s: feed'dan %d ta nashriyot", source.name, len(mappings[source.name]))
        except Exception as exc:  # noqa: BLE001 — bitta manba boshqasini to'xtatmasin
            log.warning("%s feed'ini o'qib bo'lmadi: %s", source.name, exc)
            report.failed_sources.append(source.name)

    if not mappings:
        log.warning("Hech qaysi agregator feed'i o'qilmadi")
        report.not_found = len(pending)
        return report

    with transaction():
        for item in pending:
            mapping = mappings.get(item["source"], {})
            found = mapping.get(str(item["external_id"]))
            if not found:
                report.not_found += 1
                continue

            publisher_url, publisher_name = found
            execute(
                "UPDATE items SET extra = ? WHERE id = ?",
                (_merged_extra(item["extra"], publisher_url, publisher_name), item["id"]),
            )
            report.updated += 1

    log.info("Backfill: %s", report.summary())
    return report
