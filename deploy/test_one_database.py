"""What the one-time move to one database does to the data (deploy/one-database-move.sh).

Unlike the other deploy tests, nothing here is a fake: each test starts the
PostgreSQL image the channels run, pinned in deploy/compose.images.yaml, with
no port and a name of its own, gives it the two databases a host has — the
scanner's tables, its migration history, its queue, a policy and a grant for
a retired role, a metabase view — and runs the script inside it the way
deploy/one-database.sh does. The host half, Docker volumes and Compose
projects, is proved by a rehearsal on real stacks instead (deploy/README.md).
It needs Docker, and pulls the image the first time.
"""

from pathlib import Path
import re
import subprocess
import unittest


HERE = Path(__file__).parent
IMAGE = re.search(r"image: (docker\.io/library/postgres@sha256:[0-9a-f]{64})", (HERE / "compose.images.yaml").read_text())[1]
SCRIPT = (HERE / "one-database-move.sh").read_text()
ROLES = ("agentify_web", "agentify_worker", "agentify_privacy", "agentify_dashboard")

SCANNER = r"""
CREATE TYPE public.scan_status AS ENUM ('queued', 'completed');
CREATE TABLE public.scans (id uuid PRIMARY KEY, target text NOT NULL, status public.scan_status NOT NULL, report jsonb);
CREATE TABLE public.scan_checks (scan_id uuid REFERENCES public.scans (id) ON DELETE CASCADE, check_id integer, result text,
  PRIMARY KEY (scan_id, check_id));
CREATE INDEX scans_target_idx ON public.scans (target);
ALTER TABLE public.scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY agentify_web_service ON public.scans TO agentify_web USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON public.scans TO agentify_web, agentify_worker;
INSERT INTO public.scans VALUES
  ('0190a000-0000-7000-8000-000000000001', 'https://shop.example', 'completed', '{"score": 71, "note": "two\nlines"}'),
  ('0190a000-0000-7000-8000-000000000002', 'https://тест.example', 'queued', NULL);
INSERT INTO public.scan_checks VALUES
  ('0190a000-0000-7000-8000-000000000001', 1, 'pass'), ('0190a000-0000-7000-8000-000000000001', 2, NULL);
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('a1', 1780000000000), ('b2', 1790000000000), ('c3', 1790400000000);
CREATE SCHEMA pgboss;
CREATE TABLE pgboss.job (id serial PRIMARY KEY, name text, state text);
INSERT INTO pgboss.job (name, state) VALUES ('scan-v1', 'completed'), ('browser-observation-v1', 'failed');
CREATE SCHEMA metabase;
CREATE VIEW metabase.scan_health WITH (security_barrier = true) AS SELECT status, count(*) FROM public.scans GROUP BY 1;
GRANT USAGE ON SCHEMA metabase TO agentify_dashboard;
GRANT SELECT ON metabase.scan_health TO agentify_dashboard;
"""

COMMERCE = r"""
CREATE TABLE public.orders (id text PRIMARY KEY, total numeric NOT NULL);
INSERT INTO public.orders VALUES ('ord_1', 12.50), ('ord_2', 3);
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('g1', 1785000000000), ('g2', 1790100000000);
CREATE TABLE drizzle.cabinet_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
INSERT INTO drizzle.cabinet_migrations (hash, created_at) VALUES ('k1', 1786000000000);
CREATE SCHEMA pgboss;
CREATE TABLE pgboss.job (id serial PRIMARY KEY, name text, state text);
INSERT INTO pgboss.job (name, state) VALUES ('agentify_envelopes', 'created');
"""


def docker_available():
    try:
        return subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True).returncode == 0 or (
            subprocess.run(["docker", "pull", "-q", IMAGE], capture_output=True).returncode == 0
        )
    except FileNotFoundError:
        return False


class TheMove(unittest.TestCase):
    count = 0

    @classmethod
    def setUpClass(cls):
        if not docker_available():
            raise RuntimeError(f"these tests run {IMAGE} in Docker, and Docker is not available here")

    def setUp(self):
        TheMove.count += 1
        self.name = f"one-database-test-{id(self)}-{TheMove.count}"
        subprocess.run(["docker", "run", "-d", "--name", self.name, "--network", "none",
                        "-e", "POSTGRES_USER=agentify_commerce", "-e", "POSTGRES_PASSWORD=unused-here",
                        "-e", "POSTGRES_DB=agentify_commerce", IMAGE], check=True, capture_output=True)
        self.addCleanup(subprocess.run, ["docker", "rm", "-f", "-v", self.name], capture_output=True)
        for _ in range(120):
            logs = subprocess.run(["docker", "logs", self.name], capture_output=True, text=True)
            if "init process complete" in logs.stdout + logs.stderr and self.ready():
                break
            subprocess.run(["sleep", "0.25"])
        else:
            self.fail(f"{self.name} did not start")
        self.sql("postgres", "".join(f"CREATE ROLE {role} LOGIN;" for role in ROLES) + "CREATE DATABASE agentify_scanner;")
        # The test suites' scratch database under the old name, as the hosts have it.
        self.sql("postgres", "CREATE DATABASE agentify_commerce_test;")
        self.sql("agentify_scanner", SCANNER)
        self.sql("agentify_commerce", COMMERCE)

    def ready(self):
        return subprocess.run(["docker", "exec", self.name, "psql", "-U", "agentify_commerce", "-d", "postgres", "-c", "select 1"],
                              capture_output=True).returncode == 0

    def sql(self, database, statements, role="agentify_commerce"):
        result = subprocess.run(["docker", "exec", "-i", self.name, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1",
                                 "-U", role, "-d", database], input=statements, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def run_move(self, *arguments):
        return subprocess.run(["docker", "exec", "-i", self.name, "sh", "-s", "--", *arguments],
                              input=SCRIPT, capture_output=True, text=True)

    def rows(self, database, table, role="agentify_commerce"):
        return self.sql(database, f"COPY (SELECT * FROM {table} ORDER BY 1, 2) TO STDOUT;", role)

    def test_the_move_keeps_every_row_and_the_history_and_leaves_the_old_roles_behind(self):
        before = {table: self.rows("agentify_scanner", table) for table in ("public.scans", "public.scan_checks")}
        history = self.rows("agentify_scanner", "drizzle.__drizzle_migrations")
        orders = self.rows("agentify_commerce", "public.orders")
        moved = self.run_move("move")
        self.assertEqual(moved.returncode, 0, moved.stderr)
        for table, rows in before.items():
            self.assertEqual(self.rows("agentify_commerce", table), rows, table)
        self.assertEqual(self.rows("agentify_commerce", "drizzle.scanner_migrations"), history)
        self.assertEqual(self.rows("agentify_commerce", "public.orders"), orders)
        self.assertEqual(self.sql("agentify_commerce", "SELECT string_agg(hash, ' ' ORDER BY id) FROM drizzle.__drizzle_migrations"), "g1 g2")
        # What drizzle's migrator writes next continues the copied history.
        self.assertEqual(self.sql("agentify_commerce", "SELECT nextval('drizzle.scanner_migrations_id_seq')"), "4")
        self.assertEqual(self.sql("agentify_commerce", "SELECT count(*) FROM pg_policies"), "0")
        self.assertEqual(self.sql("agentify_commerce", "SELECT count(*) FROM information_schema.role_table_grants "
                                                       "WHERE grantee IN ('agentify_web', 'agentify_worker')"), "0")
        self.assertEqual(self.sql("agentify_commerce", "SELECT string_agg(relname || ':' || relrowsecurity || relforcerowsecurity, ' ' ORDER BY relname) "
                                                       "FROM pg_class WHERE relname IN ('scans', 'scan_checks')"), "scan_checks:truetrue scans:truefalse")
        self.assertEqual(self.sql("agentify_commerce", "SELECT count(*) FROM public.scans WHERE target LIKE '%shop%'"), "1")
        self.assertEqual(self.sql("agentify_commerce", "SELECT to_regclass('pgboss.job') IS NOT NULL AND "
                                                       "(SELECT count(*) FROM pgboss.job WHERE name LIKE 'scan%') = 0"), "t")
        again = self.run_move("move")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(self.rows("agentify_commerce", "public.scans"), before["public.scans"])

    def test_the_fingerprints_change_with_one_row(self):
        printed = self.run_move("fingerprints", "agentify_scanner")
        self.assertEqual(printed.returncode, 0, printed.stderr)
        self.assertIn("public.scans|2|", printed.stdout)
        self.sql("agentify_scanner", "UPDATE public.scan_checks SET result = 'fail' WHERE check_id = 2;")
        changed = self.run_move("fingerprints", "agentify_scanner").stdout
        self.assertEqual(
            sorted(set(printed.stdout.splitlines()) ^ set(changed.splitlines()))[0].split("|")[0], "public.scan_checks")
        self.assertEqual(len(set(printed.stdout.splitlines()) ^ set(changed.splitlines())), 2)

    def test_finish_leaves_one_database_reached_by_one_account_with_its_password(self):
        secret = self.sql("postgres", "SELECT rolpassword FROM pg_authid WHERE rolname = 'agentify_commerce'")
        self.assertEqual(self.run_move("move").returncode, 0)
        finished = self.run_move("finish")
        self.assertEqual(finished.returncode, 0, finished.stderr)
        self.assertEqual(self.sql("postgres", "SELECT string_agg(datname, ' ' ORDER BY datname) FROM pg_database WHERE NOT datistemplate", "agentify"),
                         "agentify postgres")
        self.assertEqual(self.sql("postgres", "SELECT string_agg(rolname, ' ') FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%'", "agentify"), "agentify")
        self.assertEqual(self.sql("postgres", "SELECT rolpassword FROM pg_authid WHERE rolname = 'agentify'", "agentify"), secret)
        self.assertEqual(self.sql("agentify", "SELECT count(*) FROM public.scans", "agentify"), "2")
        again = self.run_move("finish")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(self.run_move("move").returncode, 0)

    def test_refuses_while_the_scanner_queue_holds_unfinished_work(self):
        for state in ("created", "retry", "active"):
            with self.subTest(state=state):
                self.sql("agentify_scanner", f"UPDATE pgboss.job SET state = '{state}' WHERE name = 'scan-v1';")
                refused = self.run_move("move")
                self.assertEqual(refused.returncode, 1)
                self.assertIn("1 unfinished jobs", refused.stderr)
                self.assertEqual(self.sql("agentify_commerce", "SELECT to_regclass('public.scans') IS NULL AND to_regclass('drizzle.scanner_migrations') IS NULL"), "t")

    def test_refuses_a_name_the_one_database_already_has(self):
        self.sql("agentify_commerce", "CREATE TABLE public.scan_checks (id integer);")
        refused = self.run_move("move")
        self.assertEqual(refused.returncode, 1)
        self.assertIn("scan_checks", refused.stderr)
        self.assertEqual(self.sql("agentify_commerce", "SELECT to_regclass('public.scans') IS NULL AND to_regclass('drizzle.scanner_migrations') IS NULL"), "t")

    def test_refuses_while_anything_is_connected_to_the_scanner_database(self):
        subprocess.run(["docker", "exec", "-d", self.name, "psql", "-U", "agentify_commerce", "-d", "agentify_scanner", "-c", "SELECT pg_sleep(60)"], check=True)
        for _ in range(40):
            if self.sql("postgres", "SELECT count(*) FROM pg_stat_activity WHERE datname = 'agentify_scanner'") == "1":
                break
            subprocess.run(["sleep", "0.25"])
        refused = self.run_move("move")
        self.assertEqual(refused.returncode, 1)
        self.assertIn("connected to agentify_scanner", refused.stderr)

    def test_a_move_that_fails_partway_leaves_nothing_and_the_next_run_moves_everything(self):
        self.sql("agentify_commerce", "ALTER SCHEMA drizzle RENAME TO drizzle_elsewhere;")
        failed = self.run_move("move")
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(self.sql("agentify_commerce", "SELECT to_regclass('public.scans') IS NULL"), "t")
        self.sql("agentify_commerce", "ALTER SCHEMA drizzle_elsewhere RENAME TO drizzle;")
        moved = self.run_move("move")
        self.assertEqual(moved.returncode, 0, moved.stderr)
        self.assertEqual(self.sql("agentify_commerce", "SELECT count(*) FROM public.scan_checks"), "2")

    def test_finish_before_the_move_drops_nothing(self):
        refused = self.run_move("finish")
        self.assertEqual(refused.returncode, 1)
        self.assertIn("only copy", refused.stderr)
        self.assertEqual(self.sql("postgres", "SELECT count(*) FROM pg_database WHERE datname IN ('agentify_scanner', 'agentify_commerce', 'agentify_commerce_test')"), "3")
        self.assertEqual(self.sql("postgres", f"SELECT count(*) FROM pg_roles WHERE rolname IN {ROLES}"), "4")


if __name__ == "__main__":
    unittest.main()
