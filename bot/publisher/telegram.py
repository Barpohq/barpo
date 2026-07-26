"""Telegram klienti — kanalga va shaxsiy chatga xabar yuborish.

Barcha Telegram chaqiruvlar shu modul orqali o'tadi. aiogram asinxron,
qolgan pipeline sinxron — shuning uchun bu yerda ko'prik funksiyalar bor
(`run_sync`), kod bazasining qolgan qismi asinxron bo'lishga majbur emas.
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
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from bot.config import env_str
from bot.logging_setup import get_logger

log = get_logger(__name__)

# Callback ma'lumot prefikslari — approval tugmalari
CB_APPROVE = "ap"
CB_REJECT = "rj"
CB_EDIT = "ed"


class TelegramError(RuntimeError):
    """Telegram bilan bog'liq xato."""


class NotConfigured(TelegramError):
    """Token yoki kanal belgilanmagan."""


def is_configured() -> bool:
    """Telegram sozlanganmi (token va kanal bor)."""
    return bool(env_str("TELEGRAM_BOT_TOKEN") and env_str("TELEGRAM_CHANNEL_ID"))


def admin_chat_id() -> str:
    """Approval postlari keladigan shaxsiy chat."""
    return env_str("TELEGRAM_ADMIN_CHAT_ID")


def channel_id() -> str:
    return env_str("TELEGRAM_CHANNEL_ID")


def run_sync(coro: Any) -> Any:
    """Asinxron funksiyani sinxron koddan chaqirish.

    Pipeline sinxron (APScheduler, SQLite), aiogram esa asinxron.
    Har chaqiruv uchun yangi event loop ochiladi — scheduler turli
    threadlarda ishlagani uchun global loop ishonchsiz.
    """
    return asyncio.run(coro)


@dataclass(slots=True)
class SentMessage:
    """Yuborilgan xabar haqidagi ma'lumot."""

    message_id: int
    chat_id: int


def approval_keyboard(post_id: int) -> InlineKeyboardMarkup:
    """Approval tugmalari: tasdiqlash, tahrir, rad etish."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="✅ Chiqarish", callback_data=f"{CB_APPROVE}:{post_id}"),
                InlineKeyboardButton(text="✏️ Tahrir", callback_data=f"{CB_EDIT}:{post_id}"),
                InlineKeyboardButton(text="❌ Rad etish", callback_data=f"{CB_REJECT}:{post_id}"),
            ]
        ]
    )


class TelegramClient:
    """Telegram Bot API bilan ishlash."""

    def __init__(self, token: str | None = None) -> None:
        resolved = token or env_str("TELEGRAM_BOT_TOKEN")
        if not resolved:
            raise NotConfigured(
                "TELEGRAM_BOT_TOKEN belgilanmagan. .env.example dan nusxa oling."
            )
        self._bot = Bot(token=resolved)

    async def close(self) -> None:
        await self._bot.session.close()

    @property
    def bot(self) -> Bot:
        return self._bot

    # ─────────────────────── Yuborish ───────────────────────

    async def send_post(
        self,
        chat_id: str | int,
        text: str,
        *,
        image_url: str = "",
        keyboard: InlineKeyboardMarkup | None = None,
        parse_mode: str = "HTML",
    ) -> SentMessage:
        """Postni yuborish. Rasm bo'lsa caption sifatida.

        Rasm yuklanmasa matn sifatida qayta urinadi — rasm yo'qligi
        postni butunlay to'xtatmasligi kerak.
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
                # Rasm URL yaroqsiz yoki juda katta — matn bilan davom etamiz
                log.warning("Rasm yuborilmadi (%s), matn sifatida yuborilmoqda", exc)

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
        """Xabar tugmalarini yangilash (masalan tasdiqlangandan keyin olib tashlash)."""
        try:
            await self._bot.edit_message_reply_markup(
                chat_id=chat_id, message_id=message_id, reply_markup=keyboard
            )
        except TelegramAPIError as exc:
            # Xabar o'chirilgan yoki o'zgarmagan bo'lishi mumkin — halokatli emas
            log.debug("Tugmalarni yangilab bo'lmadi: %s", exc)

    async def send_notice(self, chat_id: str | int, text: str) -> None:
        """Oddiy xabar (holat, xato, hisobot)."""
        try:
            await self._bot.send_message(
                chat_id=chat_id,
                text=text,
                parse_mode="HTML",
                link_preview_options={"is_disabled": True},
            )
        except TelegramAPIError as exc:
            log.warning("Xabar yuborilmadi: %s", exc)

    async def delete(self, chat_id: str | int, message_id: int) -> None:
        try:
            await self._bot.delete_message(chat_id=chat_id, message_id=message_id)
        except TelegramAPIError as exc:
            log.debug("Xabarni o'chirib bo'lmadi: %s", exc)

    # ─────────────────────── Tekshiruv ───────────────────────

    async def check_access(self) -> dict[str, Any]:
        """Bot va kanal sozlamalarini tekshirish (CLI uchun)."""
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
                    "Bot bu chatga yoza olmaydi — Telegram'da botga /start bosing"
                )
            except TelegramAPIError as exc:
                result["admin_error"] = str(exc)

        return result


async def with_client(func: Any) -> Any:
    """Klientni ochib, ish bajarib, yopish.

    Har chaqiruvda sessiya yopilishi kerak — aks holda aiogram
    "Unclosed client session" ogohlantirishi chiqadi.
    """
    client = TelegramClient()
    try:
        return await func(client)
    finally:
        await client.close()


def retry_after_seconds(exc: BaseException) -> float | None:
    """Flood control xatosidan kutish vaqtini olish."""
    if isinstance(exc, TelegramRetryAfter):
        return float(exc.retry_after)
    return None
