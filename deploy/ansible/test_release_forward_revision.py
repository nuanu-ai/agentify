import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("check-forward-revision.sh")


class ForwardRevisionTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.repository = Path(self.temporary.name)
        subprocess.run(["git", "init", "-q", "-b", "main", self.repository], check=True)
        subprocess.run(["git", "-C", self.repository, "config", "user.name", "Test"], check=True)
        subprocess.run(["git", "-C", self.repository, "config", "user.email", "test@example.test"], check=True)
        self.revisions = []
        for number in range(3):
            (self.repository / "state").write_text(str(number))
            subprocess.run(["git", "-C", self.repository, "add", "state"], check=True)
            subprocess.run(["git", "-C", self.repository, "commit", "-qm", f"state {number}"], check=True)
            self.revisions.append(
                subprocess.check_output(["git", "-C", self.repository, "rev-parse", "HEAD"], text=True).strip()
            )

    def tearDown(self):
        self.temporary.cleanup()

    def check(self, running, candidate):
        return subprocess.run(
            ["bash", SCRIPT, self.repository, running, candidate],
            capture_output=True,
            text=True,
        )

    def test_accepts_equal_or_forward_candidate(self):
        self.assertEqual(self.check(self.revisions[0], self.revisions[0]).returncode, 0)
        self.assertEqual(self.check(self.revisions[0], self.revisions[2]).returncode, 0)

    def test_refuses_candidate_older_than_running_revision(self):
        result = self.check(self.revisions[2], self.revisions[1])

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("older than or diverges", result.stderr)
        self.assertIn("manual recovery", result.stderr)

    def test_refuses_invalid_running_revision(self):
        result = self.check("missing", self.revisions[2])

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("full Git SHA", result.stderr)


if __name__ == "__main__":
    unittest.main()
