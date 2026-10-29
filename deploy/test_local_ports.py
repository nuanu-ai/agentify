"""Which interfaces a stack run from compose.yaml alone listens on.

The laptop stack carries sandbox values on purpose: the database password is
agentify and the web door serves a seeded sandbox merchant's key. Those are
safe only while the ports stay on the machine itself, so the defaults bind the
loopback interface, and AGENTIFY_POSTGRES_PUBLISH and AGENTIFY_WEB_PUBLISH stay
the way to publish anywhere else. This renders compose.yaml alone, as
`docker compose up` in a checkout does; what the deployed channels publish is
test_channel_render.py's subject, not this file's.

It needs Docker with Compose.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parent.parent


class LocalPorts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if shutil.which("docker") is None:
            raise RuntimeError("these tests render compose.yaml with docker compose, which is missing here")

    def published(self, extra=None):
        rendered = subprocess.run(
            ["docker", "compose", "--project-directory", str(ROOT), "--project-name", "agentify",
             "--env-file", os.devnull, "-f", str(ROOT / "compose.yaml"), "--profile", "jobs", "config", "--format", "json"],
            capture_output=True, text=True,
            # Nothing from the shell running the suite, nor from a .env in the
            # checkout, may reach the render.
            env={"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/tmp"), **(extra or {})},
        )
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        services = json.loads(rendered.stdout)["services"]
        return {
            (name, port["target"]): (port.get("host_ip"), port.get("published"))
            for name, service in services.items()
            for port in service.get("ports", [])
        }

    def test_a_stack_run_from_this_file_alone_listens_only_on_this_machine(self):
        ports = self.published()

        self.assertEqual(ports, {
            ("postgres", 5432): ("127.0.0.1", "5432"),
            ("web", 8080): ("127.0.0.1", "8080"),
        })

    def test_moving_the_web_port_keeps_it_on_this_machine(self):
        ports = self.published({"AGENTIFY_HOST_PORT": "8090"})

        self.assertEqual(ports[("web", 8080)], ("127.0.0.1", "8090"))

    def test_the_publish_variables_still_publish_where_they_are_told(self):
        ports = self.published({
            "AGENTIFY_POSTGRES_PUBLISH": "192.0.2.10:5432:5432",
            "AGENTIFY_WEB_PUBLISH": "192.0.2.10:443:443",
        })

        self.assertEqual(ports[("postgres", 5432)], ("192.0.2.10", "5432"))
        self.assertEqual(ports[("web", 443)], ("192.0.2.10", "443"))


if __name__ == "__main__":
    unittest.main()
