"""LLM diagnostika — muammo sababini izohlash.

Hozircha bo'sh: alert LLM'siz to'liq ishlaydi (o'lchov fakti o'zi
yetarli ma'lumot beradi). Bosqich 9 da to'ldiriladi.
"""

from __future__ import annotations

from monitor.checks import CheckResult


def diagnose_problem(result: CheckResult) -> str:
    """Muammo haqida qisqa izoh. Hozircha bo'sh satr."""
    return ""
