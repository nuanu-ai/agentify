"""What a deployed channel's gateway is handed to seed, from the real files.

The preflight's own tests read two hand-written fixtures, so they cannot see
what `deploy/compose.public.yaml` does to the seed. This renders each channel
the way deploy/stack.sh does — the same compose files in the same order, the
jobs profile activation renders with — from a synthetic environment file, and
runs the preflight over the result, as activation does. A deployed channel
seeds no merchant (ADR-0014), whether or not its environment file still names
AGENTIFY_SEED_KEY, since that line leaves a host's file only after a release
is verified (deploy/README.md, "The release that stops seeding").

It needs Docker with Compose and Node, as the release does.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OVERLAYS = {
    "test": "deploy/compose.agentify-test.yaml",
    "production": "deploy/compose.hetzner-commerce.yaml",
}
DIGEST = "0" * 64
IMAGES = "".join(
    f"AGENTIFY_{name.upper().replace('-', '_')}_IMAGE=ghcr.io/nuanu-ai/agentify-{name}@sha256:{DIGEST}\n"
    for name in ("app", "web", "scanner", "scanner-worker", "scanner-privacy")
)
# Values of their own length and nothing else; none is a credential anywhere.
COMMON = {
    "AGENTIFY_COOKIE_SECURE": "true",
    "AGENTIFY_AUTH_SECRET": "a" * 32,
    "AGENTIFY_INVITATION": "b" * 32,
    "TOKEN_HMAC_SECRET": "c" * 32,
    "EMAIL_ENCRYPTION_KEY": "d" * 32,
    "REPORT_IDENTITY_SECRET": "e" * 32,
    "ANNOUNCEMENT_SECRET": "f" * 32,
}
CHANNELS = {
    "test": {
        **COMMON,
        "AGENTIFY_PUBLIC_ORIGIN": "https://test.agentify.ad",
        "AGENTIFY_SURFACE_MODE": "test",
        "AGENTIFY_PAYMENT_NETWORK": "eip155:84532",
        "AGENTIFY_FACILITATOR_URL": "https://x402.org/facilitator",
        "AGENTIFY_TEST_LISTEN_ADDRESS": "10.20.10.20",
    },
    "production": {
        **COMMON,
        "AGENTIFY_PUBLIC_ORIGIN": "https://agentify.ad",
        "AGENTIFY_SURFACE_MODE": "live",
        "AGENTIFY_PAYMENT_NETWORK": "eip155:8453",
        "AGENTIFY_FACILITATOR_URL": "https://api.cdp.coinbase.com/platform/v2/x402",
        "AGENTIFY_DB_PASSWORD": "g" * 32,
        "CDP_API_KEY_ID": "h" * 16,
        "CDP_API_KEY_SECRET": "i" * 16,
        "MAIL_URL": "https://mail.invalid/send",
        "MAIL_API_KEY": "j" * 16,
        "MAIL_FROM": "Agentify <no-reply@agentify.ad>",
    },
}
SEED = {"test": "csk_test_" + "k" * 44, "production": "csk_live_" + "k" * 44}


def tools_available():
    return shutil.which("docker") is not None and shutil.which("node") is not None


class ChannelRender(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not tools_available():
            raise RuntimeError("these tests render the channels with docker compose and run the preflight with node, and one of the two is missing here")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        (self.dir / "images.env").write_text(IMAGES)

    def tearDown(self):
        self.temp.cleanup()

    def render(self, channel, extra=None):
        values = {**CHANNELS[channel], **(extra or {})}
        environment = self.dir / f"{channel}.env"
        environment.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
        rendered = subprocess.run(
            ["docker", "compose", "--project-directory", str(ROOT), "--project-name", "agentify",
             "--env-file", str(environment), "--env-file", str(self.dir / "images.env"),
             "-f", str(ROOT / "compose.yaml"), "-f", str(ROOT / "deploy/compose.public.yaml"),
             "-f", str(ROOT / OVERLAYS[channel]), "-f", str(ROOT / "deploy/compose.images.yaml"),
             "--profile", "jobs", "config", "--format", "json"],
            capture_output=True, text=True,
            # Nothing from the shell running the suite may reach the render.
            env={"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/tmp"),
                 "AGENTIFY_POSTGRES_INIT": f"/var/lib/agentify/{channel}/postgres-init"},
        )
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        return json.loads(rendered.stdout)

    def preflight(self, channel, document):
        return subprocess.run(
            ["node", str(ROOT / "packages/core/src/deployment/preflight.mjs"), channel],
            input=json.dumps(document), capture_output=True, text=True,
        )

    def test_a_channel_whose_file_names_no_seed_seeds_nothing_and_passes(self):
        for channel in CHANNELS:
            with self.subTest(channel=channel):
                document = self.render(channel)
                self.assertEqual(document["services"]["gateway"]["environment"].get("SANDBOX_MERCHANT_KEY"), "")
                checked = self.preflight(channel, document)
                self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_a_channel_whose_file_still_names_a_seed_seeds_nothing_and_passes(self):
        # The line stays in a host's file until a release is verified, so that
        # an older revision, whose preflight requires a seed, can still be
        # released back onto the channel.
        for channel in CHANNELS:
            with self.subTest(channel=channel):
                document = self.render(channel, {"AGENTIFY_SEED_KEY": SEED[channel]})
                self.assertEqual(document["services"]["gateway"]["environment"].get("SANDBOX_MERCHANT_KEY"), "")
                self.assertNotIn(SEED[channel], json.dumps(document))
                checked = self.preflight(channel, document)
                self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_the_preflight_run_here_refuses_a_rendered_seed_without_printing_it(self):
        # The control for the two above: the same rendered document, with a key
        # put back where the overlay emptied it, is refused.
        for channel in CHANNELS:
            with self.subTest(channel=channel):
                document = self.render(channel)
                document["services"]["gateway"]["environment"]["SANDBOX_MERCHANT_KEY"] = SEED[channel]
                checked = self.preflight(channel, document)
                self.assertEqual(checked.returncode, 65)
                self.assertIn("gateway: SANDBOX_MERCHANT_KEY", checked.stderr)
                self.assertNotIn(SEED[channel], checked.stderr + checked.stdout)


if __name__ == "__main__":
    unittest.main()
