import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "pull-agent.py"
SPEC = importlib.util.spec_from_file_location("agentify_pull_agent", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load the pull agent under test")
AGENT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AGENT)


class PullAgentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.remote = self.root / "remote.git"
        self.source = self.root / "source"
        self.state = self.root / "state"
        self.log = self.root / "ansible.jsonl"
        self.inventory = self.root / "inventory.json"
        self.fake_ansible = self.root / "ansible-playbook"

        subprocess.run(["git", "init", "--bare", str(self.remote)], check=True, capture_output=True)
        subprocess.run(["git", "init", "-b", "main", str(self.source)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.source), "config", "user.name", "Pull Agent Test"], check=True)
        subprocess.run(
            ["git", "-C", str(self.source), "config", "user.email", "pull-agent@example.invalid"],
            check=True,
        )
        (self.source / "deploy" / "ansible").mkdir(parents=True)
        (self.source / "deploy" / "ansible" / "inventory.yml").write_text("all: {}\n")
        (self.source / "deploy" / "ansible" / "release.yml").write_text("---\n")
        self.first = self.commit("first")
        subprocess.run(["git", "-C", str(self.source), "remote", "add", "origin", str(self.remote)], check=True)
        subprocess.run(["git", "-C", str(self.source), "push", "origin", "main"], check=True, capture_output=True)
        self.move_tag(self.first)

        self.inventory.write_text("{}\n")
        self.fake_ansible.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import json
                import os
                import pathlib
                import sys

                phase = next(value.split("=", 1)[1] for value in sys.argv if value.startswith("release_phase="))
                with pathlib.Path(os.environ["FAKE_ANSIBLE_LOG"]).open("a") as output:
                    output.write(json.dumps({"cwd": os.getcwd(), "argv": sys.argv[1:]}) + "\\n")
                if os.environ.get("FAKE_FAIL_PHASE") == phase:
                    raise SystemExit(23)
                """
            )
        )
        self.fake_ansible.chmod(0o755)
        self.config = self.root / "config.json"
        self.config.write_text(
            json.dumps(
                {
                    "channel": "test",
                    "repository": str(self.remote),
                    "intentTag": "deploy-test",
                    "controllerBranch": "main",
                    "stateDirectory": str(self.state),
                    "inventoryFile": str(self.inventory),
                    "ansiblePlaybook": str(self.fake_ansible),
                }
            )
            + "\n"
        )

    def tearDown(self):
        self.temp.cleanup()

    def commit(self, message):
        marker = self.source / "marker.txt"
        marker.write_text(message + "\n")
        subprocess.run(["git", "-C", str(self.source), "add", "marker.txt"], check=True)
        subprocess.run(["git", "-C", str(self.source), "commit", "-m", message], check=True, capture_output=True)
        return subprocess.check_output(["git", "-C", str(self.source), "rev-parse", "HEAD"], text=True).strip()

    def move_tag(self, revision):
        subprocess.run(["git", "-C", str(self.source), "tag", "-f", "deploy-test", revision], check=True, capture_output=True)
        subprocess.run(
            ["git", "-C", str(self.source), "push", "--force", "origin", "refs/tags/deploy-test"],
            check=True,
            capture_output=True,
        )

    def run_agent(self, fail_phase=None):
        environment = {**os.environ, "FAKE_ANSIBLE_LOG": str(self.log)}
        if fail_phase is not None:
            environment["FAKE_FAIL_PHASE"] = fail_phase
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--config", str(self.config)],
            text=True,
            capture_output=True,
            env=environment,
        )

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def state_value(self):
        return json.loads((self.state / "state.json").read_text())

    def test_deploys_tag_once_with_trusted_main_controller(self):
        result = self.run_agent()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 2)
        self.assertIn("release_phase=stage", calls[0]["argv"])
        self.assertIn("release_phase=activate", calls[1]["argv"])
        for call in calls:
            self.assertIn(f"release_revision={self.first}", call["argv"])
            self.assertIn(f"release_controller_revision={self.first}", call["argv"])
            self.assertEqual(Path(call["cwd"]).name, self.first)
        self.assertEqual(self.state_value()["status"], "verified")

        repeated = self.run_agent()
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(len(self.calls()), 2)

    def test_moving_tag_deploys_the_new_exact_revision(self):
        self.assertEqual(self.run_agent().returncode, 0)
        second = self.commit("second")
        subprocess.run(["git", "-C", str(self.source), "push", "origin", "main"], check=True, capture_output=True)
        self.move_tag(second)

        result = self.run_agent()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls()), 4)
        self.assertIn(f"release_revision={second}", self.calls()[-1]["argv"])
        self.assertEqual(self.state_value()["revision"], second)

    def test_test_candidate_uses_the_newer_trusted_main_controller(self):
        second = self.commit("new controller")
        subprocess.run(["git", "-C", str(self.source), "push", "origin", "main"], check=True, capture_output=True)

        result = self.run_agent()

        self.assertEqual(result.returncode, 0, result.stderr)
        for call in self.calls():
            self.assertIn(f"release_revision={self.first}", call["argv"])
            self.assertIn(f"release_controller_revision={second}", call["argv"])
            self.assertEqual(Path(call["cwd"]).name, second)

    def test_failed_revision_is_not_retried_until_the_tag_moves(self):
        failed = self.run_agent(fail_phase="stage")
        self.assertEqual(failed.returncode, 23)
        self.assertEqual(self.state_value()["status"], "failed")
        self.assertEqual(self.state_value()["phase"], "stage")
        self.assertEqual(len(self.calls()), 1)

        repeated = self.run_agent()
        self.assertEqual(repeated.returncode, 75, repeated.stderr)
        self.assertEqual(len(self.calls()), 1)

        second = self.commit("second")
        subprocess.run(["git", "-C", str(self.source), "push", "origin", "main"], check=True, capture_output=True)
        self.move_tag(second)
        recovered = self.run_agent()
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        self.assertEqual(self.state_value()["status"], "verified")
        self.assertEqual(len(self.calls()), 3)

    def test_missing_tag_is_a_noop_and_never_stops_the_running_revision(self):
        subprocess.run(
            ["git", "-C", str(self.source), "push", "origin", ":refs/tags/deploy-test"],
            check=True,
            capture_output=True,
        )
        result = self.run_agent()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.state / "state.json").exists())

    def test_refuses_a_configuration_that_can_watch_another_tag(self):
        config = json.loads(self.config.read_text())
        config["intentTag"] = "anything-else"
        self.config.write_text(json.dumps(config) + "\n")
        result = self.run_agent()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("deploy-test", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_production_uses_the_same_agent_with_its_own_tag_and_channel(self):
        subprocess.run(
            ["git", "-C", str(self.source), "tag", "-f", "deploy-production", self.first],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "-C", str(self.source), "push", "--force", "origin", "refs/tags/deploy-production"],
            check=True,
            capture_output=True,
        )
        config = json.loads(self.config.read_text())
        config["channel"] = "production"
        config["intentTag"] = "deploy-production"
        self.config.write_text(json.dumps(config) + "\n")
        newer_main = self.commit("not part of the accepted production controller")
        subprocess.run(["git", "-C", str(self.source), "push", "origin", "main"], check=True, capture_output=True)

        with mock.patch.dict(os.environ, {"FAKE_ANSIBLE_LOG": str(self.log)}):
            with mock.patch.object(AGENT, "require_production_acceptance") as acceptance:
                returncode = AGENT.execute(AGENT.read_config(self.config))

        self.assertEqual(returncode, 0)
        acceptance.assert_called_once_with(mock.ANY, self.first)
        self.assertIn("--limit", self.calls()[0]["argv"])
        self.assertIn("production", self.calls()[0]["argv"])
        self.assertIn("release_channel_ack=production", self.calls()[0]["argv"])
        self.assertIn(f"release_revision={self.first}", self.calls()[0]["argv"])
        self.assertIn(f"release_controller_revision={self.first}", self.calls()[0]["argv"])
        self.assertEqual(Path(self.calls()[0]["cwd"]).name, self.first)
        self.assertNotEqual(self.first, newer_main)
        self.assertEqual(self.state_value()["channel"], "production")
        self.assertEqual(self.state_value()["intentTag"], "deploy-production")


class ProductionAcceptanceTest(unittest.TestCase):
    revision = "a" * 40

    def tag_result(self, accepted=True):
        stdout = ""
        if accepted:
            stdout = f"{'b' * 40}\trefs/tags/app-v1\n{self.revision}\trefs/tags/app-v1^{{}}\n"
        return subprocess.CompletedProcess([], 0, stdout=stdout, stderr="")

    def response(self, *, status="completed", conclusion="success", branch="main"):
        return io.BytesIO(
            json.dumps(
                {
                    "workflow_runs": [
                        {
                            "head_sha": self.revision,
                            "head_branch": branch,
                            "event": "push",
                            "status": status,
                            "conclusion": conclusion,
                        }
                    ]
                }
            ).encode()
        )

    def test_requires_an_app_acceptance_tag_before_reading_ci(self):
        with mock.patch.object(AGENT, "run", return_value=self.tag_result(accepted=False)):
            with mock.patch.object(AGENT.urllib.request, "urlopen") as urlopen:
                with self.assertRaisesRegex(AGENT.AgentError, "no app-v"):
                    AGENT.require_production_acceptance({"repository": "unused"}, self.revision)
        urlopen.assert_not_called()

    def test_requires_successful_main_ci_for_the_exact_accepted_revision(self):
        with mock.patch.object(AGENT, "run", return_value=self.tag_result()):
            with mock.patch.object(
                AGENT.urllib.request,
                "urlopen",
                return_value=self.response(conclusion="failure"),
            ):
                with self.assertRaisesRegex(AGENT.AgentError, "did not succeed"):
                    AGENT.require_production_acceptance({"repository": "unused"}, self.revision)

    def test_accepts_only_the_app_tag_with_completed_successful_main_ci(self):
        with mock.patch.object(AGENT, "run", return_value=self.tag_result()):
            with mock.patch.object(AGENT.urllib.request, "urlopen", return_value=self.response()):
                AGENT.require_production_acceptance({"repository": "unused"}, self.revision)


if __name__ == "__main__":
    unittest.main()
