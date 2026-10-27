"""Disposable PostgreSQL for deploy scripts' SQL/data guarantees. No host ports are exposed."""

from pathlib import Path
import subprocess
import time


class RealPostgres:
    def __init__(self, mounts=()):
        volumes = [argument for source, target in mounts for argument in ("--volume", f"{Path(source).resolve()}:{target}:ro")]
        self.id = subprocess.run(
            ["docker", "run", "--detach", "--rm", "--env", "POSTGRES_USER=agentify", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_DB=agentify", *volumes, "postgres:17"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        try:
            for _ in range(150):
                if self.execute("pg_isready", "-h", "127.0.0.1", "-U", "agentify", check=False).returncode == 0:
                    return
                time.sleep(.1)
            raise RuntimeError("the disposable PostgreSQL did not start")
        except BaseException:
            self.close()
            raise

    def execute(self, *argv, input=None, check=True):
        return subprocess.run(["docker", "exec", "-i", self.id, *argv], input=input, capture_output=True, text=True, check=check, timeout=90)

    def sql(self, statement, database="postgres", check=True):
        return self.execute("psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "agentify", "-d", database, input=statement, check=check)

    def close(self):
        subprocess.run(["docker", "rm", "--force", self.id], capture_output=True, check=True)
