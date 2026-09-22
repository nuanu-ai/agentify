#!/usr/bin/env python3
"""Bound Docker release storage without touching containers or volumes."""

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


GIBIBYTE = 1024**3
COMMIT = re.compile(r"^[0-9a-f]{40}$")
FIRST_PARTY_REPOSITORIES = (
    "agentify-commerce-app",
    "agentify-commerce-web",
    "agentify-scanner",
    "agentify-scanner-worker",
    "agentify-scanner-privacy",
)


class CleanupError(RuntimeError):
    pass


def release_revision(reference):
    if not isinstance(reference, str):
        return None
    for repository in FIRST_PARTY_REPOSITORIES:
        prefix = repository + ":"
        if reference.startswith(prefix):
            candidate = reference[len(prefix) :]
            return candidate if COMMIT.fullmatch(candidate) else None
    return None


def image_revisions(image):
    revisions = {
        revision
        for tag in image.get("RepoTags") or []
        if (revision := release_revision(tag)) is not None
    }
    labels = (image.get("Config") or {}).get("Labels") or {}
    labelled = labels.get("org.opencontainers.image.revision")
    if COMMIT.fullmatch(labelled or ""):
        revisions.add(labelled)
    return revisions


def installed_job_revision(path):
    job = Path(path)
    if not job.exists():
        return None
    matches = set(
        re.findall(r"/agentify-releases/([0-9a-f]{40})/source(?:/|')", job.read_text())
    )
    if len(matches) != 1:
        raise CleanupError(
            "The installed scanner job does not name exactly one full release revision"
        )
    return matches.pop()


def cleanup(
    docker,
    candidate_revision,
    minimum_free_gib,
    additional_protected_revisions=(),
):
    if not COMMIT.fullmatch(candidate_revision):
        raise CleanupError("The release candidate must be a 40-character commit SHA")
    if minimum_free_gib <= 0:
        raise CleanupError("The Docker free-space floor must be positive")

    images, containers = docker.snapshot()
    images_by_id = {image["Id"]: image for image in images}
    protected_revisions = {candidate_revision, *additional_protected_revisions}
    if not all(COMMIT.fullmatch(revision) for revision in protected_revisions):
        raise CleanupError("Every protected release must be a 40-character commit SHA")
    referenced_image_ids = {container["Image"] for container in containers}

    for container in containers:
        if not (container.get("State") or {}).get("Running"):
            continue
        image = images_by_id.get(container["Image"], {})
        references = [
            (container.get("Config") or {}).get("Image"),
            *(image.get("RepoTags") or []),
        ]
        is_first_party = any(
            isinstance(reference, str)
            and any(reference.startswith(repository + ":") for repository in FIRST_PARTY_REPOSITORIES)
            for reference in references
        )
        if not is_first_party:
            continue
        revisions = image_revisions(image)
        direct_revision = release_revision(references[0])
        if direct_revision is not None:
            revisions.add(direct_revision)
        if not revisions:
            raise CleanupError(
                "A running Agentify container has no trustworthy source revision; refusing cleanup"
            )
        protected_revisions.update(revisions)

    removable_tags = []
    blocked_tags = []
    ignored_tags = []
    for image in images:
        for tag in image.get("RepoTags") or []:
            if not any(tag.startswith(repository + ":") for repository in FIRST_PARTY_REPOSITORIES):
                continue
            revision = release_revision(tag)
            if revision is None:
                ignored_tags.append(tag)
            elif revision in protected_revisions:
                continue
            elif image["Id"] in referenced_image_ids:
                blocked_tags.append(tag)
            else:
                removable_tags.append(tag)

    for tag in sorted(removable_tags):
        docker.remove_tag(tag)
    docker.prune_build_cache()

    free_bytes = docker.disk_free_bytes()
    minimum_free_bytes = minimum_free_gib * GIBIBYTE
    if free_bytes < minimum_free_bytes:
        raise CleanupError(
            f"Docker storage has {free_bytes / GIBIBYTE:.1f} GiB free after cleanup; "
            f"at least {minimum_free_gib} GiB of free space is required before a release build"
        )

    return {
        "blockedTags": sorted(blocked_tags),
        "freeBytes": free_bytes,
        "ignoredTags": sorted(ignored_tags),
        "minimumFreeBytes": minimum_free_bytes,
        "protectedRevisions": sorted(protected_revisions),
        "removedTags": sorted(removable_tags),
    }


class DockerCLI:
    @staticmethod
    def _output(argv):
        return subprocess.check_output(argv, text=True).strip()

    def snapshot(self):
        image_ids = sorted(
            set(self._output(["docker", "image", "ls", "--quiet", "--no-trunc"]).splitlines())
        )
        container_ids = self._output(
            ["docker", "container", "ls", "--all", "--quiet", "--no-trunc"]
        ).splitlines()
        images = (
            json.loads(self._output(["docker", "image", "inspect", *image_ids]))
            if image_ids
            else []
        )
        containers = (
            json.loads(self._output(["docker", "container", "inspect", *container_ids]))
            if container_ids
            else []
        )
        return images, containers

    @staticmethod
    def remove_tag(tag):
        subprocess.run(
            ["docker", "image", "rm", tag],
            check=True,
            stdout=subprocess.DEVNULL,
        )

    @staticmethod
    def prune_build_cache():
        subprocess.run(
            ["docker", "builder", "prune", "--force", "--all"],
            check=True,
            stdout=subprocess.DEVNULL,
        )

    def disk_free_bytes(self):
        docker_root = self._output(["docker", "info", "--format", "{{.DockerRootDir}}"])
        if not docker_root.startswith("/") or docker_root == "/":
            raise CleanupError("Docker reported an unsafe storage root")
        return shutil.disk_usage(docker_root).free


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("candidate_revision")
    parser.add_argument("--minimum-free-gib", type=int, default=30)
    parser.add_argument("--protect-installed-jobs")
    args = parser.parse_args()
    try:
        additional_revisions = []
        if args.protect_installed_jobs:
            protected = installed_job_revision(args.protect_installed_jobs)
            if protected is not None:
                additional_revisions.append(protected)
        result = cleanup(
            DockerCLI(),
            args.candidate_revision,
            args.minimum_free_gib,
            additional_revisions,
        )
    except (CleanupError, subprocess.CalledProcessError) as error:
        print(f"Docker release cleanup refused: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
