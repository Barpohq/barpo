"""Monitor CLI entry point.

Commands:
    monitor servers          — list servers and test the SSH connection
    monitor check            — run the checks once and store the results
    monitor status           — last known state (without a fresh check)
    monitor alerts           — alert history
    monitor diagnose         — explain a problem with the LLM (manual testing)
    monitor run              — continuous mode under the scheduler
"""

from __future__ import annotations

import argparse
import sys

from core.config import ConfigError, log_level
from core.logging_setup import get_logger, setup_logging

# Only for the parser's help text — this avoids pulling in apscheduler
from monitor.config import DEFAULT_INTERVAL_MINUTES

log = get_logger("monitor.cli")

# Status markers for the terminal
STATUS_MARK = {"ok": "✓", "warn": "⚠", "fail": "✗", "error": "✗"}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="monitor",
        description="Server monitor agent — monitoring over SSH",
    )
    parser.add_argument(
        "--log-level",
        default=None,
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Log level (default: LOG_LEVEL from .env)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # ── servers ──
    sub.add_parser("servers", help="List servers and test connectivity")

    # ── check ──
    check_parser = sub.add_parser("check", help="Check the servers once")
    check_parser.add_argument("--server", help="This server only (by name)")
    check_parser.add_argument(
        "--no-save", action="store_true", help="Don't write results to the database"
    )
    check_parser.add_argument(
        "--notify", action="store_true", help="Send a Telegram alert if there's a problem"
    )
    check_parser.add_argument(
        "--diagnose",
        action="store_true",
        help="Add an LLM diagnosis to the alert (with --notify)",
    )

    # ── status ──
    status_parser = sub.add_parser("status", help="Last known state (without checking)")
    status_parser.add_argument("--server", help="This server only")
    status_parser.add_argument(
        "--problems", action="store_true", help="Show problems only"
    )

    # ── alerts ──
    alerts_parser = sub.add_parser("alerts", help="Alert history")
    alerts_parser.add_argument("--limit", type=int, default=20, help="How many (default: 20)")
    alerts_parser.add_argument(
        "--open", action="store_true", help="Unresolved alerts only"
    )

    # ── diagnose ──
    diag_parser = sub.add_parser(
        "diagnose", help="Explain a problem with the LLM (no alert is sent)"
    )
    diag_parser.add_argument("--server", required=True, help="Server name")
    diag_parser.add_argument(
        "--check", help="Check name (e.g. disk:/). If omitted, the first problem"
    )

    # ── run ──
    run_parser = sub.add_parser("run", help="Continuous mode (scheduler)")
    run_parser.add_argument(
        "--interval-minutes",
        type=int,
        default=DEFAULT_INTERVAL_MINUTES,
        help=f"Check interval (default: {DEFAULT_INTERVAL_MINUTES})",
    )
    run_parser.add_argument("--once", action="store_true", help="Run a single cycle and exit")
    run_parser.add_argument(
        "--no-diagnose", action="store_true", help="Skip the LLM diagnosis (cheaper)"
    )

    return parser


def cmd_servers() -> int:
    """Show the configuration and test the connection to each server."""
    from monitor.config import load_servers
    from monitor.ssh import check_connection

    servers = load_servers()
    if not servers:
        print("No servers in servers.yaml")
        return 1

    failures = 0
    for server in servers:
        target = f"{server.user}@{server.host}"
        if server.port != 22:
            target += f":{server.port}"

        if not server.enabled:
            print(f"○ {server.name:<14} {target:<28} disabled")
            continue

        result = check_connection(server)
        if result.ok:
            services = ", ".join(server.services) or "—"
            print(f"✓ {server.name:<14} {target:<28} {result.duration_ms:>5} ms   {services}")
        else:
            failures += 1
            print(f"✗ {server.name:<14} {target:<28} {result.error_message}")

    if failures:
        print(f"\nCould not connect to {failures} server(s).")
        print("Check: the SSH key, known_hosts, and host/user in servers.yaml.")
    return 1 if failures else 0


def cmd_check(server_name: str | None, no_save: bool, notify: bool, diagnose: bool) -> int:
    """Run the checks, store the results and display them."""
    from core import db
    from monitor.checks import check_server
    from monitor.config import enabled_servers, find_server
    from monitor.run import run_checks

    servers = [find_server(server_name)] if server_name else enabled_servers()
    if not servers:
        print("No servers to monitor (all enabled: false?)")
        return 1

    alerts = resolved = 0
    if no_save:
        if notify:
            print("--notify and --no-save don't work together (alerting relies on stored state)")
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
    print(f"{problems} problem(s) found." if problems else "All good.")
    if alerts:
        print(f"{alerts} alert(s) sent.")
    if resolved:
        print(f"{resolved} problem(s) recovered.")
    # Meaningful exit code: for cron and scripts
    return 1 if problems else 0


def cmd_status(server_name: str | None, problems_only: bool) -> int:
    """Show the last stored state — without running a fresh check."""
    from core import db
    from monitor.state import current_states

    db.check_schema()
    states = current_states(server_name)
    if problems_only:
        states = [s for s in states if s.is_problem]

    if not states:
        print("No data — run `monitor check`")
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
    print(f"{problems} problem(s)." if problems else "All good.")
    return 1 if problems else 0


def cmd_alerts(limit: int, open_only: bool) -> int:
    """Show the alert history."""
    from core import db
    from monitor.notify import open_alerts, recent_alerts

    db.check_schema()
    alerts = open_alerts() if open_only else recent_alerts(limit)

    if not alerts:
        print("No open alerts." if open_only else "Alert history is empty.")
        return 0

    for alert in alerts:
        is_open = not alert.get("resolved_at")
        state = "open" if is_open else "resolved"
        mark = "🔴" if is_open else "✓"
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
    """Run the diagnosis by hand — to inspect the prompt and the answer."""
    from monitor.checks import check_server
    from monitor.config import find_server
    from monitor.diagnose import diagnose_problem

    server = find_server(server_name)
    results = check_server(server)

    if check_name:
        selected = next((r for r in results if r.name == check_name), None)
        if selected is None:
            names = ", ".join(r.name for r in results)
            print(f"'{check_name}' not found. Available: {names}")
            return 2
    else:
        selected = next((r for r in results if r.is_problem), None)
        if selected is None:
            print(f"{server.name}: no problems — no diagnosis needed.")
            print("To inspect a specific check: --check <name>")
            return 0

    print(f"Problem:  {selected.server}/{selected.name} — {selected.message}")
    print("Requesting diagnosis...\n")

    diagnosis = diagnose_problem(selected, server)
    if not diagnosis:
        print("No diagnosis obtained (LLM error or cost limit — check the logs).")
        return 1

    print(diagnosis)
    return 0


def cmd_run(interval_minutes: int, once: bool, no_diagnose: bool) -> int:
    """Continuous mode, or a single full cycle."""
    from core import db
    from monitor.scheduler import run_cycle, run_forever

    db.check_schema()

    if once:
        run_cycle(diagnose=not no_diagnose)
        return 0

    return run_forever(interval_minutes, diagnose=not no_diagnose)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        level = args.log_level or log_level()
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
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
            case "run":
                return cmd_run(args.interval_minutes, args.once, args.no_diagnose)
            case _:
                parser.error(f"Unknown command: {args.command}")
                return 2
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001 — the CLI shows the error to the user
        log.exception("Unexpected error")
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
