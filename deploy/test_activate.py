"""What activate.sh and restore.sh do to a channel's data and services.

The scripts run as they ship, as root, in a throwaway Debian container, since
they own host paths (/var/lib/agentify, /var/backups/agentify, /run/lock).
Around them, `docker`, the checkout's `stack.sh`, `curl`, `git` and `df` are
fakes that act on a small world of files in the test's directory: the two
databases, one line per migration applied; the containers of the channel,
with the release each runs and whether it runs; and the catalog. Each test
asserts on that world after the run, as a person would inspect the host.
The fake docker knows a container only by the ID `stack.sh ps` lists, never
by its name: Compose finds its containers by label, and a recreate cut short
leaves one running under a temporary name.

It needs Docker, which pulls python:3.12-slim-bookworm the first time, and it
fails with that sentence when there is none.
"""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest


HERE = Path(__file__).parent
IMAGE = "python:3.12-slim-bookworm"
NEW, OLD = "a" * 40, "b" * 40
APPLICATIONS = ("cabinet", "gateway", "scanner", "scanner-worker")
ORIGINAL = {"agentify_commerce": "agentify_commerce: the old release's data", "agentify_scanner": "agentify_scanner: the old release's data"}

STACK = r"""#!/usr/bin/env bash
# Fake stack.sh: the channel's Compose command line, acting on /h/world.
shift
W=/h/world args="$*"
echo "stack $args" >> $W/calls
hook() {
  if [[ -n ${TERM_AT:-} && $args == "$TERM_AT" ]]; then kill -TERM $PPID; fi
  if [[ -n ${KILL_AT:-} && $args == "$KILL_AT" ]]; then kill -KILL $PPID; exit 0; fi
  if [[ -n ${FAIL_AT:-} && $args == "$FAIL_AT" ]]; then echo "stack: $args failed" >&2; exit 1; fi
}
[[ $args == "run --rm --no-deps -T migrate" ]] || hook
case "$args" in
  "config --no-interpolate") echo "name: agentify-test" ;;
  "--profile jobs config --format json") echo '{"services": {"scanner": {"environment": {"A": "1"}}}}' ;;
  "config --images postgres") echo "postgres@sha256:pinned" ;;
  "stop --timeout 60 gateway cabinet scanner scanner-worker")
    for c in gateway cabinet scanner scanner-worker; do [[ ! -f $W/containers/$c ]] || sed -i 's/running/exited/' $W/containers/$c; done ;;
  "exec -T postgres pg_dump -U agentify_commerce -Fc "*) cat "$W/db/${args##* }" ;;
  "exec -T postgres psql"*"DROP DATABASE IF EXISTS "*) db="${args#*EXISTS }"; rm -f "$W/db/${db%% *}" ;;
  "exec -T postgres pg_restore"*)
    content="$(cat)"; printf '%s\n' "$content" > "$W/db/${content%%:*}"
    if [[ -n ${RESTORE_FAILS:-} ]]; then echo "pg_restore: error" >&2; exit 1; fi ;;
  "run --rm --no-deps -T scanner-migrate") echo "a scanner migration" >> $W/db/agentify_scanner ;;
  "run --rm --no-deps -T migrate")
    echo "the gateway's migration" >> $W/db/agentify_commerce
    hook
    echo "the cabinet's migration" >> $W/db/agentify_commerce ;;
  "up -d --wait --no-deps scanner scanner-worker"|"up -d --wait --no-deps gateway cabinet web")
    for c in ${args#up -d --wait --no-deps }; do echo "new running" > $W/containers/$c; done
    if [[ -n ${CARDS_AFTER+set} && $args == *gateway* ]]; then printf '%s' "$CARDS_AFTER" > $W/cards; fi ;;
  "ps -aq "*) for c in ${args#ps -aq }; do [[ ! -f $W/containers/$c ]] || echo $c; done ;;
  "exec -T postgres psql -U agentify_commerce -d postgres -Atc "*) echo 1000 ;;
  "port web 443") echo "127.0.0.1:8443" ;;
esac
"""

DOCKER = r"""#!/usr/bin/env bash
# Fake docker, acting on /h/world.
W=/h/world args="$*"
echo "docker $args" >> $W/calls
case "$args" in
  "ps -q --filter"*) ;;
  "ps -aq --filter"*) ls $W/containers ;;
  "inspect -f {{.Image}} "*)
    for c in ${args#inspect -f \{\{.Image\}\} }; do
      [[ -f $W/containers/$c ]] || { echo "Error: No such object: $c" >&2; exit 1; }
      if [[ $c == postgres ]]; then echo "${POSTGRES_IMAGE:-sha256:pinned}"; else echo "sha256:$(cut -d' ' -f1 $W/containers/$c)-$c"; fi
    done ;;
  "image inspect -f {{index .Config.Labels \"org.opencontainers.image.revision\"}} sha256:old"*) echo "$OLD" ;;
  "image inspect -f {{index .Config.Labels \"org.opencontainers.image.revision\"}} "*) echo "$NEW" ;;
  "image inspect -f {{.Id}} postgres@sha256:pinned") echo "sha256:pinned" ;;
  "image inspect -f {{.Id}} ghcr.io/nuanu-ai/agentify-app@"*) echo "sha256:new-app" ;;
  "image inspect -f {{.Id}} "*) echo "sha256:new-${args##*/}" ;;
  "run --rm -i --network none "*) cat > /dev/null; exit "${PREFLIGHT_EXIT:-0}" ;;
  "run -d --name agentify-scanner-check --network none --env-file "*) file="${args#*--env-file }"; cat "${file%% *}" > /dev/null ;;
  "inspect -f {{.State.Running}} agentify-scanner-check") echo true ;;
  "exec agentify-scanner-check "*) echo "${SCANNER_HEALTH:-200}" ;;
  "start "*) for c in ${args#start }; do sed -i 's/exited/running/' $W/containers/$c; done ;;
esac
exit 0
"""

CURL = r"""#!/usr/bin/env python3
# Fake curl: the channel's public door, answering from /h/world.
import base64, json, sys
args = sys.argv[1:]
url = next(a for a in args if a.startswith("https://"))
path = url.split("test.agentify.ad", 1)[1]
cards = open("/h/world/cards").read().split()
routes = {"/": 200, "/owner": 308, "/api/health/live": 200, "/api/health": 200, "/cabinet/sign-in": 200,
          "/cabinet/healthz": 200, "/docs/": 200, "/healthz": 200, "/x402/catalog": 200, "/admin": 401}
if path.endswith("/purchase"):
    network = open("/h/world/network").read().strip()
    challenge = {"resource": {"url": url}, "accepts": [{"network": network}]}
    print("HTTP/2 402\r\npayment-required: " + base64.b64encode(json.dumps(challenge).encode()).decode() + "\r\n\r")
elif "-w" in args:
    print(routes.get(path, 404), end="")
else:
    print(json.dumps({"items": [{"id": card} for card in cards]}))
"""


def container_available():
    try:
        return subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True).returncode == 0 or (
            subprocess.run(["docker", "pull", "-q", IMAGE], capture_output=True).returncode == 0
        )
    except FileNotFoundError:
        return False


class Activation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not container_available():
            raise RuntimeError(f"these tests run activate.sh in a {IMAGE} container, and Docker is not available here")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.world = self.root / "world"
        for directory in ("tree/deploy", "bin", "world/db", "world/containers", "state/test", "backups", "etc"):
            (self.root / directory).mkdir(parents=True)
        for name in ("activate.sh", "restore.sh"):
            shutil.copy(HERE / name, self.root / "tree/deploy" / name)
        for path, body in ((self.root / "tree/deploy/stack.sh", STACK), (self.root / "bin/docker", DOCKER), (self.root / "bin/curl", CURL)):
            path.write_text(body)
            path.chmod(0o755)
        for name, body in (("git", 'case "$*" in *rev-parse*) echo "$NEW" ;; esac'), ("df", 'printf "Avail\\n%s\\n" "${DF_AVAIL:-999999999999}"')):
            (self.root / "bin" / name).write_text(f"#!/bin/sh\n{body}\n")
            (self.root / "bin" / name).chmod(0o755)
        (self.root / "etc/release.json").write_text(json.dumps({"channel": "test", "repository": "unused"}))
        for database, content in ORIGINAL.items():
            (self.world / "db" / database).write_text(content + "\n")
        for container in ("gateway", "cabinet", "scanner", "scanner-worker", "web", "postgres"):
            (self.world / "containers" / container).write_text("old running\n")
        (self.world / "cards").write_text("card_one card_two")
        (self.world / "network").write_text("eip155:84532")
        (self.root / "state/test/current").write_text(OLD + "\n")

    def tearDown(self):
        subprocess.run(["docker", "run", "--rm", "-v", f"{self.root}:/h", IMAGE, "chmod", "-R", "a+rwX", "/h"], capture_output=True)
        self.temp.cleanup()

    def run_script(self, script, **environment):
        """Runs a bash script as root in the container, with the fakes first on PATH."""
        digests = {
            f"AGENTIFY_{name.upper().replace('-', '_')}_IMAGE": f"ghcr.io/nuanu-ai/agentify-{name}@sha256:{index:064x}"
            for index, name in enumerate(("app", "web", "scanner", "scanner-worker", "scanner-privacy"))
        }
        prelude = textwrap.dedent("""\
            mkdir -p /run/lock /etc/cron.d /var/lib /var/backups /etc/agentify
            ln -s /h/state /var/lib/agentify; ln -s /h/backups /var/backups/agentify; cp /h/etc/release.json /etc/agentify/
            export PATH=/h/bin:$PATH
            activate() { /h/tree/deploy/activate.sh test "$NEW"; echo "exit $?"; }
            """)
        options = [f"--env={key}={value}" for key, value in {"NEW": NEW, "OLD": OLD, **digests, **environment}.items()]
        result = subprocess.run(
            ["docker", "run", "--rm", "--network", "none", "-v", f"{self.root}:/h", *options, IMAGE, "bash", "-c", prelude + script],
            capture_output=True, text=True, timeout=120,
        )
        return result.stdout + result.stderr

    def databases(self):
        return {path.name: path.read_text().strip() for path in sorted((self.world / "db").iterdir())}

    def containers(self):
        return {path.name: path.read_text().strip() for path in sorted((self.world / "containers").iterdir())}

    def restore_points(self):
        return sorted(path.name for path in (self.root / "backups" / "test").iterdir()) if (self.root / "backups/test").exists() else []

    def pending(self):
        path = self.root / "state/test/pending"
        return path.read_text().split() if path.exists() else None

    def applications(self):
        return {name: self.containers()[name] for name in APPLICATIONS}

    def assert_old_release_runs_on_old_data(self, said):
        self.assertEqual(self.databases(), ORIGINAL, said)
        self.assertEqual(self.applications(), dict.fromkeys(APPLICATIONS, "old running"), said)

    def test_a_release_takes_a_restore_point_then_migrates_and_starts_the_new_release(self):
        said = self.run_script("activate")
        self.assertIn("exit 0", said)
        self.assertEqual(self.containers()["gateway"], "new running")
        self.assertIn("the cabinet's migration", self.databases()["agentify_commerce"])
        [point] = self.restore_points()
        self.assertTrue(point.endswith(f"-{OLD}-before-{NEW}"), point)
        self.assertEqual((self.root / "backups/test" / point / "agentify_commerce.dump").read_text().strip(), ORIGINAL["agentify_commerce"])
        self.assertIsNone(self.pending())

    def test_a_failed_second_migration_restores_both_databases_and_starts_the_previous_release(self):
        said = self.run_script("activate", FAIL_AT="run --rm --no-deps -T migrate")
        self.assertIn("exit 1", said)
        self.assertIn("both databases were restored", said)
        self.assert_old_release_runs_on_old_data(said)
        self.assertIsNone(self.pending())

    def test_a_signal_during_a_migration_takes_the_same_way_back(self):
        said = self.run_script("activate", TERM_AT="run --rm --no-deps -T scanner-migrate")
        self.assertIn("exit 1", said)
        self.assert_old_release_runs_on_old_data(said)

    def test_a_rerun_after_a_kill_restores_from_the_point_taken_before_the_first_migration(self):
        said = self.run_script(
            'KILL_AT="up -d --wait --no-deps scanner scanner-worker" activate\n'
            'FAIL_AT="run --rm --no-deps -T migrate" activate'
        )
        [point] = self.restore_points()
        taken = sorted(path.name for path in (self.root / "backups/test" / point).iterdir())
        self.assertEqual(taken, ["agentify_commerce.dump", "agentify_scanner.dump"], said)
        self.assert_old_release_runs_on_old_data(said)

    def test_a_failure_after_the_new_release_started_restores_nothing_and_says_so(self):
        said = self.run_script("activate", FAIL_AT="up -d --wait --no-deps gateway cabinet web")
        self.assertIn("exit 1", said)
        self.assertIn("nothing was restored", said)
        self.assertIn("the cabinet's migration", self.databases()["agentify_commerce"])
        self.assertEqual(self.pending()[1], NEW)

    def test_a_restore_that_fails_leaves_the_applications_stopped_and_says_what_to_run(self):
        said = self.run_script("activate", FAIL_AT="run --rm --no-deps -T migrate", RESTORE_FAILS="1")
        self.assertIn("exit 1", said)
        self.assertIn("restore.sh", said)
        self.assertEqual(self.applications(), dict.fromkeys(APPLICATIONS, "old exited"))
        self.assertEqual(self.pending()[1], NEW)

    def test_a_restore_by_hand_after_a_failed_one_ends_the_unfinished_release_however_its_path_is_spelled(self):
        said = self.run_script("activate", FAIL_AT="run --rm --no-deps -T migrate", RESTORE_FAILS="1")
        self.assertEqual(self.pending()[1], NEW, said)
        [point] = self.restore_points()
        # /var/backups/agentify is a symlink on this host, and the person types
        # the directory it points to, with a trailing slash.
        said = self.run_script(f'/h/tree/deploy/restore.sh /h/backups/test/{point}/; echo "restore exit $?"')
        self.assertIn("restore exit 0", said)
        self.assertIsNone(self.pending(), said)
        self.assertEqual(self.databases(), ORIGINAL)

    def test_a_channel_that_already_runs_the_revision_is_checked_without_stopping_anything(self):
        (self.root / "state/test/current").write_text(NEW + "\n")
        for container in ("gateway", "cabinet", "scanner", "scanner-worker", "web"):
            (self.world / "containers" / container).write_text("new running\n")
        said = self.run_script("activate")
        self.assertIn("exit 0", said)
        self.assertNotIn("stack stop", (self.world / "calls").read_text())
        self.assertEqual((self.restore_points(), self.databases()), ([], ORIGINAL))

    def test_another_unfinished_release_is_refused_before_anything_stops(self):
        (self.root / "backups/test/somewhen").mkdir(parents=True)
        (self.root / "state/test/pending").write_text(f"{OLD} {'c' * 40} /var/backups/agentify/test/somewhen\n")
        said = self.run_script("activate")
        self.assertIn("exit 1", said)
        self.assertIn("c" * 40, said)
        self.assert_old_release_runs_on_old_data(said)

    def test_a_release_waits_while_a_restore_or_the_privacy_job_holds_the_release_lock(self):
        said = self.run_script("flock /run/lock/agentify-release.lock sleep 5 &\nsleep 1\nactivate")
        self.assertIn("exit 75", said)
        self.assert_old_release_runs_on_old_data(said)

    def test_a_restore_by_hand_waits_for_a_release_holding_the_lock(self):
        (self.root / "backups/test/point").mkdir(parents=True)
        for database, content in ORIGINAL.items():
            (self.root / "backups/test/point" / f"{database}.dump").write_text(content + "\n")
        (self.world / "db/agentify_commerce").write_text("agentify_commerce: written after the dump\n")
        said = self.run_script(
            "flock /run/lock/agentify-release.lock sleep 5 &\nsleep 1\n"
            "/h/tree/deploy/restore.sh /var/backups/agentify/test/point; echo \"restore exit $?\"\n"
            "wait\n/h/tree/deploy/restore.sh /var/backups/agentify/test/point; echo \"restore exit $?\""
        )
        self.assertIn("restore exit 75", said)
        self.assertIn("restore exit 0", said)
        self.assertEqual(self.databases(), ORIGINAL)
        self.assertEqual(self.applications(), dict.fromkeys(APPLICATIONS, "old exited"))

    def test_images_that_do_not_arrive_are_a_wait_that_stops_nothing(self):
        said = self.run_script("activate", FAIL_AT="--profile jobs pull --policy missing --quiet")
        self.assertIn("exit 75", said)
        self.assert_old_release_runs_on_old_data(said)

    def test_a_scanner_that_refuses_its_own_configuration_stops_nothing(self):
        said = self.run_script("activate", SCANNER_HEALTH="503")
        self.assertIn("exit 1", said)
        self.assertIn("scanner", said)
        self.assert_old_release_runs_on_old_data(said)

    def test_a_database_running_another_image_than_the_pinned_one_stops_nothing(self):
        said = self.run_script("activate", POSTGRES_IMAGE="sha256:postgres-16")
        self.assertIn("exit 1", said)
        self.assertIn("postgres", said)
        self.assert_old_release_runs_on_old_data(said)

    def test_a_restore_point_that_would_not_fit_stops_nothing(self):
        # The databases measure 1000 bytes, and a restore point needs them
        # and a GiB more.
        said = self.run_script("activate", DF_AVAIL=str((1 << 30) + 500))
        self.assertIn("exit 1", said)
        self.assertIn("MiB free", said)
        self.assertEqual(self.restore_points(), [])
        self.assert_old_release_runs_on_old_data(said)

    def test_a_card_on_sale_before_the_release_must_still_be_on_sale_after_it(self):
        said = self.run_script("activate", CARDS_AFTER="card_one")
        self.assertIn("exit 1", said)
        self.assertIn("card_two", said)

    def test_every_card_must_answer_its_challenge_on_the_channels_network(self):
        (self.world / "network").write_text("eip155:8453")
        said = self.run_script("activate")
        self.assertIn("exit 1", said)
        self.assertIn("card_one", said)


class TheEnvironmentFile(unittest.TestCase):
    """stack.sh refuses a $ that Compose would read as a variable, naming only the key."""

    @classmethod
    def setUpClass(cls):
        if not container_available():
            raise RuntimeError(f"these tests run stack.sh in a {IMAGE} container, and Docker is not available here")

    def check(self, content):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "deploy").mkdir()
            shutil.copy(HERE / "stack.sh", root / "deploy/stack.sh")
            (root / "deploy/images.env").write_text("")
            (root / "test.env").write_text(content)
            (root / "docker").write_text("#!/bin/sh\necho compose would run\n")
            (root / "docker").chmod(0o755)
            result = subprocess.run(
                ["docker", "run", "--rm", "--network", "none", "-v", f"{root}:/h", IMAGE, "bash", "-c",
                 "mkdir -p /etc/agentify && cp /h/test.env /etc/agentify/ && PATH=/h:$PATH /h/deploy/stack.sh test ps; echo \"exit $?\""],
                capture_output=True, text=True, timeout=60,
            )
        return result.stdout + result.stderr

    def test_refuses_an_unquoted_or_double_quoted_dollar_and_names_only_the_key(self):
        said = self.check("A=plain\nADMIN_BASIC_AUTH_HASH=$2a$14$saltandhash\nB=\"x$y\"\n")
        self.assertIn("exit 78", said)
        self.assertIn("ADMIN_BASIC_AUTH_HASH", said)
        self.assertIn("B ", said)
        self.assertNotIn("saltandhash", said)

    def test_takes_a_dollar_inside_single_quotes_and_a_comment(self):
        said = self.check("ADMIN_BASIC_AUTH_HASH='$2a$14$saltandhash'\n# NOTE=$x\n")
        self.assertIn("compose would run", said)
        self.assertIn("exit 0", said)


if __name__ == "__main__":
    unittest.main()
