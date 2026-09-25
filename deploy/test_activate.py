"""What activate.sh and restore.sh do to a channel's data and services.

The scripts run as they ship, as root, in a throwaway Debian container, since
they own host paths (/var/lib/agentify, /var/backups/agentify, /run/lock).
Around them, `docker`, the checkout's `stack.sh`, `curl`, `git`, `df` and
`logger` are fakes that act on a small world of files in the test's
directory: the databases, one file each with one line per migration applied;
the containers of the channel, with the release each runs and whether it runs;
and the catalog. Each test asserts on that world after the run, as a person
would inspect the host.

The fake docker knows a container only by the ID `stack.sh ps` lists, never by
its name: Compose finds its containers by label, and a recreate cut short
leaves one running under a temporary name. The fake database server creates,
drops and renames databases as files, lists and measures them, and runs a
script's renames all together when the script is one transaction, and one by
one otherwise. When the database starts, the fake records
what its init-script mount holds, and creates the directory empty when it is
missing, as Docker does with a bind mount's source. It also records the
transition record as it stands when the first dump is taken and when the new
release starts. The fake curl is a shell script, so that a catalog of
thousands of cards is checked in seconds.

It needs Docker, which pulls python:3.12-slim-bookworm the first time, and it
fails with that sentence when there is none.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest


HERE = Path(__file__).parent
IMAGE = "python:3.12-slim-bookworm"
NEW, OLD, OTHER = "a" * 40, "b" * 40, "c" * 40
APPLICATIONS = ("cabinet", "gateway", "scanner", "scanner-worker")
INIT = {"01-test-databases.sql": "CREATE DATABASE agentify_test;\n"}
ORIGINAL = {"agentify": "agentify: the old release's data"}
MIGRATED = {"agentify": ORIGINAL["agentify"] + "\na scanner migration\nthe gateway's migration\nthe cabinet's migration"}
ORDER = "an order written while the new release ran"
FAILED_MIGRATION = "run --rm --no-deps -T migrate"
FAILED_START = "up -d --wait --no-deps gateway cabinet web"

STACK = r"""#!/usr/bin/env bash
# Fake stack.sh: the channel's Compose command line, acting on /h/world.
shift
W=/h/world args="$*"
echo "stack $args" >> $W/calls
record=/var/lib/agentify/test/transition
hook() {
  if [[ -n ${TERM_AT:-} && $args == "$TERM_AT" ]]; then kill -TERM $PPID; fi
  if [[ -n ${TERM_ALL_AT:-} && $args == "$TERM_ALL_AT" ]]; then
    for p in /proc/[0-9]*; do
      case "$(tr '\0' ' ' < $p/cmdline 2>/dev/null)" in
        *"bash /h/tree/deploy/activate.sh "*|*"bash /h/tree/deploy/restore.sh "*) kill -TERM ${p#/proc/} 2>/dev/null ;;
      esac
    done
  fi
  if [[ -n ${KILL_AT:-} && $args == "$KILL_AT" ]]; then kill -KILL $PPID; exit 0; fi
  if [[ -n ${FAIL_AT:-} && $args == "$FAIL_AT" ]]; then echo "stack: $args failed" >&2; exit 1; fi
}
[[ $args == "run --rm --no-deps -T migrate" ]] || hook
statement() {
  case $1 in
    "DROP DATABASE "*) db="${1#DROP DATABASE }"; db="${db#IF EXISTS }"; db="${db//\"/}"; rm -f "$W/db/${db%% *}" ;;
    "CREATE DATABASE "*) : > "$W/db/${1#CREATE DATABASE }" ;;
    "ALTER DATABASE "*) names="${1#ALTER DATABASE }"; mv "$W/db/${names%% *}" "$W/db/${names##* }" ;;
    *"datname like"*) ls "$W/db" | grep _replaced_ || true ;;
    *"not datistemplate"*) ls "$W/db" ;;
    select*) echo "${DB_SIZE:-1000}" ;;
  esac
}
case "$args" in
  "config --no-interpolate") echo "name: agentify" ;;
  "--profile jobs config --format json") echo '{"services": {"scanner": {"environment": {"A": "1"}}}, "volumes": {"agentify-postgres": {"name": "agentify-postgres"}}}' ;;
  "config --images postgres") echo "postgres@sha256:pinned" ;;
  "stop --timeout 60 gateway cabinet scanner scanner-worker")
    for c in gateway cabinet scanner scanner-worker; do [[ ! -f $W/containers/$c ]] || sed -i 's/running/exited/' $W/containers/$c; done ;;
  "exec -T postgres pg_dump -U agentify -Fc "*)
    [[ -f $W/record-at-dump ]] || cat $record > $W/record-at-dump 2>/dev/null
    cat "$W/db/${args##* }" ;;
  "exec -T postgres psql"*)
    if [[ $args == *" -c "* || $args == *" -Atc "* ]]; then
      while (($#)); do [[ $1 != -c && $1 != -Atc ]] || statement "$2"; shift; done
    else
      script="$(cat)"
      mapfile -t renames < <(grep -o 'ALTER DATABASE [a-z0-9_]* RENAME TO [a-z0-9_]*' <<<"$script")
      if [[ -n ${SWAP_FAILS:-} ]]; then
        # The second rename fails: inside a transaction nothing is applied,
        # outside one the rename before it stays.
        [[ $script == *BEGIN* ]] || statement "${renames[0]}"
        echo "ERROR: the second rename failed" >&2; exit 1
      fi
      for rename in "${renames[@]}"; do statement "$rename"; done
    fi ;;
  "exec -T postgres df -Pk /var/lib/postgresql/data")
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/data 1 1 %s 1%% /var/lib/postgresql/data\n' "${DB_FREE_KB:-999999999}" ;;
  "exec -T postgres pg_restore"*)
    target="${args#* -d }"; target="${target%% *}"
    if [[ -n ${RESTORE_FAILS:-} ]]; then
      head -c 12 > "$W/db/$target"; echo "pg_restore: error: could not read from input file: end of file" >&2; exit 1
    fi
    cat > "$W/db/$target" ;;
  "run --rm --no-deps -T scanner-migrate") echo "a scanner migration" >> $W/db/agentify ;;
  "run --rm --no-deps -T migrate")
    echo "the gateway's migration" >> $W/db/agentify
    hook
    echo "the cabinet's migration" >> $W/db/agentify ;;
  "up -d --wait --no-deps postgres")
    init=/var/lib/agentify/test/postgres-init
    mkdir -p $init; ls $init > $W/postgres-init-at-start ;;
  "up -d --wait --no-deps scanner scanner-worker"|"up -d --wait --no-deps gateway cabinet web")
    [[ -f $W/record-at-start || ! -f $record ]] || cat $record > $W/record-at-start
    for c in ${args#up -d --wait --no-deps }; do echo "new running" > $W/containers/$c; done
    if [[ -n ${CARDS_AFTER+set} && $args == *gateway* ]]; then printf '%s' "$CARDS_AFTER" > $W/cards; fi ;;
  "ps -aq "*) for c in ${args#ps -aq }; do [[ ! -f $W/containers/$c ]] || echo $c; done ;;
  "ps --status running --format {{.Service}} "*)
    for c in ${args##*\}\} }; do ! grep -qs running $W/containers/$c || echo $c; done ;;
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
  "image inspect -f {{index .Config.Labels \"org.opencontainers.image.revision\"}} "*) echo "${REV:-$NEW}" ;;
  "image inspect -f {{.Id}} postgres@sha256:pinned") echo "sha256:pinned" ;;
  "image inspect -f {{.Id}} ghcr.io/nuanu-ai/agentify-app@"*) echo "sha256:new-app" ;;
  "image inspect -f {{.Id}} "*) echo "sha256:new-${args##*/}" ;;
  "run --rm -i --network none "*) cat > /dev/null; exit "${PREFLIGHT_EXIT:-0}" ;;
  "run -d --name agentify-scanner-check --network none --env-file "*) file="${args#*--env-file }"; cat "${file%% *}" > /dev/null ;;
  "inspect -f {{.State.Running}} agentify-scanner-check") echo true ;;
  "exec agentify-scanner-check "*) echo "${SCANNER_HEALTH:-200}" ;;
  "start "*) for c in ${args#start }; do sed -i 's/exited/running/' $W/containers/$c; done ;;
  "volume inspect agentify-postgres") [[ -z ${NO_VOLUME:-} ]] || { echo "Error response from daemon: get agentify-postgres: no such volume" >&2; exit 1; } ;;
esac
exit 0
"""

CURL = r"""#!/usr/bin/env bash
# Fake curl: the channel's public door, answering from /h/world.
url="" code=""
for argument in "$@"; do case $argument in https://*) url=$argument ;; -w) code=yes ;; esac; done
path="${url#https://test.agentify.ad}"
case $path in
  */purchase)
    challenge="{\"resource\": {\"url\": \"$url\"}, \"accepts\": [{\"network\": \"$(< /h/world/network)\"}]}"
    printf 'HTTP/2 402\r\npayment-required: %s\r\n\r\n' "$(printf '%s' "$challenge" | base64 -w0)" ;;
  *)
    if [[ -n $code ]]; then
      case $path in /owner) printf 308 ;; /admin) printf 404 ;; *) printf 200 ;; esac
    else
      printf '{"items": [%s]}' "$(tr ' ' '\n' < /h/world/cards | sed '/^$/d; s/.*/{"id": "&"}/' | paste -sd, -)"
    fi ;;
esac
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
        for directory in ("tree/deploy/postgres-init", "bin", "world/db", "world/containers", "state/test", "backups", "etc"):
            (self.root / directory).mkdir(parents=True)
        for name, body in INIT.items():
            (self.root / "tree/deploy/postgres-init" / name).write_text(body)
        for name in ("activate.sh", "restore.sh", "transition"):
            shutil.copy(HERE / name, self.root / "tree/deploy" / name)
        for path, body in ((self.root / "tree/deploy/stack.sh", STACK), (self.root / "bin/docker", DOCKER), (self.root / "bin/curl", CURL)):
            path.write_text(body)
            path.chmod(0o755)
        for name, body in (
            ("git", 'case "$*" in *rev-parse*) echo "${REV:-$NEW}" ;; *merge-base*) exit "${NOT_FORWARD:-0}" ;; esac'),
            ("logger", 'echo "$*" >> /h/world/log'),
            ("df", 'printf "Avail\\n%s\\n" "${DF_AVAIL:-999999999999}"'),
        ):
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
        # Every run already gives the tree back; this is for one cut short.
        subprocess.run(["docker", "run", "--rm", "-v", f"{self.root}:/h", IMAGE, "chown", "-R", self.owner, "/h"], capture_output=True)
        self.temp.cleanup()

    @property
    def owner(self):
        return f"{os.getuid()}:{os.getgid()}"

    def run_script(self, script, **environment):
        """Runs a bash script as root in the container, with the fakes first on PATH."""
        digests = {
            f"AGENTIFY_{name.upper().replace('-', '_')}_IMAGE": f"ghcr.io/nuanu-ai/agentify-{name}@sha256:{index:064x}"
            for index, name in enumerate(("app", "web", "scanner", "scanner-worker", "scanner-privacy"))
        }
        # The scripts run as root, and on Linux what root writes into the bind
        # mount stays root's, with the scripts' own modes (0700, 0600). So each
        # run ends by giving the whole tree back to the user running the tests,
        # keeping its modes, which the tests assert, and the script's status.
        prelude = textwrap.dedent("""\
            trap 'status=$?; chown -R "$OWNER" /h; exit $status' EXIT
            mkdir -p /run/lock /etc/cron.d /var/lib /var/backups /etc/agentify
            ln -s /h/state /var/lib/agentify; ln -s /h/backups /var/backups/agentify; cp /h/etc/release.json /etc/agentify/
            export PATH=/h/bin:$PATH
            activate() { /h/tree/deploy/activate.sh test "$NEW"; echo "exit $?"; }
            release() { REV=$1 /h/tree/deploy/activate.sh test "$1"; echo "exit $?"; }
            restore() { /h/tree/deploy/restore.sh "$1"; echo "restore exit $?"; }
            privacy() { bash -c "$(sed -n 's/^23 4 \\* \\* \\* root //p' /etc/cron.d/agentify-release)"; }
            """)
        options = [f"--env={key}={value}" for key, value in {"NEW": NEW, "OLD": OLD, "OWNER": self.owner, **digests, **environment}.items()]
        result = subprocess.run(
            ["docker", "run", "--rm", "--network", "none", "-v", f"{self.root}:/h", *options, IMAGE, "bash", "-c", prelude + script],
            capture_output=True, text=True, timeout=240,
        )
        return result.stdout + result.stderr

    def databases(self):
        return {name: (self.world / "db" / name).read_text().strip() for name in ORIGINAL}

    def containers(self):
        return {path.name: path.read_text().strip() for path in sorted((self.world / "containers").iterdir())}

    def restore_points(self):
        return sorted(path.name for path in (self.root / "backups" / "test").iterdir()) if (self.root / "backups/test").exists() else []

    def record(self):
        path = self.root / "state/test/transition"
        return json.loads(path.read_text()) if path.exists() else None

    def current(self):
        path = self.root / "state/test/current"
        return path.read_text().strip() if path.exists() else None

    def applications(self):
        return {name: self.containers()[name] for name in APPLICATIONS}

    def calls(self):
        return (self.world / "calls").read_text().splitlines()

    def open_transition(self, to, phase, cards="card_one card_two"):
        """A transition record another run left, with its restore point and its cards before."""
        point = self.root / "backups/test" / f"20260101T000000Z-{OLD}-before-{to}"
        point.mkdir(parents=True)
        for database, content in ORIGINAL.items():
            (point / f"{database}.dump").write_text(content + "\n")
        (self.root / "state/test/cards-before").write_text(cards.replace(" ", "\n") + "\n")
        record = {"from": OLD, "to": to, "restore": f"/var/backups/agentify/test/{point.name}", "phase": phase,
                  "cards": "/var/lib/agentify/test/cards-before"}
        (self.root / "state/test/transition").write_text(json.dumps(record))
        return record

    def replaced(self):
        return sorted(path.name for path in (self.world / "db").iterdir() if "_replaced_" in path.name)

    def assert_old_release_runs_on_old_data(self, said):
        self.assertEqual(self.databases(), ORIGINAL, said)
        self.assertEqual(self.applications(), dict.fromkeys(APPLICATIONS, "old running"), said)

    # A release without an open transition.

    def test_a_release_takes_a_restore_point_then_migrates_and_starts_the_new_release(self):
        said = self.run_script("activate")
        self.assertIn("exit 0", said)
        self.assertEqual(self.containers()["gateway"], "new running")
        self.assertEqual(self.databases(), MIGRATED)
        [point] = self.restore_points()
        self.assertTrue(point.endswith(f"-{OLD}-before-{NEW}"), point)
        self.assertEqual((self.root / "backups/test" / point / "agentify.dump").read_text().strip(), ORIGINAL["agentify"])
        self.assertEqual((self.record(), self.current()), (None, NEW))

    def test_the_record_is_written_before_the_dump_and_says_started_before_the_new_release_starts(self):
        said = self.run_script("activate")
        self.assertIn("exit 0", said)
        at_dump = json.loads((self.world / "record-at-dump").read_text())
        self.assertEqual((at_dump["from"], at_dump["to"], at_dump["phase"]), (OLD, NEW, "stopped"))
        self.assertEqual(json.loads((self.world / "record-at-start").read_text())["phase"], "started")

    def test_a_channel_that_already_runs_the_revision_is_checked_without_stopping_anything(self):
        (self.root / "state/test/current").write_text(NEW + "\n")
        for container in ("gateway", "cabinet", "scanner", "scanner-worker", "web"):
            (self.world / "containers" / container).write_text("new running\n")
        said = self.run_script("activate")
        self.assertIn("exit 0", said)
        self.assertNotIn("stack stop --timeout 60 gateway cabinet scanner scanner-worker", self.calls())
        self.assertEqual((self.restore_points(), self.databases(), self.record()), ([], ORIGINAL, None))

    def test_messages_and_the_record_name_the_tags_of_each_revision(self):
        (self.root / "state/test/tags").write_text(f"{OLD} app-v1.1.0\n{NEW} app-v1.2.0\n{NEW} app-v1.2.0-rc.1\n")
        said = self.run_script("activate", FAIL_AT=FAILED_MIGRATION)
        self.assertIn(f"{NEW} (app-v1.2.0, app-v1.2.0-rc.1)", said)
        self.assertEqual((self.record()["from_tags"], self.record()["to_tags"]), ("app-v1.1.0", "app-v1.2.0, app-v1.2.0-rc.1"))

    # Failures of a first run, by how far it got. Nothing restores by itself.

    def test_a_failure_before_any_migration_ends_the_transition_and_the_previous_release_runs(self):
        said = self.run_script("activate", FAIL_AT="exec -T postgres pg_dump -U agentify -Fc agentify")
        self.assertIn("exit 1", said)
        self.assert_old_release_runs_on_old_data(said)
        self.assertEqual((self.restore_points(), self.record(), self.current()), ([], None, OLD))

    def test_a_failed_second_migration_leaves_the_channel_down_with_its_record_and_both_ways_out(self):
        said = self.run_script("activate", FAIL_AT=FAILED_MIGRATION)
        self.assertIn("exit 1", said)
        [point] = self.restore_points()
        self.assertIn("down", said)
        self.assertIn(f"agentify-release --restore /var/backups/agentify/test/{point}", said)
        # Nothing was restored, and nothing started again on the half-migrated data.
        self.assertEqual(self.databases()["agentify"], ORIGINAL["agentify"] + "\na scanner migration\nthe gateway's migration")
        self.assertFalse([call for call in self.calls() if "pg_restore" in call])
        self.assertEqual(self.applications(), dict.fromkeys(APPLICATIONS, "old exited"))
        self.assertEqual((self.record()["phase"], self.current()), ("migrating", OLD))

    def test_a_signal_during_a_migration_leaves_the_channel_down_the_same_way(self):
        said = self.run_script("activate", TERM_AT="run --rm --no-deps -T scanner-migrate")
        self.assertIn("exit 1", said)
        self.assertEqual(self.applications(), dict.fromkeys(APPLICATIONS, "old exited"))
        self.assertEqual(self.record()["phase"], "migrating")

    def test_a_rerun_once_the_cause_is_fixed_carries_the_migrations_on_and_completes(self):
        said = self.run_script(f'FAIL_AT="{FAILED_MIGRATION}" activate\nactivate')
        self.assertIn("exit 0", said)
        self.assertEqual(len(self.restore_points()), 1, said)
        self.assertEqual(self.applications(), dict.fromkeys(APPLICATIONS, "new running"))
        self.assertEqual((self.record(), self.current()), (None, NEW))

    def test_a_rerun_after_a_kill_during_the_migrations_carries_them_on(self):
        said = self.run_script(f'KILL_AT="{FAILED_MIGRATION}" activate\nactivate')
        self.assertIn("exit 0", said)
        [point] = self.restore_points()
        taken = sorted(path.name for path in (self.root / "backups/test" / point).iterdir())
        self.assertEqual(taken, ["agentify.dump"], said)
        self.assertEqual((self.record(), self.current()), (None, NEW))

    def test_a_failure_after_the_new_release_started_restores_nothing_and_says_so(self):
        said = self.run_script("activate", FAIL_AT=FAILED_START)
        self.assertIn("exit 1", said)
        self.assertIn("nothing was restored", said)
        self.assertEqual(self.databases(), MIGRATED)
        self.assertEqual((self.record()["to"], self.record()["phase"]), (NEW, "started"))

    def test_without_a_previous_release_the_message_says_what_does_not_run(self):
        # A host this command never released: no `current`, and no scanner
        # containers for a failed release to start again.
        (self.root / "state/test/current").unlink()
        for container in ("scanner", "scanner-worker"):
            (self.world / "containers" / container).unlink()
        said = self.run_script("activate", FAIL_AT="exec -T postgres pg_dump -U agentify -Fc agentify")
        self.assertIn("exit 1", said)
        self.assertIn("running now: cabinet gateway", said)

    # A rerun of the same revision.

    def test_a_rerun_after_the_new_release_started_never_restores_and_carries_it_forward(self):
        said = self.run_script("activate", FAIL_AT=FAILED_START)
        self.assertIn("exit 1", said)
        # Written from inside, as the running release would: an append from
        # the macOS side of Docker Desktop's file sharing can reach the next
        # container after that container's own append, which overwrites it.
        self.run_script(f'echo "{ORDER}" >> /h/world/db/agentify')
        said = self.run_script("activate", FAIL_AT=FAILED_MIGRATION)
        self.assertIn("exit 1", said)
        self.assertIn("nothing was restored", said)
        self.assertIn(ORDER, self.databases()["agentify"])
        self.assertEqual(self.record()["phase"], "started")
        stopped = len(self.calls())
        said = self.run_script("activate")
        self.assertIn("exit 0", said)
        self.assertIn(ORDER, self.databases()["agentify"])
        self.assertNotIn("stack stop --timeout 60 gateway cabinet scanner scanner-worker", self.calls()[stopped:])
        self.assertIsNone(self.record())

    def test_a_rerun_holds_the_release_to_the_cards_on_sale_before_its_first_run(self):
        said = self.run_script("activate", CARDS_AFTER="card_one")
        self.assertIn("card_two", said)
        said = self.run_script("activate")
        self.assertIn("exit 1", said)
        self.assertIn("card_two", said)
        self.assertEqual(self.record()["phase"], "started")

    def test_a_rerun_refused_while_the_channel_is_down_says_that_it_is_down(self):
        said = self.run_script("activate", FAIL_AT=FAILED_MIGRATION)
        said = self.run_script("activate", SCANNER_HEALTH="503")
        self.assertIn("exit 1", said)
        self.assertIn("none of gateway, cabinet, scanner and scanner-worker runs, so the channel is down", said)

    def test_a_rerun_that_takes_its_first_dump_checks_the_room_for_it(self):
        # Killed before its restore point was taken: the rerun takes it, and
        # needs the room a first run would.
        record = self.open_transition(NEW, "stopped")
        shutil.rmtree(self.root / "backups/test" / record["restore"].rsplit("/", 1)[1])
        said = self.run_script("activate", DF_AVAIL=str((1 << 30) + 500))
        self.assertIn("exit 1", said)
        self.assertIn("MiB free", said)
        self.assertEqual(self.record(), record)

    def test_a_missing_restore_point_of_a_migrating_release_is_refused(self):
        record = self.open_transition(NEW, "migrating")
        shutil.rmtree(self.root / "backups/test" / record["restore"].rsplit("/", 1)[1])
        said = self.run_script("activate")
        self.assertIn("exit 1", said)
        self.assert_old_release_runs_on_old_data(said)
        self.assertEqual(self.record(), record)

    def test_a_record_that_cannot_be_read_starts_and_stops_nothing(self):
        # Even for the revision the channel runs, which would otherwise only
        # be checked again: the record is not the same as no record.
        (self.root / "state/test/current").write_text(NEW + "\n")
        (self.root / "state/test/transition").write_text('{"to": "')
        said = self.run_script("activate")
        self.assertIn("exit 1", said)
        self.assert_old_release_runs_on_old_data(said)

    # Another revision against an open transition.

    def test_a_revision_that_moves_forward_from_a_release_that_started_unverified_goes_ahead(self):
        self.open_transition(OTHER, "started")
        said = self.run_script("activate")
        self.assertIn("exit 0", said)
        self.assertIn("2 compared", said)
        fresh = [point for point in self.restore_points() if point.endswith(f"-{OTHER}-before-{NEW}")]
        self.assertEqual(len(fresh), 1, self.restore_points())
        self.assertEqual((self.record(), self.current()), (None, NEW))

    def test_a_revision_that_does_not_move_forward_from_it_is_refused(self):
        record = self.open_transition(OTHER, "started")
        said = self.run_script("activate", NOT_FORWARD="1")
        self.assertIn("exit 1", said)
        self.assertIn(OTHER, said)
        self.assert_old_release_runs_on_old_data(said)
        self.assertEqual(self.record(), record)

    def test_another_revision_waits_for_a_transition_that_had_not_started(self):
        record = self.open_transition(OTHER, "migrating")
        said = self.run_script("activate")
        self.assertIn("exit 75", said)
        self.assertIn(OTHER, said)
        self.assertIn(f"agentify-release --restore {record['restore']}", said)
        self.assert_old_release_runs_on_old_data(said)
        self.assertEqual(self.record(), record)

    def test_another_revision_behind_a_release_stopped_before_its_restore_point_is_not_sent_to_restore_it(self):
        record = self.open_transition(OTHER, "stopped")
        shutil.rmtree(self.root / "backups/test" / record["restore"].rsplit("/", 1)[1])
        said = self.run_script("activate")
        self.assertIn("exit 75", said)
        self.assertNotIn("--restore", said)
        self.assertIn("aside", said)

    # A fix-forward that fails before its migrations gives the unverified
    # release its record back, so `current` and the record never disagree:
    # releasing the verified revision before it is refused afterwards.

    def assert_the_started_release_keeps_its_record(self, **failure):
        record = self.open_transition(OTHER, "started")
        said = self.run_script("activate", **failure)
        self.assertIn("exit 1", said)
        self.assertEqual(self.record(), record, said)
        said = self.run_script(f"release {OLD}", NOT_FORWARD="1")
        self.assertIn("exit 1", said)
        self.assertNotIn("again: the channel already runs it", said)
        self.assertEqual(self.record(), record, said)

    def test_a_fix_forward_whose_dump_fails_gives_the_started_release_its_record_back(self):
        self.assert_the_started_release_keeps_its_record(FAIL_AT="exec -T postgres pg_dump -U agentify -Fc agentify")

    def test_a_fix_forward_stopped_by_systemctl_stop_gives_the_started_release_its_record_back(self):
        self.assert_the_started_release_keeps_its_record(TERM_AT="stop --timeout 60 gateway cabinet scanner scanner-worker")

    def test_a_fix_forward_stopped_by_a_reboot_gives_the_started_release_its_record_back(self):
        self.assert_the_started_release_keeps_its_record(TERM_AT="up -d --wait --no-deps postgres")

    def test_a_stop_after_current_is_written_and_before_the_record_goes_leaves_them_agreeing(self):
        # A verified release writes `current` before it removes its record.
        # Stopped in between, both name it: the previous revision is refused,
        # and the release itself finishes when run again.
        record = self.open_transition(NEW, "started")
        (self.root / "state/test/current").write_text(NEW + "\n")
        said = self.run_script(f"release {OLD}", NOT_FORWARD="1")
        self.assertIn("exit 1", said)
        self.assertEqual(self.record(), record)
        said = self.run_script("activate")
        self.assertIn("exit 0", said)
        self.assertEqual((self.record(), self.current()), (None, NEW))

    def test_once_the_record_is_gone_the_previous_revision_migrates_rather_than_runs_on_the_new_schema(self):
        self.assertIn("exit 0", self.run_script("activate"))
        stopped = len(self.calls())
        said = self.run_script(f"release {OLD}")
        self.assertNotIn("again: the channel already runs it", said)
        self.assertIn(f"stack {FAILED_MIGRATION}", self.calls()[stopped:])

    # The nightly privacy job.

    def test_the_nightly_privacy_job_skips_while_a_transition_is_open_and_says_why(self):
        # The job's line as the release wrote it into /etc/cron.d, run once
        # with a record open and once without.
        (self.root / "state/test/open.json").write_text(json.dumps({"to": OTHER, "phase": "started"}))
        said = self.run_script(
            "activate\ncp /h/state/test/open.json /h/state/test/transition\nprivacy\n"
            "echo skipped: $(grep -c 'stack --profile jobs run' /h/world/calls)\nrm /h/state/test/transition\nprivacy"
        )
        self.assertIn("skipped: 0", said)
        self.assertIn("/var/lib/agentify/test/transition", (self.world / "log").read_text())
        self.assertEqual(self.calls().count("stack --profile jobs run --rm --no-deps -T scanner-privacy"), 1)

    # Restores, which only a person starts.

    def test_a_restore_writes_current_as_the_revision_whose_data_it_holds_so_the_next_release_migrates(self):
        self.assertIn("exit 0", self.run_script("activate"))
        [point] = self.restore_points()
        said = self.run_script(f"restore /var/backups/agentify/test/{point}")
        self.assertIn("restore exit 0", said)
        self.assertEqual((self.databases(), self.current()), (ORIGINAL, OLD))
        # What it says is current is the revision it wrote, and nothing else.
        self.assertIn(f"and {OLD} is current.", said)
        stopped = len(self.calls())
        said = self.run_script("activate")
        self.assertIn("exit 0", said)
        self.assertIn(f"stack {FAILED_MIGRATION}", self.calls()[stopped:])

    def test_a_restore_keeps_the_databases_it_replaced_until_a_release_is_verified(self):
        self.assertIn("exit 0", self.run_script("activate"))
        [point] = self.restore_points()
        self.assertIn("restore exit 0", self.run_script(f"restore /var/backups/agentify/test/{point}"))
        replaced = self.replaced()
        self.assertEqual(len(replaced), 1, replaced)
        self.assertEqual((self.world / "db" / replaced[0]).read_text().strip(), MIGRATED["agentify"])
        self.assertIn("exit 1", self.run_script("activate", FAIL_AT=FAILED_START))
        self.assertEqual(self.replaced(), replaced)
        self.assertIn("exit 0", self.run_script("activate"))
        self.assertEqual(self.replaced(), [])

    def test_a_restore_of_a_bad_dump_leaves_the_databases_and_holds_no_release_back(self):
        self.assertIn("exit 0", self.run_script("activate"))
        [point] = self.restore_points()
        said = self.run_script(f"restore /var/backups/agentify/test/{point}", RESTORE_FAILS="1")
        self.assertIn("restore exit 1", said)
        self.assertIn("down", said)
        self.assertEqual((self.databases(), self.record(), self.current()), (MIGRATED, None, NEW))
        self.assertIn("exit 0", self.run_script("activate"))

    def test_a_restore_of_a_bad_dump_during_a_transition_gives_the_record_back_as_it_was(self):
        self.run_script("activate", FAIL_AT=FAILED_MIGRATION)
        record = self.record()
        said = self.run_script(f"restore {record['restore']}", RESTORE_FAILS="1")
        self.assertIn("restore exit 1", said)
        self.assertEqual(self.record(), record)
        self.assertIn("exit 0", self.run_script("activate"))

    def test_a_swap_that_fails_partway_leaves_the_database_as_it_was(self):
        self.assertIn("exit 0", self.run_script("activate"))
        [point] = self.restore_points()
        said = self.run_script(f"restore /var/backups/agentify/test/{point}", SWAP_FAILS="1")
        self.assertIn("restore exit 1", said)
        self.assertEqual((self.databases(), self.record()), (MIGRATED, None))

    def test_a_restore_without_room_for_a_second_copy_changes_nothing(self):
        self.assertIn("exit 0", self.run_script("activate"))
        [point] = self.restore_points()
        said = self.run_script(f"restore /var/backups/agentify/test/{point}", DB_FREE_KB="1000")
        self.assertIn("restore exit 1", said)
        self.assertIn("MiB free", said)
        self.assertEqual(self.applications(), dict.fromkeys(APPLICATIONS, "new running"))
        self.assertEqual((self.databases(), self.record()), (MIGRATED, None))

    def test_a_restore_that_would_not_fit_on_a_large_volume_changes_nothing(self):
        # 3 GiB free for databases of 5 GB: the free room is larger than a
        # 32-bit number, which an awk may print as 3.2e+09.
        self.assertIn("exit 0", self.run_script("activate"))
        [point] = self.restore_points()
        said = self.run_script(f"restore /var/backups/agentify/test/{point}", DB_FREE_KB=str(3 << 20), DB_SIZE="5000000000")
        self.assertIn("restore exit 1", said)
        self.assertIn("MiB free", said)
        self.assertEqual((self.databases(), self.record()), (MIGRATED, None))

    def test_a_directory_holding_no_dump_is_refused_and_changes_nothing(self):
        (self.root / "backups/test/empty").mkdir(parents=True)
        said = self.run_script("restore /var/backups/agentify/test/empty")
        self.assertIn("restore exit 1", said)
        self.assertIn("dump", said)
        self.assertEqual((self.databases(), self.record()), (ORIGINAL, None))
        self.assertEqual(self.applications(), dict.fromkeys(APPLICATIONS, "old running"))

    def test_a_restore_refuses_a_record_it_cannot_read_in_words(self):
        self.assertIn("exit 0", self.run_script("activate"))
        [point] = self.restore_points()
        (self.root / "state/test/transition").write_text("")
        said = self.run_script(f"restore /var/backups/agentify/test/{point}")
        self.assertIn("restore exit 1", said)
        self.assertIn("cannot be read", said)
        self.assertNotIn("unbound variable", said)
        self.assertEqual(self.databases(), MIGRATED)

    def test_a_restore_by_hand_after_a_failed_release_ends_the_transition_however_its_path_is_spelled(self):
        self.run_script("activate", FAIL_AT=FAILED_MIGRATION)
        [point] = self.restore_points()
        # /var/backups/agentify is a symlink on this host, and the person types
        # the directory it points to, with a trailing slash.
        said = self.run_script(f"restore /h/backups/test/{point}/")
        self.assertIn("restore exit 0", said)
        self.assertEqual((self.record(), self.databases(), self.current()), (None, ORIGINAL, OLD))

    def test_a_restore_waits_for_a_release_holding_the_lock(self):
        (self.root / "backups/test/point").mkdir(parents=True)
        for database, content in ORIGINAL.items():
            (self.root / "backups/test/point" / f"{database}.dump").write_text(content + "\n")
        (self.world / "db/agentify").write_text("agentify: written after the dump\n")
        said = self.run_script(
            "flock /run/lock/agentify-release.lock sleep 5 &\nsleep 1\n"
            "restore /var/backups/agentify/test/point\nwait\nrestore /var/backups/agentify/test/point"
        )
        self.assertIn("restore exit 75", said)
        self.assertIn("restore exit 0", said)
        self.assertEqual(self.databases(), ORIGINAL)
        self.assertEqual(self.applications(), dict.fromkeys(APPLICATIONS, "old exited"))

    def test_a_release_waits_while_a_restore_or_the_privacy_job_holds_the_release_lock(self):
        said = self.run_script("flock /run/lock/agentify-release.lock sleep 5 &\nsleep 1\nactivate")
        self.assertIn("exit 75", said)
        self.assert_old_release_runs_on_old_data(said)

    # The database's init scripts.

    def init_scripts(self):
        init = self.root / "state/test/postgres-init"
        return {path.name: path.read_text() for path in sorted(init.iterdir())} if init.exists() else None

    def test_the_database_starts_with_the_revisions_init_scripts_at_a_path_that_does_not_change(self):
        said = self.run_script("activate")
        self.assertIn("exit 0", said)
        self.assertEqual((self.world / "postgres-init-at-start").read_text().split(), sorted(INIT), said)
        self.assertEqual(self.init_scripts(), INIT)
        # The database's server reads them as its own user.
        init = self.root / "state/test/postgres-init"
        self.assertEqual(init.stat().st_mode & 0o777, 0o755)
        self.assertEqual({(init / name).stat().st_mode & 0o777 for name in INIT}, {0o644})

    def test_unchanged_init_scripts_are_left_as_they_are(self):
        self.run_script("activate")
        init = self.root / "state/test/postgres-init"
        before = [(path.name, path.stat().st_ino) for path in (init, *sorted(init.iterdir()))]
        (self.root / "state/test/current").write_text(OLD + "\n")
        said = self.run_script("activate")
        self.assertIn("exit 0", said)
        self.assertEqual([(path.name, path.stat().st_ino) for path in (init, *sorted(init.iterdir()))], before)

    def test_changed_init_scripts_replace_the_old_ones_whole(self):
        init = self.root / "state/test/postgres-init"
        init.mkdir()
        (init / "01-test-database.sql").write_text("an older script\n")
        (init / "00-removed-since.sql").write_text("a script the revision no longer has\n")
        said = self.run_script("activate")
        self.assertIn("exit 0", said)
        self.assertEqual(self.init_scripts(), INIT)
        self.assertEqual(sorted(path.name for path in (self.root / "state/test").iterdir() if path.name.startswith("postgres-init")), ["postgres-init"])

    # What is refused before anything stops.

    def test_images_that_do_not_arrive_are_a_wait_that_stops_nothing(self):
        said = self.run_script("activate", FAIL_AT="--profile jobs pull --policy missing --quiet")
        self.assertIn("exit 75", said)
        self.assert_old_release_runs_on_old_data(said)

    def test_a_scanner_that_refuses_its_own_configuration_stops_nothing(self):
        said = self.run_script("activate", SCANNER_HEALTH="503")
        self.assertIn("exit 1", said)
        self.assertIn("scanner", said)
        self.assert_old_release_runs_on_old_data(said)

    def test_a_host_without_the_database_volume_stops_nothing(self):
        said = self.run_script("activate", NO_VOLUME="1")
        self.assertIn("exit 1", said)
        self.assertIn("the volume agentify-postgres", said)
        self.assert_old_release_runs_on_old_data(said)
        self.assertEqual((self.restore_points(), self.record()), ([], None))

    def test_a_move_to_one_database_that_has_not_finished_stops_nothing(self):
        # deploy/one-database.sh keeps its progress beside the transition
        # record; until it says done, the new project's database is a copy in
        # the middle of a move, and a release must not start on it.
        # Written from inside, as the move writes it: a rewrite from the macOS
        # side of Docker Desktop's file sharing can reach the container late.
        write = 'echo "{}" > /var/lib/agentify/test/one-database\nactivate'
        for progress in ("stopping", "stopped /var/backups/agentify/test/point 1", "copied /var/backups/agentify/test/point 1 2"):
            with self.subTest(progress=progress):
                said = self.run_script(write.format(progress))
                self.assertIn("exit 1", said)
                self.assertIn("/var/lib/agentify/test/one-database", said)
                self.assert_old_release_runs_on_old_data(said)
                self.assertEqual((self.restore_points(), self.record()), ([], None))
        self.assertIn("exit 0", self.run_script(write.format("done /var/backups/agentify/test/point 1 2")))

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

    # The cards on sale.

    def test_a_card_on_sale_before_the_release_must_still_be_on_sale_after_it(self):
        said = self.run_script("activate", CARDS_AFTER="card_one")
        self.assertIn("exit 1", said)
        self.assertIn("card_two", said)

    def test_every_card_must_answer_its_challenge_on_the_channels_network(self):
        (self.world / "network").write_text("eip155:8453")
        said = self.run_script("activate")
        self.assertIn("exit 1", said)
        self.assertIn("card_one", said)

    def test_a_catalog_longer_than_one_argument_can_hold_is_checked_whole(self):
        # A card ID is `item_` and 32 hex characters; 3,600 of them are more
        # than the 128 KiB Linux allows a single argument.
        (self.world / "cards").write_text(" ".join(f"item_{index:032x}" for index in range(3600)))
        said = self.run_script("activate")
        self.assertIn("exit 0", said)
        self.assertIn("3600 card(s) on sale (3600 compared)", said)


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
        said = self.check("A=plain\nAGENTIFY_AUTH_SECRET=aaaa$bbbb$cccc\nB=\"x$y\"\n")
        self.assertIn("exit 78", said)
        self.assertIn("AGENTIFY_AUTH_SECRET", said)
        self.assertIn("B ", said)
        self.assertNotIn("bbbb", said)

    def test_takes_a_dollar_inside_single_quotes_and_a_comment(self):
        said = self.check("AGENTIFY_AUTH_SECRET='aaaa$bbbb$cccc'\n# NOTE=$x\n")
        self.assertIn("compose would run", said)
        self.assertIn("exit 0", said)


if __name__ == "__main__":
    unittest.main()
