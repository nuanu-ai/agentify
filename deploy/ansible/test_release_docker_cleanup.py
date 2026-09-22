import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("release-docker-cleanup.py")
SPEC = importlib.util.spec_from_file_location("release_docker_cleanup", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class FakeDocker:
    def __init__(self, images, containers, free_bytes):
        self.images = images
        self.containers = containers
        self.free_bytes = free_bytes
        self.removed_tags = []
        self.cache_limits = []

    def snapshot(self):
        return self.images, self.containers

    def remove_tag(self, tag):
        self.removed_tags.append(tag)

    def prune_build_cache(self):
        self.cache_limits.append("all")

    def disk_free_bytes(self):
        return self.free_bytes


def image(image_id, tags, revision=None):
    labels = {}
    if revision is not None:
        labels["org.opencontainers.image.revision"] = revision
    return {"Id": image_id, "RepoTags": tags, "Config": {"Labels": labels}}


def container(image_id, reference, running):
    return {
        "Image": image_id,
        "Config": {"Image": reference},
        "State": {"Running": running},
    }


class ReleaseDockerCleanupTests(unittest.TestCase):
    def setUp(self):
        self.running = "a" * 40
        self.candidate = "b" * 40
        self.old = "c" * 40

    def test_removes_only_unreferenced_old_release_tags(self):
        images = [
            image("sha256:running", [f"agentify-commerce-app:{self.running}"], self.running),
            image("sha256:privacy", [f"agentify-scanner-privacy:{self.running}"], self.running),
            image("sha256:candidate", [f"agentify-commerce-web:{self.candidate}"], self.candidate),
            image("sha256:old", [f"agentify-scanner-worker:{self.old}"], self.old),
            image("sha256:infra", ["postgres:17-alpine"]),
        ]
        containers = [
            container(
                "sha256:running",
                f"agentify-commerce-app:{self.running}",
                True,
            )
        ]
        docker = FakeDocker(images, containers, 30 * MODULE.GIBIBYTE)

        result = MODULE.cleanup(docker, self.candidate, 30)

        self.assertEqual(docker.removed_tags, [f"agentify-scanner-worker:{self.old}"])
        self.assertEqual(docker.cache_limits, ["all"])
        self.assertEqual(
            result["protectedRevisions"],
            [self.running, self.candidate],
        )

    def test_keeps_old_image_referenced_by_an_exited_container(self):
        old_tag = f"agentify-commerce-app:{self.old}"
        docker = FakeDocker(
            [image("sha256:old", [old_tag], self.old)],
            [container("sha256:old", old_tag, False)],
            30 * MODULE.GIBIBYTE,
        )

        result = MODULE.cleanup(docker, self.candidate, 30)

        self.assertEqual(docker.removed_tags, [])
        self.assertEqual(result["blockedTags"], [old_tag])

    def test_keeps_the_revision_pinned_by_installed_scheduled_jobs(self):
        scheduled_tag = f"agentify-scanner-privacy:{self.old}"
        docker = FakeDocker(
            [image("sha256:privacy", [scheduled_tag], self.old)],
            [],
            30 * MODULE.GIBIBYTE,
        )

        result = MODULE.cleanup(docker, self.candidate, 30, [self.old])

        self.assertEqual(docker.removed_tags, [])
        self.assertEqual(
            result["protectedRevisions"],
            [self.candidate, self.old],
        )

    def test_reads_the_exact_revision_from_the_installed_job(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scanner-jobs.sh"
            path.write_text(
                "cd '/home/dmitry/agentify-releases/"
                + self.running
                + "/source/ops/deploy/droplet'\n"
            )

            self.assertEqual(MODULE.installed_job_revision(path), self.running)

    def test_refuses_to_build_when_cleanup_cannot_restore_the_space_floor(self):
        docker = FakeDocker([], [], 19 * MODULE.GIBIBYTE)

        with self.assertRaisesRegex(
            MODULE.CleanupError,
            "at least 30 GiB of free space",
        ):
            MODULE.cleanup(docker, self.candidate, 30)

    def test_rejects_a_non_commit_candidate_before_touching_docker(self):
        docker = FakeDocker([], [], 30 * MODULE.GIBIBYTE)

        with self.assertRaisesRegex(MODULE.CleanupError, "40-character commit"):
            MODULE.cleanup(docker, "deploy-test", 30)

        self.assertEqual(docker.cache_limits, [])


if __name__ == "__main__":
    unittest.main()
