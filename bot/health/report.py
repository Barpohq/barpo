"""Kunlik hisobot va alert xabarlari.

Ikki xil xabar:

  Kunlik hisobot  — har kuni belgilangan vaqtda, hammasi joyida bo'lsa ham.
                    Maqsad: bot ishlayotganini ko'rish va tendensiyani
                    kuzatish.

  Alert           — faqat muammo bo'lganda, darhol. Maqsad: bot jimgina
                    o'lib qolmasin (04-xavflar, X4).

Xabarlar Telegram HTML formatida — Publisher'ning klienti orqali ketadi.
"""

from __future__ import annotations

from bot.health.metrics import (
    APPROVAL_AUTO_THRESHOLD,
    APPROVAL_WARNING_THRESHOLD,
    Metrics,
    collect_metrics,
    lifetime_stats,
    source_health,
)
from bot.logging_setup import get_logger

log = get_logger(__name__)


def _rate_line(metrics: Metrics) -> str:
    rate = metrics.approval_rate
    if rate is None:
        return "Approval:  — (hali ko'rilmagan)"

    mark = "✅" if rate >= APPROVAL_AUTO_THRESHOLD else (
        "⚠️" if rate < APPROVAL_WARNING_THRESHOLD else ""
    )
    return f"Approval:  {rate:.0f}% ({metrics.posts_approved}/{metrics.reviewed}) {mark}".rstrip()


def format_daily_report(metrics: Metrics | None = None) -> str:
    """Kunlik hisobot matni (Telegram HTML)."""
    m = metrics or collect_metrics(24)

    lines = [
        f"📊 <b>Kunlik hisobot</b> ({m.hours} soat)",
        "",
        "<b>Pipeline</b>",
        f"Yig'ildi:  {m.items_collected} yangilik",
        f"Klaster:   {m.clusters_created} yangi, {m.clusters_ranked} baholandi",
        f"Boyitildi: {m.clusters_enriched}",
        "",
        "<b>Postlar</b>",
        f"Yozildi:   {m.posts_written}",
        f"Chiqdi:    {m.posts_published}",
    ]

    if m.posts_pending:
        lines.append(f"Kutmoqda:  {m.posts_pending} (tasdiq kerak)")
    if m.posts_rejected:
        lines.append(f"Rad etildi: {m.posts_rejected}")
    if m.posts_edited:
        lines.append(f"Tahrirlandi: {m.posts_edited}")

    lines.append(_rate_line(m))

    lines += [
        "",
        "<b>Xarajat</b>",
        f"Bugun:     ${m.cost_usd:.3f} / ${m.cost_limit:.2f} ({m.cost_pct:.0f}%)",
        f"LLM:       {m.llm_calls} chaqiruv"
        + (f", {m.llm_failures} xato" if m.llm_failures else ""),
    ]

    problems = _problem_lines(m)
    if problems:
        lines += ["", "<b>Diqqat</b>", *problems]

    return "\n".join(lines)


def _problem_lines(m: Metrics) -> list[str]:
    """Hisobotdagi muammolar bo'limi."""
    lines: list[str] = []

    if m.is_stale:
        lines.append(f"🔴 {m.hours} soatda bitta ham yangilik yig'ilmadi")
    if m.failed_stages:
        lines.append(f"🔴 Bosqich xatosi: {', '.join(m.failed_stages)}")
    if m.failed_sources:
        lines.append(f"🔴 Manba tiklanmadi: {', '.join(m.failed_sources[:5])}")
    if m.cost_pct >= 90:
        lines.append(f"⚠️ Xarajat limitiga yaqin: {m.cost_pct:.0f}%")
    if m.errors:
        # Xatolar tarixiy — ba'zilari allaqachon tuzatilgan bo'lishi mumkin
        lines.append(f"ℹ️ {m.errors} ta xato qayd etildi (loglarni ko'ring)")

    rate = m.approval_rate
    if rate is not None and rate < APPROVAL_WARNING_THRESHOLD:
        lines.append(f"⚠️ Approval rate past: {rate:.0f}% — prompt tuzatish kerak")

    return lines


def format_alert(metrics: Metrics | None = None) -> str | None:
    """Alert matni. Muammo bo'lmasa None.

    Alert faqat jiddiy holatlarda yuboriladi — har kichik xato uchun
    xabar kelsa, foydalanuvchi ularni e'tiborsiz qoldira boshlaydi.
    """
    m = metrics or collect_metrics(24)

    critical: list[str] = []
    if m.is_stale:
        critical.append(f"{m.hours} soatda bitta ham yangilik yig'ilmadi — manbalarni tekshiring")
    if m.failed_stages:
        critical.append(f"Pipeline bosqichi ishlamadi: {', '.join(m.failed_stages)}")
    if m.cost_limit and m.cost_usd >= m.cost_limit:
        critical.append(f"Kunlik xarajat limiti tugadi: ${m.cost_usd:.3f}")

    if not critical:
        return None

    lines = ["🔴 <b>Bot muammosi</b>", ""]
    lines += [f"• {c}" for c in critical]
    lines += ["", "<code>bot db status</code> va loglarni tekshiring."]
    return "\n".join(lines)


def format_stats() -> str:
    """Umumiy statistika — avtonom rejimga tayyorlik (CLI va /stats uchun)."""
    stats = lifetime_stats()

    lines = [
        "📈 <b>Umumiy statistika</b>",
        "",
        f"Yozilgan postlar: {stats.total_written}",
        f"Chiqarilgan:      {stats.total_published}",
        f"Rad etilgan:      {stats.total_rejected}",
        f"Faol kunlar:      {stats.days_active}",
        "",
    ]

    rate = stats.approval_rate
    if rate is None:
        lines.append("Approval rate: hali ma'lumot yo'q")
    else:
        lines.append(f"Approval rate: <b>{rate:.0f}%</b> ({stats.total_approved}/{stats.reviewed})")

    if (edit_rate := stats.edit_rate) is not None and stats.total_edited:
        lines.append(f"Tahrir kerak bo'ldi: {edit_rate:.0f}%")

    lines.append("")
    if stats.ready_for_auto:
        lines.append(
            f"✅ Avtonom rejimga tayyor (≥{APPROVAL_AUTO_THRESHOLD:.0f}%, "
            f"{stats.reviewed} ta namuna)"
        )
    else:
        need = max(0, 10 - stats.reviewed)
        if need:
            lines.append(f"Avtonom rejim uchun yana {need} ta post ko'rilishi kerak")
        elif rate is not None:
            lines.append(
                f"Avtonom rejim uchun approval rate {APPROVAL_AUTO_THRESHOLD:.0f}% kerak "
                f"(hozir {rate:.0f}%)"
            )

    if stats.reject_reasons:
        lines += ["", "<b>Oxirgi rad etish sabablari</b>"]
        for reason, _ in stats.reject_reasons[:5]:
            lines.append(f"• {reason[:80]}")

    return "\n".join(lines)


def format_sources() -> str:
    """Manbalar sog'ligi — qaysi biri ishlayapti, qaysi biri yo'q."""
    rows = source_health(48)
    if not rows:
        return "Manba ma'lumoti yo'q."

    lines = ["🔌 <b>Manbalar</b> (48 soat)", ""]
    for row in rows:
        count = int(row["items"] or 0)
        mark = "🔴" if count == 0 else ("⚠️" if count < 3 else "✅")
        lines.append(f"{mark} {row['source']}: {count}")
    return "\n".join(lines)
