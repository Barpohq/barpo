"""Postlarni tasdiqlash va kanalga chiqarish.

Oqim:
  draft     Writer yozdi, hali ko'rilmagan
  pending   shaxsiy chatga tugmalar bilan yuborildi
  approved  ✅ bosildi — navbatda
  published kanalga chiqdi
  rejected  ❌ bosildi (sabab bilan)

Tahrir (✏️): foydalanuvchi tuzatilgan matnni javob qilib yuboradi, asl
matn `original_body` da saqlanadi — Faza 3 da prompt tuning uchun eng
qimmatli signal.
"""

from __future__ import annotations

import traceback
from dataclasses import dataclass, field
from typing import Any

from bot.config import load_config
from bot.publisher.queue import QueueBlocked, check_can_publish, unsent_drafts
from bot.publisher.telegram import (
    TelegramClient,
    TelegramError,
    admin_chat_id,
    approval_keyboard,
    channel_id,
    is_configured,
    with_client,
)
from core.db import execute, log_error, query_one, utc_now
from core.logging_setup import get_logger

log = get_logger(__name__)


@dataclass(slots=True)
class PublishReport:
    sent_for_approval: int = 0
    published: int = 0
    skipped: int = 0
    failed: int = 0
    problems: list[str] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"{self.sent_for_approval} tasdiqqa yuborildi, "
            f"{self.published} kanalga chiqdi, {self.skipped} o'tkazib yuborildi, "
            f"{self.failed} xato"
        )


# ─────────────────────── Holat o'zgartirish ───────────────────────


def mark_pending(post_id: int, message_id: int, chat_id: int) -> None:
    execute(
        "UPDATE posts SET status = 'pending', approval_msg_id = ?, approval_chat_id = ? "
        "WHERE id = ?",
        (message_id, chat_id, post_id),
    )


def mark_approved(post_id: int) -> None:
    execute(
        "UPDATE posts SET status = 'approved', reviewed_at = ? WHERE id = ?",
        (utc_now(), post_id),
    )


def mark_rejected(post_id: int, reason: str = "") -> None:
    execute(
        "UPDATE posts SET status = 'rejected', reviewed_at = ?, reject_reason = ? WHERE id = ?",
        (utc_now(), reason or None, post_id),
    )
    row = query_one("SELECT cluster_id FROM posts WHERE id = ?", (post_id,))
    if row:
        execute(
            "UPDATE clusters SET status = 'rejected', updated_at = ? WHERE id = ?",
            (utc_now(), row["cluster_id"]),
        )


def mark_published(post_id: int, message_id: int) -> None:
    execute(
        "UPDATE posts SET status = 'published', published_at = ?, message_id = ? WHERE id = ?",
        (utc_now(), message_id, post_id),
    )
    row = query_one("SELECT cluster_id FROM posts WHERE id = ?", (post_id,))
    if row:
        execute(
            "UPDATE clusters SET status = 'published', updated_at = ? WHERE id = ?",
            (utc_now(), row["cluster_id"]),
        )


def apply_edit(post_id: int, new_body: str) -> None:
    """Tahrirlangan matnni saqlash. Asl matn birinchi tahrirdagina saqlanadi."""
    row = query_one("SELECT body, original_body FROM posts WHERE id = ?", (post_id,))
    if row is None:
        return
    original = row["original_body"] or row["body"]
    execute(
        "UPDATE posts SET body = ?, original_body = ? WHERE id = ?",
        (new_body, original, post_id),
    )


def get_post(post_id: int) -> dict[str, Any] | None:
    row = query_one(
        """
        SELECT p.*, c.title AS cluster_title, c.category, c.importance_score
        FROM posts p JOIN clusters c ON c.id = p.cluster_id
        WHERE p.id = ?
        """,
        (post_id,),
    )
    return dict(row) if row else None


# ─────────────────────── Tasdiqqa yuborish ───────────────────────


def _approval_header(post: dict[str, Any]) -> str:
    """Post ustidagi qisqa ma'lumot — qaror qabul qilishga yordam beradi."""
    score = post.get("importance_score")
    parts = [f"<b>#{post['id']}</b>"]
    if score is not None:
        parts.append(f"muhimlik {score:.0f}")
    if category := post.get("category"):
        parts.append(str(category))
    parts.append(f"{len(post['body'])} belgi")
    return " · ".join(parts)


async def _send_drafts(client: TelegramClient, limit: int) -> tuple[int, int, list[str]]:
    """Draftlarni tasdiqqa yuborish. (yuborildi, o'tkazildi, muammolar)."""
    admin = admin_chat_id()
    if not admin:
        return 0, 0, ["TELEGRAM_ADMIN_CHAT_ID belgilanmagan"]

    drafts = unsent_drafts(limit)
    if not drafts:
        return 0, 0, []

    sent = 0
    problems: list[str] = []

    for post in drafts:
        text = f"{_approval_header(post)}\n\n{post['body']}"
        try:
            message = await client.send_post(
                admin,
                text,
                image_url=str(post.get("image_url") or ""),
                keyboard=approval_keyboard(int(post["id"])),
            )
        except TelegramError as exc:
            problems.append(f"post {post['id']}: {exc}")
            continue
        except Exception as exc:  # noqa: BLE001 — bitta post oqimni to'xtatmasin
            log.exception("Post %s yuborilmadi", post["id"])
            problems.append(f"post {post['id']}: {exc}")
            continue

        mark_pending(int(post["id"]), message.message_id, message.chat_id)
        sent += 1
        log.info("Post #%s tasdiqqa yuborildi", post["id"])

    return sent, 0, problems


# ─────────────────────── Kanalga chiqarish ───────────────────────


async def _publish_post(client: TelegramClient, post: dict[str, Any]) -> int:
    """Postni kanalga yuborish. Xabar id qaytaradi."""
    message = await client.send_post(
        channel_id(),
        str(post["body"]),
        image_url=str(post.get("image_url") or ""),
    )
    return message.message_id


async def publish_approved(client: TelegramClient) -> tuple[int, int, list[str]]:
    """Tasdiqlangan postlarni kanalga chiqarish.

    Bir chaqiruvda bitta post — vaqt oralig'i cheklovi tufayli navbatdagi
    keyingisi baribir kutishi kerak.
    """
    from bot.publisher.queue import next_in_queue

    post = next_in_queue()
    if post is None:
        return 0, 0, []

    try:
        check_can_publish(str(post.get("title") or ""))
    except QueueBlocked as exc:
        log.info("Post #%s kutmoqda: %s", post["id"], exc)
        return 0, 1, []

    try:
        message_id = await _publish_post(client, post)
    except Exception as exc:  # noqa: BLE001
        log.exception("Post #%s kanalga chiqmadi", post["id"])
        log_error(
            "publisher",
            str(exc),
            context=f"post {post['id']}",
            traceback=traceback.format_exc(),
        )
        return 0, 0, [f"post {post['id']}: {exc}"]

    mark_published(int(post["id"]), message_id)
    log.info("Post #%s kanalga chiqdi (message_id=%s)", post["id"], message_id)

    # Tasdiqlagan odamга xabar beramiz
    if admin := admin_chat_id():
        await client.send_notice(
            admin, f"✅ Post #{post['id']} kanalga chiqdi:\n{post['title'][:70]}"
        )

    return 1, 0, []


# ─────────────────────── Asosiy oqim ───────────────────────


def run_publish(*, limit: int = 5, send_only: bool = False) -> PublishReport:
    """Draftlarni tasdiqqa yuborish va tasdiqlanganlarini chiqarish.

    `send_only` — faqat tasdiqqa yuboradi, kanalga chiqarmaydi.
    """
    report = PublishReport()

    if not is_configured():
        log.warning("Telegram sozlanmagan — TELEGRAM_BOT_TOKEN va TELEGRAM_CHANNEL_ID kerak")
        report.problems.append("Telegram sozlanmagan")
        return report

    async def work(client: TelegramClient) -> None:
        sent, skipped, problems = await _send_drafts(client, limit)
        report.sent_for_approval = sent
        report.skipped += skipped
        report.problems.extend(problems)

        if not send_only:
            published, waiting, pub_problems = await publish_approved(client)
            report.published = published
            report.skipped += waiting
            report.problems.extend(pub_problems)

    try:
        import asyncio

        asyncio.run(with_client(work))
    except Exception as exc:  # noqa: BLE001 — CLI/scheduler chegarasi
        log.exception("Publisher xatosi")
        log_error("publisher", str(exc), traceback=traceback.format_exc())
        report.failed += 1
        report.problems.append(str(exc))

    log.info("Publisher: %s", report.summary())
    return report


def publish_now(post_id: int, *, force: bool = False) -> int:
    """Bitta postni darhol kanalga chiqarish (CLI uchun).

    `force` — vaqt oralig'i va takror cheklovlarini e'tiborsiz qoldirish.
    Xabar id qaytaradi.
    """
    post = get_post(post_id)
    if post is None:
        raise ValueError(f"Post #{post_id} topilmadi")
    if post["status"] == "published":
        raise ValueError(f"Post #{post_id} allaqachon chiqarilgan")

    if not force:
        check_can_publish(str(post.get("cluster_title") or ""))

    async def work(client: TelegramClient) -> int:
        return await _publish_post(client, post)

    import asyncio

    message_id = asyncio.run(with_client(work))
    mark_published(post_id, message_id)
    return message_id


def channel_link(message_id: int) -> str:
    """Kanaldagi postga havola."""
    username = ((load_config().channel.get("channel") or {}).get("username") or "").lstrip("@")
    return f"https://t.me/{username}/{message_id}" if username else ""
