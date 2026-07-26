"""Monitor CLI kirish nuqtasi.

Buyruqlar:
    monitor servers          — serverlar ro'yxati va SSH ulanishini sinash
    monitor check            — bir marta tekshirish, natijani saqlash
    monitor status           — oxirgi ma'lum holat (yangi tekshiruvsiz)
    monitor alerts           — alert tarixi
    monitor diagnose         — muammoni LLM bilan izohlash (qo'lda sinash)
"""

from __future__ import annotations

import argparse
import sys

from core.config import ConfigError, log_level
from core.logging_setup import get_logger, setup_logging

log = get_logger("monitor.cli")

# Terminal uchun holat belgilari
STATUS_MARK = {"ok": "✓", "warn": "⚠", "fail": "✗", "error": "✗"}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="monitor",
        description="Server monitor agenti — SSH orqali kuzatish",
    )
    parser.add_argument(
        "--log-level",
        default=None,
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Log darajasi (default: .env dagi LOG_LEVEL)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # ── servers ──
    sub.add_parser("servers", help="Serverlar ro'yxati va ulanish sinovi")

    # ── check ──
    check_parser = sub.add_parser("check", help="Serverlarni bir marta tekshirish")
    check_parser.add_argument("--server", help="Faqat shu server (nom bo'yicha)")
    check_parser.add_argument(
        "--no-save", action="store_true", help="Natijani bazaga yozmaslik"
    )
    check_parser.add_argument(
        "--notify", action="store_true", help="Muammo bo'lsa Telegram'ga alert yuborish"
    )
    check_parser.add_argument(
        "--diagnose",
        action="store_true",
        help="Alertga LLM diagnostikasini qo'shish (--notify bilan)",
    )

    # ── status ──
    status_parser = sub.add_parser("status", help="Oxirgi ma'lum holat (tekshirmasdan)")
    status_parser.add_argument("--server", help="Faqat shu server")
    status_parser.add_argument(
        "--problems", action="store_true", help="Faqat muammolarni ko'rsatish"
    )

    # ── alerts ──
    alerts_parser = sub.add_parser("alerts", help="Alert tarixi")
    alerts_parser.add_argument("--limit", type=int, default=20, help="Nechta (default: 20)")
    alerts_parser.add_argument(
        "--open", action="store_true", help="Faqat yopilmagan alertlar"
    )

    # ── diagnose ──
    diag_parser = sub.add_parser(
        "diagnose", help="Muammoni LLM bilan izohlash (alert yuborilmaydi)"
    )
    diag_parser.add_argument("--server", required=True, help="Server nomi")
    diag_parser.add_argument(
        "--check", help="Check nomi (masalan disk:/). Bo'sh bo'lsa birinchi muammo"
    )

    return parser


def cmd_servers() -> int:
    """Konfiguratsiyani ko'rsatish va har serverga ulanishni sinash."""
    from monitor.config import load_servers
    from monitor.ssh import check_connection

    servers = load_servers()
    if not servers:
        print("servers.yaml da server yo'q")
        return 1

    failures = 0
    for server in servers:
        target = f"{server.user}@{server.host}"
        if server.port != 22:
            target += f":{server.port}"

        if not server.enabled:
            print(f"○ {server.name:<14} {target:<28} o'chirilgan")
            continue

        result = check_connection(server)
        if result.ok:
            services = ", ".join(server.services) or "—"
            print(f"✓ {server.name:<14} {target:<28} {result.duration_ms:>5} ms   {services}")
        else:
            failures += 1
            print(f"✗ {server.name:<14} {target:<28} {result.error_message}")

    if failures:
        print(f"\n{failures} ta serverga ulanib bo'lmadi.")
        print("Tekshiring: SSH kaliti, known_hosts, servers.yaml dagi host/user.")
    return 1 if failures else 0


def cmd_check(server_name: str | None, no_save: bool, notify: bool, diagnose: bool) -> int:
    """Tekshiruvni bajarish, natijani saqlash va ko'rsatish."""
    from core import db
    from monitor.checks import check_server
    from monitor.config import enabled_servers, find_server
    from monitor.run import run_checks

    servers = [find_server(server_name)] if server_name else enabled_servers()
    if not servers:
        print("Kuzatiladigan server yo'q (hammasi enabled: false?)")
        return 1

    alerts = resolved = 0
    if no_save:
        if notify:
            print("--notify va --no-save birga ishlamaydi (alert holatga tayanadi)")
            return 2
        results = []
        for server in servers:
            results.extend(check_server(server))
        problems = sum(1 for r in results if r.is_problem)
    else:
        db.check_schema()
        report = run_checks(servers, notify=notify, diagnose=diagnose)
        results = report.results
        problems = report.problems
        alerts, resolved = report.alerts_sent, report.alerts_resolved

    current = ""
    for result in results:
        if result.server != current:
            current = result.server
            print(f"\n─── {current} ───")
        mark = STATUS_MARK.get(result.status, "?")
        print(f"  {mark} {result.name:<20} {result.message}")

    print()
    print(f"{problems} ta muammo topildi." if problems else "Hammasi joyida.")
    if alerts:
        print(f"{alerts} ta alert yuborildi.")
    if resolved:
        print(f"{resolved} ta muammo tiklandi.")
    # Semantik exit code: cron va skriptlar uchun
    return 1 if problems else 0


def cmd_status(server_name: str | None, problems_only: bool) -> int:
    """Bazadagi oxirgi holatni ko'rsatish — yangi tekshiruvsiz."""
    from core import db
    from monitor.state import current_states

    db.check_schema()
    states = current_states(server_name)
    if problems_only:
        states = [s for s in states if s.is_problem]

    if not states:
        print("Ma'lumot yo'q — `monitor check` ni ishga tushiring")
        return 0

    current = ""
    problems = 0
    for state in states:
        if state.server != current:
            current = state.server
            print(f"\n─── {current} ───")
        mark = STATUS_MARK.get(state.status, "?")
        print(f"  {mark} {state.check_name:<20} {state.message:<44} {state.checked_at}")
        if state.is_problem:
            problems += 1

    print()
    print(f"{problems} ta muammo." if problems else "Hammasi joyida.")
    return 1 if problems else 0


def cmd_alerts(limit: int, open_only: bool) -> int:
    """Alert tarixini ko'rsatish."""
    from core import db
    from monitor.notify import open_alerts, recent_alerts

    db.check_schema()
    alerts = open_alerts() if open_only else recent_alerts(limit)

    if not alerts:
        print("Ochiq alert yo'q." if open_only else "Alert tarixi bo'sh.")
        return 0

    for alert in alerts:
        state = "ochiq" if not alert.get("resolved_at") else "yopilgan"
        mark = "🔴" if state == "ochiq" else "✓"
        print(
            f"{mark} #{alert['id']:<4} {alert['created_at']}  "
            f"{alert['server']}/{alert['check_name']:<16} {state}"
        )
        print(f"     {alert['summary']}")
        if alert.get("diagnosis"):
            first_line = str(alert["diagnosis"]).splitlines()[0]
            print(f"     💡 {first_line[:90]}")

    return 0


def cmd_diagnose(server_name: str, check_name: str | None) -> int:
    """Diagnostikani qo'lda ishga tushirish — prompt va javobni ko'rish."""
    from monitor.checks import check_server
    from monitor.config import find_server
    from monitor.diagnose import diagnose_problem

    server = find_server(server_name)
    results = check_server(server)

    if check_name:
        selected = next((r for r in results if r.name == check_name), None)
        if selected is None:
            names = ", ".join(r.name for r in results)
            print(f"'{check_name}' topilmadi. Mavjud: {names}")
            return 2
    else:
        selected = next((r for r in results if r.is_problem), None)
        if selected is None:
            print(f"{server.name}: muammo yo'q — diagnostika kerak emas.")
            print("Aniq checkni ko'rish uchun: --check <nom>")
            return 0

    print(f"Muammo:  {selected.server}/{selected.name} — {selected.message}")
    print("Diagnostika so'ralmoqda...\n")

    diagnosis = diagnose_problem(selected, server)
    if not diagnosis:
        print("Diagnostika olinmadi (LLM xatosi yoki limit — loglarni ko'ring).")
        return 1

    print(diagnosis)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        level = args.log_level or log_level()
    except ConfigError as exc:
        print(f"Konfiguratsiya xatosi: {exc}", file=sys.stderr)
        return 2
    setup_logging(level)

    try:
        match args.command:
            case "servers":
                return cmd_servers()
            case "check":
                return cmd_check(args.server, args.no_save, args.notify, args.diagnose)
            case "status":
                return cmd_status(args.server, args.problems)
            case "alerts":
                return cmd_alerts(args.limit, args.open)
            case "diagnose":
                return cmd_diagnose(args.server, args.check)
            case _:
                parser.error(f"Noma'lum buyruq: {args.command}")
                return 2
    except ConfigError as exc:
        print(f"Konfiguratsiya xatosi: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001 — CLI foydalanuvchiga xato ko'rsatadi
        log.exception("Kutilmagan xato")
        print(f"Xato: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
