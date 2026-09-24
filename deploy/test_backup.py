"""What the backup of PRODUCTION does to its databases, its bucket and its host.

The scripts run as they ship, as root, in a throwaway Debian container, since
they own host paths (/etc/agentify, /var/lib/agentify, /run/lock). Around them,
`docker`, `restic` and a checkout's `stack.sh` are fakes that act on a small
world of files in the test's directory, and each test asserts on that world
after the run, as a person would inspect the host and the bucket.

The database server is a directory per database holding a file per table, one
line per row. The fake `pg_dump` writes a table's name and its rows; the fake
`pg_restore` renders them as pg_restore renders a real dump, a COPY block per
table, or loads them into another database; the fake `psql` lists, creates,
drops and counts. The repository is a directory per snapshot holding the files
restic was given, so a test reads a snapshot as a restore would. The fake
docker knows the database's container only by the ID the checkout's
`stack.sh ps -q postgres` prints, never by a name. `flock` is the real one with
every wait a hundredth as long, so the five-minute wait for the release lock
takes three seconds, and `date` can be moved a day on.

It needs Docker, which pulls python:3.12-slim-bookworm the first time, and it
fails with that sentence when there is none.
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
REVISION = "a" * 40
SCRIPTS = ("backup.sh", "backup-check.sh", "backup-credentials.sh")
# Secrets of the two files: production.env goes into every snapshot, and
# backup.env, which opens the snapshots, must never be in one.
DB_PASSWORD = "production-database-secret"
RESTIC_PASSWORD = "restic-repository-secret"
S3_SECRET = "s3-secret-access-key"
PRODUCTION_ENV = f"AGENTIFY_DB_PASSWORD={DB_PASSWORD}\nAGENTIFY_PUBLIC_ORIGIN=https://agentify.ad\n"
BACKUP_ENV = (
    "RESTIC_REPOSITORY=s3:https://fsn1.your-objectstorage.com/nuanu-agentify-backups\n"
    f"AWS_DEFAULT_REGION=fsn1\nRESTIC_PASSWORD={RESTIC_PASSWORD}\n"
    f"AWS_ACCESS_KEY_ID=V0VVEXAMPLEKEY\nAWS_SECRET_ACCESS_KEY={S3_SECRET}\n"
)
# What the database server holds: the two databases the channel runs on, and
# around them what must not be backed up — the server's own database, the
# test suites' databases, a restore's scratch and replaced databases, and a
# scratch database a killed check left.
LIVE = {
    "agentify_commerce": {
        "public.orders": ["ord_1\tpaid", "ord_2\trefund_due", "ord_3\tfulfilled"],
        "public.cards": ["item_one"],
        "drizzle.__drizzle_migrations": ["1", "2"],
        "public.receipts": [],
    },
    "agentify_scanner": {"public.scans": ["scan_1", "scan_2", "scan_3", "scan_4"], "pgboss.job": ["job_1"]},
}
SCRATCH = {
    "postgres": {},
    "agentify_commerce_test": {"public.orders": ["a test's order"]},
    "agentify_scanner_migration_test": {},
    "agentify_commerce_restoring": {"public.orders": ["half a restore"]},
    "agentify_scanner_replaced_20260924101010": {"public.scans": ["before a restore"]},
    "check_agentify_scanner": {"public.scans": ["left by a killed check"]},
}

STACK = r"""#!/usr/bin/env bash
# Fake stack.sh of a checkout that ran a release: Compose finds the database's
# container by its labels and prints its ID.
echo "stack $*" >> /h/world/calls
if [[ "$*" == "production ps -q postgres" && -z ${NO_POSTGRES:-} ]]; then echo postgres-1; fi
"""

BROKEN_STACK = r"""#!/usr/bin/env bash
# Fake stack.sh of a checkout whose release waited before it recorded any image.
echo "stack: images.env is missing, so this checkout names no images" >&2
exit 78
"""

DOCKER = r"""#!/usr/bin/env bash
# Fake docker: the channel's one PostgreSQL container, acting on /h/world.
W=/h/world
echo "docker $*" >> $W/calls
if [[ -n ${TERM_AT:-} && "$*" == *"$TERM_AT"* ]]; then kill -TERM $PPID; sleep 1; fi
[[ ${1:-} == exec ]] || exit 0
shift
[[ $1 != -i ]] || shift
[[ $1 == postgres-1 ]] || { echo "Error response from daemon: No such container: $1" >&2; exit 1; }
shift
lock() { if flock -n /run/lock/agentify-release.lock true; then echo free; else echo held; fi; }
target() { while (($#)); do [[ $1 != -d ]] || { echo "$2"; return; }; shift; done; }
case $1 in
  pg_dump)
    database="${*: -1}"
    echo "$database $(lock)" >> $W/dumped
    [[ ${FAIL_DUMP:-} != "$database" ]] || { echo "pg_dump: error: connection to server was lost" >&2; exit 1; }
    for table in $W/db/$database/*; do [[ ! -f $table ]] || { echo "TABLE ${table##*/}"; cat "$table"; }; done ;;
  pg_dumpall) printf 'CREATE ROLE agentify_commerce;\nCREATE ROLE agentify_web;\n' ;;
  pg_restore)
    if [[ " $* " == *" -f - "* ]]; then
      awk '/^TABLE /{ if (open) print "\\."; print "CREATE TABLE " $2 " (id text);"; print "COPY " $2 " (id) FROM stdin;"; open = 1; next }
           { print } END { if (open) print "\\." }'
    else
      database="$(target "$@")"
      if [[ ${FAIL_RESTORE:-} == "$database" ]]; then cat > /dev/null; echo "pg_restore: error: could not read from input file: end of file" >&2; exit 1; fi
      mkdir -p $W/db/$database
      awk -v into=$W/db/$database -v lose="${LOSE_ROW:-}" '
        /^TABLE / { table = into "/" $2; printf "" > table; skip = ($2 == lose); next }
        skip { skip = 0; next }
        { print >> table }'
    fi ;;
  psql)
    database="$(target "$@")" script="$(cat)"
    case $script in
      *"FROM pg_database"*"datistemplate"*) ls $W/db ;;
      *pg_database_size*) echo 1000 ;;
      *"count(*)"*)
        n=0
        for table in $(grep -o 'FROM [^ ;]*' <<<"$script" | cut -d' ' -f2); do
          n=$((n + 1))
          [[ -f $W/db/$database/$table ]] || { echo "ERROR:  relation \"$table\" does not exist" >&2; exit 1; }
          echo "$n|$(wc -l < $W/db/$database/$table)"
        done ;;
      *)
        while read -r statement; do
          case $statement in
            "CREATE DATABASE "*) name="${statement#CREATE DATABASE }"; mkdir $W/db/${name%;} ;;
            "DROP DATABASE "*) name="${statement#DROP DATABASE }"; name="${name#IF EXISTS }"; rm -rf "$W/db/${name%% *}" ;;
          esac
        done <<<"$script" ;;
    esac ;;
  df) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/data 1 1 %s 1%% /var/lib/postgresql/data\n' "${DB_FREE_KB:-999999999}" ;;
esac
"""

RESTIC = r"""#!/usr/bin/env bash
# Fake restic: a repository of snapshot directories under /h/world/repo, each
# holding the files it was given, in the order they were taken.
W=/h/world R=/h/world/repo
echo "restic $*" >> $W/calls
if [[ $1 == version ]]; then echo "restic ${RESTIC_VERSION:-0.16.4} compiled with go1.22.2 on linux/amd64"; exit 0; fi
[[ -n ${RESTIC_REPOSITORY:-} && -n ${RESTIC_PASSWORD:-} && -n ${AWS_ACCESS_KEY_ID:-} && -n ${AWS_SECRET_ACCESS_KEY:-} ]] \
  || { echo "Fatal: the repository, its password or its S3 key is not set" >&2; exit 1; }
mkdir -p $R/snapshots
touch $R/order
after() { local flag=$1; shift; while (($#)); do [[ $1 != "$flag" ]] || { echo "$2"; return; }; shift; done; }
case $1 in
  backup)
    [[ -z ${FAIL_UPLOAD:-} ]] || { echo "Fatal: unable to save snapshot: connection refused" >&2; exit 1; }
    if flock -n /run/lock/agentify-release.lock true; then echo free >> $W/uploaded; else echo held >> $W/uploaded; fi
    id="$(printf 'snapshot %s' "$(wc -l < $R/order)" | sha256sum | cut -c1-64)"
    files=() seen=""
    for argument in "$@"; do if [[ -n $seen ]]; then files+=("$argument"); elif [[ $argument == -- ]]; then seen=1; fi; done
    mkdir $R/snapshots/$id
    cp -p "${files[@]}" $R/snapshots/$id/
    echo $id >> $R/order
    echo "{\"message_type\":\"summary\",\"files_new\":${#files[@]},\"snapshot_id\":\"$id\"}" ;;
  forget) [[ -z ${FAIL_FORGET:-} ]] || { echo "Fatal: unable to create lock in backend: repository is already locked exclusively" >&2; exit 1; } ;;
  prune) ;;
  check) [[ -z ${CHECK_FAILS:-} ]] || { echo "error: pack 1a2b3c4d: not referenced in any index" >&2; exit 1; } ;;
  snapshots)
    id="$(tail -n 1 $R/order)"
    if [[ -z $id ]]; then echo "[]"; else echo "[{\"id\":\"$id\",\"short_id\":\"${id:0:8}\"}]"; fi ;;
  restore)
    target="$(after --target "$@")" include="$(after --include "$@")"
    mkdir -p "$target"
    for file in $R/snapshots/$2/*; do [[ -z $include || /${file##*/} == $include ]] && cp -p "$file" "$target/"; done ;;
  cat) [[ -z ${REPOSITORY_REFUSES:-} ]] || { echo "Fatal: wrong password or no key found" >&2; exit 1; }; echo '{"version":2}' ;;
esac
"""

FLOCK = r"""#!/usr/bin/env bash
# The real flock, with every wait a hundredth as long.
arguments=()
while (($#)); do
  if [[ $1 == -w ]]; then arguments+=(-w "$(($2 / 100))"); shift 2; else arguments+=("$1"); shift; fi
done
exec /usr/bin/flock "${arguments[@]}"
"""

DATE = r"""#!/usr/bin/env bash
# The real date, as many days on as DAYS_LATER says.
exec /usr/bin/date -d "${DAYS_LATER:-0} days" "$@"
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
        for directory in ("tree/deploy", "bin", "world/db", "etc", "state/checkouts"):
            (self.root / directory).mkdir(parents=True)
        for name in SCRIPTS:
            if (HERE / name).exists():
                shutil.copy(HERE / name, self.root / "tree/deploy" / name)
        for name, body in (("docker", DOCKER), ("restic", RESTIC), ("flock", FLOCK), ("date", DATE)):
            (self.root / "bin" / name).write_text(body)
            (self.root / "bin" / name).chmod(0o755)
        self.checkout(REVISION, STACK)
        (self.root / "state/current").write_text(REVISION + "\n")
        (self.root / "etc/production.env").write_text(PRODUCTION_ENV)
        (self.root / "etc/release.json").write_text('{"channel": "production", "repository": "https://github.com/nuanu-ai/agentify.git"}\n')
        (self.root / "etc/backup.env").write_text(BACKUP_ENV)
        self.server({**LIVE, **SCRATCH})

    def tearDown(self):
        # Every run already gives the tree back; this is for one cut short.
        subprocess.run(["docker", "run", "--rm", "-v", f"{self.root}:/h", IMAGE, "chown", "-R", self.owner, "/h"], capture_output=True)
        self.temp.cleanup()

    @property
    def owner(self):
        return f"{os.getuid()}:{os.getgid()}"

    def checkout(self, revision, stack, images=True):
        deploy = self.root / "state/checkouts" / revision / "deploy"
        deploy.mkdir(parents=True)
        (deploy / "stack.sh").write_text(stack)
        (deploy / "stack.sh").chmod(0o755)
        if images:
            (deploy / "images.env").write_text("AGENTIFY_APP_IMAGE=ghcr.io/nuanu-ai/agentify-app@sha256:0\n")

    def server(self, databases):
        shutil.rmtree(self.world / "db")
        for database, tables in databases.items():
            (self.world / "db" / database).mkdir(parents=True)
            for table, rows in tables.items():
                (self.world / "db" / database / table).write_text("".join(row + "\n" for row in rows))

    def run_script(self, script, **environment):
        """Runs a bash script as root in the container, with the fakes first on PATH."""
        # On Linux what root writes into the bind mount stays root's, with the
        # scripts' own modes, so each run ends by giving the tree back to the
        # user running the tests, keeping its modes and the script's status.
        prelude = textwrap.dedent("""\
            trap 'status=$?; chown -R "$OWNER" /h; exit $status' EXIT
            mkdir -p /run/lock /etc/agentify /var/lib/agentify
            ln -s /h/state /var/lib/agentify/production
            install -m 600 /h/etc/production.env /etc/agentify/production.env
            install -m 644 /h/etc/release.json /etc/agentify/release.json
            [[ ! -f /h/etc/backup.env ]] || install -m "${BACKUP_ENV_MODE:-600}" /h/etc/backup.env /etc/agentify/backup.env
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
        return {path.name: path.read_text() for path in sorted((self.world / "repo/snapshots" / snapshot).iterdir())}

    def calls(self, command):
        path = self.world / "calls"
        return [line for line in path.read_text().splitlines() if line.startswith(command)] if path.exists() else []

    def databases(self):
        return sorted(path.name for path in (self.world / "db").iterdir())

    def status(self):
        path = self.root / "state/backup-status"
        return path.read_text() if path.exists() else ""

    # A backup.

    def test_a_backup_stores_every_database_of_the_channel_its_configuration_and_its_row_counts(self):
        said = self.run_script("backup")
        self.assertIn("backup exit 0", said)
        [snapshot] = self.snapshots()
        stored = self.stored(snapshot)
        self.assertEqual(
            sorted(stored),
            ["agentify_commerce.dump", "agentify_scanner.dump", "counts", "production.env", "release.json", "roles.sql"],
        )
        self.assertEqual(stored["production.env"], PRODUCTION_ENV)
        self.assertIn("scan_4", stored["agentify_scanner.dump"])
        # The counts are the dump's own, table by table, empty tables included.
        counts = {tuple(line.split()[:2]): int(line.split()[2]) for line in stored["counts"].splitlines()}
        expected = {(database, table): len(rows) for database, tables in LIVE.items() for table, rows in tables.items()}
        self.assertEqual(counts, expected)
        # Every file of the snapshot is root's alone, as the dumps are on the host.
        modes = {path.stat().st_mode & 0o777 for path in (self.world / "repo/snapshots" / snapshot).iterdir()}
        self.assertEqual(modes, {0o600})

    def test_backup_env_which_opens_the_snapshots_is_never_in_one(self):
        self.assertIn("backup exit 0", self.run_script("backup"))
        [snapshot] = self.snapshots()
        stored = "".join(self.stored(snapshot).values())
        self.assertNotIn(RESTIC_PASSWORD, stored)
        self.assertNotIn(S3_SECRET, stored)
        self.assertIn(DB_PASSWORD, stored)

    def test_the_databases_are_dumped_under_the_release_lock_and_uploaded_after_it_is_released(self):
        # A release never migrates a database halfway through its dump, and a
        # slow upload never holds a release back.
        self.assertIn("backup exit 0", self.run_script("backup"))
        self.assertEqual((self.world / "dumped").read_text().split(), ["agentify_commerce", "held", "agentify_scanner", "held"])
        self.assertEqual((self.world / "uploaded").read_text().split(), ["free"])

    def test_a_success_is_recorded_where_anyone_on_the_host_can_read_it(self):
        self.assertIn("backup exit 0", self.run_script("backup"))
        [snapshot] = self.snapshots()
        self.assertIn(snapshot[:8], self.status())
        self.assertEqual((self.root / "state/backup-status").stat().st_mode & 0o777, 0o644)

    def test_old_snapshots_are_forgotten_every_run_and_pruned_once_a_day(self):
        said = self.run_script("backup\nbackup\nDAYS_LATER=1 backup")
        self.assertEqual(said.count("backup exit 0"), 3, said)
        self.assertEqual(len(self.calls("restic forget")), 3)
        self.assertEqual(len(self.calls("restic prune")), 2)

    # The database list.

    def test_the_database_list_survives_the_merge_into_one_database_named_agentify(self):
        self.server({
            "agentify": {"public.orders": ["ord_1\tpaid"], "public.scans": ["scan_1"]},
            "postgres": {},
            "agentify_replaced_20261001000000": {"public.orders": []},
            "check_agentify": {},
        })
        said = self.run_script("backup")
        self.assertIn("backup exit 0", said)
        [snapshot] = self.snapshots()
        stored = self.stored(snapshot)
        self.assertEqual([name for name in stored if name.endswith(".dump")], ["agentify.dump"])
        self.assertEqual(sorted(stored["counts"].splitlines()), ["agentify public.orders 1", "agentify public.scans 1"])

    def test_a_server_holding_no_database_of_the_channel_is_a_failure_that_stores_nothing(self):
        self.server(SCRATCH)
        said = self.run_script("backup")
        self.assertNotIn("backup exit 0", said)
        self.assertIn("backup:", said)
        self.assertEqual(self.snapshots(), [])

    # Finding the database.

    def test_the_database_is_found_through_a_checkout_that_ran_a_release_whatever_current_names(self):
        # A restore went back to a revision whose checkout is gone, and a
        # release that waited left a newer checkout without images.
        (self.root / "state/current").write_text("b" * 40 + "\n")
        self.checkout("c" * 40, BROKEN_STACK, images=False)
        os.utime(self.root / "state/checkouts" / REVISION, (0, 0))
        said = self.run_script("backup")
        self.assertIn("backup exit 0", said)
        self.assertEqual(len(self.snapshots()), 1)

    def test_no_running_database_is_a_failure_in_words_that_stores_nothing(self):
        said = self.run_script("backup", NO_POSTGRES="1")
        self.assertNotIn("backup exit 0", said)
        self.assertIn("postgres", said)
        self.assertEqual(self.snapshots(), [])

    # Failures.

    def test_a_failed_dump_stores_no_snapshot_and_names_the_step(self):
        said = self.run_script("backup\necho left: $(ls -d /var/tmp/agentify-backup* 2>/dev/null | wc -l)", FAIL_DUMP="agentify_scanner")
        self.assertRegex(said, r"backup exit [1-9]")
        self.assertIn("dumping agentify_scanner", said)
        self.assertEqual((self.snapshots(), self.status()), ([], ""))
        # Nothing of the dump stays behind on the host.
        self.assertIn("left: 0", said)

    def test_a_failed_upload_names_the_step_and_records_no_success(self):
        said = self.run_script("backup", FAIL_UPLOAD="1")
        self.assertRegex(said, r"backup exit [1-9]")
        self.assertIn("uploading", said)
        self.assertEqual(self.status(), "")

    def test_a_failed_forget_fails_the_run_and_says_the_snapshot_is_stored(self):
        said = self.run_script("backup", FAIL_FORGET="1")
        self.assertRegex(said, r"backup exit [1-9]")
        [snapshot] = self.snapshots()
        self.assertIn(snapshot[:8], said)

    def test_a_busy_release_lock_is_waited_for_then_given_up_with_75_and_nothing_dumped(self):
        said = self.run_script("flock /run/lock/agentify-release.lock sleep 8 &\nsleep 1\nSECONDS=0\nbackup\necho waited $SECONDS")
        self.assertIn("backup exit 75", said)
        self.assertGreaterEqual(int(said.split("waited ")[1].split()[0]), 3)
        self.assertFalse((self.world / "dumped").exists())
        self.assertEqual(self.snapshots(), [])

    def test_a_release_lock_freed_within_the_wait_lets_the_backup_go_ahead(self):
        said = self.run_script("flock /run/lock/agentify-release.lock sleep 2 &\nsleep 1\nbackup")
        self.assertIn("backup exit 0", said)
        self.assertEqual(len(self.snapshots()), 1)

    # The door.

    def test_a_backup_env_others_can_read_is_refused_and_nothing_is_dumped(self):
        said = self.run_script("backup", BACKUP_ENV_MODE="644")
        self.assertRegex(said, r"(?m)^backup exit 1$")
        self.assertIn("/etc/agentify/backup.env", said)
        self.assertFalse((self.world / "dumped").exists())

    def test_a_missing_backup_env_is_refused_in_words(self):
        (self.root / "etc/backup.env").unlink()
        said = self.run_script("backup")
        self.assertRegex(said, r"(?m)^backup exit 1$")
        self.assertIn("/etc/agentify/backup.env", said)
        self.assertFalse((self.world / "dumped").exists())

    # The weekly check.

    def scratch_databases(self):
        return [name for name in self.databases() if name.startswith("check_")]

    def live(self):
        return {database: {path.name: path.read_text() for path in sorted((self.world / "db" / database).iterdir())} for database in LIVE}

    def check_line(self):
        return next((line for line in self.status().splitlines() if line.startswith("check ")), "")

    def test_a_check_restores_the_latest_snapshot_whole_and_leaves_no_scratch_database(self):
        before = self.live()
        said = self.run_script("backup\ncheck")
        self.assertIn("check exit 0", said)
        [snapshot] = self.snapshots()
        self.assertIn(snapshot[:8], self.check_line())
        self.assertIn("passed", self.check_line())
        restored = [call for call in self.calls("docker exec -i postgres-1 pg_restore") if " -d " in call]
        self.assertEqual(len(restored), 2, restored)
        # The scratch database a killed check left is gone with its own.
        self.assertEqual(self.scratch_databases(), [])
        self.assertEqual(self.live(), before)
        self.assertEqual((self.root / "state/backup-status").stat().st_mode & 0o777, 0o644)

    def test_a_restore_that_loses_a_row_fails_the_check_and_names_the_table(self):
        said = self.run_script("backup\nLOSE_ROW=public.orders check")
        self.assertRegex(said, r"check exit [1-9]")
        self.assertIn("public.orders", said)
        self.assertIn("failed", self.check_line())
        self.assertEqual(self.scratch_databases(), [])

    def test_a_failed_restore_fails_the_check_names_the_step_and_drops_the_scratch_databases(self):
        said = self.run_script("backup\nFAIL_RESTORE=check_agentify_scanner check")
        self.assertRegex(said, r"check exit [1-9]")
        self.assertIn("agentify_scanner", said)
        self.assertIn("failed", self.check_line())
        self.assertEqual(self.scratch_databases(), [])

    def test_a_check_stopped_by_a_signal_drops_the_scratch_databases(self):
        said = self.run_script("backup\nTERM_AT='-d check_agentify_scanner' check")
        self.assertRegex(said, r"check exit [1-9]")
        self.assertEqual(self.scratch_databases(), [])

    def test_a_repository_that_fails_restics_check_fails_before_anything_is_restored(self):
        said = self.run_script("backup\nCHECK_FAILS=1 check")
        self.assertRegex(said, r"check exit [1-9]")
        self.assertFalse([call for call in self.calls("docker exec -i postgres-1 pg_restore") if " -d " in call])
        self.assertIn("failed", self.check_line())

    def test_a_check_without_room_for_a_second_copy_restores_nothing(self):
        said = self.run_script("backup\nDB_FREE_KB=1000 check")
        self.assertRegex(said, r"check exit [1-9]")
        self.assertIn("MiB free", said)
        self.assertFalse([call for call in self.calls("docker exec -i postgres-1 pg_restore") if " -d " in call])
        self.assertIn("failed", self.check_line())

    def test_a_snapshot_that_recorded_no_row_counts_fails_the_check_in_words(self):
        self.assertIn("backup exit 0", self.run_script("backup"))
        [snapshot] = self.snapshots()
        (self.world / "repo/snapshots" / snapshot / "counts").unlink()
        said = self.run_script("check")
        self.assertRegex(said, r"check exit [1-9]")
        self.assertIn("counts", said)
        self.assertIn("failed", self.check_line())

    def test_a_repository_without_a_snapshot_fails_the_check_in_words(self):
        said = self.run_script("check")
        self.assertRegex(said, r"check exit [1-9]")
        self.assertIn("no snapshot", said)

    def test_the_check_restores_the_one_database_the_merge_leaves(self):
        self.server({"agentify": {"public.orders": ["ord_1\tpaid"], "public.scans": ["scan_1", "scan_2"]}, "postgres": {}})
        said = self.run_script("backup\ncheck")
        self.assertIn("check exit 0", said)
        self.assertEqual(self.databases(), ["agentify", "postgres"])

    # Putting the S3 key on the host.

    def credentials(self, lines, **environment):
        """Pipes the lines into the credentials command, then reads backup.env the way the backup does."""
        said = self.run_script(
            f"printf '%s' {lines!r} | /h/tree/deploy/backup-credentials.sh --stdin; echo \"credentials exit $?\"\n"
            "stat -c '%U %a' /etc/agentify/backup.env > /h/world/mode\n"
            "(set -a; . /etc/agentify/backup.env; env) | grep -E '^(RESTIC|AWS)_' | sort > /h/world/values",
            **environment,
        )
        values = dict(line.split("=", 1) for line in (self.world / "values").read_text().splitlines())
        return said, values, (self.world / "mode").read_text().strip()

    def test_a_new_key_replaces_the_old_one_and_the_rest_of_backup_env_stays(self):
        said, values, mode = self.credentials("  NEWKEYID0123 \nnew-secret/with+signs=\n")
        self.assertIn("credentials exit 0", said)
        self.assertEqual(values["AWS_ACCESS_KEY_ID"], "NEWKEYID0123")
        self.assertEqual(values["AWS_SECRET_ACCESS_KEY"], "new-secret/with+signs=")
        self.assertEqual(values["RESTIC_PASSWORD"], RESTIC_PASSWORD)
        self.assertEqual(values["RESTIC_REPOSITORY"], "s3:https://fsn1.your-objectstorage.com/nuanu-agentify-backups")
        self.assertEqual(mode, "root 600")
        self.assertNotIn("new-secret", said)
        self.assertNotIn(RESTIC_PASSWORD, said)

    def test_a_key_the_repository_does_not_open_with_leaves_backup_env_as_it_was(self):
        said, values, mode = self.credentials("NEWKEYID0123\nnew-secret\n", REPOSITORY_REFUSES="1")
        self.assertRegex(said, r"(?m)^credentials exit 1$")
        self.assertEqual((values["AWS_ACCESS_KEY_ID"], values["AWS_SECRET_ACCESS_KEY"]), ("V0VVEXAMPLEKEY", S3_SECRET))

    def test_a_new_host_is_asked_for_the_repository_password_too(self):
        (self.root / "etc/backup.env").unlink()
        said, values, mode = self.credentials("NEWKEYID0123\nnew-secret\nthe password from 1Password\n")
        self.assertIn("credentials exit 0", said)
        self.assertEqual(values["RESTIC_PASSWORD"], "the password from 1Password")
        self.assertEqual(values["RESTIC_REPOSITORY"], "s3:https://fsn1.your-objectstorage.com/nuanu-agentify-backups")
        self.assertEqual(values["AWS_DEFAULT_REGION"], "fsn1")
        self.assertEqual(mode, "root 600")

    def test_a_value_copied_twice_or_not_at_all_is_refused_and_nothing_changes(self):
        for lines in ("SAMEVALUE\nSAMEVALUE\n", "\nnew-secret\n", "NEWKEYID0123\nnew secret\n"):
            said, values, _ = self.credentials(lines)
            self.assertRegex(said, r"(?m)^credentials exit 1$", lines)
            self.assertEqual(values["AWS_SECRET_ACCESS_KEY"], S3_SECRET, lines)

    def test_nothing_typed_or_pasted_at_its_prompts_reaches_the_screen(self):
        # Run on a terminal, as `ssh -t agentify sudo agentify-backup-credentials`
        # runs it, with each value answered once its prompt has appeared.
        (self.root / "pty.py").write_text(textwrap.dedent("""\
            import os, pty, select, time
            pid, fd = pty.fork()
            if pid == 0:
                os.execv("/h/tree/deploy/backup-credentials.sh", ["backup-credentials.sh"])
            screen = b""
            def more(wait):
                global screen
                while select.select([fd], [], [], wait)[0]:
                    try:
                        chunk = os.read(fd, 1024)
                    except OSError:
                        return
                    if not chunk:
                        return
                    screen += chunk
                    wait = 0.3
            for answer in (b"PTYKEYID0123\\n", b"pty-secret-value\\n"):
                more(10)
                os.write(fd, answer)
            more(10)
            _, status = os.waitpid(pid, 0)
            print(screen.decode(errors="replace"))
            print("pty exit", os.waitstatus_to_exitcode(status))
            """))
        said = self.run_script(
            "python3 /h/pty.py\n(set -a; . /etc/agentify/backup.env; env) | grep -E '^AWS_' | sort > /h/world/values"
        )
        self.assertIn("pty exit 0", said)
        self.assertNotIn("pty-secret-value", said)
        self.assertNotIn("PTYKEYID0123", said)
        self.assertIn("AWS_SECRET_ACCESS_KEY=pty-secret-value", (self.world / "values").read_text())


if __name__ == "__main__":
    unittest.main()
