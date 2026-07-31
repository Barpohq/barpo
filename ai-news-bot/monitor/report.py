"""Alert and report text — Telegram HTML.

The formatting conventions come from `bot/health/report.py`: emoji +
<b>heading</b>, sections, 🔴/⚠️/✅ markers, and only the tags Telegram
supports.

Key principle (04-risks, X2): the measured fact is always shown BEFORE the
diagnosis and independently of it. The LLM's text never overrides the fact —
it is only supplementary commentary.

The user-visible strings here are deliberately Uzbek: this module's output
goes straight into the Telegram admin chat, so it is product content rather
than developer-facing text.
"""

from __future__ import annotations

from html import escape

from monitor.checks import CheckResult
from monitor.state import CurrentState

STATUS_EMOJI = {"ok": "✅", "warn": "⚠️", "fail": "🔴", "error": "🔴"}


def _esc(text: str) -> str:
    """Make text safe for Telegram HTML.

    Text coming from a server (service names, error messages) lands
    directly in the message and must not be interpreted as markup.
    """
    return escape(text, quote=False)


def format_alert(result: CheckResult, *, diagnosis: str = "") -> str:
    """Alert about a single problem."""
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
    """Message announcing that a problem has cleared.

    Without it the user, having received an alert, never learns how the
    situation ended.
    """
    return (
        f"✅ <b>{_esc(state.server)}</b> — {_esc(state.check_name)} tiklandi\n\n"
        f"{_esc(state.message)}"
    )


def format_status(states: list[CurrentState]) -> str:
    """Current state of every server — for `/servers` and the report."""
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
        # Problems and warnings are listed; healthy checks are only
        # counted — nobody reads a list of 5 servers × 10 checks
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
    """One-line summary — internal, for logs and `runs.note`.

    Unlike the rest of this module this is not Telegram-facing, so it is
    in English like the other operator-facing output.
    """
    problems = sum(1 for s in states if s.is_problem)
    servers = len({s.server for s in states})
    return f"{servers} servers, {len(states)} checks, {problems} problems"
