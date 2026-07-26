"""Collector qatlami — manbalardan yangilik yig'ish.

Yangi manba turi qo'shish:
  1. `bot/collector/<tur>.py` da `collect(source) -> list[CollectedItem]` yozing
  2. Uni quyidagi ADAPTERS lug'atiga qo'shing
  3. `config/sources.yaml` da `type: <tur>` bilan manba e'lon qiling
"""

from __future__ import annotations

import traceback
from dataclasses import dataclass, field

from bot.collector import hn, rss
from bot.collector.base import (
    CollectedItem,
    SaveResult,
    SourceAdapter,
    clean_text,
    normalize_url,
    save_items,
)
from bot.config import Source, load_config
from bot.db import finish_run, log_error, start_run
from bot.logging_setup import get_logger

log = get_logger(__name__)

# Manba turi -> adapter funksiyasi
ADAPTERS: dict[str, SourceAdapter] = {
    "rss": rss.collect,
    "hackernews": hn.collect,
}


@dataclass(slots=True)
class CollectReport:
    """Bitta yig'ish siklining natijasi."""

    fetched: int = 0
    inserted: int = 0
    duplicates: int = 0
    invalid: int = 0
    failed_sources: list[str] = field(default_factory=list)
    ok_sources: list[str] = field(default_factory=list)

    @property
    def has_errors(self) -> bool:
        return bool(self.failed_sources)

    def summary(self) -> str:
        parts = [
            f"{self.fetched} element olindi",
            f"{self.inserted} yangi",
            f"{self.duplicates} dublikat",
        ]
        if self.invalid:
            parts.append(f"{self.invalid} yaroqsiz")
        if self.failed_sources:
            parts.append(f"xato: {', '.join(self.failed_sources)}")
        return ", ".join(parts)


def collect_source(source: Source) -> list[CollectedItem]:
    """Bitta manbadan elementlarni olish. Adapter topilmasa xato."""
    adapter = ADAPTERS.get(source.type)
    if adapter is None:
        raise ValueError(
            f"'{source.type}' turi uchun adapter yo'q. "
            f"Mavjud turlar: {', '.join(sorted(ADAPTERS))}"
        )
    return adapter(source)


def collect_all(source_name: str | None = None) -> CollectReport:
    """Barcha yoqilgan manbalardan yig'ish.

    Bitta manba buzilsa qolganlari davom etadi — xato log va bazaga yoziladi.
    """
    config = load_config()
    sources = config.enabled_sources
    if source_name:
        sources = [s for s in sources if s.name == source_name]
        if not sources:
            raise ValueError(f"'{source_name}' nomli yoqilgan manba topilmadi")

    report = CollectReport()
    run_id = start_run("collect")

    for source in sources:
        try:
            items = collect_source(source)
        except Exception as exc:  # noqa: BLE001 — bitta manba butun siklni to'xtatmasin
            log.warning("Manba '%s' ishlamadi: %s", source.name, exc)
            log_error(
                f"collector.{source.type}",
                str(exc),
                context=source.name,
                traceback=traceback.format_exc(),
            )
            report.failed_sources.append(source.name)
            continue

        saved = save_items(items)
        report.fetched += len(items)
        report.inserted += saved.inserted
        report.duplicates += saved.duplicates
        report.invalid += saved.invalid
        report.ok_sources.append(source.name)

        log.info(
            "%-22s %3d olindi, %3d yangi, %3d dublikat",
            source.name,
            len(items),
            saved.inserted,
            saved.duplicates,
        )

    finish_run(
        run_id,
        items_in=report.fetched,
        items_out=report.inserted,
        error_count=len(report.failed_sources),
        ok=not report.has_errors,
        note=report.summary(),
    )
    log.info("Yig'ish tugadi: %s", report.summary())
    return report


__all__ = [
    "ADAPTERS",
    "CollectReport",
    "CollectedItem",
    "SaveResult",
    "clean_text",
    "collect_all",
    "collect_source",
    "normalize_url",
    "save_items",
]
