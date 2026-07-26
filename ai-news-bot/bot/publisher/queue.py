"""Chiqarish navbati — nima, qachon va qanday tartibda chiqadi.

Bu yerda uchta qaror qabul qilinadi:

  1. Takror mavzu — bir voqea haqida ikkinchi post chiqmasligi kerak.
     Real muammo: klaster 259 (rasmiy Anthropic blogi) va 264
     (SiliconANGLE qayta hikoyasi) ikkalasi ham Claude Opus 5 relizi
     haqida edi va ikkalasiga ham post yozilgan. Dedup ham, Rank ham
     xato qilmagan — bular texnik jihatdan turli maqolalar. Filtrlash
     uchun to'g'ri joy aynan shu yer.

  2. Vaqt oralig'i — postlar ketma-ket otilib ketmasligi kerak
     (`posting.min_interval_minutes`).

  3. Kunlik limit — `posting.max_posts_per_day`.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from bot.config import load_config
from bot.dedup.versions import extract_model_ids
from core.db import query, query_one
from core.logging_setup import get_logger

log = get_logger(__name__)

# Takror tekshiruvi shu oynadagi chop etilgan postlar bilan solishtiradi
DUPLICATE_WINDOW_HOURS = 48


class QueueBlocked(RuntimeError):
    """Post hozir chiqarilmaydi — sabab bilan."""


def _posting(channel: dict[str, Any]) -> dict[str, Any]:
    return channel.get("posting") or {}


# ─────────────────────── Takror tekshiruvi ───────────────────────


def _recent_published(hours: int) -> list[dict[str, Any]]:
    """Oxirgi N soatda kanalga chiqqan postlar."""
    since = (datetime.now(UTC) - timedelta(hours=hours)).isoformat(timespec="seconds")
    rows = query(
        """
        SELECT p.id, p.published_at, c.title, c.id AS cluster_id
        FROM posts p
        JOIN clusters c ON c.id = p.cluster_id
        WHERE p.status = 'published' AND p.published_at >= ?
        ORDER BY p.published_at DESC
        """,
        (since,),
    )
    return [dict(r) for r in rows]


def duplicate_of(
    cluster_title: str, *, hours: int = DUPLICATE_WINDOW_HOURS
) -> dict[str, Any] | None:
    """Shu mavzuda yaqinda post chiqqanmi.

    Taqqoslash model identifikatori bo'yicha: "Claude Opus 5" va
    "Anthropic launches Claude Opus 5" bir xil `claude-opus-5` beradi,
    "Claude Sonnet 5" esa boshqa. Sarlavha fuzzy o'xshashligi bu vazifada
    ishlamaydi — Enricher'da o'lchangan: to'g'ri juftliklar 50-64 ball,
    noto'g'rilari 72-76, ular ustma-ust tushadi.
    """
    ids = extract_model_ids(cluster_title)
    if not ids:
        # Model nomi yo'q yangilik (biznes, tadqiqot) — takror tekshiruvi
        # ishonchsiz bo'ladi, o'tkazib yuboramiz
        return None

    for published in _recent_published(hours):
        if ids & extract_model_ids(published["title"]):
            return published
    return None


# ─────────────────────── Vaqt cheklovlari ───────────────────────


def _last_published_at() -> datetime | None:
    row = query_one(
        "SELECT published_at FROM posts WHERE status = 'published' "
        "ORDER BY published_at DESC LIMIT 1"
    )
    if not row or not row["published_at"]:
        return None
    try:
        return datetime.fromisoformat(row["published_at"])
    except ValueError:
        return None


def minutes_since_last_post() -> float | None:
    """Oxirgi postdan beri necha daqiqa o'tdi. Post bo'lmasa None."""
    last = _last_published_at()
    if last is None:
        return None
    if last.tzinfo is None:
        last = last.replace(tzinfo=UTC)
    return (datetime.now(UTC) - last).total_seconds() / 60


def published_today() -> int:
    """Bugun (UTC) chiqarilgan postlar soni."""
    today = datetime.now(UTC).date().isoformat()
    row = query_one(
        "SELECT COUNT(*) AS c FROM posts WHERE status = 'published' AND published_at >= ?",
        (today,),
    )
    return int(row["c"]) if row else 0


# ─────────────────────── Umumiy tekshiruv ───────────────────────


def check_can_publish(cluster_title: str = "") -> None:
    """Hozir post chiqarish mumkinmi. Mumkin bo'lmasa QueueBlocked.

    `cluster_title` berilsa takror tekshiruvi ham bajariladi.
    """
    channel = load_config().channel
    posting = _posting(channel)

    limit = int(posting.get("max_posts_per_day", 6))
    today = published_today()
    if today >= limit:
        raise QueueBlocked(
            f"Kunlik limit to'ldi: bugun {today} ta post chiqdi (limit {limit})"
        )

    interval = float(posting.get("min_interval_minutes", 45))
    elapsed = minutes_since_last_post()
    if elapsed is not None and elapsed < interval:
        wait = interval - elapsed
        raise QueueBlocked(
            f"Oxirgi postdan {elapsed:.0f} daqiqa o'tdi, "
            f"kamida {interval:.0f} kerak — {wait:.0f} daqiqa kutiladi"
        )

    if cluster_title and (duplicate := duplicate_of(cluster_title)):
        raise QueueBlocked(
            f"Shu mavzuda post allaqachon chiqqan: #{duplicate['id']} "
            f"({duplicate['title'][:50]})"
        )


def next_in_queue() -> dict[str, Any] | None:
    """Navbatdagi keyingi tasdiqlangan post.

    Tasdiqlangan, lekin hali chiqmagan postlar orasidan eng muhimi.
    """
    row = query_one(
        """
        SELECT p.id, p.body, p.image_url, p.cluster_id, c.title, c.importance_score
        FROM posts p
        JOIN clusters c ON c.id = p.cluster_id
        WHERE p.status = 'approved'
        ORDER BY c.importance_score DESC, p.reviewed_at
        LIMIT 1
        """
    )
    return dict(row) if row else None


def pending_approval() -> list[dict[str, Any]]:
    """Tasdiq kutayotgan (chatga yuborilgan) postlar."""
    rows = query(
        """
        SELECT p.id, p.approval_msg_id, p.approval_chat_id, c.title
        FROM posts p
        JOIN clusters c ON c.id = p.cluster_id
        WHERE p.status = 'pending'
        ORDER BY p.created_at
        """
    )
    return [dict(r) for r in rows]


def unsent_drafts(limit: int = 10) -> list[dict[str, Any]]:
    """Hali chatga yuborilmagan draftlar — takror mavzular filtrlangan.

    Filtr shu yerda: chatga yuborishdan oldin ham tekshiramiz, aks holda
    odam takror postni ko'rib, o'zi rad etishga majbur bo'ladi.
    """
    rows = query(
        """
        SELECT p.id, p.body, p.image_url, p.cluster_id,
               c.title, c.category, c.importance_score
        FROM posts p
        JOIN clusters c ON c.id = p.cluster_id
        WHERE p.status = 'draft'
        ORDER BY c.importance_score DESC, p.created_at
        LIMIT ?
        """,
        (limit * 2,),
    )

    result: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for row in rows:
        post = dict(row)
        title = str(post.get("title") or "")
        model_ids = extract_model_ids(title)

        # Chop etilganlar bilan takror
        if duplicate := duplicate_of(title):
            log.info(
                "Post #%s o'tkazib yuborildi: #%s bilan takror (%s)",
                post["id"],
                duplicate["id"],
                title[:44],
            )
            continue

        # Shu partiyaning o'zi ichida takror
        if model_ids and (model_ids & seen_ids):
            log.info(
                "Post #%s o'tkazib yuborildi: shu partiyada takror (%s)",
                post["id"],
                title[:44],
            )
            continue

        seen_ids |= model_ids
        result.append(post)
        if len(result) >= limit:
            break

    return result
