#!/usr/bin/env python3
"""Exercise Docker discovery and mail exclusion with synthetic logs, without remote writes.

Requires Docker and the pinned collector image cached locally. This does not
contact either channel, Joglo, a merchant, or a payment network.
"""

import json
import shlex
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IMAGE = "grafana/alloy:v1.19.2@sha256:b8ec653c44235fbe910879145dac3597d66b0aaecf60bcbbe82580767771a839"


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.STDOUT, timeout=45)


def main():
    project = "agentify-log-smoke-" + uuid.uuid4().hex[:12]
    containers = []
    try:
        for service, lines in {
            "app": [
                "[gateway] smoke_gateway_diagnostic",
                "[dashboard] no mail provider is configured, so this message was not sent. To: mail-secret@example.invalid",
                "Open https://test.agentify.ad/dashboard/sign-in/open?token=mail-token-secret",
                "mail-body-secret",
                "[app] smoke_after_mail",
            ],
            "scanner": [json.dumps({"schema": "agentify-log-v1", "level": "error", "event": "smoke_scanner_diagnostic"})],
            "wordpress": ["unrelated_fixture_secret"],
        }.items():
            name = project + "-" + service
            docker("run", "--pull=never", "-d", "--name", name,
                   "--label", "com.docker.compose.project=" + project,
                   "--label", "com.docker.compose.service=" + service,
                   "--entrypoint", "/bin/sh", IMAGE, "-c",
                   "sleep 5; printf '%s\n' " + " ".join(shlex.quote(line) for line in lines) + "; sleep 90")
            containers.append(name)

        config = (ROOT / "config.alloy").read_text()
        config = config[:config.index('loki.write "joglo"')]
        config = config.replace('"com.docker.compose.project=agentify", "com.docker.compose.project=agentify-edge"',
                                '"com.docker.compose.project=' + project + '"')
        config = config.replace("loki.write.joglo.receiver", "loki.echo.smoke.receiver")
        config += '\nloki.echo "smoke" {}\n'
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "smoke.alloy"
            path.write_text(config)
            name = project + "-collector"
            docker("run", "--pull=never", "-d", "--name", name,
                   "-v", str(path) + ":/etc/alloy/config.alloy:ro",
                   "-v", "/var/run/docker.sock:/var/run/docker.sock:ro",
                   "-e", "AGENTIFY_CHANNEL=test", IMAGE, "run", "/etc/alloy/config.alloy")
            containers.append(name)
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                output = docker("logs", name)
                if all(marker in output for marker in ("smoke_gateway_diagnostic", "smoke_scanner_diagnostic", "smoke_after_mail")):
                    break
                time.sleep(1)
            else:
                print("\n".join(line for line in output.splitlines() if "level=error" in line))
                raise AssertionError("collector did not receive both fixture diagnostics")
            assert all(secret not in output for secret in (
                "mail-secret", "mail-token-secret", "mail-body-secret", "unrelated_fixture_secret"
            )), "private or unrelated fixture log reached the output"
            assert 'environment="test"' in output.replace(chr(92), ""), "channel label is missing"
            print("PASS: Docker logs received with channel labels; mail and unrelated services excluded")
    finally:
        for name in reversed(containers):
            subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
