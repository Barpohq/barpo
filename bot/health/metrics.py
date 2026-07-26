"""Bot holati va statistikasi.

Ma'lumot allaqachon bazada: `runs` (har bosqich natijasi), `posts`
(approval oqimi), `llm_calls` (xarajat), `errors`. Bu modul ularni
o'qib ma'noli ko'rsatkichlarga aylantiradi.

Asosiy ko'rsatkich — **approval rate**: yozilgan postlarning necha foizi
tasdiqlangan. Faza 3 ning maqsadi shu ko'rsatkichni 95% ga yetkazish,
keyin avtonom rejimga o'tish (04-xavflar, X3).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

from bot.config import load_config
from bot.db import query, query_one
from core.logging_setup import get_logger

log = get_logger(__name__)

# Approval rate shu qiymatdan past bo'lsa muammo bor deb hisoblanadi
APPROVAL_WARNING_THRESHOLD = 70.0
# Avtonom rejimga o'tish uchun kerakli daraja (04-xavflar, X3)
APPROVAL_AUTO_THRESHOLD = 95.0
# Shu muddat davomida yangilik kelmasa — manbalar buzilgan
STALE_HOURS = 24

# Botning pipeline bosqichlari. `runs` jadvali umumiy — boshqa agentlar
# (masalan server monitor) ham o'z yozuvlarini shu yerga qo'yadi, va
# `alert` ham bosqich sifatida yoziladi. Filtrsiz ular botning
# hisobotida "pipeline bosqichi ishlamadi" bo'lib chiqib qolardi.
PIPELINE_STAGES = ("collect", "dedup", "rank", "enrich", "write", "publish")


def _since(hours: int) -> str:
    return (datetime.now(UTC) - timedelta(hours=hours)).isoformat(timespec="seconds")


def _today_start() -> str:
    return date.today().isoformat()


# ─────────────────────────── Ko'rsatkichlar ───────────────────────────


@dataclass(slots=True)
class Metrics:
    """Bir davr uchun bot ko'rsatkichlari."""

    hours: int = 24

    # Pipeline
    items_collected: int = 0
    clusters_created: int = 0
    clusters_ranked: int = 0
    clusters_enriched: int = 0

    # Postlar
    posts_written: int = 0
    posts_approved: int = 0
    posts_rejected: int = 0
    posts_published: int = 0
    posts_pending: int = 0
    posts_edited: int = 0

    # Xarajat
    cost_usd: float = 0.0
    cost_limit: float = 0.0
    llm_calls: int = 0
    llm_failures: int = 0

    # Muammolar
    errors: int = 0
    failed_sources: list[str] = field(default_factory=list)
    failed_stages: list[str] = field(default_factory=list)

    @property
    def reviewed(self) -> int:
        """Ko'rib chiqilgan postlar (tasdiqlangan yoki rad etilgan)."""
        return self.posts_approved + self.posts_rejected

    @property
    def approval_rate(self) -> float | None:
        """Tasdiqlangan postlar ulushi (%). Ko'rilmagan bo'lsa None."""
        if self.reviewed == 0:
            return None
        return self.posts_approved / self.reviewed * 100

    @property
    def cost_pct(self) -> float:
        return (self.cost_usd / self.cost_limit * 100) if self.cost_limit else 0.0

    @property
    def is_stale(self) -> bool:
        """Yangilik kelmayaptimi — eng jiddiy buzilish belgisi."""
        return self.items_collected == 0

    @property
    def has_problems(self) -> bool:
        """Hozir e'tibor talab qiladigan muammo bormi.

        `errors` bu yerda hisobga olinmaydi — u tarixiy jadval, ichidagi
        xatolarning bir qismi allaqachon tuzatilgan bo'lishi mumkin.
        Haqiqiy holat `failed_sources` va `failed_stages` da.
        """
        rate = self.approval_rate
        return bool(
            self.is_stale
            or self.failed_sources
            or self.failed_stages
            or self.cost_pct >= 90
            or (rate is not None and rate < APPROVAL_WARNING_THRESHOLD)
        )


def _count(sql: str, params: Any = ()) -> int:
    row = query_one(sql, params)
    return int(row["c"]) if row and row["c"] is not None else 0


def collect_metrics(hours: int = 24) -> Metrics:
    """Oxirgi N soat uchun ko'rsatkichlarni yig'ish."""
    since = _since(hours)
    metrics = Metrics(hours=hours)

    metrics.items_collected = _count(
        "SELECT COUNT(*) AS c FROM items WHERE fetched_at >= ?", (since,)
    )
    metrics.clusters_created = _count(
        "SELECT COUNT(*) AS c FROM clusters WHERE created_at >= ?", (since,)
    )
    metrics.clusters_ranked = _count(
        "SELECT COUNT(*) AS c FROM clusters WHERE ranked_at >= ?", (since,)
    )
    metrics.clusters_enriched = _count(
        "SELECT COUNT(*) AS c FROM clusters WHERE enriched_at >= ? AND enrich_source != 'none'",
        (since,),
    )

    metrics.posts_written = _count(
        "SELECT COUNT(*) AS c FROM posts WHERE created_at >= ?", (since,)
    )
    # Tasdiqlangan: hozir approved yoki allaqachon published
    metrics.posts_approved = _count(
        "SELECT COUNT(*) AS c FROM posts WHERE reviewed_at >= ? "
        "AND status IN ('approved', 'published')",
        (since,),
    )
    metrics.posts_rejected = _count(
        "SELECT COUNT(*) AS c FROM posts WHERE reviewed_at >= ? AND status = 'rejected'",
        (since,),
    )
    metrics.posts_published = _count(
        "SELECT COUNT(*) AS c FROM posts WHERE published_at >= ?", (since,)
    )
    metrics.posts_pending = _count("SELECT COUNT(*) AS c FROM posts WHERE status = 'pending'")
    metrics.posts_edited = _count(
        "SELECT COUNT(*) AS c FROM posts WHERE created_at >= ? AND original_body IS NOT NULL",
        (since,),
    )

    cost_row = query_one(
        "SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS calls, "
        "SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures "
        "FROM llm_calls WHERE created_at >= ?",
        (_today_start(),),
    )
    if cost_row:
        metrics.cost_usd = float(cost_row["total"] or 0)
        metrics.llm_calls = int(cost_row["calls"] or 0)
        metrics.llm_failures = int(cost_row["failures"] or 0)
    metrics.cost_limit = load_config().models.limits.daily_cost_usd

    metrics.errors = _count(
        "SELECT COUNT(*) AS c FROM errors WHERE created_at >= ?", (since,)
    )

    metrics.failed_sources = _currently_broken_sources(hours)
    metrics.failed_stages = _currently_failing_stages(since)

    return metrics


def _currently_broken_sources(hours: int) -> list[str]:
    """Hozir buzilgan manbalar.

    Diqqat: xatolar jadvalidan to'g'ridan-to'g'ri o'qib bo'lmaydi — u
    tarixni saqlaydi. Ertalab buzilib, keyin tuzatilgan manba kun bo'yi
    "buzilgan" bo'lib ko'rinardi va alert ma'nosini yo'qotardi.

    To'g'ri mezon: manba xato bergan VA o'shandan keyin muvaffaqiyatli
    ishlamagan. Buni oxirgi xato va oxirgi element vaqtini solishtirib
    aniqlaymiz.
    """
    since = _since(hours)
    rows = query(
        """
        SELECT e.context AS source, MAX(e.created_at) AS last_error
        FROM errors e
        WHERE e.created_at >= ? AND e.component LIKE 'collector%' AND e.context IS NOT NULL
        GROUP BY e.context
        """,
        (since,),
    )

    broken: list[str] = []
    for row in rows:
        source = str(row["source"])
        last_error = str(row["last_error"])
        # Xatodan keyin shu manbadan element kelganmi?
        recovered = query_one(
            "SELECT 1 AS ok FROM items WHERE source = ? AND fetched_at > ? LIMIT 1",
            (source, last_error),
        )
        if not recovered:
            broken.append(source)

    return sorted(broken)


def _currently_failing_stages(since: str) -> list[str]:
    """Hozir ishlamayotgan bosqichlar.

    Manbalar bilan bir xil mantiq: bosqich xato bergan bo'lsa ham,
    keyin muvaffaqiyatli ishlagan bo'lsa muammo hal bo'lgan.

    Faqat botning o'z bosqichlari hisobga olinadi (PIPELINE_STAGES) —
    `runs` jadvalini boshqa agentlar ham ishlatadi.
    """
    placeholders = ", ".join("?" for _ in PIPELINE_STAGES)
    rows = query(
        f"""
        SELECT stage,
               MAX(CASE WHEN ok = 0 THEN started_at END) AS last_fail,
               MAX(CASE WHEN ok = 1 THEN started_at END) AS last_ok
        FROM runs
        WHERE started_at >= ? AND stage IN ({placeholders})
        GROUP BY stage
        """,
        (since, *PIPELINE_STAGES),
    )

    failing: list[str] = []
    for row in rows:
        last_fail = row["last_fail"]
        if not last_fail:
            continue
        last_ok = row["last_ok"]
        if last_ok is None or str(last_ok) < str(last_fail):
            failing.append(str(row["stage"]))

    return sorted(failing)


# ─────────────────────────── Umumiy statistika ───────────────────────────


@dataclass(slots=True)
class LifetimeStats:
    """Butun davr uchun statistika — avtonom rejimga tayyorlikni baholash."""

    total_written: int = 0
    total_approved: int = 0
    total_rejected: int = 0
    total_published: int = 0
    total_edited: int = 0
    days_active: int = 0
    reject_reasons: list[tuple[str, str]] = field(default_factory=list)

    @property
    def reviewed(self) -> int:
        return self.total_approved + self.total_rejected

    @property
    def approval_rate(self) -> float | None:
        if self.reviewed == 0:
            return None
        return self.total_approved / self.reviewed * 100

    @property
    def edit_rate(self) -> float | None:
        """Tahrirlangan postlar ulushi — sifat signali.

        Tasdiqlangan, lekin tahrirlangan post "yaxshi emas, lekin
        tuzatsa bo'ladi" degani. Bu ko'rsatkich yuqori bo'lsa prompt
        hali yetarli emas.
        """
        if self.total_approved == 0:
            return None
        return self.total_edited / self.total_approved * 100

    @property
    def ready_for_auto(self) -> bool:
        """Avtonom rejimga o'tish mumkinmi.

        Shart: yetarli namuna (10+ post) va approval rate 95% dan yuqori.
        """
        rate = self.approval_rate
        return self.reviewed >= 10 and rate is not None and rate >= APPROVAL_AUTO_THRESHOLD


def lifetime_stats() -> LifetimeStats:
    """Butun davr statistikasi."""
    stats = LifetimeStats()

    stats.total_written = _count("SELECT COUNT(*) AS c FROM posts")
    stats.total_approved = _count(
        "SELECT COUNT(*) AS c FROM posts WHERE status IN ('approved', 'published')"
    )
    stats.total_rejected = _count("SELECT COUNT(*) AS c FROM posts WHERE status = 'rejected'")
    stats.total_published = _count("SELECT COUNT(*) AS c FROM posts WHERE status = 'published'")
    stats.total_edited = _count("SELECT COUNT(*) AS c FROM posts WHERE original_body IS NOT NULL")

    row = query_one(
        "SELECT COUNT(DISTINCT date(created_at)) AS c FROM posts WHERE created_at IS NOT NULL"
    )
    stats.days_active = int(row["c"]) if row and row["c"] else 0

    # Rad etish sabablari — prompt tuning uchun asosiy manba
    reason_rows = query(
        "SELECT reject_reason, created_at FROM posts "
        "WHERE reject_reason IS NOT NULL AND trim(reject_reason) != '' "
        "ORDER BY reviewed_at DESC LIMIT 30"
    )
    stats.reject_reasons = [
        (str(r["reject_reason"]), str(r["created_at"])) for r in reason_rows
    ]

    return stats


# ─────────────────────────── Manba sog'ligi ───────────────────────────


def source_health(hours: int = 48) -> list[dict[str, Any]]:
    """Har bir manba oxirgi N soatda nechta element bergan.

    0 bergan manba buzilgan bo'lishi mumkin — RSS URL o'zgargan,
    sayt bloklagan va h.k.
    """
    since = _since(hours)
    rows = query(
        """
        SELECT s.name AS source,
               COALESCE(i.cnt, 0) AS items,
               i.last_seen
        FROM (SELECT DISTINCT source AS name FROM items) s
        LEFT JOIN (
            SELECT source, COUNT(*) AS cnt, MAX(fetched_at) AS last_seen
            FROM items WHERE fetched_at >= ? GROUP BY source
        ) i ON i.source = s.name
        ORDER BY items ASC, s.name
        """,
        (since,),
    )
    return [dict(r) for r in rows]
