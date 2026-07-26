"""Botning Telegram qatlami — approval tugmalari.

Transport (klient, yuborish, tekshirish) `core/telegram.py` da.
Bu yerda faqat postlarni tasdiqlash oqimiga tegishlisi: tugmalar va
ularning callback formati.
"""

from __future__ import annotations

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from core.config import env_str
from core.telegram import (
    NotConfigured,
    SentMessage,
    TelegramClient,
    TelegramError,
    admin_chat_id,
    channel_id,
    has_token,
    retry_after_seconds,
    run_sync,
    with_client,
)

__all__ = [
    "CB_APPROVE",
    "CB_EDIT",
    "CB_REJECT",
    "NotConfigured",
    "SentMessage",
    "TelegramClient",
    "TelegramError",
    "admin_chat_id",
    "approval_keyboard",
    "channel_id",
    "is_configured",
    "retry_after_seconds",
    "run_sync",
    "with_client",
]

# Callback ma'lumot prefikslari — approval tugmalari
CB_APPROVE = "ap"
CB_REJECT = "rj"
CB_EDIT = "ed"


def is_configured() -> bool:
    """Bot postlarni chiqara oladimi — token va kanal kerak.

    Monitor uchun kanal shart emas, u `core.telegram.has_token()` ni
    ishlatadi (alertlar admin chatga ketadi).
    """
    return bool(has_token() and env_str("TELEGRAM_CHANNEL_ID"))


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
