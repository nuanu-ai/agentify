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
procedure currently installs the live-publication approval rule from ADR-0026.
Passwordless login and the coordinated identity migration have their own
acceptance boundary and are not implied by a successful approval rollout.

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

Activation holds the existing schedules and records the pre-activation public
catalog and non-recoverable aggregate row fingerprints under
`/home/dmitry/agentify-releases/<SHA>/recovery`. It verifies those fingerprints
after migration, starts the selected revision, and records runtime, route,
scheduled job, and image-identity evidence. It does not create database, role or
environment dumps. The existing edge route file is retained for error recovery.
Public catalog and route probes run from the Ansible controller; Docker, image,
environment and database checks run on the assigned host. The pre-activation
catalog probe must succeed before the state changes or schedules are held.

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
all five first-party image roles. If this is the first migration adding live
approval, use the first-cutover procedure below instead. Later releases run:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  --limit production -e release_phase=activate \
  -e release_channel_ack=production \
  -e "release_revision=$SHA" \
  -e "release_evidence_directory=$EVIDENCE"
```

### First live-approval cutover

Before activation, review existing production accounts, merchant bindings and
selling cards. Save the deliberately selected merchant IDs in the ignored file
`$EVIDENCE/initial-live-approvals.json` as an object whose
`release_initial_live_merchant_ids` value is the exact JSON array of those IDs.
Use an empty array only when no existing merchant is intended to sell live.
This file selects the set to verify; Ansible grants nothing from it. The
preflight refuses a missing or malformed inventory before stopping writers.

Run this activation in an interactive terminal, retaining the same `SHA` and
`EVIDENCE` values used for staging and test acceptance:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  --limit production -e release_phase=activate \
  -e release_channel_ack=production \
  -e "release_revision=$SHA" \
  -e "release_evidence_directory=$EVIDENCE" \
  -e "@$EVIDENCE/initial-live-approvals.json"
```

After migration and retained-data comparison, the playbook pauses with its
release lock held and writers stopped. In a second local terminal, set `SHA`
to that same full staged revision, then run the following for each reviewed
account. Type its email at the `read` prompt. The email travels on stdin,
never inside the remote shell command:

```sh
printf 'Reviewed production account email: '
read -r APPROVAL_EMAIL
printf '%s\n' "$APPROVAL_EMAIL" | ssh -o BatchMode=yes -o ConnectTimeout=10 \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=2 \
  -o ControlMaster=auto -o ControlPersist=60 \
  -o ControlPath=~/.ssh/agentify-approve-%C agentify \
  "cd /home/dmitry/agentify-releases/$SHA/source && \
   docker compose --project-name agentify-commerce --env-file ../commerce.env \
     -f compose.yaml -f deploy/compose.public.yaml \
     -f deploy/compose.hetzner-commerce.yaml \
     -f deploy/compose.scanner-database.yaml -f deploy/compose.release.yaml \
     run --rm --no-deps -T cabinet \
     pnpm --filter @agentify/commerce-cabinet approve"
unset APPROVAL_EMAIL
```

The command runs from the staged commerce image and environment already checked
by activation. It neither exposes a listener nor starts the gateway. The usual
local `pnpm approve <email>` uses the running cabinet after installation; the
stopped old cabinet cannot execute the new command during this initial cutover.

If this staged command has not returned within 60 seconds, interrupt it with
Ctrl-C. Its approval outcome is unknown: keep activation paused and repeat the
same idempotent command to reconcile the result. SSH liveness checks cannot
detect a blocked database operation on a responsive server. Do not resume
activation until the command reports the exact expected merchant and approval.

Resume the first terminal after those separate operator commands finish.
Ansible compares the complete approved merchant set with the reviewed inventory
before reopening any writer. A skipped non-interactive pause cannot bypass that
check. An uncertain operator result calls for a safe repeat and inspection,
never an assumption that approval failed. Later releases need neither this
inventory nor this pause; they fingerprint approval timestamps separately from
all previous merchant fields. Origin-obligation checks and the old challenge
expiry wait run only when the canonical origin actually changes.

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
edge configuration. Public HTTP checks use the controller's external
perspective; local runtime checks stay on the assigned host. It sends no mail
and spends no money.

If a read-only gate fails before the recovery boundary, the candidate remains
`staged`. If activation fails after entering that boundary, the candidate stays
marked `activating` and its recovery evidence and held schedules remain on the
host. Preserve them and stop. Do not automatically retry, roll back or restart
an older writer; inspect the failed task and prepare a reviewed recovery for
that specific state.
