#!/usr/bin/env python3
"""Keep the one TEST Woo shop reachable without changing application DNS.

The shop and Agentify TEST happen to share dmitry-dev. The host cannot hairpin
through the Comino public address, while the application must still resolve and
pin that public address for its SSRF boundary. This rule translates only the
TEST Compose subnet's connection to that one public address and port, below
DNS and TLS. Production never installs this file.
"""

from __future__ import annotations

import ipaddress
import json
import os
import shlex
import socket
import subprocess
import sys
from collections.abc import Sequence

EXPECTED_HOST = "dmitry-dev"
NETWORKS = (
    ("agentify-test_default", "agentify-test", "default"),
    ("agentify-woo-lab", "agentify-woo-lab", "shop"),
)
PUBLIC_HOSTS = ("woo.nuanu.ai", "test.agentify.ad")
PUBLIC_IP = "153.124.160.16"
INGRESS_IP = "10.20.10.11"
HTTPS_PORT = "443"
CHAIN = "AGENTIFY_TEST_WOO"
COMMENT = "agentify-test-woo-hairpin"
JUMP_COMMENT = "agentify-test-woo-hairpin-jump"
IPTABLES = ["iptables", "--wait", "10", "-t", "nat"]


def refuse(message: str) -> RuntimeError:
    return RuntimeError(message)


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


def validate_dns(host: str, addresses: Sequence[str]) -> None:
    if set(addresses) != {PUBLIC_IP}:
        raise refuse(f"{host} DNS differs from the one reviewed public address")


def chain_rule(subnet: str) -> list[str]:
    private_ipv4(subnet)
    return [
        "-s", subnet,
        "-d", f"{PUBLIC_IP}/32",
        "-p", "tcp",
        "-m", "tcp",
        "--dport", HTTPS_PORT,
        "-m", "comment",
        "--comment", COMMENT,
        "-j", "DNAT",
        "--to-destination", f"{INGRESS_IP}:{HTTPS_PORT}",
    ]


def jump_rule() -> list[str]:
    return ["-m", "comment", "--comment", JUMP_COMMENT, "-j", CHAIN]


def is_owned_chain_rule(tokens: list[str]) -> bool:
    if len(tokens) < 4 or tokens[:3] != ["-A", CHAIN, "-s"]:
        return False
    try:
        expected = ["-A", CHAIN, *chain_rule(tokens[3])]
    except RuntimeError:
        return False
    return tokens == expected


def validate_existing(chain_lines: Sequence[str], prerouting_lines: Sequence[str]) -> None:
    for line in chain_lines:
        tokens = shlex.split(line)
        if tokens == ["-N", CHAIN] or is_owned_chain_rule(tokens):
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


def require_host() -> None:
    if os.geteuid() != 0:
        raise refuse("the TEST hairpin must run as root")
    if socket.gethostname().split(".", 1)[0] != EXPECTED_HOST:
        raise refuse("the TEST hairpin is on the wrong host")


def current_subnets() -> list[str]:
    subnets = []
    for name, project, label in NETWORKS:
        inspected = run(["docker", "network", "inspect", name])
        subnets.append(validate_network(inspected.stdout, name, project, label))
    if len(set(subnets)) != len(subnets):
        raise refuse("the two TEST Docker networks share one subnet")
    return subnets


def require_public_dns() -> None:
    for host in PUBLIC_HOSTS:
        answers = [
            address[4][0]
            for address in socket.getaddrinfo(host, int(HTTPS_PORT), socket.AF_INET)
        ]
        validate_dns(host, answers)


def existing_rules() -> tuple[list[str] | None, list[str]]:
    chain = rule_lines(CHAIN)
    prerouting = rule_lines("PREROUTING")
    if prerouting is None:
        raise refuse("the nat PREROUTING chain is unavailable")
    validate_existing(chain or [], prerouting)
    return chain, prerouting


def delete_owned_jumps() -> None:
    while run([*IPTABLES, "-C", "PREROUTING", *jump_rule()], check=False).returncode == 0:
        run([*IPTABLES, "-D", "PREROUTING", *jump_rule()])


def reconcile() -> None:
    require_host()
    subnets = current_subnets()
    require_public_dns()
    chain, _ = existing_rules()
    if chain is None:
        run([*IPTABLES, "-N", CHAIN])
    delete_owned_jumps()
    run([*IPTABLES, "-F", CHAIN])
    for subnet in subnets:
        run([*IPTABLES, "-A", CHAIN, *chain_rule(subnet)])
    run([*IPTABLES, "-I", "PREROUTING", "1", *jump_rule()])
    verify()
    print(f"TEST Woo hairpin reconciled for {', '.join(subnets)}")


def verify() -> None:
    require_host()
    subnets = current_subnets()
    require_public_dns()
    chain, prerouting = existing_rules()
    if chain is None:
        raise refuse("the TEST hairpin chain is absent")
    expected_chain = [f"-N {CHAIN}"] + [
        " ".join(["-A", CHAIN, *chain_rule(subnet)]) for subnet in subnets
    ]
    if chain != expected_chain:
        raise refuse("the TEST hairpin chain is not exactly the assigned rule")
    expected_jump = " ".join(["-A", "PREROUTING", *jump_rule()])
    if sum(line == expected_jump for line in prerouting) != 1:
        raise refuse("the TEST hairpin needs exactly one owned PREROUTING jump")


def remove() -> None:
    require_host()
    chain, _ = existing_rules()
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
