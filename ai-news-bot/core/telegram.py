"""Telegram transport layer — sending messages and running checks.

Both agents reach Telegram through this module: the bot sends posts to
the channel and to approval, the monitor sends alerts to the admin chat.

aiogram is async while the rest of the code is sync, so this module
provides bridge functions (`run_sync`, `with_client`) that keep the rest
of the codebase from having to go async.

Approval buttons and their callback format do not live here — they
belong to the bot's domain (`bot/publisher/telegram.py`).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from aiogram import Bot
from aiogram.exceptions import (
    TelegramAPIError,
    TelegramForbiddenError,
    TelegramRetryAfter,
)
from aiogram.types import InlineKeyboardMarkup

from core.config import env_str
from core.logging_setup import get_logger

log = get_logger(__name__)


class TelegramError(RuntimeError):
    """A Telegram-related error."""


class NotConfigured(TelegramError):
    """The token or channel is not configured."""


def has_token() -> bool:
    """Whether a bot token is set.

    That is enough to send messages to the admin chat — the channel is
    only needed for posts (`bot.publisher.telegram.is_configured`).
    """
    return bool(env_str("TELEGRAM_BOT_TOKEN"))


def admin_chat_id() -> str:
    """The private chat that receives messages (approvals, alerts, reports)."""
    return env_str("TELEGRAM_ADMIN_CHAT_ID")


def channel_id() -> str:
    return env_str("TELEGRAM_CHANNEL_ID")


def run_sync(coro: Any) -> Any:
    """Call an async function from synchronous code.

    The pipeline is sync (APScheduler, SQLite) while aiogram is async.
    A fresh event loop is opened for each call — a global loop would be
    unreliable because the scheduler runs across different threads.
    """
    return asyncio.run(coro)


@dataclass(slots=True)
class SentMessage:
    """Details about a message that was sent."""

    message_id: int
    chat_id: int


class TelegramClient:
    """Wrapper around the Telegram Bot API."""

    def __init__(self, token: str | None = None) -> None:
        resolved = token or env_str("TELEGRAM_BOT_TOKEN")
        if not resolved:
            raise NotConfigured(
                "TELEGRAM_BOT_TOKEN is not set. Copy it from .env.example."
            )
        self._bot = Bot(token=resolved)

    async def close(self) -> None:
        await self._bot.session.close()

    @property
    def bot(self) -> Bot:
        return self._bot

    # ─────────────────────── Sending ────────────────────────

    async def send_post(
        self,
        chat_id: str | int,
        text: str,
        *,
        image_url: str = "",
        keyboard: InlineKeyboardMarkup | None = None,
        parse_mode: str = "HTML",
    ) -> SentMessage:
        """Send a message. If there is an image, the text becomes its caption.

        If the image fails to load, it retries as plain text — a missing
        image must not block the post entirely.
        """
        if image_url:
            try:
                message = await self._bot.send_photo(
                    chat_id=chat_id,
                    photo=image_url,
                    caption=text,
                    parse_mode=parse_mode,
                    reply_markup=keyboard,
                )
                return SentMessage(message_id=message.message_id, chat_id=message.chat.id)
            except TelegramAPIError as exc:
                # The image URL is invalid or too large — fall back to text
                log.warning("Image could not be sent (%s), sending as text instead", exc)

        message = await self._bot.send_message(
            chat_id=chat_id,
            text=text,
            parse_mode=parse_mode,
            reply_markup=keyboard,
            link_preview_options={"is_disabled": True} if image_url else None,
        )
        return SentMessage(message_id=message.message_id, chat_id=message.chat.id)

    async def edit_markup(
        self,
        chat_id: str | int,
        message_id: int,
        keyboard: InlineKeyboardMarkup | None = None,
    ) -> None:
        """Update a message's buttons (e.g. remove them after approval)."""
        try:
            await self._bot.edit_message_reply_markup(
                chat_id=chat_id, message_id=message_id, reply_markup=keyboard
            )
        except TelegramAPIError as exc:
            # The message may have been deleted or left unchanged — not fatal
            log.debug("Could not update buttons: %s", exc)

    async def send_notice(self, chat_id: str | int, text: str) -> None:
        """A plain message (status, error, report, alert)."""
        try:
            await self._bot.send_message(
                chat_id=chat_id,
                text=text,
                parse_mode="HTML",
                link_preview_options={"is_disabled": True},
            )
        except TelegramAPIError as exc:
            log.warning("Message could not be sent: %s", exc)

    async def delete(self, chat_id: str | int, message_id: int) -> None:
        try:
            await self._bot.delete_message(chat_id=chat_id, message_id=message_id)
        except TelegramAPIError as exc:
            log.debug("Could not delete message: %s", exc)

    # ─────────────────────── Checks ─────────────────────────

    async def check_access(self) -> dict[str, Any]:
        """Verify the bot, channel and admin chat settings (for the CLI).

        If no channel is configured that part is skipped — the monitor
        agent does not need a channel.
        """
        me = await self._bot.get_me()
        result: dict[str, Any] = {
            "bot_username": me.username,
            "bot_id": me.id,
            "channel_ok": False,
            "admin_ok": False,
        }

        chan = channel_id()
        if chan:
            try:
                chat = await self._bot.get_chat(chan)
                member = await self._bot.get_chat_member(chan, me.id)
                result["channel_title"] = chat.title
                result["channel_numeric_id"] = chat.id
                result["channel_status"] = member.status
                result["can_post"] = bool(getattr(member, "can_post_messages", False))
                result["channel_ok"] = member.status == "administrator" and result["can_post"]
            except TelegramAPIError as exc:
                result["channel_error"] = str(exc)

        admin = admin_chat_id()
        if admin:
            try:
                chat = await self._bot.get_chat(admin)
                result["admin_name"] = chat.full_name or chat.title
                result["admin_ok"] = True
            except TelegramForbiddenError:
                result["admin_error"] = (
                    "The bot cannot write to this chat — send /start to the bot in Telegram"
                )
            except TelegramAPIError as exc:
                result["admin_error"] = str(exc)

        return result


async def with_client(func: Any) -> Any:
    """Open a client, run the work, then close it.

    The session must be closed on every call — otherwise aiogram emits
    an "Unclosed client session" warning.
    """
    client = TelegramClient()
    try:
        return await func(client)
    finally:
        await client.close()


def retry_after_seconds(exc: BaseException) -> float | None:
    """Extract the wait time from a flood control error."""
    if isinstance(exc, TelegramRetryAfter):
        return float(exc.retry_after)
    return None
