#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


SUBJECT = pathlib.Path(__file__).with_name("agentify-test-woo-hairpin.py")

# Documentation-range addresses (RFC 5737). The real deployment facts are
# supplied by the operator and are deliberately absent from this repository.
PUBLIC_IP = "203.0.113.10"
INGRESS_IP = "192.0.2.7"
EXPECTED_HOST = "test-host"
PUBLIC_HOSTS = ("shop.example", "app.example")


def load_subject():
    spec = importlib.util.spec_from_file_location("agentify_test_woo_hairpin", SUBJECT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # The subject declares a dataclass, and dataclasses resolve annotations
    # through sys.modules. A module loaded by path must be registered there
    # before it executes, or the declaration fails.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def settings(subject, **changes):
    value = {
        "expected_host": EXPECTED_HOST,
        "public_hosts": PUBLIC_HOSTS,
        "public_ip": PUBLIC_IP,
        "ingress_ip": INGRESS_IP,
    }
    value.update(changes)
    return subject.Settings(**value)


def network(**changes):
    value = {
        "Name": "agentify_default",
        "Driver": "bridge",
        "Internal": False,
        "Labels": {
            "com.docker.compose.project": "agentify",
            "com.docker.compose.network": "default",
        },
        "IPAM": {"Config": [{"Subnet": "172.18.0.0/16", "Gateway": "172.18.0.1"}]},
    }
    value.update(changes)
    return json.dumps([value])


class HairpinContract(unittest.TestCase):
    def test_accepts_only_the_actual_private_test_compose_network(self):
        subject = load_subject()
        self.assertEqual(
            subject.validate_network(network(), "agentify_default", "agentify", "default"),
            "172.18.0.0/16",
        )

        woo = network(
            Name="agentify-woo-lab",
            Labels={
                "com.docker.compose.project": "agentify-woo-lab",
                "com.docker.compose.network": "shop",
            },
            IPAM={"Config": [{"Subnet": "172.19.0.0/16", "Gateway": "172.19.0.1"}]},
        )
        self.assertEqual(
            subject.validate_network(woo, "agentify-woo-lab", "agentify-woo-lab", "shop"),
            "172.19.0.0/16",
        )

    def test_refuses_a_network_from_another_compose_project(self):
        subject = load_subject()
        with self.assertRaisesRegex(RuntimeError, "compose project"):
            subject.validate_network(
                network(Labels={"com.docker.compose.project": "somebody-else"}),
                "agentify_default",
                "agentify",
                "default",
            )

    def test_refuses_internal_non_bridge_or_ambiguous_address_space(self):
        subject = load_subject()
        for document in (
            network(Internal=True),
            network(Driver="macvlan"),
            network(IPAM={"Config": [{"Subnet": "8.8.8.0/24"}]}),
            network(IPAM={"Config": [{"Subnet": "172.18.0.0/16"}, {"Subnet": "172.19.0.0/16"}]}),
        ):
            with self.subTest(document=document), self.assertRaises(RuntimeError):
                subject.validate_network(
                    document, "agentify_default", "agentify", "default"
                )

    def test_requires_the_one_reviewed_public_dns_answer(self):
        subject = load_subject()
        configured = settings(subject)
        subject.validate_dns("shop.example", [PUBLIC_IP, PUBLIC_IP], configured)
        for answers in (
            [],
            [INGRESS_IP],
            [PUBLIC_IP, "203.0.113.4"],
            [PUBLIC_IP, "2001:db8::1"],
        ):
            with self.subTest(answers=answers), self.assertRaisesRegex(RuntimeError, "DNS"):
                subject.validate_dns("shop.example", answers, configured)

    def test_rule_is_narrow_and_preserves_the_public_destination_above_the_kernel(self):
        subject = load_subject()
        self.assertEqual(
            subject.chain_rule("172.18.0.0/16", settings(subject)),
            [
                "-s", "172.18.0.0/16",
                "-d", f"{PUBLIC_IP}/32",
                "-p", "tcp",
                "-m", "tcp",
                "--dport", "443",
                "-m", "comment",
                "--comment", "agentify-test-woo-hairpin",
                "-j", "DNAT",
                "--to-destination", f"{INGRESS_IP}:443",
            ],
        )

    def test_existing_state_may_only_contain_our_exact_replaceable_rule(self):
        subject = load_subject()
        configured = settings(subject)
        previous = " ".join(
            ["-A", subject.CHAIN, *subject.chain_rule("172.19.0.0/16", configured)]
        )
        jump = " ".join(["-A", "PREROUTING", *subject.jump_rule()])
        subject.validate_existing(
            [f"-N {subject.CHAIN}", previous], ["-P PREROUTING ACCEPT", jump], configured
        )

        with self.assertRaisesRegex(RuntimeError, "unowned"):
            subject.validate_existing(
                [f"-N {subject.CHAIN}", f"-A {subject.CHAIN} -j ACCEPT"],
                ["-P PREROUTING ACCEPT", jump],
                configured,
            )
        with self.assertRaisesRegex(RuntimeError, "unowned"):
            subject.validate_existing(
                [f"-N {subject.CHAIN}", previous],
                ["-P PREROUTING ACCEPT", f"-A PREROUTING -j {subject.CHAIN}"],
                configured,
            )

    def test_a_rule_built_for_one_deployment_is_not_owned_by_another(self):
        subject = load_subject()
        mine = settings(subject)
        theirs = settings(subject, public_ip="203.0.113.99")
        line = " ".join(["-A", subject.CHAIN, *subject.chain_rule("172.19.0.0/16", theirs)])
        with self.assertRaisesRegex(RuntimeError, "unowned"):
            subject.validate_existing([f"-N {subject.CHAIN}", line], [], mine)


class HairpinSettings(unittest.TestCase):
    environment = {
        "AGENTIFY_TEST_WOO_EXPECTED_HOST": EXPECTED_HOST,
        "AGENTIFY_TEST_WOO_PUBLIC_HOSTS": "shop.example, app.example",
        "AGENTIFY_TEST_WOO_PUBLIC_IP": PUBLIC_IP,
        "AGENTIFY_TEST_WOO_INGRESS_IP": INGRESS_IP,
    }

    def test_reads_every_deployment_fact_from_the_environment(self):
        subject = load_subject()
        with mock.patch.dict("os.environ", self.environment, clear=True):
            loaded = subject.load_settings()
        self.assertEqual(loaded, settings(subject))

    def test_reads_the_same_facts_from_a_configuration_file(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory, "hairpin.json")
            path.write_text(
                json.dumps(
                    {
                        "expected_host": EXPECTED_HOST,
                        "public_hosts": list(PUBLIC_HOSTS),
                        "public_ip": PUBLIC_IP,
                        "ingress_ip": INGRESS_IP,
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.dict(
                "os.environ", {"AGENTIFY_TEST_WOO_CONFIG": str(path)}, clear=True
            ):
                loaded = subject.load_settings()
        self.assertEqual(loaded, settings(subject))

    def test_the_environment_outranks_the_file(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory, "hairpin.json")
            path.write_text(
                json.dumps(
                    {
                        "expected_host": "some-other-host",
                        "public_hosts": ["stale.example"],
                        "public_ip": "203.0.113.200",
                        "ingress_ip": "192.0.2.200",
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.dict(
                "os.environ",
                {**self.environment, "AGENTIFY_TEST_WOO_CONFIG": str(path)},
                clear=True,
            ):
                loaded = subject.load_settings()
        self.assertEqual(loaded, settings(subject))

    def test_every_absent_deployment_fact_is_named_and_nothing_is_assumed(self):
        subject = load_subject()
        for variable in self.environment:
            partial = {name: v for name, v in self.environment.items() if name != variable}
            with self.subTest(missing=variable):
                with mock.patch.dict("os.environ", partial, clear=True):
                    with self.assertRaises(RuntimeError) as refused:
                        subject.load_settings()
                self.assertIn(variable, str(refused.exception))

    def test_an_empty_environment_refuses_instead_of_running_on_a_default(self):
        subject = load_subject()
        with mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(RuntimeError) as refused:
                subject.load_settings()
        for variable in self.environment:
            self.assertIn(variable, str(refused.exception))

    def test_a_configured_path_that_does_not_exist_is_refused_by_name(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as directory:
            missing = pathlib.Path(directory, "absent.json")
            with mock.patch.dict(
                "os.environ", {"AGENTIFY_TEST_WOO_CONFIG": str(missing)}, clear=True
            ):
                with self.assertRaisesRegex(RuntimeError, "does not exist"):
                    subject.load_settings()

    def test_an_address_that_is_not_one_ipv4_address_is_refused(self):
        subject = load_subject()
        for variable, value in (
            ("AGENTIFY_TEST_WOO_PUBLIC_IP", "not-an-address"),
            ("AGENTIFY_TEST_WOO_PUBLIC_IP", "203.0.113.0/24"),
            ("AGENTIFY_TEST_WOO_INGRESS_IP", "2001:db8::1"),
        ):
            with self.subTest(variable=variable, value=value):
                with mock.patch.dict(
                    "os.environ", {**self.environment, variable: value}, clear=True
                ):
                    with self.assertRaises(RuntimeError) as refused:
                        subject.load_settings()
                self.assertIn(variable, str(refused.exception))


if __name__ == "__main__":
    unittest.main()
