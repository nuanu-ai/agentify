# Agentify release operations

TEST and PRODUCTION use the same Ansible procedure, but select revisions
independently. Each server checks out one full Git SHA and builds the five
first-party images locally and sequentially. Infrastructure images remain pinned
in `release.yml`; no image registry or release service sits between the channels.

A channel is one Compose project with one environment file. It was two — the
commerce project and a scanner project beside it, joined by an external
network — and a host that has not yet been through the one-time reconciliation
below still carries the second one. Read that section before the first release
of this shape reaches a server.

The server baseline remains in `nuanu-ai/infra`. Release playbooks do not
provision servers, change DNS, publish packages, or make paid requests. The
one-time agent bootstrap installs the distribution's `python3-venv` package for
its isolated pinned Ansible client. The playbooks preserve each channel's
credentials, databases and authentication configuration. Activation keeps the
retained-data, migration, runtime, route and image-identity checks. A release
that begins a migration has no automatic downgrade or rollback.

## Install the outbound pull agents

The same root-owned agent runs on both servers. It needs outbound HTTPS to the
public repository and no GitHub credential, inbound SSH route, Headscale session
or public webhook. Installation remains an operator action because it changes a
root service. Run it from a clean checkout at the exact reviewed `main` SHA,
using the ignored operator inventory:

```sh
SHA=$(git rev-parse HEAD)
ansible-playbook -i deploy/ansible/inventory.yml \
  -e @deploy/ansible/inventory.local.yml deploy/ansible/pull-agent.yml \
  --limit test -e pull_agent_channel_ack=test \
  -e "pull_agent_controller_revision=$SHA"

ansible-playbook -i deploy/ansible/inventory.yml \
  -e @deploy/ansible/inventory.local.yml deploy/ansible/pull-agent.yml \
  --limit production -e pull_agent_channel_ack=production \
  -e "pull_agent_controller_revision=$SHA"
```

The timers poll independently. Their closed configuration lives in
`/etc/agentify-pull-agent`, while selection state, retained controller checkouts
and evidence live under `/var/lib/agentify-pull-agent/<channel>`. Reapplying the
bootstrap prepares a complete controller-SHA version under
`/opt/agentify-pull-agent/releases`, refuses an active deployment, then switches
the installed version while polling is held. A failed reapply restores the prior
timer. It changes no channel secret or application data. Bootstrap also removes
only the retired channel-specific GitHub runner key block; operator SSH access
is left intact.

On a host with needrestart, the bootstrap also installs
`/etc/needrestart/conf.d/agentify-pull.conf` from
`needrestart-agentify-pull.conf`, creating the directory where the host has
none, and the rule in it tells needrestart never to restart
`agentify-pull@<channel>.service`. Unattended upgrades run needrestart after
they replace a shared library, and a restart of that service kills a release in
the middle of activation, with writers stopped and the release lock held. The
agent is a one-shot service started by its timer, so the next poll runs on the
upgraded libraries without any restart.

## Deploy TEST by moving `deploy-test`

Run **Deploy TEST** from `main` and enter a branch, tag or full SHA from this
repository, or move the pointer directly:

```sh
git push --force origin <branch-tag-or-sha>:refs/tags/deploy-test
```

The workflow only resolves the input and moves `deploy-test`; it has no server
credential or route. Within one polling interval the TEST agent resolves that
tag to a full commit, fetches the current `main` controller, then stages,
activates and verifies locally. TEST does not require main ancestry or a prior CI
run. The controller still refuses incompatible layout, unsafe migration state
and channel drift.

A tag that still resolves to the last verified SHA is a no-op. A failed or
uncertain SHA is not tried again: inspect its evidence and move `deploy-test` to
make a new selection. Deleting the tag leaves the running TEST revision in place.

## Deploy PRODUCTION by accepted tag

Pushing an `app-v*` tag starts **Deploy PRODUCTION**. The tag is the operator's
human acceptance; there is no second approval or TEST marker. The workflow proves
that the tag belongs to public `main` and that CI passed for that exact SHA, then
moves the internal `deploy-production` pointer. It does not connect to a server.
Do not move `deploy-production` directly. The server nevertheless repeats the
`app-v*` and exact successful main-CI checks, so a direct move bypasses nothing.

The PRODUCTION agent uses the same program and procedure as TEST. It additionally
executes release mechanics from the accepted SHA itself, then requires the
candidate to be in public `main` history and forward from the running OCI
revision, once before building and again before activation. A missing identity
or backward or divergent selection stops without touching writers.

Before a build, staging removes unreferenced first-party image tags from older
revisions and clears Docker's build cache. It retains the selected revision,
the revisions used by running Agentify containers or the installed scheduled
jobs, and any image referenced by a stopped container; it never removes
containers, volumes or third-party images. The build starts only with at least
30 GiB free. Staging clears transient build cache again after all five images
exist and requires a 10 GiB reserve before activation.

Staging checks out a clean source under
`<agentify_home>/agentify-releases/<SHA>/source`, builds first-party images, pulls
pinned infrastructure images, preserves host configuration and records sanitized
topology. Activation fingerprints retained data, verifies it after migration,
starts the selected revision and records runtime evidence. Separate server builds
are not claimed to have identical bytes.

Each server performs its TLS route checks against its own listener while keeping
the public hostname as the HTTP Host and TLS SNI name. This proves the selected
edge without depending on public DNS hairpin routing. It is not an independent
Internet vantage point, so release acceptance also includes the outside probes
listed below.

The first shared-identity or live-approval cutover remains an explicit recovery
boundary. Prepare it with the procedures below before creating a production tag;
the pull agent must stop rather than improvise missing private inputs.

## Reconcile a host that still runs two projects

Each channel ran two Compose projects on one host: the commerce project —
`agentify-commerce` on PRODUCTION, `agentify-test` on TEST — and a scanner
project beside it, `agentify` and `agentify-test-scanner`, joined by an
external network that carried the scanner's database and its identity route.
The merged graph is one project, and it is the commerce one: a project name is
the prefix on every container and the label every volume is found by, so
keeping it means the first release replaces the containers that are there
rather than building a second stack beside the running one (ADR-0025 says when
the names move).

The old scanner project is not replaced by that, because nothing in the merged
graph is named after it. It has to be stopped by hand, and it has to be stopped
*before* staging rather than after: its worker writes to the database this
release fingerprints, migrates and then fingerprints again, and a comparison
taken around a process that is still writing proves nothing.

Staging refuses while any of it is running, before it builds anything, and it
stops nothing itself — but a refusal is not free, and nothing retries. The pull
agent records that revision as `failed` and refuses it on every later poll,
printing `<CHANNEL> revision <sha> remains failed; move <tag> to make another
selection`. Getting past it means a new selection: on TEST, force-push
`deploy-test` to a different commit; on PRODUCTION, an `app-v*` tag on another
commit of `main` with green CI, because the server checks for that tag itself
and `deploy-production` is not moved by hand. That is expensive enough to be
worth avoiding, which is what the order below is for — the guard catches the
time somebody forgets, not the ordinary path.

There is one honest way to make the same revision selectable again, and it is
narrow. Read `state.json` for the channel first: if it says `"status":
"failed"` with `"phase": "stage"`, nothing was built, migrated or started, the
evidence directory says exactly which check refused, and removing that one file
lets the next poll select the same revision. `history.jsonl` keeps the record
either way. This does not contradict "do not clear state merely to make the
timer try the same uncertain operation again" further down: a refusal at stage
is not uncertain — it is a host that had not been prepared yet, and it is the
one state where what happens next is known in advance.

Do it in this order, once per channel.

**One. Merge the two environment files.** This is the only step that cannot be
undone by running it again, and it is why the refusal above is worth having:
everything after it is recoverable, this is not. In
`<agentify_home>/agentify-configuration` there are `commerce.env` and
`scanner.env`; the merged release reads `agentify.env`. Start from
`commerce.env`, append every line of `scanner.env` that the merged
`compose.yaml` still reads, and leave out the ones that named machinery that is
gone:

- drop `DATABASE_MODE`, `ADMIN_DATABASE_URL`, `WEB_DATABASE_URL`,
  `WORKER_DATABASE_URL`, `PRIVACY_DATABASE_URL`, `DASHBOARD_DATABASE_URL` and
  every `POSTGRES_*_PASSWORD` other than the commerce one — the scanner reaches
  its database with the commerce account now;
- drop `RECONCILE_RUNTIME_ROLE_PASSWORDS`,
  `ROLE_PASSWORD_ROTATION_MAINTENANCE_ACK`, `AGENTIFY_BACKUP_DIRECTORY`,
  `AGENTIFY_SCANNER_DB_NETWORK` and `AGENTIFY_ALPINE_IMAGE` — the jobs and the
  network they configured are gone;
- drop `AGENTIFY_SCANNER_WEB_IMAGE` and the other image tags; staging writes
  the current ones every time;
- keep everything else, and in particular `TOKEN_HMAC_SECRET`,
  `EMAIL_ENCRYPTION_KEY`, `REPORT_IDENTITY_SECRET`, `ADMIN_BASIC_AUTH_USER`,
  `ADMIN_BASIC_AUTH_HASH`, the `TURNSTILE_*`, `POSTHOG_*`, `META_*` and
  `STRIPE_*` settings, `PRIVACY_EMAIL`, `ABUSE_EMAIL`, the `LEGAL_*` pair,
  `REGISTRATION_ENABLED`, `SCAN_ACCEPTANCE_ENABLED`, `SCANNER_CONCURRENCY`,
  the `APIFY_*` settings and `ANALYTICS_RUNTIME_ENV`.

The keys keep the names the processes read, so this is a concatenation and a
deletion, never a rename. Write the result with mode `0600` and keep the two
originals until the channel has been verified.

The first two keys in that list are the ones to be careful with.
`deploy/compose.public.yaml` requires both of every public deployment, so a
channel without them does not render, and staging does that render before it
builds anything: the refusal names the variable and costs no image. That
refusal is the whole of the protection. `compose.yaml` gives both a sandbox
answer so a laptop needs no file at all, and those answers are printed in a
public repository. One signs every report link this site hands out and the
other is what the address behind a report is encrypted with, so a channel that
deployed them would be verifying forged links, and a channel that lost them
would find every link already sent and every address already stored unreadable.

A channel that has never existed has no file to merge, and the release will not
invent one for it: `prepare-release-environments.py` generates the scanner's
two secrets on the test branch only, for a first TEST channel whose scanner
database does not exist yet. A new PRODUCTION channel gets both written by
hand, into `<agentify_home>/agentify-configuration/agentify.env`, before its
first staging.

Several of the scanner's settings were never in `scanner.env` at all: they were
written into the scanner's own Compose file, which this change deletes. Do not
go looking for them in the file you are merging. Most are in `compose.yaml` and
the channel overlays now as variables with the value the deleted file gave
them, and an environment file that names one still wins: `SCANNER_CONCURRENCY`
(four on PRODUCTION), `POSTHOG_DESTINATION_ENV` and `META_DESTINATION_ENV`
(`production` on PRODUCTION), `POSTHOG_ENABLED`, `META_CAPI_ENABLED`, the
feature switches — including `REGISTRATION_ENABLED`, which the laptop has on so
its one command walks the whole reader's path and which
`deploy/compose.public.yaml` turns off again for every deployment — and the
`APIFY_BROWSER_*` budget knobs.

Two exceptions. `WORKER_ID` is not the value the deleted file gave: it was
`agentify-droplet-1` on both channels, which is a name two hosts answered to,
and heartbeats are keyed on it — two workers under one name read as one worker
restarting. It is `agentify-production-1` and `agentify-test-1` now. And a
handful of settings are written as literals rather than variables, exactly as
the deleted file wrote them: `ANALYTICS_SERVER_DELIVERY_ENABLED`,
`CARD_SIGNAL_ENABLED`, and `STRIPE_ADAPTER` with `PRIVACY_CLEANUP_ACK`,
`PRIVACY_CLEANUP_DRY_RUN` and `PRIVACY_CLEANUP_BATCH_SIZE` on the scheduled
job. These are fixed by the packaging. A line about any of them in the
environment file is read by nobody, and deleting such a line changes nothing.

**Two. Stop the old scanner project.** Do this immediately before moving the
channel's tag — or, if staging has already refused, do it and then make the new
selection the paragraphs above describe:

```sh
docker ps --filter label=com.docker.compose.project=agentify -q | xargs -r docker stop
```

Use `agentify-test-scanner` on TEST. The `-r` matters: without it `xargs` runs
`docker stop` with no arguments when the filter matches nothing, and a channel
that has already been reconciled would be told it used the command wrong.

From this moment the front page answers 502. The Caddy that is running is
still the old one, and it proxies `/` to a container that has stopped; it goes
on doing that until activation recreates it. So the window closes at `up
gateway cabinet web`, not when the scanner starts — stop to `up web` is the
real outage of this release, which is the staging time plus most of the
activation time. `/cabinet`, `/docs`, `/v0` and `/x402` are unaffected until
activation stops their own processes.

**Three. Release.** An ordinary activation: it stops the commerce writers,
fingerprints both databases, migrates them, compares, starts `scanner` and
`scanner-worker`, and then starts `gateway`, `cabinet` and `web`. The front
page comes back with that last step, because it is the new Caddy — inside the
same project, reaching `scanner:3000` by service name — that knows where the
scanner is. One extra second of 502 across the whole origin belongs to this
release and not to later ones: the alias the edge routes to changes name here,
so the origin answers nothing between `up web` and the edge reload that
follows it (ADR-0025).

**Four. Verify, and expect `/api/health` to need a look.** Verification checks
that route, and two things the stopped scanner can leave behind will hold it at
503 on every run until somebody clears them, not just the first:

- a scan the old worker was running when it lost its database stays `running`
  with a stale heartbeat, and the health query counts it;
- a scan the old web had accepted stays `accepted` or `queued` once its pg-boss
  job has expired past its single retry, and the health query measures the age
  of the oldest such scan against ten seconds.

Nothing reaps either. Find them in the scanner database and give them the
terminal status they never reached:

```sql
select id, status, accepted_at, worker_heartbeat_at from public.scans
 where status in ('accepted', 'queued', 'running')
 order by accepted_at;
```

Anything from before the stop is stranded; a scan submitted after activation is
not, and will move on its own. Update the stranded ones to `'failed'` — one of
the three terminal statuses, with `completed` and `partial` — and check the
route again. Do not leave the check red: it is reporting something true.

**Five. Remove the old scanner project's containers.** They are stopped by now.
`docker compose down` is not available for them — the Compose file that
described that project is gone from the release source — so remove exactly its
containers by the label Compose wrote on them, and nothing else:

```sh
docker ps -a --filter label=com.docker.compose.project=agentify --format '{{.Names}}'
docker rm -f <the names that command printed>
```

Use `agentify-test-scanner` for the TEST channel. Read the list before you
remove anything: on PRODUCTION the merged project is `agentify-commerce`, so
that filter names only the old scanner's containers, but a mistyped project
name would name the ones serving the site. No volume is touched, and none of
the scanner's data lives in one — it is in the commerce PostgreSQL volume,
which the activation you just verified is using.

**Six. Remove the private database network.** Activation recreated `cabinet`
and `postgres` without it and the old scanner's containers are gone, so by now
it has no members:

```sh
docker network rm agentify-scanner-db        # PRODUCTION
docker network rm agentify-test-scanner-db   # TEST
```

If Docker refuses because the network still has an endpoint, something is still
attached: find it with `docker network inspect`, and do not force it.

Once both channels have been through this, the staging refusal and the
`retired_scanner_project` variable it reads have no subject left and are
deleted, together with the identity-cutover machinery
(`docs/research/00-open-questions.md` keeps that list).

## Observe a selection

The GitHub workflow proves only that it moved a tag. Runtime truth stays on the
assigned server:

```sh
sudo systemctl status agentify-pull@test.timer
sudo journalctl -u agentify-pull@test.service -n 200 --no-pager
sudo cat /var/lib/agentify-pull-agent/test/state.json
```

Use `production` in those paths and unit names for the live channel. A verified
state names the exact source and controller SHA. A failed state names the phase
and exit code; preserve the evidence directory and do not clear state merely to
make the timer try the same uncertain operation again. The agent itself never
retries: it prints `<CHANNEL> revision <sha> remains <status>; move <tag> to
make another selection` and exits, on that poll and every poll after it.

`"phase": "stage"` is the one state where the operation is not uncertain —
staging builds and starts nothing on the running channel, and the evidence says
which check refused — so clearing it deliberately to select the same revision
again is a decision an operator can defend. The transition release has a
refusal of exactly that kind; "Reconcile a host that still runs two projects"
above says when.

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

The one-off importer joins this project's own network and reaches the database
by the name the rest of the stack calls it by.

The private recovery directory holds an `identity-cutover.json` checkpoint with
the original account IDs, frozen eligibility time and hashes, without customer
row copies. Do not replace it after an interrupted import. A reviewed forward
retry uses that same checkpoint: an exact repeated import is accepted, while
changed source or target rows refuse continuation. The temporary importer
credential file is removed whether activation succeeds or fails.

The cabinet serves report identity on its private port 3002; this port is not
published. Staging creates one host-owned credential for the cabinet and the
scanner, reuses it on subsequent releases, and keeps test and production
credentials separate. No other service in the rendered graph is given the
route or the secret, and the release refuses a graph in which one is. That is
the whole of the separation: every service holds the same database account,
which is the instance's superuser, so the worker and the privacy job could
read the cabinet's tables by changing one word in a connection string. What
stops them reading a person's identity is that they are not the cabinet and
cannot ask it.

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
   sudo -n docker compose --project-name agentify-commerce --env-file ../agentify.env \
     -f compose.yaml -f deploy/compose.public.yaml \
     -f deploy/compose.hetzner-commerce.yaml -f deploy/compose.release.yaml \
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
environments, public routes, unpaid challenges, the scheduled privacy cleanup,
and production edge configuration. Under the pull agent, public HTTP checks leave the assigned
server through public DNS and TLS; they do not prove reachability from an
independent internet client. Local image evidence proves the selected revision,
and an operator's outside-in probe remains separate evidence. Verification sends
no mail and spends no money.

If a read-only gate fails before the recovery boundary, the candidate remains
`staged`. If activation fails after entering that boundary, the candidate stays
marked `activating` and its recovery evidence and held schedules remain on the
host. Preserve them and stop. Do not automatically retry, roll back or restart
an older writer; inspect the failed task and prepare a reviewed recovery for
that specific state.
