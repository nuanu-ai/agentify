# Agentify release operations

Application releases use one bundle built by the manually dispatched
`release-images.yml` workflow. The workflow builds the five first-party images
once, tests those image IDs, pushes them to GHCR, and records their registry
digests with the source revision and configuration archive checksum. It has no
server credentials or delivery step. Test and production consume the same
manifest and archive through `release.yml`; neither host builds application
images.

The machine baseline remains in `nuanu-ai/infra`. These playbooks do not
provision servers, change DNS, publish packages, or make payment probes.
Automatic delivery is retired and the test pull timer remains masked.

## Build and inspect a release bundle

Dispatch **Build immutable release** for the current `main` revision only after
its CI push run succeeds. Download its `agentify-release-<SHA>` artifact into an
ignored local directory. The artifact contains exactly
`release-manifest.json` and `agentify-config-<SHA>.tar.gz`.

Before any host action, validate both the manifest checksum and archive
boundary:

```sh
node packages/core/src/deployment/release-manifest.mjs verify \
  "$PWD/.local/releases/$SHA/release-manifest.json" \
  "$PWD/.local/releases/$SHA/agentify-config-$SHA.tar.gz"
```

Use absolute paths for the manifest, archive and an ignored evidence directory
in every Ansible command. `release.yml` also requires one exact phase, one
inventory limit and the matching channel acknowledgement. Run the syntax check
before staging:

```sh
ansible-playbook -i deploy/ansible/inventory.yml \
  deploy/ansible/release.yml --syntax-check \
  -e release_phase=stage \
  -e release_channel_ack=test \
  -e release_manifest_file="$MANIFEST" \
  -e release_archive_file="$ARCHIVE" \
  -e release_evidence_directory="$EVIDENCE"
```

## Stage both channels and compare them

Stage the same bundle on test and production before activation. Staging
validates the bundle before extraction, pulls only digest-addressed images,
preserves channel-owned environment values, renders Compose with its build
definitions removed, runs the existing fail-closed preflight, and fetches a
secret-free topology file. It does not replace a running application.

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  --limit test -e release_phase=stage -e release_channel_ack=test \
  -e release_manifest_file="$MANIFEST" -e release_archive_file="$ARCHIVE" \
  -e release_evidence_directory="$EVIDENCE"

ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  --limit production -e release_phase=stage -e release_channel_ack=production \
  -e release_manifest_file="$MANIFEST" -e release_archive_file="$ARCHIVE" \
  -e release_evidence_directory="$EVIDENCE"

node packages/core/src/deployment/release-manifest.mjs topology \
  "$MANIFEST" "$EVIDENCE/test-topology.json" \
  "$EVIDENCE/production-topology.json"
```

The topology check requires the same commerce and scanner service roles,
commands and manifest image digests in both channels. Channel origins,
credentials, retained volume names and physical edge placement remain explicit
channel configuration and are checked separately by staging.

## Accept test and promote the same bundle

Activate test only after both staged graphs pass comparison. Activation holds
the scheduled jobs, backs up the retained databases and roles before
migrations, keeps existing channel credentials, runs migrations and starts the
runtime with `--no-build`. The same command performs runtime and public-route
verification after activation.

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  --limit test -e release_phase=activate -e release_channel_ack=test \
  -e release_manifest_file="$MANIFEST" -e release_archive_file="$ARCHIVE" \
  -e release_evidence_directory="$EVIDENCE"
```

Product acceptance is a separate operator decision. After reviewing the
fetched test runtime evidence and the actual test behavior, record
`test-accepted.json` in the evidence directory with the exact release revision,
`accepted: true`, and `manifestChecksum` equal to the SHA-256 of the manifest
bytes prefixed by `sha256:`. Production activation refuses any other marker.
Then activate production with the same manifest and archive:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  --limit production -e release_phase=activate \
  -e release_channel_ack=production \
  -e release_manifest_file="$MANIFEST" -e release_archive_file="$ARCHIVE" \
  -e release_evidence_directory="$EVIDENCE"
```

Run the `verify` phase with the same arguments and channel limit when current
runtime evidence is needed without activation. Verification checks running
image IDs and revision labels, configured environments, public routes,
scheduled jobs and the production edge image and route file. It does not send
mail or make a purchase.

## Failure recovery

Activation writes `activating` before it stops writers or runs migrations. A
failure leaves that state, the held schedules, database dumps, role custody and
environment snapshots under
`/home/dmitry/agentify-release-backups/<SHA>`, outside the candidate directory.
The playbook deliberately refuses an implicit retry or rollback: after a
migration, restarting an older writer could corrupt data or repeat effects.
Inspect the failed task and protected recovery evidence, preserve the retained
volumes and credentials, and execute a reviewed forward repair. Do not delete
the candidate directory, create an empty database, rotate credentials, restore
a dump, or restart old writers merely to clear the gate.

The two local scanner database rehearsal commands remain available for testing
the restore helper against disposable PostgreSQL containers:

```sh
bash ops/scripts/scanner-db-rehearsal.sh
bash ops/scripts/scanner-db-real-schema-rehearsal.sh
```

They do not contact a live service and do not authorize repeating the completed
production database or authentication cutovers. Their historical playbooks and
operator record remain available in Git history and protected private custody.
