"""Monitor CLI kirish nuqtasi.

Buyruqlar:
    monitor servers          — serverlar ro'yxati va SSH ulanishini sinash
    monitor check            — bir marta tekshirish va natijani ko'rsatish
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


def cmd_check(server_name: str | None) -> int:
    """Tekshiruvni bajarish va natijani jadval qilib ko'rsatish."""
    from monitor.checks import check_server
    from monitor.config import enabled_servers, find_server

    servers = [find_server(server_name)] if server_name else enabled_servers()
    if not servers:
        print("Kuzatiladigan server yo'q (hammasi enabled: false?)")
        return 1

    problems = 0
    for server in servers:
        print(f"\n─── {server.name} ({server.host}) ───")
        for result in check_server(server):
            mark = STATUS_MARK.get(result.status, "?")
            print(f"  {mark} {result.name:<20} {result.message}")
            if result.is_problem:
                problems += 1

    print()
    if problems:
        print(f"{problems} ta muammo topildi.")
    else:
        print("Hammasi joyida.")
    # Semantik exit code: cron va skriptlar uchun
    return 1 if problems else 0


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
                return cmd_check(args.server)
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
