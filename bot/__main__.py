"""CLI kirish nuqtasi.

Buyruqlar:
    bot db migrate          — baza sxemasini yangilash
    bot db status           — baza holati
    bot llm test            — OpenRouter ulanishini tekshirish
    bot cost [--days N]     — LLM xarajatlari hisoboti
    bot collect             — manbalardan yangilik yig'ish
    bot dedup               — dublikatlarni klasterlash
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

    dedup_parser = sub.add_parser("dedup", help="Dublikatlarni klasterlash")
    dedup_parser.add_argument(
        "--window-days", type=int, default=7, help="Solishtirish oynasi (default: 7 kun)"
    )

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
    print(f"Yaratildi: {cluster['created_at']}")
    print()
    print("A'zolar:")
    for m in members:
        marker = "★" if m["is_primary"] else " "
        sim = f"{m['similarity']:.3f}" if m["similarity"] is not None else "  —  "
        print(f" {marker} [{m['id']:>4}] {sim}  {m['source']:<18} {m['title'][:60]}")
        print(f"              {m['url'][:88]}")
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
            case "dedup":
                return cmd_dedup(args.window_days)
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
