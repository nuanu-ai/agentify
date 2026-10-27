"""The shipped backup/check commands restore actual PostgreSQL through actual local restic.

Docker's process selection is adapted to the single disposable server; database
commands, dumps, snapshot selection and restores all run as shipped. Restic's
fixed image supplies its binary. No bucket or external database is contacted.
"""

import json
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from real_postgres import RealPostgres  # noqa: E402

HERE = Path(__file__).parent
RESTIC = "restic/restic:0.18.1"

# Record the real restored rows immediately before the shipped cleanup drops them.
DOCKER = r'''#!/usr/bin/env bash
set -euo pipefail
if [[ $1 == ps ]]; then echo the-disposable-server; exit 0; fi
[[ $1 == exec ]]; shift
[[ $1 != -i ]] || shift
shift
if [[ $1 == psql && "${*: -1}" == "DROP DATABASE check_agentify WITH (FORCE)" ]]; then
  psql -XAtq -U agentify -d check_agentify -c 'SELECT id FROM public.orders ORDER BY id' > /audit/restored-rows
fi
exec "$@"
'''


class ActualBackupData(unittest.TestCase):
    def test_latest_of_two_snapshots_restores_its_contents_and_drops_scratch(self):
        database = RealPostgres([(HERE, "/deployment")])
        try:
            if subprocess.run(["docker", "image", "inspect", RESTIC], capture_output=True).returncode:
                subprocess.run(["docker", "pull", RESTIC], check=True, capture_output=True)
            binary = subprocess.run(["docker", "run", "--rm", "--entrypoint", "cat", RESTIC, "/usr/bin/restic"], capture_output=True, check=True).stdout
            subprocess.run(["docker", "exec", "-i", database.id, "sh", "-c", "cat > /usr/local/bin/restic; chmod +x /usr/local/bin/restic"], input=binary, capture_output=True, check=True)
            database.execute("bash", "-c", "mkdir -p /audit /etc/agentify /var/lib/agentify/production /run/lock; printf 'RESTIC_REPOSITORY=/audit/repository\\nRESTIC_PASSWORD=disposable-local-only\\n' > /etc/agentify/backup.env; printf 'test-fixture=true\\n' > /etc/agentify/production.env; printf '{}' > /etc/agentify/release.json")
            database.execute("bash", "-c", "cat > /usr/local/bin/docker; chmod +x /usr/local/bin/docker", input=DOCKER)
            database.execute("bash", "-c", "set -a; . /etc/agentify/backup.env; restic init")
            database.sql("CREATE TABLE public.orders(id text PRIMARY KEY); INSERT INTO public.orders VALUES ('before');", "agentify")
            database.execute("bash", "/deployment/backup.sh")
            database.sql("INSERT INTO public.orders VALUES ('latest');", "agentify")
            database.execute("bash", "/deployment/backup.sh")
            snapshots = json.loads(database.execute("bash", "-c", "set -a; . /etc/agentify/backup.env; restic snapshots --json").stdout)
            self.assertEqual(len(snapshots), 2)
            latest = max(snapshots, key=lambda snapshot: snapshot["time"])["short_id"]
            database.sql("INSERT INTO public.orders VALUES ('after-snapshots');", "agentify")
            result = database.execute("bash", "/deployment/backup-check.sh")
            self.assertIn(f"snapshot {latest} restored", result.stdout)
            self.assertEqual(database.execute("cat", "/audit/restored-rows").stdout.splitlines(), ["before", "latest"])
            self.assertEqual(database.sql("SELECT id FROM public.orders ORDER BY id", "agentify").stdout.splitlines(), ["after-snapshots", "before", "latest"])
            self.assertEqual(database.sql("SELECT datname FROM pg_database WHERE datname LIKE 'check_%'").stdout, "")
        finally:
            database.close()


if __name__ == "__main__":
    unittest.main()
