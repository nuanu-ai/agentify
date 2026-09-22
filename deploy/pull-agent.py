#!/usr/bin/env python3

import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request


FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
APP_TAG = re.compile(r"^refs/tags/app-v[0-9A-Za-z._-]+(?:\^\{\})?$")
INTENT_TAGS = {
    "production": "deploy-production",
    "test": "deploy-test",
}


class AgentError(RuntimeError):
    pass


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run(args, *, cwd=None, capture=False):
    return subprocess.run(
        [str(value) for value in args],
        cwd=None if cwd is None else str(cwd),
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def require_success(result, description):
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise AgentError(description + (f": {detail}" if detail else ""))
    return result


def read_config(path):
    try:
        config = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise AgentError(f"Cannot read pull-agent configuration: {error}") from error
    required = {
        "channel",
        "repository",
        "intentTag",
        "controllerBranch",
        "stateDirectory",
        "inventoryFile",
        "ansiblePlaybook",
    }
    if set(config) != required:
        raise AgentError("Pull-agent configuration has unknown or missing fields")
    channel = config["channel"]
    if channel not in INTENT_TAGS:
        raise AgentError("The pull agent accepts only the test and production channels")
    if config["intentTag"] != INTENT_TAGS[channel]:
        raise AgentError(f"The {channel.upper()} pull agent watches only the {INTENT_TAGS[channel]} tag")
    if config["controllerBranch"] != "main":
        raise AgentError("The release controller must come from main")
    if not isinstance(config["repository"], str) or not config["repository"]:
        raise AgentError("The repository must be explicit")
    for field in ["stateDirectory", "inventoryFile", "ansiblePlaybook"]:
        value = Path(config[field])
        if not value.is_absolute():
            raise AgentError(f"{field} must be an absolute path")
    if not Path(config["inventoryFile"]).is_file():
        raise AgentError(f"The local {channel.upper()} inventory is missing")
    if not Path(config["ansiblePlaybook"]).is_file():
        raise AgentError("The pinned ansible-playbook executable is missing")
    return config


def parse_remote_refs(output):
    refs = {}
    for line in output.splitlines():
        fields = line.split("\t", 1)
        if len(fields) == 2 and FULL_SHA.fullmatch(fields[0]):
            refs[fields[1]] = fields[0]
    return refs


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump(value, output, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def append_history(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as output:
        output.write(json.dumps(value, sort_keys=True) + "\n")
        output.flush()
        os.fsync(output.fileno())
    path.chmod(0o600)


def record_state(config, state_file, history_file, revision, controller, status, phase=None, returncode=None):
    value = {
        "channel": config["channel"],
        "controllerRevision": controller,
        "intentTag": config["intentTag"],
        "revision": revision,
        "status": status,
        "updatedAt": utc_now(),
    }
    if phase is not None:
        value["phase"] = phase
    if returncode is not None:
        value["returncode"] = returncode
    atomic_json(state_file, value)
    append_history(history_file, value)


def initialize_mirror(mirror, repository):
    if mirror.exists():
        return
    mirror.parent.mkdir(parents=True, exist_ok=True)
    require_success(run(["git", "init", "--bare", str(mirror)], capture=True), "Cannot initialize repository mirror")
    require_success(
        run(["git", "-C", str(mirror), "remote", "add", "origin", repository], capture=True),
        "Cannot configure repository mirror",
    )


def resolve_intent(config, mirror):
    repository = config["repository"]
    controller_ref = f"refs/heads/{config['controllerBranch']}"
    tag_ref = f"refs/tags/{config['intentTag']}"
    advertised = require_success(
        run(["git", "ls-remote", repository, controller_ref, tag_ref, tag_ref + "^{}"], capture=True),
        "Cannot read deployment intent",
    )
    refs = parse_remote_refs(advertised.stdout)
    main_revision = refs.get(controller_ref)
    candidate = refs.get(tag_ref + "^{}", refs.get(tag_ref))
    if main_revision is None:
        raise AgentError("The trusted main controller ref is missing")
    if candidate is None:
        return None

    initialize_mirror(mirror, repository)
    fetch = run(
        [
            "git",
            "-C",
            str(mirror),
            "fetch",
            "--force",
            "--no-tags",
            "origin",
            f"+{controller_ref}:refs/remotes/origin/{config['controllerBranch']}",
            f"+{tag_ref}:{tag_ref}",
        ],
        capture=True,
    )
    require_success(fetch, "Cannot fetch the selected deployment intent")
    fetched_controller = require_success(
        run(
            ["git", "-C", str(mirror), "rev-parse", f"refs/remotes/origin/{config['controllerBranch']}^{{commit}}"],
            capture=True,
        ),
        "Cannot resolve the fetched controller",
    ).stdout.strip()
    fetched_candidate = require_success(
        run(["git", "-C", str(mirror), "rev-parse", f"{tag_ref}^{{commit}}"], capture=True),
        f"Cannot resolve {config['intentTag']} to a commit",
    ).stdout.strip()
    if fetched_controller != main_revision or fetched_candidate != candidate:
        raise AgentError(f"The controller or {config['intentTag']} tag moved while it was being selected")
    controller_revision = fetched_candidate if config["channel"] == "production" else fetched_controller
    return fetched_candidate, controller_revision


def require_production_acceptance(config, revision):
    accepted_tags = require_success(
        run(
            [
                "git",
                "ls-remote",
                config["repository"],
                "refs/tags/app-v*",
                "refs/tags/app-v*^{}",
            ],
            capture=True,
        ),
        "Cannot read production acceptance tags",
    )
    accepted_revisions = {
        sha for ref, sha in parse_remote_refs(accepted_tags.stdout).items() if APP_TAG.fullmatch(ref)
    }
    if revision not in accepted_revisions:
        raise AgentError(f"Production revision {revision} has no app-v* acceptance tag")

    url = (
        "https://api.github.com/repos/nuanu-ai/agentify/actions/workflows/ci.yml/runs"
        f"?event=push&head_sha={revision}&per_page=100"
    )
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "agentify-pull-agent",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.load(response)
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        raise AgentError(f"Cannot verify production CI: {error}") from error
    runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
    if not isinstance(runs, list):
        raise AgentError("GitHub returned no readable production CI runs")
    run_evidence = next(
        (
            item
            for item in runs
            if isinstance(item, dict)
            and item.get("head_sha") == revision
            and item.get("head_branch") == "main"
            and item.get("event") == "push"
        ),
        None,
    )
    if run_evidence is None or run_evidence.get("status") != "completed":
        raise AgentError(f"Production CI is not complete for {revision}")
    if run_evidence.get("conclusion") != "success":
        raise AgentError(f"Production CI did not succeed for {revision}")


def ensure_controller(mirror, controllers, revision):
    destination = controllers / revision
    if destination.exists():
        head = require_success(
            run(["git", "-C", str(destination), "rev-parse", "HEAD"], capture=True),
            "Cannot read the retained controller checkout",
        ).stdout.strip()
        status = require_success(
            run(
                ["git", "-C", str(destination), "status", "--porcelain=v1", "--untracked-files=all"],
                capture=True,
            ),
            "Cannot inspect the retained controller checkout",
        ).stdout
        if head != revision or status != "":
            raise AgentError("The retained controller checkout is not exact and clean")
        return destination
    controllers.mkdir(parents=True, exist_ok=True)
    require_success(
        run(["git", "--git-dir", str(mirror), "worktree", "add", "--detach", str(destination), revision], capture=True),
        "Cannot create the trusted controller checkout",
    )
    return destination


def phase_command(config, controller_path, revision, controller_revision, evidence, phase):
    return [
        config["ansiblePlaybook"],
        "-i",
        "deploy/ansible/inventory.yml",
        "deploy/ansible/release.yml",
        "-e",
        "@" + config["inventoryFile"],
        "--limit",
        config["channel"],
        "-e",
        f"release_phase={phase}",
        "-e",
        f"release_channel_ack={config['channel']}",
        "-e",
        f"release_revision={revision}",
        "-e",
        f"release_controller_revision={controller_revision}",
        "-e",
        f"release_evidence_directory={evidence}",
    ]


def execute(config):
    channel = config["channel"]
    channel_label = channel.upper()
    intent_tag = config["intentTag"]
    state_directory = Path(config["stateDirectory"])
    state_directory.mkdir(parents=True, exist_ok=True)
    lock_path = state_directory / "agent.lock"
    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(f"Another pull-agent invocation owns the {channel_label} selection lock")
            return 0

        mirror = state_directory / "repository.git"
        intent = resolve_intent(config, mirror)
        if intent is None:
            print(f"{intent_tag} is absent; the running {channel_label} revision is unchanged")
            return 0
        revision, controller_revision = intent
        state_file = state_directory / "state.json"
        history_file = state_directory / "history.jsonl"
        if state_file.exists():
            state = json.loads(state_file.read_text())
            if state.get("revision") == revision:
                status = state.get("status")
                if status == "verified":
                    print(f"{channel_label} already runs verified revision {revision}")
                    return 0
                print(
                    f"{channel_label} revision {revision} remains {status}; "
                    f"move {intent_tag} to make another selection",
                    file=sys.stderr,
                )
                return 75

        if channel == "production":
            require_production_acceptance(config, revision)

        controller_path = ensure_controller(mirror, state_directory / "controllers", controller_revision)
        evidence = state_directory / "evidence" / revision
        evidence.mkdir(parents=True, exist_ok=True)
        record_state(config, state_file, history_file, revision, controller_revision, "deploying", phase="stage")
        stage = run(
            phase_command(config, controller_path, revision, controller_revision, evidence, "stage"),
            cwd=controller_path,
        )
        if stage.returncode != 0:
            record_state(
                config,
                state_file,
                history_file,
                revision,
                controller_revision,
                "failed",
                phase="stage",
                returncode=stage.returncode,
            )
            return stage.returncode

        record_state(
            config,
            state_file,
            history_file,
            revision,
            controller_revision,
            "activating",
            phase="activate",
        )
        activate = run(
            phase_command(config, controller_path, revision, controller_revision, evidence, "activate"),
            cwd=controller_path,
        )
        if activate.returncode != 0:
            record_state(
                config,
                state_file,
                history_file,
                revision,
                controller_revision,
                "failed",
                phase="activate",
                returncode=activate.returncode,
            )
            return activate.returncode

        record_state(config, state_file, history_file, revision, controller_revision, "verified")
        print(f"{channel_label} revision {revision} is verified")
        return 0


def main():
    parser = argparse.ArgumentParser(description="Deploy the exact revision selected by a channel intent tag")
    parser.add_argument("--config", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        config = read_config(arguments.config)
        return execute(config)
    except AgentError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, json.JSONDecodeError) as error:
        print(f"Pull agent refused uncertain local state: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
