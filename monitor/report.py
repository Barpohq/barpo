"""Alert va hisobot matnlari — Telegram HTML.

Format konvensiyalari `bot/health/report.py` dan: emoji + <b>sarlavha</b>,
bo'limlar, 🔴/⚠️/✅ belgilar, faqat Telegram qo'llab-quvvatlaydigan teglar.

Muhim tamoyil (04-xavflar, X2): o'lchov fakti har doim diagnostikadan
OLDIN va undan mustaqil ko'rsatiladi. LLM matni faktni hech qachon
bekor qilmaydi — u faqat qo'shimcha izoh.
"""

from __future__ import annotations

from html import escape

from monitor.checks import CheckResult
from monitor.state import CurrentState

STATUS_EMOJI = {"ok": "✅", "warn": "⚠️", "fail": "🔴", "error": "🔴"}


def _esc(text: str) -> str:
    """Telegram HTML uchun xavfsiz matn.

    Serverdan kelgan matn (xizmat nomlari, xato xabarlari) bevosita
    xabarga tushadi — teg sifatida talqin qilinmasligi kerak.
    """
    return escape(text, quote=False)


def format_alert(result: CheckResult, *, diagnosis: str = "") -> str:
    """Bitta muammo haqida alert."""
    emoji = STATUS_EMOJI.get(result.status, "🔴")
    lines = [
        f"{emoji} <b>{_esc(result.server)}</b> — {_esc(result.name)}",
        "",
        _esc(result.message),
    ]

    if result.threshold is not None and result.value is not None:
        lines.append(f"<i>chegara: {result.threshold:g}</i>")

    if diagnosis:
        lines += ["", "<b>Diagnostika</b>", _esc(diagnosis)]

    return "\n".join(lines)


def format_recovery(state: CurrentState) -> str:
    """Muammo tugagani haqida xabar.

    Busiz foydalanuvchi alert olgandan keyin holat qanday
    tugaganini bilmaydi.
    """
    return (
        f"✅ <b>{_esc(state.server)}</b> — {_esc(state.check_name)} tiklandi\n\n"
        f"{_esc(state.message)}"
    )


def format_status(states: list[CurrentState]) -> str:
    """Barcha serverlarning joriy holati — `/servers` va hisobot uchun."""
    if not states:
        return "ℹ️ Hali tekshiruv o'tkazilmagan."

    problems = [s for s in states if s.is_problem]
    warnings = [s for s in states if s.status == "warn"]

    header = "🔴 <b>Serverlar holati</b>" if problems else "✅ <b>Serverlar holati</b>"
    lines = [header, ""]

    by_server: dict[str, list[CurrentState]] = {}
    for state in states:
        by_server.setdefault(state.server, []).append(state)

    for server, server_states in by_server.items():
        server_problems = [s for s in server_states if s.is_problem]
        mark = "🔴" if server_problems else "✅"
        lines.append(f"{mark} <b>{_esc(server)}</b>")
        # Muammolar va ogohlantirishlar ko'rsatiladi, normal holat esa
        # faqat sanaladi — 5 server × 10 check ro'yxati o'qilmaydi
        shown = [s for s in server_states if s.status != "ok"]
        for state in shown:
            emoji = STATUS_EMOJI.get(state.status, "•")
            lines.append(f"   {emoji} {_esc(state.check_name)}: {_esc(state.message)}")
        ok_count = len(server_states) - len(shown)
        if ok_count:
            lines.append(f"   ✓ {ok_count} ta tekshiruv normal")

    if problems or warnings:
        lines += [
            "",
            f"<b>Jami:</b> {len(problems)} muammo, {len(warnings)} ogohlantirish",
        ]

    return "\n".join(lines)


def format_summary(states: list[CurrentState]) -> str:
    """Bir qatorlik xulosa — log va `runs.note` uchun."""
    problems = sum(1 for s in states if s.is_problem)
    servers = len({s.server for s in states})
    return f"{servers} server, {len(states)} tekshiruv, {problems} muammo"
