# Agentify release operations

Test and production releases use the same Ansible playbook and one reviewed,
green revision from the public `main` branch. The revision is always a full
40-character lowercase Git SHA. Each target checks out that exact public source
and builds the five first-party images locally and sequentially. Infrastructure
images remain pinned in `release.yml`.

Staging builds and checks a candidate without replacing the running
application. Activation is manual, test comes first, and production accepts
only the revision recorded after test acceptance. Automatic delivery remains
disabled.

The server baseline remains in `nuanu-ai/infra`. These playbooks do not
provision servers, change DNS, publish packages, or make paid requests. They
preserve the channel-owned credentials and authentication configuration. This
procedure stops before ADR-0026 and does not enable passwordless login or
change the authentication boundary.

## Select the source revision

Use a dedicated operator clone or worktree. Select a green revision on public
`main`, put the controller checkout at exactly that revision, and keep all
fetched evidence in an ignored local directory with an absolute path:

```sh
git fetch --no-tags origin main
SHA="$(git rev-parse FETCH_HEAD)"
git switch --detach "$SHA"
test "$(git rev-parse HEAD)" = "$SHA"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
EVIDENCE="$PWD/.local/release-evidence/$SHA"
mkdir -p "$EVIDENCE"
```

Every playbook invocation requires these two values, one phase, one inventory
limit, and an acknowledgement matching that limit. The playbook refuses an
abbreviated revision, a revision that is not public `main` history, a relative
evidence path, a controller checkout at another revision or with non-ignored
changes, or a command that does not select exactly one channel. If `main`
advances after test acceptance, keep using a clean checkout at the accepted
SHA for production promotion.

Check the playbook before contacting a host:

```sh
ansible-playbook -i deploy/ansible/inventory.yml \
  deploy/ansible/release.yml --syntax-check --limit test \
  -e release_phase=stage -e release_channel_ack=test \
  -e "release_revision=$SHA" \
  -e "release_evidence_directory=$EVIDENCE"
```

## Stage test and production

Stage the selected revision on both channels before activating either one:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  --limit test -e release_phase=stage -e release_channel_ack=test \
  -e "release_revision=$SHA" \
  -e "release_evidence_directory=$EVIDENCE"

ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  --limit production -e release_phase=stage \
  -e release_channel_ack=production \
  -e "release_revision=$SHA" \
  -e "release_evidence_directory=$EVIDENCE"
```

For each channel, staging checks out a clean copy under
`/home/dmitry/agentify-releases/<SHA>/source`, builds the first-party images,
pulls the pinned infrastructure images, preserves the host-owned environment,
renders the actual Compose graph, and runs the preflight and isolated web
configuration checks. It fetches sanitized `test-topology.json` and
`production-topology.json` files into the evidence directory. It does not stop
or replace a live service.

The channel builds prove the same source SHA, image roles, commands, OCI source
labels, and runtime topology. Because each host builds separately, image IDs
and image bytes may differ; this procedure does not claim byte-identical
artifacts.

## Activate and accept test

Activate test only after both topology files exist. Activation compares them
before touching the running service:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  --limit test -e release_phase=activate -e release_channel_ack=test \
  -e "release_revision=$SHA" \
  -e "release_evidence_directory=$EVIDENCE"
```

Activation takes a one-off pre-migration recovery snapshot of the databases,
roles, environment, schedules, and data fingerprints under
`/home/dmitry/agentify-release-backups/<SHA>`. That snapshot protects this
migration; it is not a new backup platform. The playbook then applies the
migrations, starts the selected revision, and records runtime, route, scheduled
job, and image-identity evidence.

Review `test-runtime-verified.json` and perform product acceptance against the
actual test service. Only after the revision is accepted, write its explicit
marker:

```sh
python3 - "$SHA" "$EVIDENCE/test-accepted.json" <<'PY'
import json
import pathlib
import sys

pathlib.Path(sys.argv[2]).write_text(
    json.dumps({"revision": sys.argv[1], "accepted": True}) + "\n"
)
PY
```

The marker records an operator decision; the playbook does not create it.

## Activate production

Production requires the same two topology files, the trusted acceptance marker,
and `test-runtime-verified.json` for the selected revision. The runtime evidence
must name channel `test` and contain all six expected resident service roles and
all five first-party image roles:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  --limit production -e release_phase=activate \
  -e release_channel_ack=production \
  -e "release_revision=$SHA" \
  -e "release_evidence_directory=$EVIDENCE"
```

Activation performs runtime verification before it succeeds. To collect fresh
evidence later without another activation, run the read-only verify phase for
one channel at a time:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  --limit test -e release_phase=verify -e release_channel_ack=test \
  -e "release_revision=$SHA" \
  -e "release_evidence_directory=$EVIDENCE"

ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  --limit production -e release_phase=verify \
  -e release_channel_ack=production \
  -e "release_revision=$SHA" \
  -e "release_evidence_directory=$EVIDENCE"
```

Verification checks the running image identities and source labels, configured
environments, public routes, unpaid challenges, scheduled jobs, and production
edge configuration. It sends no mail and spends no money.

If activation fails after entering the migration boundary, the candidate stays
marked `activating` and its recovery evidence and held schedules remain on the
host. Preserve them and stop. Do not automatically retry, roll back, restore a
dump, or restart an older writer; inspect the failed task and prepare a reviewed
recovery for that specific state.
