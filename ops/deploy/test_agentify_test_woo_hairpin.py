#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import unittest


SUBJECT = pathlib.Path(__file__).with_name("agentify-test-woo-hairpin.py")


def load_subject():
    spec = importlib.util.spec_from_file_location("agentify_test_woo_hairpin", SUBJECT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def network(**changes):
    value = {
        "Name": "agentify-test_default",
        "Driver": "bridge",
        "Internal": False,
        "Labels": {
            "com.docker.compose.project": "agentify-test",
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
            subject.validate_network(network(), "agentify-test_default", "agentify-test", "default"),
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
                "agentify-test_default",
                "agentify-test",
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
                    document, "agentify-test_default", "agentify-test", "default"
                )

    def test_requires_the_one_reviewed_public_dns_answer(self):
        subject = load_subject()
        subject.validate_dns("woo.nuanu.ai", ["153.124.160.16", "153.124.160.16"])
        for answers in ([], ["10.20.10.11"], ["153.124.160.16", "203.0.113.4"]):
            with self.subTest(answers=answers), self.assertRaisesRegex(RuntimeError, "DNS"):
                subject.validate_dns("woo.nuanu.ai", answers)

    def test_rule_is_narrow_and_preserves_the_public_destination_above_the_kernel(self):
        subject = load_subject()
        self.assertEqual(
            subject.chain_rule("172.18.0.0/16"),
            [
                "-s", "172.18.0.0/16",
                "-d", "153.124.160.16/32",
                "-p", "tcp",
                "-m", "tcp",
                "--dport", "443",
                "-m", "comment",
                "--comment", "agentify-test-woo-hairpin",
                "-j", "DNAT",
                "--to-destination", "10.20.10.11:443",
            ],
        )

    def test_existing_state_may_only_contain_our_exact_replaceable_rule(self):
        subject = load_subject()
        previous = " ".join(["-A", subject.CHAIN, *subject.chain_rule("172.19.0.0/16")])
        jump = " ".join(["-A", "PREROUTING", *subject.jump_rule()])
        subject.validate_existing([f"-N {subject.CHAIN}", previous], ["-P PREROUTING ACCEPT", jump])

        with self.assertRaisesRegex(RuntimeError, "unowned"):
            subject.validate_existing(
                [f"-N {subject.CHAIN}", f"-A {subject.CHAIN} -j ACCEPT"],
                ["-P PREROUTING ACCEPT", jump],
            )
        with self.assertRaisesRegex(RuntimeError, "unowned"):
            subject.validate_existing(
                [f"-N {subject.CHAIN}", previous],
                ["-P PREROUTING ACCEPT", f"-A PREROUTING -j {subject.CHAIN}"],
            )


if __name__ == "__main__":
    unittest.main()
