"""agentify-release's promises, against a local repository and a fake GitHub.

Git is real: a bare remote with branches and tags, which the command reads
with ls-remote and fetches from, exactly as it does the public repository.
GitHub's API is a fake that answers the way the API does, filtering runs by
the query it is given and paging annotations by per_page, with no network.
Activation is a deploy/activate.sh committed in that repository, which
records how it was called and exits with the code a test asks for.
"""

import contextlib
import fcntl
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest import mock
import urllib.parse


SCRIPT = Path(__file__).with_name("agentify-release")
LOADER = importlib.machinery.SourceFileLoader("agentify_release", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
RELEASE = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(RELEASE)

API = "https://api.github.com/repos/nuanu-ai/agentify"
NAMES = ("app", "web", "scanner", "scanner-worker", "scanner-privacy")

FAKE_ACTIVATE = """#!/usr/bin/env bash
python3 -c 'import json, os, sys
images = {k: v for k, v in os.environ.items() if k.startswith("AGENTIFY_") and k.endswith("_IMAGE")}
with open(os.environ["FAKE_ACTIVATE_LOG"], "a") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "images": images}) + "\\n")' "$@"
exit "${FAKE_ACTIVATE_EXIT:-0}"
"""


def digests(seed=0, **changes):
    document = {name: f"ghcr.io/nuanu-ai/agentify-{name}@sha256:{seed * 16 + index:064x}" for index, name in enumerate(NAMES)}
    document.update(changes)
    return {name: value for name, value in document.items() if value is not None}


def environment(document):
    return {f"AGENTIFY_{name.upper().replace('-', '_')}_IMAGE": value for name, value in document.items()}


class FakeGitHub:
    """GitHub's REST API for the image builds and CI runs of a few commits."""

    def __init__(self):
        self.calls, self.noise = [], []
        self.image_runs, self.ci_runs, self.jobs, self.annotations, self.counts = [], [], {}, {}, {}

    def built(self, revision, branch="main", status="completed", conclusion="success", notices=None):
        run_id = len(self.image_runs) + 1
        self.image_runs.append(
            {"id": run_id, "head_sha": revision, "head_branch": branch, "event": "push",
             "status": status, "conclusion": conclusion}
        )
        self.jobs[run_id] = [{"name": f"build {name}", "check_run_url": f"{API}/check-runs/{run_id}{index}"} for index, name in enumerate(NAMES)]
        self.jobs[run_id].append({"name": "digests", "check_run_url": f"{API}/check-runs/{run_id}9"})
        self.annotations[int(f"{run_id}9")] = notices if notices is not None else [self.notice(json.dumps(digests(run_id)))]
        return run_id

    def ci(self, revision, status="completed", conclusion="success"):
        self.ci_runs.append({"head_sha": revision, "head_branch": "main", "event": "push", "status": status, "conclusion": conclusion})

    @staticmethod
    def notice(message, title="images"):
        return {"annotation_level": "notice", "title": title, "message": message}

    def __call__(self, url):
        self.calls.append(url)
        parts = urllib.parse.urlsplit(url)
        query = dict(urllib.parse.parse_qsl(parts.query))
        path = parts.path.removeprefix("/repos/nuanu-ai/agentify")
        if parts.netloc != "api.github.com" or path == parts.path:
            raise AssertionError(f"a request outside the repository's API: {url}")
        if match := re.fullmatch(r"/actions/workflows/(images|ci)\.yml/runs", path):
            runs = self.image_runs if match[1] == "images" else self.ci_runs
            selected = [
                run for run in runs
                if run["head_sha"] == query.get("head_sha")
                and query.get("branch", run["head_branch"]) == run["head_branch"]
                and query.get("event", run["event"]) == run["event"]
                and query.get("status", run["conclusion"]) == run["conclusion"]
            ]
            # `noise` is what a list answer holds beyond the query, which the
            # command filters again itself rather than trust.
            return {"total_count": len(selected), "workflow_runs": selected + self.noise}
        if match := re.fullmatch(r"/actions/runs/(\d+)/jobs", path):
            return {"jobs": self.jobs.get(int(match[1]), [])}
        if match := re.fullmatch(r"/check-runs/(\d+)", path):
            check_run = int(match[1])
            return {"output": {"annotations_count": self.counts.get(check_run, len(self.annotations.get(check_run, [])))}}
        if match := re.fullmatch(r"/check-runs/(\d+)/annotations", path):
            per_page, page = int(query.get("per_page", 30)), int(query.get("page", 1))
            return self.annotations.get(int(match[1]), [])[(page - 1) * per_page : page * per_page]
        raise AssertionError(f"an unexpected request: {url}")


class ReleaseTest(unittest.TestCase):
    channel = "test"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.remote, self.source = root / "remote.git", root / "source"
        # The state lives in /var/lib/agentify/<channel>, where activate.sh and
        # restore.sh read it too; these tests move that root into the temp dir.
        self.states = root / "var-lib-agentify"
        self.state = self.states / self.channel
        self.log, self.config = root / "activations.jsonl", root / "release.json"
        self.config.write_text(json.dumps({"channel": self.channel, "repository": str(self.remote)}))
        self.git("init", "-q", "--bare", str(self.remote), cwd=root)
        self.git("init", "-q", "-b", "main", str(self.source), cwd=root)
        self.git("config", "user.name", "Release Test")
        self.git("config", "user.email", "release@example.invalid")
        self.git("remote", "add", "origin", str(self.remote))
        activate = self.source / "deploy" / "activate.sh"
        activate.parent.mkdir(parents=True)
        activate.write_text(FAKE_ACTIVATE)
        activate.chmod(0o755)
        self.github = FakeGitHub()
        self.first = self.commit("first")
        self.push("main")
        self.first_run = self.github.built(self.first)

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd or self.source, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, message):
        (self.source / "marker.txt").write_text(message + "\n")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def push(self, *refs):
        self.git("push", "-q", "--force", "origin", *refs)

    def tag(self, name, revision):
        self.git("tag", "-f", name, revision)
        self.push(f"refs/tags/{name}")

    def release(self, name, *flags, exit_code=0):
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            # INVOCATION_ID is how a process knows systemd started it: these
            # runs are the release inside its unit, not a person's launcher.
            environment = {"FAKE_ACTIVATE_LOG": str(self.log), "FAKE_ACTIVATE_EXIT": str(exit_code), "INVOCATION_ID": "test"}
            stack.enter_context(mock.patch.dict(os.environ, environment))
            stack.enter_context(contextlib.redirect_stdout(output))
            stack.enter_context(mock.patch.object(RELEASE, "fetch_json", self.github))
            stack.enter_context(mock.patch.object(RELEASE, "STATES", self.states))
            code = RELEASE.main(["--config", str(self.config), *flags, name])
        self.said = output.getvalue()
        return code

    def activations(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def recorded(self, name):
        path = self.state / name
        return path.read_text().strip() if path.exists() else None

    def refused(self, name, word, *flags):
        before = len(self.activations())
        self.assertEqual(self.release(name, *flags), 1, self.said)
        self.assertEqual(len(self.activations()), before)
        self.assertIn(word, self.said)

    def waited(self, name, word, *flags):
        self.assertEqual(self.release(name, *flags), 75, self.said)
        self.assertEqual(self.activations(), [])
        self.assertIsNone(self.recorded("failed"))
        self.assertIn(word, self.said)


class TheDigestRule(ReleaseTest):
    """How the five images of a commit are found, on either channel."""

    def test_activates_a_branch_head_from_its_own_checkout_with_the_digests_its_build_published(self):
        self.assertEqual(self.release("main"), 0, self.said)
        [activation] = self.activations()
        self.assertEqual(activation["argv"], ["test", self.first])
        self.assertEqual(Path(activation["cwd"]).resolve(), (self.state / "checkouts" / self.first).resolve())
        self.assertEqual(activation["images"], environment(digests(self.first_run)))
        self.assertEqual(self.recorded("current"), self.first)

    def test_takes_an_annotated_tag_at_the_commit_it_points_to(self):
        self.git("tag", "-a", "-m", "annotated", "an-annotated-tag", self.first)
        self.push("refs/tags/an-annotated-tag")
        self.assertEqual(self.release("an-annotated-tag"), 0, self.said)
        self.assertEqual(self.activations()[-1]["argv"], ["test", self.first])

    def test_takes_a_tag_or_a_full_sha_on_test(self):
        self.tag("some-tag", self.first)
        self.assertEqual(self.release("some-tag"), 0, self.said)
        self.assertEqual(self.release(self.first), 0, self.said)
        self.assertEqual([a["argv"][1] for a in self.activations()], [self.first, self.first])

    def test_reads_every_page_and_finds_the_notice_past_the_first(self):
        check_run = int(f"{self.first_run}9")
        warnings = [self.github.notice(f"warning {n}", title="build") for n in range(130)]
        self.github.annotations[check_run] = warnings + self.github.annotations[check_run]

        self.assertEqual(self.release("main"), 0, self.said)
        self.assertEqual(len([url for url in self.github.calls if "/annotations" in url]), 2)

    def test_refuses_annotations_that_do_not_add_up_to_their_count(self):
        self.github.counts[int(f"{self.first_run}9")] = 2
        self.refused("main", "count")
        self.assertEqual(self.recorded("failed"), self.first)

    def test_refuses_a_build_with_no_images_notice_or_two(self):
        check_run = int(f"{self.first_run}9")
        self.github.annotations[check_run] = [self.github.notice("something else", title="build")]
        self.refused("main", "images notices")
        forged = self.github.notice(json.dumps(digests(7)))
        self.github.annotations[check_run] = [self.github.notice(json.dumps(digests(self.first_run))), forged]
        self.refused("main", "images notices")

    def test_refuses_a_notice_that_is_not_the_five_digests(self):
        check_run = int(f"{self.first_run}9")
        for document in (digests(web=None), digests(app=f"ghcr.io/nuanu-ai/agentify-app:{self.first}"), digests(extra="x")):
            self.github.annotations[check_run] = [self.github.notice(json.dumps(document))]
            self.refused("main", "five image digests")

    def test_reads_only_runs_of_this_commit_whatever_else_github_returns(self):
        second = self.commit("second")
        self.push("main")
        self.github.built(second)
        self.github.noise = [dict(run, head_sha=second) for run in self.github.image_runs] + [
            dict(self.github.image_runs[0], event="workflow_dispatch", id=99)
        ]
        self.assertEqual(self.release(self.first), 0, self.said)
        self.assertEqual(self.activations()[-1]["images"], environment(digests(self.first_run)))

    def test_refuses_a_build_without_exactly_one_digests_job_on_this_repository(self):
        jobs = self.github.jobs[self.first_run]
        self.github.jobs[self.first_run] = jobs + [dict(jobs[-1])]
        self.refused("main", "digests job")
        self.github.jobs[self.first_run] = jobs[:-1] + [dict(jobs[-1], check_run_url="https://api.github.com/repos/someone/else/check-runs/19")]
        self.refused("main", "digests job")

    def test_stops_reading_annotations_once_they_outnumber_the_count(self):
        check_run = int(f"{self.first_run}9")
        self.github.annotations[check_run] = [self.github.notice(f"warning {n}", title="build") for n in range(250)]
        self.github.counts[check_run] = 5
        self.refused("main", "count")
        self.assertEqual(len([url for url in self.github.calls if "/annotations" in url]), 1)

    def test_refuses_two_successful_builds_of_one_commit(self):
        self.github.built(self.first, branch="another")
        self.refused("main", "choose")

    def test_refuses_a_failed_build(self):
        self.github.image_runs.clear()
        self.github.built(self.first, conclusion="failure")
        self.refused("main", "did not succeed")

    def test_a_commit_with_no_build_listed_is_a_wait_that_says_it_may_never_come(self):
        # GitHub lists a build a few seconds after the push, and never for a
        # commit that was not the head of one: from here the two look the same.
        inner = self.commit("inner")
        self.commit("head")
        self.push("main")
        self.waited(inner, "head of a pushed branch")

    def test_a_manual_run_waits_while_the_build_is_running_and_changes_nothing(self):
        second = self.commit("second")
        self.push("main")
        self.github.built(second, status="in_progress", conclusion=None)

        self.assertEqual(self.release("main"), 75, self.said)
        self.assertEqual(self.activations(), [])
        self.assertIsNone(self.recorded("failed"))
        self.assertIsNone(self.recorded("current"))


class Production(ReleaseTest):
    """What PRODUCTION adds to the one path: an app-v* tag, main, CI, forward."""

    channel = "production"

    def setUp(self):
        super().setUp()
        self.tag("app-v1", self.first)
        self.github.ci(self.first)

    def test_releases_an_app_tag_by_the_digests_mains_build_published(self):
        self.assertEqual(self.release("app-v1"), 0, self.said)
        [activation] = self.activations()
        self.assertEqual(activation["argv"], ["production", self.first])
        self.assertEqual(activation["images"], environment(digests(self.first_run)))

    def test_refuses_any_name_but_an_app_tag_before_asking_github(self):
        self.tag("deploy-production", self.first)
        for name in ("main", self.first, "deploy-production"):
            self.refused(name, "app-v")
        self.assertEqual(self.github.calls, [])

    def test_refuses_a_commit_whose_only_build_is_not_on_main(self):
        self.git("checkout", "-q", "-b", "side")
        side = self.commit("side")
        self.push("side")
        self.github.built(side, branch="side")
        self.github.ci(side)
        self.tag("app-v2", side)
        self.waited("app-v2", "head of a push to main")

    def test_ignores_a_build_of_another_branch_that_github_returns_anyway(self):
        self.git("checkout", "-q", "-b", "side")
        side = self.commit("side")
        self.push("side")
        self.github.ci(side)
        self.tag("app-v2", side)
        run = self.github.built(side, branch="side")
        self.github.noise = [self.github.image_runs[run - 1]]
        self.waited("app-v2", "head of a push to main")

    def test_waits_for_ci_and_refuses_a_failed_one(self):
        self.github.ci_runs[:] = []
        self.github.ci(self.first, status="in_progress", conclusion=None)
        self.assertEqual(self.release("app-v1"), 75, self.said)
        self.github.ci_runs[:] = []
        self.github.ci(self.first, conclusion="failure")
        self.refused("app-v1", "CI")

    def test_moves_only_forward_from_what_it_runs(self):
        second = self.commit("second")
        self.push("main")
        self.github.built(second)
        self.github.ci(second)
        self.tag("app-v2", second)
        self.assertEqual(self.release("app-v2"), 0, self.said)

        self.refused("app-v1", "forward")
        self.assertEqual(self.release("app-v2"), 0, self.said)

    def test_has_no_timer(self):
        self.refused("app-v1", "timer", "--timer")


class TheTimer(ReleaseTest):
    """What TEST's timer does once a minute with whatever deploy-test names."""

    def tick(self, exit_code=0):
        return self.release("deploy-test", "--timer", exit_code=exit_code)

    def test_does_nothing_while_deploy_test_names_nothing(self):
        self.assertEqual(self.tick(), 0)
        self.assertEqual((self.activations(), self.said), ([], ""))

    def test_activates_a_new_revision_once_and_then_stays_silent(self):
        self.tag("deploy-test", self.first)
        self.assertEqual(self.tick(), 0, self.said)
        self.assertEqual(len(self.activations()), 1)

        self.assertEqual(self.tick(), 0)
        self.assertEqual((len(self.activations()), self.said), (1, ""))

    def test_waits_for_a_build_that_is_running_and_activates_once_it_succeeds(self):
        second = self.commit("second")
        self.push("main")
        run = self.github.built(second, status="in_progress", conclusion=None)
        self.tag("deploy-test", second)

        self.assertEqual(self.tick(), 75, self.said)
        self.assertEqual(self.activations(), [])
        self.assertIsNone(self.recorded("failed"))

        self.github.image_runs[run - 1].update(status="completed", conclusion="success")
        self.assertEqual(self.tick(), 0, self.said)
        self.assertEqual([a["argv"][1] for a in self.activations()], [second])

    def test_records_a_failure_and_does_not_try_again_every_minute(self):
        self.tag("deploy-test", self.first)
        self.assertEqual(self.tick(exit_code=3), 3)
        self.assertEqual(self.recorded("failed"), self.first)

        self.assertEqual(self.tick(), 0)
        self.assertEqual((len(self.activations()), self.said), (1, ""))

    def test_records_a_refusal_and_does_not_ask_again_every_minute(self):
        second = self.commit("second")
        self.push("main")
        self.github.built(second, conclusion="failure")
        self.tag("deploy-test", second)
        self.assertEqual(self.tick(), 1, self.said)
        calls = len(self.github.calls)

        self.assertEqual(self.tick(), 0)
        self.assertEqual((len(self.github.calls), self.said), (calls, ""))

    def test_waits_thirty_minutes_for_a_build_to_be_listed_and_then_records_a_failure(self):
        inner = self.commit("inner")
        self.commit("head")
        self.push("main")
        self.tag("deploy-test", inner)
        start = RELEASE.time.time()
        for minutes, expected in ((0, 75), (29, 75), (30, 1)):
            with mock.patch.object(RELEASE.time, "time", return_value=start + minutes * 60):
                self.assertEqual(self.tick(), expected, self.said)
        self.assertEqual(self.recorded("failed"), inner)
        self.assertIn("30 minutes", self.said)
        self.assertEqual(self.tick(), 0)

    def test_a_new_revision_gets_its_own_thirty_minutes(self):
        inner = self.commit("inner")
        other = self.commit("other")
        self.commit("head")
        self.push("main")
        start = RELEASE.time.time()
        self.tag("deploy-test", inner)
        with mock.patch.object(RELEASE.time, "time", return_value=start):
            self.assertEqual(self.tick(), 75, self.said)
        self.tag("deploy-test", other)
        with mock.patch.object(RELEASE.time, "time", return_value=start + 40 * 60):
            self.assertEqual(self.tick(), 75, self.said)
        self.assertIsNone(self.recorded("failed"))

    def test_images_that_did_not_arrive_are_a_wait_and_not_a_failure(self):
        self.tag("deploy-test", self.first)
        self.assertEqual(self.tick(exit_code=75), 75, self.said)
        self.assertIsNone(self.recorded("failed"))
        self.assertEqual(self.tick(), 0, self.said)
        self.assertEqual(len(self.activations()), 2)
        self.assertEqual(self.recorded("current"), self.first)

    def test_tries_again_at_the_next_tick_when_another_release_holds_the_lock(self):
        self.tag("deploy-test", self.first)
        self.state.mkdir(parents=True)
        with (self.state / "release.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.tick(), 75)
            self.assertEqual(self.release("deploy-test"), 75)
        self.assertEqual(self.activations(), [])


class AManualRun(ReleaseTest):
    """A person's run never skips anything: it is the retry."""

    def test_activates_again_what_is_current_and_what_failed(self):
        self.assertEqual(self.release("main", exit_code=3), 3)
        self.assertEqual(self.recorded("failed"), self.first)

        self.assertEqual(self.release("main"), 0, self.said)
        self.assertEqual((self.recorded("current"), self.recorded("failed")), (self.first, None))
        self.assertEqual(self.release("main"), 0, self.said)
        self.assertEqual(len(self.activations()), 3)

    def test_a_newer_revision_drops_the_old_checkout(self):
        self.assertEqual(self.release("main"), 0, self.said)
        second = self.commit("second")
        self.push("main")
        self.github.built(second)

        self.assertEqual(self.release("main"), 0, self.said)
        self.assertEqual(sorted(p.name for p in (self.state / "checkouts").iterdir()), [second])

    def test_refuses_a_retained_checkout_somebody_changed(self):
        self.assertEqual(self.release("main", exit_code=3), 3)
        (self.state / "checkouts" / self.first / "stray.txt").write_text("edited on the host\n")
        self.refused("main", "not a clean checkout")

    def test_refuses_a_revision_without_activate_sh(self):
        self.git("rm", "-q", "deploy/activate.sh")
        older = self.commit("before activate.sh")
        self.push("main")
        self.github.built(older)
        self.refused("main", "predates")
        self.assertEqual(self.recorded("failed"), older)

    def test_leaves_its_state_readable_by_anyone_on_the_host(self):
        previous = os.umask(0o077)
        try:
            self.assertEqual(self.release("main"), 0, self.said)
        finally:
            os.umask(previous)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.state / "current").stat().st_mode & 0o777, 0o644)

    def test_refuses_a_name_the_repository_does_not_have(self):
        self.refused("no-such-branch", "names nothing")
        self.refused("../etc/passwd", "not a tag")

    def test_refuses_a_configuration_with_a_field_it_does_not_know(self):
        config = json.loads(self.config.read_text())
        config["intentTag"] = "deploy-test"
        self.config.write_text(json.dumps(config))
        self.assertEqual(self.release("main"), 1)
        self.assertEqual(self.activations(), [])


class APersonsRun(unittest.TestCase):
    """Outside a systemd unit the command hands the release to one and follows it."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.bin, self.calls = root / "bin", root / "calls"
        self.bin.mkdir()
        self.config = root / "release.json"
        self.config.write_text(json.dumps({"channel": "test", "repository": "unused"}))
        for name, body in {
            "systemctl": 'exit "${FAKE_ACTIVE:-3}"',
            "systemd-run": 'printf "%s\\n" "$@" > "$FAKE_CALLS"; exit "${FAKE_UNIT_EXIT:-0}"',
            "journalctl": "exit 0",
        }.items():
            (self.bin / name).write_text(f"#!/bin/sh\n{body}\n")
            (self.bin / name).chmod(0o755)

    def tearDown(self):
        self.temp.cleanup()

    def run_by_hand(self, **environment):
        path = f"{self.bin}{os.pathsep}{os.environ['PATH']}"
        with mock.patch.dict(os.environ, {"PATH": path, "FAKE_CALLS": str(self.calls), **environment}):
            os.environ.pop("INVOCATION_ID", None)
            with contextlib.redirect_stdout(io.StringIO()) as output:
                code = RELEASE.main(["--config", str(self.config), "my-branch"])
        return code, output.getvalue()

    def test_the_release_runs_in_its_own_unit_with_the_same_arguments_and_its_exit_status(self):
        code, said = self.run_by_hand(FAKE_UNIT_EXIT="3")
        self.assertEqual(code, 3)
        asked = self.calls.read_text().splitlines()
        self.assertIn("--unit=agentify-release-test.service", asked)
        self.assertEqual(asked[-3:], ["--config", str(self.config), "my-branch"])
        self.assertIn("journalctl -u agentify-release-test.service", said)

    def test_a_release_already_running_is_a_wait_that_starts_nothing(self):
        code, said = self.run_by_hand(FAKE_ACTIVE="0")
        self.assertEqual(code, 75)
        self.assertFalse(self.calls.exists())
        self.assertIn("already running", said)


class GitHubUnreachable(unittest.TestCase):
    def test_an_answer_github_does_not_finish_is_a_wait(self):
        import http.client

        for error in (OSError("unreachable"), http.client.IncompleteRead(b"{")):
            with mock.patch.object(RELEASE.urllib.request, "urlopen", side_effect=error):
                with self.assertRaises(RELEASE.Wait):
                    RELEASE.fetch_json(f"{API}/actions/workflows/images.yml/runs")


if __name__ == "__main__":
    unittest.main()
