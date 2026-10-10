"""One scratch container for a class of deploy tests.

The deploy scripts run as root against host paths, so the tests run them in a
throwaway Linux container. Starting one is what costs: on a Mac, Docker
Desktop spends about half a second and three to four cores on each, and these
tests used to start two per test, one to run the script and one to give the
files back afterwards, some 240 for the suite and minutes of four cores. A
class now starts one container, and each test runs its script in it with
`docker exec`, which starts a process rather than a container.

Each run still finds the container as a new one would be: before the script,
whatever an earlier run left running is killed and the paths the scripts and
the tests' preludes write outside the mounted directory are removed. The
mounted directory is the test's own and is emptied once per test, from inside
and as root, so a file a script left root's and unreadable is no obstacle.
"""

from pathlib import Path
import shutil
import subprocess
import tempfile


IMAGE = "python:3.12-slim-bookworm"

# What a new container would not have: an earlier run's processes, and what the
# scripts and the preludes write outside /h.
AS_NEW = r"""
for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  [[ $pid == 1 || $pid == $$ ]] || kill -KILL "$pid" 2>/dev/null
done
rm -rf /etc/agentify /var/lib/agentify /var/backups/agentify /etc/cron.d/agentify-release \
  /etc/systemd/system/agentify* /usr/local/sbin/* /run/lock/* /tmp/*
"""


def container_available():
    try:
        return subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True).returncode == 0 or (
            subprocess.run(["docker", "pull", "-q", IMAGE], capture_output=True).returncode == 0
        )
    except FileNotFoundError:
        return False


class ScratchContainer:
    """A container with a scratch directory of the host mounted at /h."""

    def __init__(self, purpose):
        if not container_available():
            raise RuntimeError(f"these tests run {purpose} in a {IMAGE} container, and Docker is not available here")
        self.root = Path(tempfile.mkdtemp())
        started = subprocess.run(
            ["docker", "run", "-d", "--rm", "--network", "none", "-v", f"{self.root}:/h", IMAGE, "sleep", "infinity"],
            capture_output=True, text=True, check=True,
        )
        self.id = started.stdout.strip()

    def fresh(self):
        """Empties the scratch directory for the next test, and returns it."""
        self.run("rm -rf /h/* /h/.[!.]*", timeout=60)
        return self.root

    def run(self, script, environment=None, timeout=240):
        """Runs a bash script as root in the container as a new one, and returns both streams."""
        options = [f"--env={key}={value}" for key, value in (environment or {}).items()]
        result = subprocess.run(
            ["docker", "exec", *options, self.id, "bash", "-c", AS_NEW + script],
            capture_output=True, text=True, timeout=timeout,
        )
        return result.stdout + result.stderr

    def stop(self):
        self.fresh()
        subprocess.run(["docker", "rm", "-f", self.id], capture_output=True)
        shutil.rmtree(self.root, ignore_errors=True)
