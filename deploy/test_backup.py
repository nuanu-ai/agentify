"""What the backup of PRODUCTION promises about its databases, its bucket and its host.

The scripts run as they ship, as root, in a throwaway Debian container. Around
them `docker` and `restic` are fakes acting on a small world of files: a
database is a directory holding a file per table with a line per row, and a
snapshot is a directory holding the files restic was given. The fake pg_restore
renders a dump as COPY blocks, as the real one does. `flock` is the real one
with every wait a hundredth as long. It needs Docker, which pulls
python:3.12-slim-bookworm the first time.
"""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest


HERE = Path(__file__).parent
IMAGE = "python:3.12-slim-bookworm"
RESTIC_PASSWORD, S3_SECRET = "restic-repository-secret", "s3-secret-access-key"
BACKUP_ENV = f"RESTIC_REPOSITORY=s3:https://example/bucket\nRESTIC_PASSWORD={RESTIC_PASSWORD}\nAWS_ACCESS_KEY_ID=KEY\nAWS_SECRET_ACCESS_KEY={S3_SECRET}\n"
LIVE = {
    "agentify_commerce": {"public.orders": ["ord_1", "ord_2", "ord_3"], "drizzle.__drizzle_migrations": ["1"], "public.receipts": []},
    "agentify_scanner": {"public.scans": ["scan_1", "scan_2"]},
}
# What is not the channel's data: the server's own database, the test suites',
# and the scratch a restore or a killed check leaves.
SCRATCH = {"postgres": {}, "agentify_commerce_test": {"public.orders": ["x"]}, "agentify_scanner_replaced_20260924101010": {},
           "agentify_commerce_restoring": {}, "check_agentify_scanner": {"public.scans": ["left by a killed check"]}}

DOCKER = r"""#!/usr/bin/env bash
W=/h/world
echo "docker $*" >> $W/calls
if [[ $1 == ps ]]; then echo postgres-1; exit 0; fi
[[ $2 != -i ]] || shift
shift 2
target() { while (($#)); do [[ $1 != -d ]] || { echo "$2"; return; }; shift; done; }
case $1 in
  pg_dump)
    [[ ${FAIL_DUMP:-} != "${*: -1}" ]] || { echo "pg_dump: error: connection to server was lost" >&2; exit 1; }
    for table in $W/db/${*: -1}/*; do [[ ! -f $table ]] || { echo "TABLE ${table##*/}"; cat "$table"; }; done ;;
  pg_dumpall) echo "CREATE ROLE agentify_web;" ;;
  pg_restore)
    if [[ $2 == -f ]]; then
      awk '/^TABLE /{ if (open) print "\\."; print "COPY " $2 " (id) FROM stdin;"; open = 1; next } { print } END { if (open) print "\\." }'
    else
      into=$W/db/$(target "$@")
      awk -v into=$into -v lose="${LOSE_ROW:-}" '/^TABLE /{ table = into "/" $2; printf "" > table; skip = ($2 == lose); next }
        skip { skip = 0; next } { print >> table }'
    fi ;;
  psql)
    database="$(target "$@")" sql="${*: -1}"
    case $sql in
      *datistemplate*) ls $W/db ;;
      *"LIKE 'check"*) ls $W/db | grep '^check_' || true ;;
      "CREATE DATABASE "*) mkdir $W/db/${sql#CREATE DATABASE } ;;
      "DROP DATABASE "*) name="${sql#DROP DATABASE }"; rm -rf "$W/db/${name%% *}" ;;
      *query_to_xml*) for table in $W/db/$database/*; do [[ ! -f $table ]] || echo "${table##*/}|$(wc -l < $table)"; done ;;
    esac ;;
esac
"""

RESTIC = r"""#!/usr/bin/env bash
R=/h/world/repo
echo "restic $*" >> /h/world/calls
[[ -n ${RESTIC_PASSWORD:-} && -n ${AWS_SECRET_ACCESS_KEY:-} ]] || { echo "Fatal: no repository password or key" >&2; exit 1; }
mkdir -p $R; touch $R/order
case $1 in
  backup)
    id="$(printf 'snapshot %s' "$(wc -l < $R/order)" | sha256sum | cut -c1-64)" files=() seen=""
    for argument in "$@"; do if [[ -n $seen ]]; then files+=("$argument"); elif [[ $argument == -- ]]; then seen=1; fi; done
    mkdir $R/$id && cp -p "${files[@]}" $R/$id/ && echo $id >> $R/order
    echo "{\"message_type\":\"summary\",\"snapshot_id\":\"$id\"}" ;;
  snapshots) id="$(tail -n 1 $R/order)"; echo "[{\"id\":\"$id\",\"short_id\":\"${id:0:8}\"}]" ;;
  restore) id="$(grep "^$2" $R/order)" into="${*: -1}"; mkdir -p "$into"; cp -p $R/$id/* "$into/" ;;
esac
"""

FLOCK = r"""#!/usr/bin/env bash
# The real flock, with every wait a hundredth as long.
arguments=()
while (($#)); do if [[ $1 == -w ]]; then arguments+=(-w "$(($2 / 100))"); shift 2; else arguments+=("$1"); shift; fi; done
exec /usr/bin/flock "${arguments[@]}"
"""


def container_available():
    try:
        return subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True).returncode == 0 or (
            subprocess.run(["docker", "pull", "-q", IMAGE], capture_output=True).returncode == 0
        )
    except FileNotFoundError:
        return False


class Backups(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not container_available():
            raise RuntimeError(f"these tests run the backup scripts in a {IMAGE} container, and Docker is not available here")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.world = self.root / "world"
        for directory in ("tree/deploy", "bin", "world", "etc", "state"):
            (self.root / directory).mkdir(parents=True)
        for path in HERE.iterdir():
            if path.is_file() and not path.name.startswith("test_"):
                shutil.copy(path, self.root / "tree/deploy" / path.name)
        fakes = {"docker": DOCKER, "restic": RESTIC, "flock": FLOCK, "systemctl": 'echo "systemctl $*" >> /h/world/calls',
                 "chage": "echo 'Password expires : never'", "curl": "", "git": ""}
        for name, body in fakes.items():
            (self.root / "bin" / name).write_text(body if body.startswith("#!") else f"#!/usr/bin/env bash\n{body}\n")
            (self.root / "bin" / name).chmod(0o755)
        (self.root / "etc/production.env").write_text("AGENTIFY_DB_PASSWORD=production-database-secret\n")
        (self.root / "etc/backup.env").write_text(BACKUP_ENV)
        self.server({**LIVE, **SCRATCH})

    def tearDown(self):
        subprocess.run(["docker", "run", "--rm", "-v", f"{self.root}:/h", IMAGE, "chown", "-R", self.owner, "/h"], capture_output=True)
        self.temp.cleanup()

    @property
    def owner(self):
        return f"{os.getuid()}:{os.getgid()}"

    def server(self, databases):
        shutil.rmtree(self.world / "db", ignore_errors=True)
        for database, tables in databases.items():
            (self.world / "db" / database).mkdir(parents=True)
            for table, rows in tables.items():
                (self.world / "db" / database / table).write_text("".join(row + "\n" for row in rows))

    def run_script(self, script, **environment):
        """Runs a bash script as root in the container, with the fakes first on PATH."""
        # What root writes into the bind mount stays root's on Linux, so each
        # run gives the tree back to the user running the tests, keeping modes.
        prelude = textwrap.dedent("""\
            trap 'status=$?; chown -R "$OWNER" /h; exit $status' EXIT
            mkdir -p /run/lock /etc/agentify /var/lib/agentify /usr/local/sbin /etc/cron.d /etc/systemd/system
            ln -s /h/state /var/lib/agentify/production
            install -m 600 /h/etc/production.env /etc/agentify/production.env
            [[ ! -f /h/etc/backup.env ]] || install -m "${BACKUP_ENV_MODE:-600}" /h/etc/backup.env /etc/agentify/backup.env
            echo '{"channel": "production", "repository": "unused"}' > /etc/agentify/release.json
            export PATH=/h/bin:$PATH
            backup() { /h/tree/deploy/backup.sh; echo "backup exit $?"; }
            check() { /h/tree/deploy/backup-check.sh; echo "check exit $?"; }
            """)
        options = [f"--env={key}={value}" for key, value in {"OWNER": self.owner, **environment}.items()]
        result = subprocess.run(
            ["docker", "run", "--rm", "--network", "none", "-v", f"{self.root}:/h", *options, IMAGE, "bash", "-c", prelude + script],
            capture_output=True, text=True, timeout=240,
        )
        return result.stdout + result.stderr

    def snapshots(self):
        order = self.world / "repo/order"
        return order.read_text().split() if order.exists() else []

    def stored(self, snapshot):
        return {path.name: path.read_text() for path in sorted((self.world / "repo" / snapshot).iterdir())}

    def databases(self):
        return sorted(path.name for path in (self.world / "db").iterdir())

    def status(self):
        path = self.root / "state/backup-status"
        return path.read_text() if path.exists() else ""

    def calls(self):
        path = self.world / "calls"
        return path.read_text().splitlines() if path.exists() else []

    def test_a_snapshot_holds_every_database_its_counts_and_production_env_but_never_backup_env(self):
        said = self.run_script("backup")
        self.assertIn("backup exit 0", said)
        [snapshot] = self.snapshots()
        stored = self.stored(snapshot)
        self.assertEqual(sorted(stored), ["agentify_commerce.dump", "agentify_scanner.dump", "counts", "production.env", "release.json", "roles.sql"])
        counts = sorted(f"{database}|{table}|{len(rows)}" for database, tables in LIVE.items() for table, rows in tables.items())
        self.assertEqual(sorted(stored["counts"].splitlines()), counts)
        self.assertNotIn(RESTIC_PASSWORD, "".join(stored.values()))
        self.assertNotIn(S3_SECRET, "".join(stored.values()))
        self.assertIn(snapshot[:8], self.status())
        self.assertEqual((self.root / "state/backup-status").stat().st_mode & 0o777, 0o644)

    def test_a_failed_dump_stores_no_snapshot(self):
        said = self.run_script("backup", FAIL_DUMP="agentify_scanner")
        self.assertRegex(said, r"(?m)^backup exit [1-9]")
        self.assertIn("pg_dump", said)
        self.assertEqual((self.snapshots(), self.status()), ([], ""))

    def test_a_release_lock_busy_for_the_whole_wait_returns_75_and_dumps_nothing(self):
        said = self.run_script("flock /run/lock/agentify-release.lock sleep 8 &\nsleep 1\nSECONDS=0\nbackup\necho waited $SECONDS")
        self.assertIn("backup exit 75", said)
        self.assertGreaterEqual(int(said.split("waited ")[1].split()[0]), 3)
        self.assertFalse([call for call in self.calls() if "pg_dump" in call])
        self.assertEqual(self.snapshots(), [])

    def test_the_database_list_survives_the_merge_into_one_database_named_agentify(self):
        self.server({"agentify": {"public.orders": ["ord_1"], "public.scans": ["scan_1", "scan_2"]}, "postgres": {}, "check_agentify": {}})
        said = self.run_script("backup\ncheck")
        self.assertIn("backup exit 0", said)
        self.assertIn("check exit 0", said)
        [snapshot] = self.snapshots()
        self.assertEqual([name for name in self.stored(snapshot) if name.endswith(".dump")], ["agentify.dump"])
        self.assertIn("passed", self.status())
        self.assertEqual(self.databases(), ["agentify", "postgres"])

    def test_the_check_drops_its_scratch_databases_even_when_a_restore_loses_a_row(self):
        said = self.run_script("backup\nLOSE_ROW=public.orders check")
        self.assertRegex(said, r"(?m)^check exit [1-9]")
        self.assertIn("agentify_commerce|public.orders|3", said)
        self.assertIn("failed", self.status())
        self.assertFalse([name for name in self.databases() if name.startswith("check_")])

    # install.sh

    def install(self, channel, **environment):
        said = self.run_script(
            "echo '*/10 * * * * root /usr/local/sbin/agentify-backup-interim' > /etc/cron.d/agentify-backup-interim\n"
            "touch /usr/local/sbin/agentify-backup-interim\n"
            "cp /etc/agentify/production.env /etc/agentify/test.env\n"
            f"/h/tree/deploy/install.sh {channel}; echo \"install exit $?\"\n"
            "find /usr/local/sbin /etc/systemd/system /etc/cron.d -name 'agentify*' -printf '%f\\n' | sort > /h/world/installed",
            **environment,
        )
        return said, (self.world / "installed").read_text().split()

    BACKUP = ["agentify-backup", "agentify-backup-check", "agentify-backup-check.service",
              "agentify-backup-credentials", "agentify-backup-failed@.service", "agentify-backup.service", "agentify-backup.timer"]

    def test_production_installs_the_backup_starts_its_timers_and_removes_the_interim_job(self):
        said, installed = self.install("production")
        self.assertIn("install exit 0", said)
        self.assertEqual([name for name in installed if name.startswith("agentify-backup")], self.BACKUP)
        self.assertIn("systemctl enable --now agentify-backup.timer", self.calls())
        self.assertNotIn("agentify-backup-check.timer", " ".join(self.calls()))

    def test_production_without_a_root_600_backup_env_is_refused_and_installs_nothing(self):
        said, installed = self.install("production", BACKUP_ENV_MODE="644")
        self.assertRegex(said, r"(?m)^install exit 1$")
        self.assertEqual(installed, ["agentify-backup-interim", "agentify-backup-interim"])

    def test_test_takes_no_backups(self):
        said, installed = self.install("test")
        self.assertIn("install exit 0", said)
        self.assertFalse(set(self.BACKUP) & set(installed), installed)


if __name__ == "__main__":
    unittest.main()
