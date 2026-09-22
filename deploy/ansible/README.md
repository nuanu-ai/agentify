# Agentify release operations

TEST and PRODUCTION use the same Ansible procedure, but select revisions
independently. Each server checks out one full Git SHA and builds the five
first-party images locally and sequentially. Infrastructure images remain pinned
in `release.yml`; no image registry or release service sits between the channels.

The server baseline remains in `nuanu-ai/infra`. These playbooks do not provision
servers, change DNS, publish packages, or make paid requests. They preserve each
channel's credentials, databases and authentication configuration. Activation
keeps the retained-data, migration, runtime, route and image-identity checks. A
release that begins a migration has no automatic downgrade or rollback.

## GitHub environments

Both workflows run on GitHub-hosted runners and reach their assigned server
through the private Headscale mesh. Configure environments named `test` and
`production` separately. Each has its own `SSH_KEY`, `KNOWN_HOSTS`,
`INVENTORY_JSON` and `HEADSCALE_AUTH_KEY` secrets, plus a
`HEADSCALE_LOGIN_SERVER` variable. The inventory contains the channel's mesh
address, login and deployment paths; workflow files contain no host address.
TEST permits only the workflow on `main`; PRODUCTION permits only `app-v*` tags.
Neither environment needs a manual reviewer.

Install each environment's dedicated public SSH key once with
`release-access.yml`. It appends a restricted key without replacing operator
access. Run it with the same mesh `ansible_host` and SSH port stored in that
environment's `INVENTORY_JSON`, rather than an operator-only alias, and store its
emitted known-hosts row verbatim in `KNOWN_HOSTS`.

## Deploy TEST manually

Run **Deploy TEST** from `main` and enter a branch, tag or full SHA from this
repository. The selection job resolves that input once through GitHub to a full
commit SHA. The deployment job checks out the recorded `main` controller and
passes the candidate SHA separately to Ansible, so candidate workflow code never
receives TEST credentials.

TEST does not require main ancestry or a prior CI run. This lets a branch itself
be the reason for a test deployment. The current controller still requires a
compatible application and Compose layout. It refuses unsafe migration state and
never attempts to downgrade a database to fit older code.

## Deploy PRODUCTION by tag

Pushing an `app-v*` tag starts **Deploy PRODUCTION**. The tag is the operator's
human acceptance; there is no second approval or TEST marker. Before the job can
read PRODUCTION secrets, an uncredentialed job proves that the tag names a commit
in public `main` history and requires successful CI on that exact SHA.

The deployment job stages, activates and verifies only the tagged revision. It
neither reads TEST evidence nor requires TEST to run the same SHA. Staging checks
out a clean source under `<agentify_home>/agentify-releases/<SHA>/source`, builds
the first-party images, pulls pinned infrastructure images, preserves host-owned
configuration, renders the channel's Compose graph and records sanitized
topology. Activation records pre-change data fingerprints, verifies them after
migration, starts the selected revision and records runtime evidence. Separate
server builds are not claimed to have identical bytes.

PRODUCTION also reads the full OCI revision label from the running cabinet image
and requires it to be an ancestor of, or equal to, the tagged revision. It checks
once before building and again immediately before activation. A missing label or
an older or divergent tag stops without touching writers and requires reviewed
manual recovery; the workflow never automates a downgrade.

The first shared-identity or live-approval cutover remains an explicit recovery
boundary. Prepare it with the procedures below before creating a production tag;
the automatic workflow must stop rather than improvise missing private inputs.

### First shared-identity cutover

Activation detects the existing scanner identity tables and stops both
applications and their scheduled jobs before inspecting customer rows. Scanner
migration `--identity-preflight` applies the additive schema through `0016`
without removing the source identity. The one-off importer validates email
normalization, verified scanner people, decrypted lead ownership and pending
links before the cabinet migration ends old passwords and sessions.

The importer preserves every existing cabinet account, including its current
confirmation status and merchant binding. It adds verified scanner-only people
without a merchant and transfers current hashed report links with their original
state, intent and expiry. Report cookies, Supabase provenance and commerce data
remain subject to retained-row comparisons. The scanner and cabinet databases
stay separate; only the one-off importer receives both database credentials.

After the exact target projections and retained-row comparisons pass, the
importer authorizes scanner cleanup. The ordinary migration ledger then applies
`0017`; a populated source without this authorization is refused. Activation
checks the retained rows again before starting the new applications. Do not run
a full scanner migration against a populated old identity database separately
from this stopped sequence.

The private recovery directory holds an `identity-cutover.json` checkpoint with
the original account IDs, frozen eligibility time and hashes, without customer
row copies. Do not replace it after an interrupted import. A reviewed forward
retry uses that same checkpoint: an exact repeated import is accepted, while
changed source or target rows refuse continuation. The temporary importer
credential file is removed whether activation succeeds or fails.

The cabinet serves report identity on its private port 3002; this port is not
published. Staging creates one host-owned credential for the cabinet and scanner
web, reuses it on subsequent releases, and keeps test and production credentials
separate. Workers, privacy jobs and dashboards receive no identity credential or
cabinet database access.

### First live-approval cutover

Before activation, review existing production accounts, merchant bindings and
selling cards. Save the deliberately selected merchant IDs in the ignored file
`$EVIDENCE/initial-live-approvals.json` as an object whose
`release_initial_live_merchant_ids` value is the exact JSON array of those IDs.
Use an empty array only when no existing merchant is intended to sell live.
This file selects the set to verify; Ansible grants nothing from it. The
preflight refuses a missing or malformed inventory before stopping writers.

Run this activation in an interactive terminal, retaining the same production
`SHA` and `EVIDENCE` values used for staging. The controller checkout must be
clean at that SHA:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  -e @deploy/ansible/inventory.local.yml \
  --limit production -e release_phase=activate \
  -e release_channel_ack=production \
  -e "release_revision=$SHA" \
  -e "release_controller_revision=$SHA" \
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
  "cd $AGENTIFY_HOME/agentify-releases/$SHA/source && \
   sudo -n docker compose --project-name agentify-commerce --env-file ../commerce.env \
     -f compose.yaml -f deploy/compose.public.yaml \
     -f deploy/compose.hetzner-commerce.yaml \
     -f deploy/compose.scanner-database.yaml -f deploy/compose.release.yaml \
     run --rm --no-deps -T cabinet \
     pnpm --filter @agentify/cabinet --fail-if-no-match approve"
unset APPROVAL_EMAIL
```

The command runs from the staged commerce image and environment already checked
by activation. Noninteractive sudo reads the root-owned private environment file;
its permissions stay restricted. It neither exposes a listener nor starts the gateway. The usual
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
  -e @deploy/ansible/inventory.local.yml \
  --limit test -e release_phase=verify -e release_channel_ack=test \
  -e "release_revision=$SHA" \
  -e "release_controller_revision=$(git rev-parse HEAD)" \
  -e "release_evidence_directory=$EVIDENCE"

ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/release.yml \
  -e @deploy/ansible/inventory.local.yml \
  --limit production -e release_phase=verify \
  -e release_channel_ack=production \
  -e "release_revision=$SHA" \
  -e "release_controller_revision=$(git rev-parse HEAD)" \
  -e "release_evidence_directory=$EVIDENCE"
```

## Run the isolated Woo acceptance route

The experimental Woo fixture is deliberately absent from ordinary SDK release
activation and verification. For COIN-25 only, an explicit TEST operation
installs a dedicated systemd unit that derives and validates the two named
Compose subnets and translates only their connections to the reviewed public
address on HTTPS. DNS stays public, and TLS continues to use the public host
names. A missing or malformed fixture, a different DNS answer, or a failed
connection in either direction refuses this operation without widening the
application's SSRF boundary.

From a clean checkout at the reviewed public `main` revision, reconcile and
verify the fixture route explicitly:

```sh
ansible-playbook -i deploy/ansible/inventory.yml \
  -e @deploy/ansible/inventory.local.yml \
  deploy/ansible/woo-test-hairpin.yml --limit test \
  -e woo_hairpin_channel_ack=test -e woo_hairpin_action=reconcile \
  -e "woo_hairpin_revision=$SHA"
```

The same guarded playbook owns removal. It stops and disables the unit, invokes
its idempotent rule cleanup, removes only its two installed files, reloads
systemd, and proves the dedicated chain and jump are absent:

```sh
ansible-playbook -i deploy/ansible/inventory.yml \
  -e @deploy/ansible/inventory.local.yml \
  deploy/ansible/woo-test-hairpin.yml --limit test \
  -e woo_hairpin_channel_ack=test -e woo_hairpin_action=remove \
  -e "woo_hairpin_revision=$SHA"
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
