"""Telegram bot ilovasi — approval tugmalarini tinglaydi.

Uzoq ishlaydigan jarayon (long polling). `bot run` ichida scheduler bilan
yonma-yon ishlaydi: scheduler pipeline'ni yuritadi, bu esa tugma
bosilishiga javob beradi.

Muhim: tugmalar faqat bot ishlab turganda javob beradi. Bot to'xtagan
paytda bosilgan tugma Telegram tomonidan navbatga qo'yiladi va bot qayta
ishga tushganda yetkaziladi.
"""

from __future__ import annotations

import asyncio
from typing import Any

from aiogram import Dispatcher, F
from aiogram.filters import Command
from aiogram.types import CallbackQuery, Message

from bot.db import query_one
from bot.logging_setup import get_logger
from bot.publisher.publish import (
    apply_edit,
    get_post,
    mark_approved,
    mark_rejected,
    publish_approved,
)
from bot.publisher.queue import QueueBlocked, check_can_publish, published_today
from bot.publisher.telegram import (
    CB_APPROVE,
    CB_EDIT,
    CB_REJECT,
    TelegramClient,
    admin_chat_id,
)

log = get_logger(__name__)

# Foydalanuvchi tahrir yoki sabab yozishini kutayotgan holat.
# {chat_id: (rejim, post_id)} — rejim: "edit" yoki "reason"
_awaiting: dict[int, tuple[str, int]] = {}


def _is_admin(chat_id: int | str) -> bool:
    admin = admin_chat_id()
    return bool(admin) and str(chat_id) == str(admin)


def build_dispatcher() -> Dispatcher:
    """Handler'lar bilan dispatcher qurish."""
    dp = Dispatcher()

    # ─────────────── Buyruqlar ───────────────

    @dp.message(Command("start"))
    async def cmd_start(message: Message) -> None:
        await message.answer(
            "Salom! Men AI yangiliklar botiman.\n\n"
            "Tayyor postlar shu chatga tasdiq uchun keladi:\n"
            "✅ Chiqarish — kanalga joylaydi\n"
            "✏️ Tahrir — matnni tuzatib yuborasiz\n"
            "❌ Rad etish — sababini so'rayman\n\n"
            "<b>Buyruqlar</b>\n"
            "/status — postlar holati\n"
            "/health — kunlik hisobot\n"
            "/stats — umumiy statistika\n"
            "/sources — manbalar sog'ligi",
            parse_mode="HTML",
        )

    @dp.message(Command("status"))
    async def cmd_status(message: Message) -> None:
        if not _is_admin(message.chat.id):
            return
        counts = {}
        for status in ("draft", "pending", "approved", "published", "rejected"):
            row = query_one("SELECT COUNT(*) AS c FROM posts WHERE status = ?", (status,))
            counts[status] = row["c"] if row else 0

        lines = [
            "<b>Postlar holati</b>",
            f"  yozilgan (draft):   {counts['draft']}",
            f"  tasdiq kutmoqda:    {counts['pending']}",
            f"  tasdiqlangan:       {counts['approved']}",
            f"  chiqarilgan:        {counts['published']}",
            f"  rad etilgan:        {counts['rejected']}",
            "",
            f"Bugun kanalga chiqdi: {published_today()}",
        ]
        await message.answer("\n".join(lines), parse_mode="HTML")

    @dp.message(Command("health"))
    async def cmd_health(message: Message) -> None:
        if not _is_admin(message.chat.id):
            return
        from bot.health import format_daily_report

        await message.answer(format_daily_report(), parse_mode="HTML")

    @dp.message(Command("stats"))
    async def cmd_stats(message: Message) -> None:
        if not _is_admin(message.chat.id):
            return
        from bot.health import format_stats

        await message.answer(format_stats(), parse_mode="HTML")

    @dp.message(Command("sources"))
    async def cmd_sources(message: Message) -> None:
        if not _is_admin(message.chat.id):
            return
        from bot.health import format_sources

        await message.answer(format_sources(), parse_mode="HTML")

    # ─────────────── Tugmalar ───────────────

    @dp.callback_query(F.data.startswith(f"{CB_APPROVE}:"))
    async def on_approve(callback: CallbackQuery) -> None:
        post_id = int(str(callback.data).split(":", 1)[1])
        if not _is_admin(callback.message.chat.id if callback.message else 0):
            await callback.answer("Ruxsat yo'q", show_alert=True)
            return

        post = get_post(post_id)
        if post is None:
            await callback.answer("Post topilmadi", show_alert=True)
            return
        if post["status"] in ("published", "approved"):
            await callback.answer("Allaqachon tasdiqlangan", show_alert=True)
            return

        mark_approved(post_id)
        await callback.answer("✅ Tasdiqlandi")

        if callback.message:
            await callback.message.edit_reply_markup(reply_markup=None)

        # Darhol chiqarishga urinamiz — cheklovlar ruxsat bersa
        try:
            check_can_publish(str(post.get("cluster_title") or ""))
        except QueueBlocked as exc:
            if callback.message:
                await callback.message.answer(f"⏳ Navbatda: {exc}")
            return

        client = TelegramClient()
        try:
            published, _, problems = await publish_approved(client)
            if problems and callback.message:
                await callback.message.answer(f"⚠️ Xato: {problems[0]}")
        finally:
            await client.close()

    @dp.callback_query(F.data.startswith(f"{CB_REJECT}:"))
    async def on_reject(callback: CallbackQuery) -> None:
        post_id = int(str(callback.data).split(":", 1)[1])
        chat_id = callback.message.chat.id if callback.message else 0
        if not _is_admin(chat_id):
            await callback.answer("Ruxsat yo'q", show_alert=True)
            return

        # Sababni so'raymiz — Faza 3 da prompt tuning uchun kerak
        _awaiting[int(chat_id)] = ("reason", post_id)
        await callback.answer()
        if callback.message:
            await callback.message.edit_reply_markup(reply_markup=None)
            await callback.message.answer(
                f"❌ Post #{post_id} rad etildi.\n\n"
                "Sababini yozing (yoki <code>-</code> yuboring):",
                parse_mode="HTML",
            )

    @dp.callback_query(F.data.startswith(f"{CB_EDIT}:"))
    async def on_edit(callback: CallbackQuery) -> None:
        post_id = int(str(callback.data).split(":", 1)[1])
        chat_id = callback.message.chat.id if callback.message else 0
        if not _is_admin(chat_id):
            await callback.answer("Ruxsat yo'q", show_alert=True)
            return

        post = get_post(post_id)
        if post is None:
            await callback.answer("Post topilmadi", show_alert=True)
            return

        _awaiting[int(chat_id)] = ("edit", post_id)
        await callback.answer()
        if callback.message:
            await callback.message.answer(
                f"✏️ Post #{post_id} uchun tuzatilgan matnni yuboring.\n"
                "Bekor qilish uchun <code>-</code> yuboring.",
                parse_mode="HTML",
            )

    # ─────────────── Matn javoblari ───────────────

    @dp.message(F.text)
    async def on_text(message: Message) -> None:
        chat_id = int(message.chat.id)
        if not _is_admin(chat_id):
            return

        waiting = _awaiting.get(chat_id)
        if waiting is None:
            return

        mode, post_id = waiting
        text = (message.text or "").strip()
        _awaiting.pop(chat_id, None)

        if text == "-":
            await message.answer("Bekor qilindi.")
            return

        if mode == "reason":
            mark_rejected(post_id, text)
            await message.answer(f"Sabab saqlandi: {text[:80]}")
            log.info("Post #%d rad etildi: %s", post_id, text[:80])
            return

        if mode == "edit":
            from bot.publisher.telegram import approval_keyboard

            apply_edit(post_id, text)
            log.info("Post #%d tahrirlandi (%d belgi)", post_id, len(text))
            await message.answer(
                f"✏️ Post #{post_id} yangilandi. Tasdiqlaysizmi?",
                reply_markup=approval_keyboard(post_id),
            )

    return dp


async def run_polling() -> None:
    """Botni long polling rejimida ishga tushirish."""
    client = TelegramClient()
    dp = build_dispatcher()
    try:
        me = await client.bot.get_me()
        log.info("Telegram bot ishga tushdi: @%s", me.username)
        # Eski yangilanishlarni tashlab yuboramiz — bot to'xtagan paytdagi
        # tugma bosishlari eskirgan bo'lishi mumkin
        await client.bot.delete_webhook(drop_pending_updates=False)
        await dp.start_polling(client.bot, handle_signals=False)
    finally:
        await client.close()


def start_in_background() -> tuple[Any, Any]:
    """Botni alohida threadda ishga tushirish.

    `bot run` sinxron scheduler bilan ishlaydi, shuning uchun polling
    alohida threadda o'z event loop'i bilan yuritiladi.
    """
    import threading

    loop = asyncio.new_event_loop()

    def runner() -> None:
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(run_polling())
        except Exception:  # noqa: BLE001 — thread ichidagi xato yashirinmasin
            log.exception("Telegram polling to'xtadi")

    thread = threading.Thread(target=runner, name="telegram-polling", daemon=True)
    thread.start()
    return thread, loop
