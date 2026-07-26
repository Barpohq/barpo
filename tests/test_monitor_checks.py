"""Monitor: konfiguratsiya, parserlar va baholash.

Parser namunalari real serverdan olingan (Ubuntu 24.04) — sun'iy
emas. Bu muhim: `df` va `free` chiqishi distributivlarda farq qiladi
va sun'iy namuna parser xatosini yashirib qo'yadi.
"""

from __future__ import annotations

import pytest

from core.config import ConfigError
from monitor.checks import (
    ERROR,
    FAIL,
    OK,
    SEP,
    WARN,
    build_remote_command,
    check_kind,
    evaluate,
    parse_disk,
    parse_load,
    parse_memory,
    parse_services,
    parse_uptime,
    split_sections,
)
from monitor.config import parse_servers
from monitor.ssh import MAX_OUTPUT, build_command

# ─────────────── Real server chiqishi (Ubuntu 24.04, 4 yadro, 8 GB) ───────────────

REAL_LOADAVG = "0.68 0.35 0.24 2/1359 1835000"

REAL_FREE = """\
               total        used        free      shared  buff/cache   available
Mem:      8127746048  4663480320   314232832   136699904  3611860992  3464265728
Swap:              0           0           0"""

# Diqqat: 15 qatordan 11 tasi tmpfs va Docker overlay
REAL_DF = """\
Filesystem        1-blocks        Used   Available Capacity Mounted on
tmpfs            812777472     1839104   810938368       1% /run
/dev/sda1      80307429376 39212343296 37772472320      51% /
tmpfs           4063870976           0  4063870976       0% /dev/shm
tmpfs              5242880           0     5242880       0% /run/lock
/dev/sda15       264281088      148992   264132096       1% /boot/efi
tmpfs            812773376       16384   812756992       1% /run/user/0
overlay        80307429376 39212343296 37772472320      51% /var/lib/docker/overlayfs/8402b3c
overlay        80307429376 39212343296 37772472320      51% /var/lib/docker/overlayfs/b2bf1fe"""

REAL_UPTIME = "15640138.12 60956564.53"


def _server(**overrides):
    entry = {"name": "s1", "host": "10.0.0.1", **overrides}
    return parse_servers({"servers": [entry]})[0]


class TestParseLoad:
    def test_real_output(self) -> None:
        assert parse_load(REAL_LOADAVG, "4") == (0.68, 4)

    def test_missing_nproc_assumes_one_core(self) -> None:
        assert parse_load(REAL_LOADAVG, "") == (0.68, 1)

    def test_zero_nproc_never_divides_by_zero(self) -> None:
        _, cores = parse_load(REAL_LOADAVG, "0")

        assert cores == 1

    def test_garbage_returns_none(self) -> None:
        assert parse_load("bu son emas", "4") is None

    def test_empty_returns_none(self) -> None:
        assert parse_load("", "4") is None


class TestParseMemory:
    def test_uses_available_not_used(self) -> None:
        """buff/cache band emas — kerak bo'lganda darhol bo'shatiladi.

        `used` bo'yicha hisoblansa boshqa raqam chiqadi; to'g'ri o'lchov
        `total - available`.
        """
        percent = parse_memory(REAL_FREE)

        assert percent is not None
        assert round(percent) == 57

    def test_cache_heavy_server_is_not_full(self) -> None:
        """Deyarli hammasi cache: `used` past, lekin free ham past."""
        output = (
            "               total        used        free      shared  buff/cache   available\n"
            "Mem:      1000000000    50000000    10000000           0   940000000   900000000"
        )
        percent = parse_memory(output)

        assert percent is not None
        assert round(percent) == 10

    def test_missing_columns_returns_none(self) -> None:
        assert parse_memory("Mem: 100 50") is None

    def test_no_mem_line_returns_none(self) -> None:
        assert parse_memory("Swap: 0 0 0") is None


class TestParseDisk:
    def test_skips_tmpfs_and_overlay(self) -> None:
        """Real serverda 8 qatordan faqat 2 tasi haqiqiy disk."""
        mounts = [d.mount for d in parse_disk(REAL_DF)]

        assert mounts == ["/", "/boot/efi"]

    def test_percent_and_bytes(self) -> None:
        root = next(d for d in parse_disk(REAL_DF) if d.mount == "/")

        assert root.percent == 51.0
        assert root.total_bytes == 80307429376

    def test_header_is_skipped(self) -> None:
        assert parse_disk("Filesystem 1-blocks Used Available Capacity Mounted on") == []

    def test_malformed_lines_ignored(self) -> None:
        output = REAL_DF + "\nyaroqsiz qator\n"

        assert len(parse_disk(output)) == 2

    def test_empty_output(self) -> None:
        assert parse_disk("") == []


class TestParseUptime:
    def test_real_output(self) -> None:
        uptime = parse_uptime(REAL_UPTIME)

        assert uptime is not None
        assert round(uptime / 86400) == 181

    def test_garbage_returns_none(self) -> None:
        assert parse_uptime("salom") is None


class TestParseServices:
    def test_order_matches_request(self) -> None:
        result = parse_services("active\ninactive\nactive", ("nginx", "mysql", "docker"))

        assert result == {"nginx": "active", "mysql": "inactive", "docker": "active"}

    def test_missing_lines_become_unknown(self) -> None:
        result = parse_services("active", ("nginx", "mysql"))

        assert result["mysql"] == "unknown"

    def test_empty_output(self) -> None:
        result = parse_services("", ("nginx",))

        assert result == {"nginx": "unknown"}


class TestSplitSections:
    def test_splits_by_separator(self) -> None:
        stdout = f"{SEP}loadavg\n0.1 0.2 0.3\n{SEP}nproc\n4"
        sections = split_sections(stdout)

        assert sections == {"loadavg": "0.1 0.2 0.3", "nproc": "4"}

    def test_empty_section_is_kept(self) -> None:
        """Buyruq yo'q bo'lsa bo'lim bo'sh qoladi, qolganlari ishlaydi."""
        sections = split_sections(f"{SEP}services\n{SEP}uptime\n123.4")

        assert sections["services"] == ""
        assert sections["uptime"] == "123.4"

    def test_no_separator_returns_empty(self) -> None:
        assert split_sections("shunchaki matn") == {}


class TestEvaluate:
    def _sections(self, **overrides) -> dict[str, str]:
        base = {
            "loadavg": REAL_LOADAVG,
            "nproc": "4",
            "mem": REAL_FREE,
            "disk": REAL_DF,
            "uptime": REAL_UPTIME,
        }
        base.update(overrides)
        return base

    def test_healthy_server_all_ok(self) -> None:
        results = evaluate(_server(), self._sections())

        assert all(r.status == OK for r in results)

    def test_disk_threshold_triggers_fail(self) -> None:
        server = _server(checks={"disk": {"warn": 30, "fail": 50, "mounts": ["/"]}})
        results = {r.name: r for r in evaluate(server, self._sections())}

        assert results["disk:/"].status == FAIL

    def test_disk_warn_between_thresholds(self) -> None:
        server = _server(checks={"disk": {"warn": 50, "fail": 90, "mounts": ["/"]}})
        results = {r.name: r for r in evaluate(server, self._sections())}

        assert results["disk:/"].status == WARN

    def test_mounts_filter_applies(self) -> None:
        server = _server(checks={"disk": {"mounts": ["/boot/efi"]}})
        names = [r.name for r in evaluate(server, self._sections())]

        assert "disk:/boot/efi" in names
        assert "disk:/" not in names

    def test_unreadable_section_is_error(self) -> None:
        results = {r.name: r for r in evaluate(_server(), self._sections(mem="axlat"))}

        assert results["memory"].status == ERROR

    def test_inactive_service_fails(self) -> None:
        server = _server(services=["nginx", "mysql"])
        sections = self._sections(services="active\nfailed")
        results = {r.name: r for r in evaluate(server, sections)}

        assert results["service:nginx"].status == OK
        assert results["service:mysql"].status == FAIL

    def test_uptime_is_informational_only(self) -> None:
        """Uptime chegarasiz — faqat qayd etiladi, hech qachon fail emas."""
        results = {r.name: r for r in evaluate(_server(), self._sections())}

        assert results["uptime"].status == OK

    def test_load_divided_by_cores(self) -> None:
        server = _server(checks={"load": {"warn": 0.1, "fail": 0.2}})
        # 0.68 / 4 = 0.17 -> warn, lekin 1 yadroda 0.68 -> fail
        results = {r.name: r for r in evaluate(server, self._sections())}
        assert results["load"].status == WARN

        results = {r.name: r for r in evaluate(server, self._sections(nproc="1"))}
        assert results["load"].status == FAIL


class TestRemoteCommand:
    def test_includes_all_sections(self) -> None:
        command = build_remote_command(_server())

        for section in ("loadavg", "nproc", "mem", "disk", "uptime"):
            assert f"{SEP}{section}" in command

    def test_services_only_when_configured(self) -> None:
        assert "systemctl" not in build_remote_command(_server())
        assert "systemctl is-active nginx" in build_remote_command(_server(services=["nginx"]))

    def test_read_only_commands(self) -> None:
        """Hech qanday o'zgartiruvchi buyruq bo'lmasligi kerak."""
        command = build_remote_command(_server(services=["nginx"]))

        for dangerous in ("rm ", "systemctl restart", "systemctl stop", "kill", "apt", "tee "):
            assert dangerous not in command

    def test_no_file_writes(self) -> None:
        """Faylga yozuv yo'q. `2>/dev/null` — xatoni bostirish, yozuv emas."""
        command = build_remote_command(_server(services=["nginx"]))

        assert ">>" not in command
        assert command.count(">") == command.count("2>/dev/null")


class TestSshCommandBuilding:
    def test_batch_mode_and_host_checking(self) -> None:
        command = build_command(_server(), "echo ok")

        assert "BatchMode=yes" in command
        assert "StrictHostKeyChecking=yes" in command

    def test_target_and_command_last(self) -> None:
        command = build_command(_server(user="monitor", host="1.2.3.4"), "echo ok")

        assert command[-2] == "monitor@1.2.3.4"
        assert command[-1] == "echo ok"

    def test_port_only_when_non_default(self) -> None:
        assert "-p" not in build_command(_server(), "x")
        assert "-p" in build_command(_server(port=2222), "x")

    def test_key_file_adds_identities_only(self) -> None:
        command = build_command(_server(key_file="~/.ssh/id_ed25519"), "x")

        assert "IdentitiesOnly=yes" in command
        assert not any(arg.startswith("~") for arg in command)

    def test_command_is_a_list_not_shell_string(self) -> None:
        """shell=False bilan ishlatiladi — inyeksiya yuzasi yo'q."""
        assert isinstance(build_command(_server(), "echo ok"), list)


class TestOutputLimits:
    def test_max_output_is_bounded(self) -> None:
        """Serverdan kelgan matn LLM promptiga tushadi — cheklangan bo'lishi shart."""
        assert MAX_OUTPUT <= 10_000


class TestCheckKind:
    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("disk:/", "disk"),
            ("disk:/var/lib", "disk"),
            ("service:nginx", "service"),
            ("memory", "memory"),
            ("ssh", "ssh"),
        ],
    )
    def test_kind_extraction(self, name: str, expected: str) -> None:
        assert check_kind(name) == expected


class TestConfigValidation:
    def test_duplicate_names_rejected(self) -> None:
        raw = {"servers": [{"name": "a", "host": "1"}, {"name": "a", "host": "2"}]}

        with pytest.raises(ConfigError, match="takrorlangan"):
            parse_servers(raw)

    def test_missing_host_rejected(self) -> None:
        with pytest.raises(ConfigError, match="host"):
            parse_servers({"servers": [{"name": "a"}]})

    def test_unsafe_service_name_rejected(self) -> None:
        """Xizmat nomi buyruqqa tushadi — validatsiya majburiy."""
        raw = {"servers": [{"name": "a", "host": "1", "services": ["nginx; rm -rf /"]}]}

        with pytest.raises(ConfigError, match="xizmat nomi"):
            parse_servers(raw)

    def test_unsafe_mount_rejected(self) -> None:
        raw = {"servers": [{"name": "a", "host": "1", "checks": {"disk": {"mounts": ["$(id)"]}}}]}

        with pytest.raises(ConfigError, match="mount"):
            parse_servers(raw)

    def test_unknown_check_rejected(self) -> None:
        raw = {"servers": [{"name": "a", "host": "1", "checks": {"cpu_temp": {}}}]}

        with pytest.raises(ConfigError, match="noma'lum check"):
            parse_servers(raw)

    def test_defaults_apply_to_servers(self) -> None:
        raw = {
            "defaults": {"user": "monitor", "port": 2222, "checks": {"disk": {"fail": 70}}},
            "servers": [{"name": "a", "host": "1"}],
        }
        server = parse_servers(raw)[0]

        assert server.user == "monitor"
        assert server.port == 2222
        assert server.threshold("disk").fail == 70

    def test_server_overrides_defaults(self) -> None:
        raw = {
            "defaults": {"user": "monitor", "checks": {"disk": {"fail": 70}}},
            "servers": [
                {"name": "a", "host": "1", "user": "root", "checks": {"disk": {"fail": 95}}}
            ],
        }
        server = parse_servers(raw)[0]

        assert server.user == "root"
        assert server.threshold("disk").fail == 95

    def test_partial_override_keeps_other_threshold(self) -> None:
        """Faqat fail berilsa, warn defaults'dan qolishi kerak."""
        raw = {
            "defaults": {"checks": {"disk": {"warn": 60, "fail": 80}}},
            "servers": [{"name": "a", "host": "1", "checks": {"disk": {"fail": 95}}}],
        }
        thresholds = parse_servers(raw)[0].threshold("disk")

        assert (thresholds.warn, thresholds.fail) == (60, 95)

    def test_disabled_server_parsed_but_flagged(self) -> None:
        raw = {"servers": [{"name": "a", "host": "1", "enabled": False}]}

        assert not parse_servers(raw)[0].enabled

    def test_real_config_file_parses(self) -> None:
        """Repodagi config/servers.yaml haqiqatan o'qiladi."""
        from monitor.config import load_servers

        load_servers.cache_clear()
        servers = load_servers()

        assert servers
        assert all(s.name and s.host for s in servers)
