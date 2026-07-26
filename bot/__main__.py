"""CLI kirish nuqtasi.

Buyruqlar:
    bot db migrate          — baza sxemasini yangilash
    bot db status           — baza holati
    bot llm test            — OpenRouter ulanishini tekshirish
    bot cost [--days N]     — LLM xarajatlari hisoboti
    bot collect             — manbalardan yangilik yig'ish
    bot backfill-publishers — eski elementlarga nashriyot ma'lumotini qo'shish
    bot dedup               — dublikatlarni klasterlash
    bot rank                — klasterlarni LLM bilan baholash
    bot enrich              — to'liq maqola matni bilan boyitish
    bot write               — klasterlardan post yozish
    bot posts list          — yozilgan postlar ro'yxati
    bot posts show <id>     — bitta postni ko'rish
    bot publish             — draftlarni tasdiqqa yuborish + navbatni chiqarish
    bot publish-now <id>    — bitta postni darhol kanalga chiqarish
    bot telegram check      — bot va kanal sozlamalarini tekshirish
    bot health              — hozirgi holat va kunlik hisobot
    bot stats               — umumiy statistika, avtonom rejimga tayyorlik
    bot clusters list       — klasterlar ro'yxati
    bot clusters show <id>  — bitta klaster tafsiloti
    bot run                 — scheduler bilan doimiy rejim
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime, timedelta

from bot import __version__
from bot.config import ConfigError, load_config
from bot.logging_setup import get_logger, setup_logging

# Faqat parser yordam matni uchun — og'ir bog'liqlik tortmaydi
from bot.rank.scorer import DEFAULT_BATCH_SIZE

log = get_logger("bot.cli")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bot",
        description="AI yangiliklar boti — Telegram kanali uchun avtonom pipeline",
    )
    parser.add_argument("--version", action="version", version=f"ai-news-bot {__version__}")
    parser.add_argument(
        "--log-level",
        default=None,
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Log darajasi (default: .env dagi LOG_LEVEL)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # ── db ──
    db_parser = sub.add_parser("db", help="Baza boshqaruvi")
    db_sub = db_parser.add_subparsers(dest="db_command", required=True)
    db_sub.add_parser("migrate", help="Migratsiyalarni qo'llash")
    db_sub.add_parser("status", help="Baza holati va statistika")

    # ── llm ──
    llm_parser = sub.add_parser("llm", help="LLM bilan ishlash")
    llm_sub = llm_parser.add_subparsers(dest="llm_command", required=True)
    test_parser = llm_sub.add_parser("test", help="OpenRouter ulanishini tekshirish")
    test_parser.add_argument(
        "--stage", default="rank", help="Qaysi bosqich modelini sinash (default: rank)"
    )
    test_parser.add_argument(
        "--prompt",
        default="Javob sifatida faqat bitta so'z yoz: ISHLAYAPTI",
        help="Sinov uchun prompt",
    )

    # ── cost ──
    cost_parser = sub.add_parser("cost", help="LLM xarajatlari hisoboti")
    cost_parser.add_argument("--days", type=int, default=1, help="Necha kunlik (default: 1)")

    # ── collect / dedup ──
    collect_parser = sub.add_parser("collect", help="Manbalardan yangilik yig'ish")
    collect_parser.add_argument("--source", help="Faqat shu manbadan (nom bo'yicha)")

    sub.add_parser(
        "backfill-publishers",
        help="Eski agregator elementlariga nashriyot ma'lumotini qo'shish",
    )

    dedup_parser = sub.add_parser("dedup", help="Dublikatlarni klasterlash")
    dedup_parser.add_argument(
        "--window-days", type=int, default=7, help="Solishtirish oynasi (default: 7 kun)"
    )

    # ── rank ──
    rank_parser = sub.add_parser("rank", help="Klasterlarni LLM bilan baholash")
    rank_parser.add_argument(
        "--limit", type=int, default=100, help="Maksimal nechta klaster (default: 100)"
    )
    rank_parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=f"Bir chaqiruvdagi klasterlar soni (default: {DEFAULT_BATCH_SIZE})",
    )
    rank_parser.add_argument(
        "--dry-run", action="store_true", help="Baholaydi va ko'rsatadi, bazaga yozmaydi"
    )

    # ── enrich ──
    enrich_parser = sub.add_parser("enrich", help="To'liq maqola matni bilan boyitish")
    enrich_parser.add_argument(
        "--limit", type=int, default=20, help="Maksimal nechta klaster (default: 20)"
    )
    enrich_parser.add_argument(
        "--no-search",
        action="store_true",
        help="Faqat fetch — web search ishlatilmaydi (Tavily krediti sarflanmaydi)",
    )

    # ── write ──
    write_parser = sub.add_parser("write", help="Klasterlardan post yozish")
    write_parser.add_argument(
        "--limit", type=int, default=5, help="Maksimal nechta post (default: 5)"
    )
    write_parser.add_argument(
        "--cluster", type=int, help="Faqat shu klaster uchun (sinov uchun)"
    )

    # ── posts ──
    posts_parser = sub.add_parser("posts", help="Yozilgan postlarni ko'rish")
    posts_sub = posts_parser.add_subparsers(dest="posts_command", required=True)
    posts_list = posts_sub.add_parser("list", help="Postlar ro'yxati")
    posts_list.add_argument("--limit", type=int, default=20)
    posts_list.add_argument("--status", help="Status bo'yicha filtr (draft, published, ...)")
    posts_show = posts_sub.add_parser("show", help="Bitta postni ko'rish")
    posts_show.add_argument("post_id", type=int)

    # ── publish ──
    publish_parser = sub.add_parser("publish", help="Tasdiqqa yuborish va navbatni chiqarish")
    publish_parser.add_argument(
        "--limit", type=int, default=5, help="Nechta draft yuborilsin (default: 5)"
    )
    publish_parser.add_argument(
        "--send-only",
        action="store_true",
        help="Faqat tasdiqqa yuboradi, kanalga chiqarmaydi",
    )

    now_parser = sub.add_parser("publish-now", help="Bitta postni darhol kanalga chiqarish")
    now_parser.add_argument("post_id", type=int)
    now_parser.add_argument(
        "--force",
        action="store_true",
        help="Vaqt oralig'i va takror cheklovlarini e'tiborsiz qoldirish",
    )

    # ── telegram ──
    tg_parser = sub.add_parser("telegram", help="Telegram sozlamalari")
    tg_sub = tg_parser.add_subparsers(dest="telegram_command", required=True)
    tg_sub.add_parser("check", help="Bot, kanal va admin chatni tekshirish")

    # ── health / stats ──
    health_parser = sub.add_parser("health", help="Bot holati va kunlik hisobot")
    health_parser.add_argument(
        "--hours", type=int, default=24, help="Necha soatlik (default: 24)"
    )
    health_parser.add_argument(
        "--send", action="store_true", help="Hisobotni Telegram'ga yuborish"
    )
    health_parser.add_argument(
        "--sources", action="store_true", help="Manbalar sog'ligini ko'rsatish"
    )

    sub.add_parser("stats", help="Umumiy statistika va avtonom rejimga tayyorlik")

    # ── clusters ──
    cl_parser = sub.add_parser("clusters", help="Klasterlarni ko'rish")
    cl_sub = cl_parser.add_subparsers(dest="clusters_command", required=True)
    cl_list = cl_sub.add_parser("list", help="Klasterlar ro'yxati")
    cl_list.add_argument("--limit", type=int, default=20)
    cl_list.add_argument("--status", help="Status bo'yicha filtr")
    cl_show = cl_sub.add_parser("show", help="Bitta klaster tafsiloti")
    cl_show.add_argument("cluster_id", type=int)

    # ── run ──
    run_parser = sub.add_parser("run", help="Scheduler bilan doimiy rejim")
    run_parser.add_argument(
        "--interval-hours", type=int, default=3, help="Sikl oralig'i (default: 3 soat)"
    )
    run_parser.add_argument(
        "--once", action="store_true", help="Bir marta ishlab to'xtash (scheduler'siz)"
    )

    return parser


# ─────────────────────────── Buyruqlar ───────────────────────────


def cmd_db_migrate() -> int:
    from bot import db

    applied = db.migrate()
    print(f"Baza versiyasi: {db.current_version()} (qo'llanildi: {applied} ta migratsiya)")
    return 0


def cmd_db_status() -> int:
    from bot import db

    version = db.current_version()
    print(f"Baza:     {load_config().db_path}")
    print(f"Versiya:  {version} / {db.LATEST_VERSION}")
    if version < db.LATEST_VERSION:
        print("  ⚠ Sxema eskirgan — `bot db migrate` ni ishga tushiring")
        return 0

    counts = {
        "items": "SELECT COUNT(*) c FROM items",
        "  raw": "SELECT COUNT(*) c FROM items WHERE status='raw'",
        "clusters": "SELECT COUNT(*) c FROM clusters",
        "  new": "SELECT COUNT(*) c FROM clusters WHERE status='new'",
        "posts": "SELECT COUNT(*) c FROM posts",
        "  published": "SELECT COUNT(*) c FROM posts WHERE status='published'",
        "llm_calls": "SELECT COUNT(*) c FROM llm_calls",
        "errors": "SELECT COUNT(*) c FROM errors",
    }
    print("\nYozuvlar:")
    for label, sql in counts.items():
        print(f"  {label:<12} {db.query_one(sql)['c']}")
    return 0


def cmd_llm_test(stage: str, prompt: str) -> int:
    from bot import db
    from bot.llm import AllModelsFailed, CostLimitExceeded, LLMClient

    db.check_schema()
    cfg = load_config().models
    stage_cfg = cfg.stage(stage)

    print(f"Bosqich:  {stage}")
    print(f"Zanjir:   {' → '.join(stage_cfg.chain)}")
    print(f"Prompt:   {prompt}")
    print("Yuborilmoqda...\n")

    try:
        with LLMClient() as client:
            result = client.complete(stage, prompt=prompt)
    except CostLimitExceeded as exc:
        print(f"✗ {exc}")
        return 1
    except AllModelsFailed as exc:
        print(f"✗ {exc}")
        return 1

    print(f"Javob:    {result.text.strip()[:500]}")
    print(f"Model:    {result.model}" + (" (fallback!)" if result.used_fallback else ""))
    print(f"Tokenlar: {result.prompt_tokens} + {result.completion_tokens}")
    print(f"Xarajat:  ${result.cost_usd:.6f}")
    print(f"Vaqt:     {result.duration_ms} ms")
    return 0


def cmd_cost(days: int) -> int:
    from bot import db
    from bot.llm import today_cost_usd

    db.check_schema()
    since = (datetime.now(UTC) - timedelta(days=days)).date().isoformat()

    rows = db.query(
        """
        SELECT stage, model,
               COUNT(*)                AS calls,
               SUM(success)            AS ok,
               SUM(prompt_tokens)      AS prompt_tokens,
               SUM(completion_tokens)  AS completion_tokens,
               SUM(cost_usd)           AS cost
        FROM llm_calls
        WHERE created_at >= ?
        GROUP BY stage, model
        ORDER BY cost DESC
        """,
        (since,),
    )

    if not rows:
        print(f"Oxirgi {days} kunda LLM chaqiruvi yo'q.")
        return 0

    print(f"Oxirgi {days} kun ({since} dan):\n")
    print(f"{'BOSQICH':<10} {'MODEL':<34} {'CHAQ':>5} {'OK':>4} {'TOKEN':>12} {'XARAJAT':>10}")
    print("─" * 80)
    total = 0.0
    for r in rows:
        tokens = (r["prompt_tokens"] or 0) + (r["completion_tokens"] or 0)
        cost = r["cost"] or 0.0
        total += cost
        print(
            f"{r['stage']:<10} {r['model'][:34]:<34} {r['calls']:>5} "
            f"{r['ok'] or 0:>4} {tokens:>12,} ${cost:>9.5f}"
        )
    print("─" * 80)
    print(f"{'JAMI':<10} {'':<34} {'':>5} {'':>4} {'':>12} ${total:>9.5f}")

    limit = load_config().models.limits.daily_cost_usd
    spent_today = today_cost_usd()
    pct = (spent_today / limit * 100) if limit else 0
    print(f"\nBugun: ${spent_today:.5f} / ${limit:.2f} limitdan ({pct:.0f}%)")
    return 0


def cmd_collect(source_name: str | None) -> int:
    from bot import db
    from bot.collector import collect_all

    db.check_schema()
    report = collect_all(source_name)

    print()
    print(f"Olindi:    {report.fetched}")
    print(f"Yangi:     {report.inserted}")
    print(f"Dublikat:  {report.duplicates}")
    if report.invalid:
        print(f"Yaroqsiz:  {report.invalid}")
    print(f"Manbalar:  {len(report.ok_sources)} ok", end="")
    if report.failed_sources:
        print(f", {len(report.failed_sources)} xato: {', '.join(report.failed_sources)}")
    else:
        print()
    return 1 if report.has_errors and not report.ok_sources else 0


def cmd_backfill_publishers() -> int:
    from bot import db
    from bot.collector.backfill import backfill_publishers

    db.check_schema()
    report = backfill_publishers()

    print()
    print(f"Nomzod:        {report.candidates}")
    print(f"To'ldirildi:   {report.updated}")
    print(f"Topilmadi:     {report.not_found}")
    if report.failed_sources:
        print(f"Xato manbalar: {', '.join(report.failed_sources)}")
    if report.not_found:
        print("\nTopilmaganlar feed oynasidan eski — ular `url` ga fallback qiladi.")
    return 0


def cmd_dedup(window_days: int) -> int:
    from bot import db
    from bot.dedup import run_dedup

    db.check_schema()
    run_id = db.start_run("dedup")
    report = run_dedup(window_days=window_days)
    db.finish_run(
        run_id,
        items_in=report.processed,
        items_out=report.new_clusters,
        note=report.summary(),
    )

    print()
    print(f"Ishlandi:          {report.processed}")
    print(f"Yangi klaster:     {report.new_clusters}")
    print(f"Mavjudga qo'shildi: {report.merged_into_existing}")
    print(f"Aynan dublikat:    {report.exact_duplicates}")
    return 0


def cmd_rank(limit: int, batch_size: int, dry_run: bool) -> int:
    from bot import db
    from bot.rank import run_rank

    db.check_schema()
    run_id = db.start_run("rank")
    report = run_rank(limit=limit, batch_size=batch_size, dry_run=dry_run)
    db.finish_run(
        run_id,
        items_in=report.processed,
        items_out=report.ranked,
        error_count=report.failed,
        ok=not report.failed_batches,
        note=report.summary(),
    )

    print()
    print(f"Baholandi:  {report.processed}")
    print(f"Qabul:      {report.ranked}")
    print(f"Rad etildi: {report.rejected} (shundan {report.spam} spam)")
    if report.failed:
        print(f"Baholanmadi: {report.failed} — keyingi ishga tushishda qayta urinadi")
    print(f"Xarajat:    ${report.cost_usd:.5f}")
    if report.failed_batches:
        print("\nXatolar:")
        for problem in report.failed_batches:
            print(f"  - {problem}")
    if dry_run:
        print("\n[dry-run] Bazaga hech narsa yozilmadi.")
    return 0


def cmd_enrich(limit: int, no_search: bool) -> int:
    from bot import db
    from bot.enricher import run_enrich

    db.check_schema()
    run_id = db.start_run("enrich")
    report = run_enrich(limit=limit, use_search=not no_search)
    db.finish_run(
        run_id,
        items_in=report.processed,
        items_out=report.enriched,
        error_count=report.failed,
        ok=not report.problems,
        note=report.summary(),
    )

    print()
    print(f"Ishlandi:   {report.processed}")
    print(f"Boyitildi:  {report.enriched} ({report.by_fetch} fetch, {report.by_search} search)")
    if report.failed:
        print(f"Bo'lmadi:   {report.failed} — feed matni bilan qoladi")
    if report.search_credits:
        print(f"Qidiruv:    {report.search_credits} kredit")
    if report.problems:
        print("\nMuammolar:")
        for problem in report.problems[:10]:
            print(f"  - {problem}")
    return 0


def cmd_write(limit: int, cluster_id: int | None) -> int:
    from bot import db
    from bot.writer import run_write

    db.check_schema()
    run_id = db.start_run("write")
    report = run_write(limit=limit, cluster_id=cluster_id)
    db.finish_run(
        run_id,
        items_in=report.processed,
        items_out=report.written,
        error_count=report.failed,
        ok=not report.problems,
        note=report.summary(),
    )

    print()
    print(f"Ishlandi:   {report.processed}")
    print(f"Yozildi:    {report.written}")
    if report.retried:
        print(f"Qayta yozildi: {report.retried} (birinchi urinish tekshiruvdan o'tmadi)")
    if report.failed:
        print(f"Bo'lmadi:   {report.failed}")
    print(f"Xarajat:    ${report.cost_usd:.5f}")
    if report.problems:
        print("\nMuammolar:")
        for problem in report.problems[:10]:
            print(f"  - {problem}")
    if report.written:
        print("\nKo'rish: bot posts list")
    return 0


def cmd_posts_list(limit: int, status: str | None) -> int:
    from bot import db

    db.check_schema()
    where = "WHERE p.status = ?" if status else ""
    params = (status, limit) if status else (limit,)
    rows = db.query(
        f"""
        SELECT p.id, p.cluster_id, p.status, p.model, p.created_at,
               length(p.body) AS len, c.category, c.importance_score, c.title
        FROM posts p
        JOIN clusters c ON c.id = p.cluster_id
        {where}
        ORDER BY p.created_at DESC
        LIMIT ?
        """,
        params,
    )

    if not rows:
        print("Post topilmadi. `bot write` ni ishga tushiring.")
        return 0

    header = (
        f"{'ID':>4} {'KLST':>5} {'STATUS':<10} {'BAHO':>5} "
        f"{'BELGI':>6} {'KATEGORIYA':<14} SARLAVHA"
    )
    print(header)
    print("─" * 108)
    for r in rows:
        score = f"{r['importance_score']:.1f}" if r["importance_score"] is not None else "—"
        print(
            f"{r['id']:>4} {r['cluster_id']:>5} {r['status']:<10} {score:>5} "
            f"{r['len']:>6} {(r['category'] or '—')[:14]:<14} {r['title'][:38]}"
        )
    print("\nTo'liq ko'rish: bot posts show <id>")
    return 0


def cmd_posts_show(post_id: int) -> int:
    from bot import db
    from bot.writer import post_detail

    db.check_schema()
    post = post_detail(post_id)
    if post is None:
        print(f"Post #{post_id} topilmadi.")
        return 1

    print(f"Post #{post['id']}  (klaster {post['cluster_id']})")
    print(f"Status:    {post['status']}")
    print(f"Model:     {post['model']}")
    print(f"Uzunlik:   {len(post['body'])} belgi")
    print(f"Kategoriya: {post['category']}, muhimlik {post['importance_score']}")
    if post.get("image_url"):
        print(f"Rasm:      {post['image_url'][:80]}")
    print(f"Yozildi:   {post['created_at']}")
    print()
    print("─" * 60)
    print(post["body"])
    print("─" * 60)
    return 0


def cmd_publish(limit: int, send_only: bool) -> int:
    from bot import db
    from bot.publisher import run_publish

    db.check_schema()
    run_id = db.start_run("publish")
    report = run_publish(limit=limit, send_only=send_only)
    db.finish_run(
        run_id,
        items_in=report.sent_for_approval,
        items_out=report.published,
        error_count=report.failed,
        ok=not report.problems,
        note=report.summary(),
    )

    print()
    print(f"Tasdiqqa yuborildi: {report.sent_for_approval}")
    if not send_only:
        print(f"Kanalga chiqdi:     {report.published}")
    if report.skipped:
        print(f"Kutmoqda:           {report.skipped}")
    if report.problems:
        print("\nMuammolar:")
        for problem in report.problems[:10]:
            print(f"  - {problem}")
    if report.sent_for_approval:
        print("\nTelegram'da tasdiqlang — @labbaygo_bot chatiga qarang.")
    return 0


def cmd_publish_now(post_id: int, force: bool) -> int:
    from bot import db
    from bot.publisher import QueueBlocked, channel_link, publish_now

    db.check_schema()
    try:
        message_id = publish_now(post_id, force=force)
    except QueueBlocked as exc:
        print(f"Chiqarilmadi: {exc}")
        print("Majburlash uchun: --force")
        return 1
    except ValueError as exc:
        print(f"Xato: {exc}")
        return 1

    print(f"Post #{post_id} kanalga chiqdi (message_id={message_id})")
    if link := channel_link(message_id):
        print(f"Havola: {link}")
    return 0


def cmd_telegram_check() -> int:
    import asyncio

    from bot.publisher import is_configured
    from bot.publisher.telegram import TelegramClient, with_client

    if not is_configured():
        print("Telegram sozlanmagan.")
        print("  .env da TELEGRAM_BOT_TOKEN va TELEGRAM_CHANNEL_ID kerak")
        return 1

    async def work(client: TelegramClient):
        return await client.check_access()

    result = asyncio.run(with_client(work))

    print(f"Bot:      @{result['bot_username']} (id {result['bot_id']})")
    print()
    if result.get("channel_error"):
        print(f"Kanal:    ✗ {result['channel_error']}")
    else:
        print(f"Kanal:    {result.get('channel_title')} (id {result.get('channel_numeric_id')})")
        print(f"  status:  {result.get('channel_status')}")
        print(f"  post qo'ya oladi: {result.get('can_post')}")
        print(f"  {'✓ tayyor' if result['channel_ok'] else '✗ admin qilib qo`shing'}")
    print()
    if result.get("admin_error"):
        print(f"Admin chat: ✗ {result['admin_error']}")
    else:
        print(f"Admin chat: {result.get('admin_name')} ✓")

    return 0 if result["channel_ok"] and result["admin_ok"] else 1


def _strip_html(text: str) -> str:
    """Telegram HTML'ni terminal uchun oddiy matnga aylantirish."""
    import re

    return re.sub(r"</?[a-z]+>", "", text)


def cmd_health(hours: int, send: bool, sources: bool) -> int:
    from bot import db
    from bot.health import collect_metrics, format_daily_report, format_sources

    db.check_schema()

    if sources:
        print(_strip_html(format_sources()))
        return 0

    metrics = collect_metrics(hours)
    print(_strip_html(format_daily_report(metrics)))

    if send:
        from bot.health.notify import send_daily_report

        print()
        if send_daily_report():
            print("→ Telegram'ga yuborildi")
        else:
            print("→ Yuborilmadi (Telegram sozlanmagan yoki xato)")

    return 1 if metrics.has_problems else 0


def cmd_stats() -> int:
    from bot import db
    from bot.health import format_stats

    db.check_schema()
    print(_strip_html(format_stats()))
    return 0


def cmd_clusters_list(limit: int, status: str | None) -> int:
    from bot import db

    db.check_schema()
    where = "WHERE c.status = ?" if status else ""
    params = (status, limit) if status else (limit,)
    rows = db.query(
        f"""
        SELECT c.id, c.title, c.item_count, c.status, c.importance_score,
               c.created_at, i.source AS primary_source
        FROM clusters c
        JOIN items i ON i.id = c.primary_item_id
        {where}
        ORDER BY c.item_count DESC, c.created_at DESC
        LIMIT ?
        """,
        params,
    )

    if not rows:
        print("Klaster topilmadi. Avval `bot collect` va `bot dedup` ni ishga tushiring.")
        return 0

    print(f"{'ID':>5} {'EL':>3} {'BAHO':>5} {'STATUS':<10} {'MANBA':<18} SARLAVHA")
    print("─" * 100)
    for r in rows:
        score = f"{r['importance_score']:.1f}" if r["importance_score"] is not None else "—"
        print(
            f"{r['id']:>5} {r['item_count']:>3} {score:>5} {r['status']:<10} "
            f"{r['primary_source'][:18]:<18} {r['title'][:52]}"
        )

    total = db.query_one("SELECT COUNT(*) c FROM clusters")["c"]
    multi = db.query_one("SELECT COUNT(*) c FROM clusters WHERE item_count > 1")["c"]
    print(f"\nJami {total} klaster, shundan {multi} tasida 1 dan ortiq element")
    return 0


def cmd_clusters_show(cluster_id: int) -> int:
    from bot import db
    from bot.dedup import cluster_summary

    db.check_schema()
    data = cluster_summary(cluster_id)
    if data is None:
        print(f"Klaster #{cluster_id} topilmadi.")
        return 1

    cluster, members = data["cluster"], data["members"]
    print(f"Klaster #{cluster['id']}")
    print(f"Sarlavha:  {cluster['title']}")
    print(f"Status:    {cluster['status']}")
    print(f"Elementlar: {cluster['item_count']}")
    if cluster["importance_score"] is not None:
        print(
            f"Baho:      muhimlik {cluster['importance_score']}, "
            f"moslik {cluster['relevance_score']}, kategoriya {cluster['category']}"
        )
        if cluster["rank_reason"]:
            print(f"Izoh:      {cluster['rank_reason']}")
    if cluster.get("enriched_at"):
        text_len = len(cluster["enriched_text"] or "")
        source = cluster["enrich_source"] or "—"
        print(f"Boyitish:  {source}, {text_len} belgi")
        if cluster["article_url"]:
            print(f"Maqola:    {cluster['article_url']}")
    print(f"Yaratildi: {cluster['created_at']}")
    print()
    print("A'zolar:")
    for m in members:
        marker = "★" if m["is_primary"] else " "
        sim = f"{m['similarity']:.3f}" if m["similarity"] is not None else "  —  "
        print(f" {marker} [{m['id']:>4}] {sim}  {m['source']:<18} {m['title'][:60]}")
        # Agregatordan kelgan bo'lsa nashriyot havolasi ko'rsatiladi
        link = m.get("publisher_url") or m["url"]
        print(f"              {link[:88]}")
    return 0


def cmd_run(interval_hours: int, once: bool) -> int:
    from bot import db
    from bot.scheduler import run_forever, run_pipeline

    db.check_schema()
    if once:
        run_pipeline()
        return 0
    return run_forever(interval_hours=interval_hours)


def cmd_not_implemented(name: str) -> int:
    print(f"'{name}' buyrug'i hali tayyor emas (keyingi bosqichda qo'shiladi).")
    return 1


# ─────────────────────────── Kirish nuqtasi ───────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        level = args.log_level or load_config().log_level
    except ConfigError as exc:
        print(f"Konfiguratsiya xatosi: {exc}", file=sys.stderr)
        return 2
    setup_logging(level)

    try:
        match args.command:
            case "db" if args.db_command == "migrate":
                return cmd_db_migrate()
            case "db" if args.db_command == "status":
                return cmd_db_status()
            case "llm" if args.llm_command == "test":
                return cmd_llm_test(args.stage, args.prompt)
            case "cost":
                return cmd_cost(args.days)
            case "collect":
                return cmd_collect(args.source)
            case "backfill-publishers":
                return cmd_backfill_publishers()
            case "dedup":
                return cmd_dedup(args.window_days)
            case "rank":
                return cmd_rank(args.limit, args.batch_size, args.dry_run)
            case "enrich":
                return cmd_enrich(args.limit, args.no_search)
            case "write":
                return cmd_write(args.limit, args.cluster)
            case "posts" if args.posts_command == "list":
                return cmd_posts_list(args.limit, args.status)
            case "posts" if args.posts_command == "show":
                return cmd_posts_show(args.post_id)
            case "publish":
                return cmd_publish(args.limit, args.send_only)
            case "publish-now":
                return cmd_publish_now(args.post_id, args.force)
            case "telegram" if args.telegram_command == "check":
                return cmd_telegram_check()
            case "health":
                return cmd_health(args.hours, args.send, args.sources)
            case "stats":
                return cmd_stats()
            case "clusters" if args.clusters_command == "list":
                return cmd_clusters_list(args.limit, args.status)
            case "clusters" if args.clusters_command == "show":
                return cmd_clusters_show(args.cluster_id)
            case "run":
                return cmd_run(args.interval_hours, args.once)
            case _:
                parser.error(f"Noma'lum buyruq: {args.command}")
                return 2
    except ConfigError as exc:
        print(f"Konfiguratsiya xatosi: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nTo'xtatildi.", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001 — CLI chegarasi
        log.exception("Kutilmagan xato")
        print(f"Xato: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
