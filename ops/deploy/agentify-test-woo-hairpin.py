#!/usr/bin/env python3
"""Keep the one TEST Woo shop reachable without changing application DNS.

The shop and Agentify TEST happen to share one host. That host cannot hairpin
through the shared public address, while the application must still resolve and
pin that public address for its SSRF boundary. This rule translates only the
TEST Compose subnet's connection to that one public address and port, below DNS
and TLS. Production never installs this file.

The host name and the two addresses are deployment facts, not source. They are
supplied by the operator through the environment or through a configuration
file, and every one of them is required: a missing value refuses the run with
the name of what is missing. There is no default, because a default here is a
rule pointed at somebody else's address.
"""

from __future__ import annotations

import ipaddress
import json
import os
import pathlib
import shlex
import socket
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass

NETWORKS = (
    ("agentify-test_default", "agentify-test", "default"),
    ("agentify-woo-lab", "agentify-woo-lab", "shop"),
)
HTTPS_PORT = "443"
CHAIN = "AGENTIFY_TEST_WOO"
COMMENT = "agentify-test-woo-hairpin"
JUMP_COMMENT = "agentify-test-woo-hairpin-jump"
IPTABLES = ["iptables", "--wait", "10", "-t", "nat"]

CONFIG_PATH_VARIABLE = "AGENTIFY_TEST_WOO_CONFIG"
DEFAULT_CONFIG_PATH = "/etc/agentify/test-woo-hairpin.json"
SETTING_VARIABLES = {
    "expected_host": "AGENTIFY_TEST_WOO_EXPECTED_HOST",
    "public_hosts": "AGENTIFY_TEST_WOO_PUBLIC_HOSTS",
    "public_ip": "AGENTIFY_TEST_WOO_PUBLIC_IP",
    "ingress_ip": "AGENTIFY_TEST_WOO_INGRESS_IP",
}


def refuse(message: str) -> RuntimeError:
    return RuntimeError(message)


@dataclass(frozen=True)
class Settings:
    """The deployment facts this rule is pointed at."""

    expected_host: str
    public_hosts: tuple[str, ...]
    public_ip: str
    ingress_ip: str


def _ipv4_address(value: str, field: str) -> str:
    try:
        parsed = ipaddress.ip_address(value)
    except ValueError as error:
        raise refuse(f"{SETTING_VARIABLES[field]} is not an IP address: {error}") from error
    if not isinstance(parsed, ipaddress.IPv4Address):
        raise refuse(f"{SETTING_VARIABLES[field]} must be IPv4")
    return str(parsed)


def _read_config_file() -> dict[str, object]:
    configured = os.environ.get(CONFIG_PATH_VARIABLE)
    path = pathlib.Path(configured or DEFAULT_CONFIG_PATH)
    try:
        document = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        if configured:
            raise refuse(f"{CONFIG_PATH_VARIABLE} points at {path}, which does not exist") from None
        return {}
    except OSError as error:
        raise refuse(f"the hairpin configuration at {path} is unreadable: {error}") from error
    try:
        decoded = json.loads(document)
    except json.JSONDecodeError as error:
        raise refuse(f"the hairpin configuration at {path} is not JSON: {error}") from error
    if not isinstance(decoded, dict):
        raise refuse(f"the hairpin configuration at {path} is not one JSON object")
    return decoded


def load_settings() -> Settings:
    """Assemble the deployment facts, refusing loudly when any is absent."""

    document = _read_config_file()
    raw: dict[str, object] = {}
    for field, variable in SETTING_VARIABLES.items():
        from_environment = os.environ.get(variable)
        if from_environment is not None and from_environment.strip():
            raw[field] = from_environment
        elif field in document:
            raw[field] = document[field]

    missing = [SETTING_VARIABLES[field] for field in SETTING_VARIABLES if field not in raw]
    if missing:
        raise refuse(
            "the TEST hairpin has no deployment facts to work from; set "
            + ", ".join(sorted(missing))
            + f" in the environment or in {os.environ.get(CONFIG_PATH_VARIABLE, DEFAULT_CONFIG_PATH)}"
        )

    hosts_value = raw["public_hosts"]
    if isinstance(hosts_value, str):
        hosts = tuple(part.strip() for part in hosts_value.split(",") if part.strip())
    elif isinstance(hosts_value, list) and all(isinstance(part, str) for part in hosts_value):
        hosts = tuple(part.strip() for part in hosts_value if part.strip())
    else:
        raise refuse(f"{SETTING_VARIABLES['public_hosts']} must be a comma-separated list of hosts")
    if not hosts:
        raise refuse(f"{SETTING_VARIABLES['public_hosts']} names no host")

    expected_host = raw["expected_host"]
    if not isinstance(expected_host, str) or not expected_host.strip():
        raise refuse(f"{SETTING_VARIABLES['expected_host']} names no host")

    for field in ("public_ip", "ingress_ip"):
        if not isinstance(raw[field], str):
            raise refuse(f"{SETTING_VARIABLES[field]} must be a string")

    return Settings(
        expected_host=expected_host.strip(),
        public_hosts=hosts,
        public_ip=_ipv4_address(str(raw["public_ip"]), "public_ip"),
        ingress_ip=_ipv4_address(str(raw["ingress_ip"]), "ingress_ip"),
    )


def private_ipv4(value: str) -> ipaddress.IPv4Network:
    try:
        network = ipaddress.ip_network(value, strict=True)
    except ValueError as error:
        raise refuse(f"Docker subnet is invalid: {error}") from error
    private_ranges = tuple(
        ipaddress.ip_network(value)
        for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
    )
    if not isinstance(network, ipaddress.IPv4Network) or not any(
        network.subnet_of(parent) for parent in private_ranges
    ):
        raise refuse("Docker subnet is not one private IPv4 network")
    if network.prefixlen < 16:
        raise refuse("Docker subnet is broader than the reviewed TEST boundary")
    return network


def validate_network(
    document: str, expected_name: str, expected_project: str, expected_network_label: str
) -> str:
    try:
        decoded = json.loads(document)
    except json.JSONDecodeError as error:
        raise refuse(f"Docker network inspection is not JSON: {error}") from error
    if not isinstance(decoded, list) or len(decoded) != 1 or not isinstance(decoded[0], dict):
        raise refuse("Docker returned something other than one network")
    network = decoded[0]
    if network.get("Name") != expected_name:
        raise refuse("Docker network name differs")
    if network.get("Driver") != "bridge" or network.get("Internal") is not False:
        raise refuse("Docker network is not the external bridge assigned to TEST commerce")
    labels = network.get("Labels")
    if not isinstance(labels, dict) or labels.get("com.docker.compose.project") != expected_project:
        raise refuse("Docker network compose project differs")
    if labels.get("com.docker.compose.network") != expected_network_label:
        raise refuse("Docker network label differs")
    ipam = network.get("IPAM")
    configurations = ipam.get("Config") if isinstance(ipam, dict) else None
    if not isinstance(configurations, list) or len(configurations) != 1:
        raise refuse("Docker network must have exactly one address configuration")
    subnet = configurations[0].get("Subnet") if isinstance(configurations[0], dict) else None
    if not isinstance(subnet, str):
        raise refuse("Docker network has no subnet")
    return str(private_ipv4(subnet))


def validate_dns(host: str, addresses: Sequence[str], settings: Settings) -> None:
    if set(addresses) != {settings.public_ip}:
        raise refuse(f"{host} DNS differs from the one reviewed public address")


def chain_rule(subnet: str, settings: Settings) -> list[str]:
    private_ipv4(subnet)
    return [
        "-s", subnet,
        "-d", f"{settings.public_ip}/32",
        "-p", "tcp",
        "-m", "tcp",
        "--dport", HTTPS_PORT,
        "-m", "comment",
        "--comment", COMMENT,
        "-j", "DNAT",
        "--to-destination", f"{settings.ingress_ip}:{HTTPS_PORT}",
    ]


def jump_rule() -> list[str]:
    return ["-m", "comment", "--comment", JUMP_COMMENT, "-j", CHAIN]


def is_owned_chain_rule(tokens: list[str], settings: Settings) -> bool:
    if len(tokens) < 4 or tokens[:3] != ["-A", CHAIN, "-s"]:
        return False
    try:
        expected = ["-A", CHAIN, *chain_rule(tokens[3], settings)]
    except RuntimeError:
        return False
    return tokens == expected


def validate_existing(
    chain_lines: Sequence[str], prerouting_lines: Sequence[str], settings: Settings
) -> None:
    for line in chain_lines:
        tokens = shlex.split(line)
        if tokens == ["-N", CHAIN] or is_owned_chain_rule(tokens, settings):
            continue
        raise refuse(f"refusing unowned rule in {CHAIN}")
    expected_jump = ["-A", "PREROUTING", *jump_rule()]
    for line in prerouting_lines:
        tokens = shlex.split(line)
        if CHAIN not in tokens and JUMP_COMMENT not in tokens:
            continue
        if tokens != expected_jump:
            raise refuse("refusing unowned PREROUTING reference to the TEST hairpin")


def run(arguments: Sequence[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(arguments, check=check, capture_output=True, text=True)


def rule_lines(chain: str) -> list[str] | None:
    result = run([*IPTABLES, "-S", chain], check=False)
    if result.returncode != 0:
        return None
    return [line for line in result.stdout.splitlines() if line]


def require_host(settings: Settings) -> None:
    if os.geteuid() != 0:
        raise refuse("the TEST hairpin must run as root")
    if socket.gethostname().split(".", 1)[0] != settings.expected_host:
        raise refuse("the TEST hairpin is on the wrong host")


def current_subnets() -> list[str]:
    subnets = []
    for name, project, label in NETWORKS:
        inspected = run(["docker", "network", "inspect", name])
        subnets.append(validate_network(inspected.stdout, name, project, label))
    if len(set(subnets)) != len(subnets):
        raise refuse("the two TEST Docker networks share one subnet")
    return subnets


def require_public_dns(settings: Settings) -> None:
    for host in settings.public_hosts:
        answers = [
            address[4][0]
            for address in socket.getaddrinfo(
                host, int(HTTPS_PORT), socket.AF_UNSPEC, socket.SOCK_STREAM
            )
        ]
        validate_dns(host, answers, settings)


def existing_rules(settings: Settings) -> tuple[list[str] | None, list[str]]:
    chain = rule_lines(CHAIN)
    prerouting = rule_lines("PREROUTING")
    if prerouting is None:
        raise refuse("the nat PREROUTING chain is unavailable")
    validate_existing(chain or [], prerouting, settings)
    return chain, prerouting


def delete_owned_jumps() -> None:
    while run([*IPTABLES, "-C", "PREROUTING", *jump_rule()], check=False).returncode == 0:
        run([*IPTABLES, "-D", "PREROUTING", *jump_rule()])


def reconcile() -> None:
    settings = load_settings()
    require_host(settings)
    subnets = current_subnets()
    require_public_dns(settings)
    chain, _ = existing_rules(settings)
    if chain is None:
        run([*IPTABLES, "-N", CHAIN])
    delete_owned_jumps()
    run([*IPTABLES, "-F", CHAIN])
    for subnet in subnets:
        run([*IPTABLES, "-A", CHAIN, *chain_rule(subnet, settings)])
    run([*IPTABLES, "-I", "PREROUTING", "1", *jump_rule()])
    verify()
    print(f"TEST Woo hairpin reconciled for {', '.join(subnets)}")


def verify() -> None:
    settings = load_settings()
    require_host(settings)
    subnets = current_subnets()
    require_public_dns(settings)
    chain, prerouting = existing_rules(settings)
    if chain is None:
        raise refuse("the TEST hairpin chain is absent")
    expected_chain = [f"-N {CHAIN}"] + [
        " ".join(["-A", CHAIN, *chain_rule(subnet, settings)]) for subnet in subnets
    ]
    if chain != expected_chain:
        raise refuse("the TEST hairpin chain is not exactly the assigned rule")
    expected_jump = " ".join(["-A", "PREROUTING", *jump_rule()])
    if sum(line == expected_jump for line in prerouting) != 1:
        raise refuse("the TEST hairpin needs exactly one owned PREROUTING jump")


def remove() -> None:
    settings = load_settings()
    require_host(settings)
    chain, _ = existing_rules(settings)
    if chain is None:
        print("TEST Woo hairpin already absent")
        return
    delete_owned_jumps()
    run([*IPTABLES, "-F", CHAIN])
    run([*IPTABLES, "-X", CHAIN])
    if rule_lines(CHAIN) is not None:
        raise refuse("the TEST hairpin chain remains after removal")
    print("TEST Woo hairpin removed")


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"reconcile", "verify", "remove"}:
        print(f"Usage: {sys.argv[0]} reconcile|verify|remove", file=sys.stderr)
        return 2
    try:
        {"reconcile": reconcile, "verify": verify, "remove": remove}[sys.argv[1]]()
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        print(f"REFUSED: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
