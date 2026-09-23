# Releasing Agentify

This is the runbook for putting a revision of this repository on one of its
two channels, finding out what a channel runs, and recovering when a release
goes wrong. It assumes nothing beyond shell access to the hosts and a checkout
of this repository; every command below is meant to be typed as written, with
the values in angle brackets filled in.

## Where things are

There are two channels. TEST is the site at `https://test.agentify.ad`, where
any branch can be tried; PRODUCTION is `https://agentify.ad`. Each runs on its
own host, and the hosts are reached over SSH by two aliases that each
operator's own SSH configuration defines: `agentify-test` for TEST and
`agentify` for PRODUCTION. PRODUCTION is reachable only over the nuanu mesh, so
the mesh client has to be connected before `ssh agentify` answers. The
repository holds no address of either host, and it should stay that way,
because it is public.

On each host a channel is one Compose project: `agentify-test` on TEST and
`agentify-commerce` on PRODUCTION. Those names are what the running hosts were
created under and what their containers and volumes are labelled with, so they
do not change with the repository (ADR-0025). The files a release uses on a
host are these, with `<channel>` standing for `test` or `production`:

```text
/etc/agentify/<channel>.env              the channel's configuration and secrets, root, mode 600
/etc/agentify/release.json               which channel this host is, for agentify-release
/usr/local/sbin/agentify-release         the release command
/var/lib/agentify/<channel>/current      the revision the last successful release verified
/var/lib/agentify/<channel>/failed       the last revision that was refused or failed
/var/lib/agentify/<channel>/pending      a release that stopped before it finished, and its restore point
/var/lib/agentify/<channel>/seen         the revision TEST's timer is waiting for, and since when
/var/lib/agentify/<channel>/checkouts/   one checkout per revision; the current one stays
/var/lib/agentify/<channel>/release.lock the command's lock: one release at a time
/run/lock/agentify-release.lock          activation's lock, shared by restores and the nightly privacy job
/var/backups/agentify/<channel>/         the restore points, one directory per release
/etc/cron.d/agentify-release             the nightly privacy job, written by each release
```

Everything under `/var/lib/agentify` holds nothing secret — revision names,
checkouts of this public repository — so it is readable by anyone on the host,
and the status commands below need no `sudo`. The environment file and the
restore points are root's alone. Everything about a running channel goes
through one command line, `deploy/stack.sh <channel> <compose arguments>`, run
as root from the checkout of the revision the channel runs, which `current`
names:

```sh
ssh -t agentify-test 'sudo /var/lib/agentify/test/checkouts/$(cat /var/lib/agentify/test/current)/deploy/stack.sh test ps'
```

## How a release works

A release is one command on the host, `agentify-release <name>`. Started by a
person, it does not release from the terminal: it hands the release to a
transient systemd unit, `agentify-release-<channel>.service`, and follows that
unit's journal until it ends, so a dropped connection or Ctrl-C stops only the
following and the release goes on.

The release asks the public repository which commit the name stands for, then
asks GitHub's public API for the five images that commit's image build
published (`.github/workflows/images.yml` builds them for every commit pushed
as the head of a branch and publishes their digests in a notice; the header of
that file states how the notice is read). It fetches the commit into its own
checkout and runs that checkout's `deploy/activate.sh`. Activation pulls the
images by digest and, before anything stops, checks everything it can: the
release's own preflight over the channel's rendered configuration, then the
scanner image started alone with that configuration and no network, which has
to pass its own start-up checks and its configuration check at
`/api/health/live` — the very code the scanner runs when it starts. Then it
stops the gateway, the cabinet, the scanner and its worker, takes a restore
point of both databases, runs the migrations, starts everything again, on
PRODUCTION installs the edge's route table, checks ten public routes, checks
that every card on sale before the stop is still on sale and answers its
payment challenge on the channel's network, and schedules the nightly privacy
job. The command needs no GitHub credential, and nothing in GitHub can reach a
host.

The card check spends nothing: a GET on a purchase address is always answered
with the challenge and never read for payment. It reads the catalog as the one
document the catalog is, since paging is not designed yet. The earlier
verification also compared the sitemap's origin, probed the retired
`app.agentify.ad`, compared each running container's image and environment
with the rendered configuration, held PRODUCTION's scanner registration,
Turnstile, postback and analytics settings to the values already running, and
fingerprinted retained rows before and after the migrations; none of these
runs now.

On PRODUCTION the name has to be an `app-v*` tag, the image build has to be a
push to `main`, `main`'s CI run for the commit has to have succeeded, and the
commit has to move forward from the one the host runs. TEST takes a tag, a
branch or a full commit SHA, as long as exactly one image build of it
succeeded.

## Releasing to production

A production release starts from `main`. Every change a merchant can see in
the published packages carries a Changeset (`pnpm changeset` on the branch
that makes it). When a release is due, one pull request prepares the versions:

```sh
pnpm changeset version
pnpm check && pnpm typecheck && pnpm test && pnpm build && pnpm outside
```

It is reviewed and merged like any other. The merge commit is the new head of
`main`, which is what matters here: `ci.yml` runs on it and `images.yml` builds
its images, and a commit that was never the head of a push to `main` has
neither and cannot be released. Wait until both runs are green on that commit
in the Actions tab; `docs/research/22-sdk-release.md` also describes a dry run
of the npm publication, which is worth doing before the tag.

The tag is the acceptance, and only repository administrators can create an
`app-v*` tag; once pushed, a release tag can be neither moved nor deleted.
Tag the merge commit:

```sh
git fetch origin main
git tag app-v<X.Y.Z> origin/main
git push origin app-v<X.Y.Z>
```

Pushing the tag publishes the SDK and the contracts to npm (`publish-sdk.yml`)
and nothing else, so production gets the same revision only when a person runs
the release, which belongs right after the tag:

```sh
ssh -t agentify sudo agentify-release app-v<X.Y.Z>
```

`-t` gives `sudo` a terminal to ask for a password on. The first line says the
release runs as `agentify-release-production.service`; after that the journal
of that unit scrolls by. The command prints
`agentify-release: activating app-v<X.Y.Z> (<sha>) on production`, and then
activation prints one line per step, each beginning `activate:` — pulling the
images; checking the channel's configuration, followed by the preflight's own
`preflight: the production channel is what it claims to be` (the scanner's own
check runs inside this step); stopping the four applications; taking the
restore point, with its directory; the two migrations; starting the scanner;
starting commerce and the route table; installing the edge's route table;
checking the public routes; checking the cards on sale, followed by how many
are on sale and how many were compared; scheduling the privacy job; and, when
the previous release's images are no longer needed, removing them. Compose's
own lines about containers stopping, starting and becoming healthy come in
between. A finished and verified release ends with these two lines and exit
status 0:

```text
activate: production runs <sha> and answers on every route and card checked.
agentify-release: production runs <sha>, verified
```

If the connection drops, the release goes on; follow it again, or read it
afterwards, with:

```sh
ssh agentify sudo journalctl -u agentify-release-production.service -f
```

The only release timed on a host so far is the first TEST release through this
command, on 2026-09-23: pulling the five images took 12 minutes 53 seconds, and
from the preflight to the verified line took 35 seconds, of which about 25 were
downtime; the restore point took 4 seconds, for dumps of 115 KB and 207 KB.
The pull is most of it and happens before anything stops. Over that pull the
2.4 GB app image arrived in 1 minute 55 seconds, while the 1.8 GB
scanner-privacy and 1.1 GB scanner-worker images came at about 0.7 MB/s, for
a reason nobody has found yet. That release predates the scanner's own check
and the card check, which add a few seconds before the stop and a request per
card after the start. On PRODUCTION the dumps grow with the data, and so does
the downtime.

## Releasing to test

There is one TEST channel and it is shared, so tell the other person before
moving it. A TEST release is the `deploy-test` tag: run **Deploy TEST** from
`main` in GitHub Actions with a branch, tag or SHA, or move the tag yourself.

```sh
git push origin my-branch
git push --force origin my-branch:refs/tags/deploy-test
```

A timer on the TEST host runs `agentify-release --timer deploy-test` once a
minute. It does nothing while the tag names what already runs or what already
failed. It waits while GitHub lists no build of the commit yet, or the build
is still running, or the images did not arrive, and asks again at the next
tick; after 30 minutes of waiting for one revision it records the wait as a
failure. Otherwise it releases, so a revision reaches TEST within a minute of
its images being ready. Watch it happen, and see what TEST runs afterwards:

```sh
ssh agentify-test "sudo journalctl -u 'agentify-release*' -f"
ssh agentify-test cat /var/lib/agentify/test/current
```

A person can also release on TEST directly, with any tag, branch or SHA that
has images; this is also how a failed TEST revision is tried again, since a
person's run never skips one:

```sh
ssh -t agentify-test sudo agentify-release my-branch
```

## When a release fails

A refusal is one sentence that begins `agentify-release: refused:` or
`activate:`, says what was wrong and ends with exit status 1. A wait ends with
exit status 75 and says that nothing changed and that running again later may
go through. Both are in the journal: a person's runs under
`agentify-release-<channel>.service`, TEST's timer under
`agentify-release.service`. What a failure leaves behind depends on how far
the release got, and its last line says which of these it was.

A refusal before the four applications stop changes nothing: the previous
release keeps running as it was. This covers a name the channel does not take;
a build that failed or was not listed, CI that failed or has not finished, a
move backwards; images that did not arrive within 30 minutes or do not carry
the revision's label; an environment file with a `$` outside single quotes, a
configuration that does not render, that the preflight refuses or that the
scanner refuses at its own start; a PostgreSQL image other than the pinned
one; a PRODUCTION edge other than the reviewed one; too little room for the
restore point; and another release that did not finish. Fix the cause and run
the same command again.

A failure after the stop and before the first migration — while the restore
point is being taken — starts the four applications again on the previous
release, over databases nothing has touched.

A failure from the first migration until the new release starts restores both
databases from the restore point the release had just taken, and starts the
previous release again. Nothing is lost by that, because between the stop and
this moment nothing wrote to the databases; the message says the databases
were restored and names the restore point. If the restore itself fails, the
four applications stay stopped, and the message names the one command to run
until it succeeds, `restore.sh` with that restore point; then release again
the revision that ran before.

Once the new release has started, a failure — commerce not becoming healthy,
the edge, a route, a card — restores nothing, because the new release may
already have taken orders. The new revision runs, unverified, on the migrated
databases, and the message says so. If the scanner does not start, commerce is
started anyway and the scanner stays down. Fix the cause and run the same
command again: it reuses the restore point of the unfinished release rather
than dumping data its migrations already changed.

A release killed outright — `kill -9`, a crash, the power — leaves `pending`
behind, naming its restore point. Running the same revision again carries it
on, reusing that restore point. Any other revision is refused until that one
is finished, or its restore point restored. A stop request from systemd, and
an interrupt, take the same way back as a failure at the same point.

Trying again is always the same command: on TEST,
`sudo agentify-release deploy-test`, and on PRODUCTION the same `app-v*` tag.
When the channel already runs the revision, running it again stops nothing:
it pulls, checks the configuration, starts whatever is not running and checks
the routes and the cards again.

A restore point is `/var/backups/agentify/<channel>/<time>-<previous>-before-<new>/`:
the data of the revision `<previous>`, as it was just before `<new>` began to
migrate it, with the PRODUCTION edge's previous `Caddyfile` beside it. Every
release that switches revisions takes one, a retry never takes a second, and
the five newest are kept. Restoring one loses everything written to the
databases after it was taken. Restore by hand when activation says its own
restore failed, or when a person has decided the data has to go back:

```sh
ssh -t agentify-test 'sudo /var/lib/agentify/test/checkouts/$(cat /var/lib/agentify/test/current)/deploy/restore.sh /var/backups/agentify/test/<time>-<previous>-before-<new>'
```

On PRODUCTION the same command runs over `ssh -t agentify`, with `production`
in the three paths. `restore.sh` takes the release lock, so no release, no timer tick and no
privacy job runs meanwhile; stops the four applications; and for each
database drops it, closing every connection, and creates it again from its
dump, stopping at the first error. It leaves the applications stopped. Then
release `<previous>` again: on TEST, `sudo agentify-release <previous>`; on
PRODUCTION, its `app-v*` tag, which the command takes because it is still the
one `current` names — a release that failed never becomes `current`. The edge's
previous `Caddyfile` is for a person to copy back if the route table was the
problem; `restore.sh` does not touch the edge.

A release that passed its checks and turns out bad later is fixed forward, not
restored: revert or fix it on a branch, merge to `main`, tag the new commit and
release that tag. Restoring its restore point would lose every order and
receipt written since, and the command refuses to move production backwards
in any case.

## Setting up a host

A host needs Docker with Compose, `flock`, `curl`, `git` and `python3`, and
its channel's environment file in place before anything else. From a checkout
of `main` on the host:

```sh
sudo deploy/install.sh test          # or: production
```

It installs `agentify-release` and `/etc/agentify/release.json`. On TEST it
also installs and starts the timer (`agentify-release.timer`) and, where
needrestart is installed, the rule that keeps needrestart from restarting the
timer's service in the middle of an activation. PRODUCTION gets no timer. On
either channel it removes the pull agent the earlier Ansible release had
installed (`agentify-pull@<channel>`), keeping its old records in
`/var/lib/agentify-pull-agent`. The command on a host is whatever this last
installed, and a release does not update it: when a change reaches `main`
that touches `deploy/agentify-release`, `deploy/install.sh` or the timer's
units, run `install.sh` again from a checkout of that `main`.

It refuses while root is in the "password must be changed" state, because in
that state `sudo` refuses to switch accounts, and it stopped every production
release on 2026-09-22. Check it yourself with:

```sh
sudo chage -l root | grep -i 'password must be changed' && echo 'change root password first'
```

The environment file, `/etc/agentify/<channel>.env`, owned by root with mode
600, holds every setting the compose files and the preflight ask for, and no
image: activation records the images per checkout. On both channels it names
`AGENTIFY_PUBLIC_ORIGIN`, `AGENTIFY_COOKIE_SECURE`, `AGENTIFY_SURFACE_MODE`,
`AGENTIFY_PAYMENT_NETWORK`, `AGENTIFY_FACILITATOR_URL`, `AGENTIFY_SEED_KEY`,
`AGENTIFY_AUTH_SECRET`, `AGENTIFY_INVITATION`, `ADMIN_BASIC_AUTH_USER`,
`ADMIN_BASIC_AUTH_HASH`, `TOKEN_HMAC_SECRET`, `EMAIL_ENCRYPTION_KEY` and
`REPORT_IDENTITY_SECRET`. TEST adds `AGENTIFY_TEST_LISTEN_ADDRESS`, the
private address its door binds on. PRODUCTION adds `AGENTIFY_DB_PASSWORD`,
`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `MAIL_URL`, `MAIL_API_KEY` and
`MAIL_FROM`. The scanner's remaining settings — `PRIVACY_EMAIL`,
`ABUSE_EMAIL`, the `LEGAL_*` pair, the `TURNSTILE_*`, `POSTHOG_*`, `META_*`,
`STRIPE_*` and `APIFY_*` settings, `REGISTRATION_ENABLED`,
`SCAN_ACCEPTANCE_ENABLED`, `SCANNER_CONCURRENCY`, `ANALYTICS_RUNTIME_ENV` —
keep the defaults `compose.yaml` gives them unless the file names them, and on
TEST the scanner's policy is fixed by `deploy/compose.agentify-test.yaml`
whatever the file says.

A value holding a `$` goes inside single quotes, as a bcrypt hash always does:
`ADMIN_BASIC_AUTH_HASH='$2a$14$…'`. Compose reads a `$` anywhere else as the
start of a variable, cuts the value there and prints the rest in a warning, so
`stack.sh` refuses such a file and names the key. The first release renders
the file and refuses, before it stops anything, if a variable is missing, the
preflight disagrees or the scanner refuses the configuration at its own start.

A host released by the Ansible release already has this file, rendered by its
last release, so writing it is a copy that leaves out the lines the new shape
does not read. On TEST, with `<revision>` the last one the old agent verified
(the last `"status": "verified"` line of
`/var/lib/agentify-pull-agent/test/history.jsonl`) and `<home>` the deployment
account's home directory:

```sh
sudo sh -c 'umask 077; mkdir -p /etc/agentify; grep -vE "^(AGENTIFY_(APP|WEB|SCANNER|SCANNER_WORKER|SCANNER_PRIVACY|POSTGRES|EDGE)_IMAGE|AGENTIFY_INGRESS_NETWORK)=" <home>/agentify-releases/<revision>/agentify.env > /etc/agentify/test.env'
```

The command prints no value. The files the old release kept beside it,
`report-identity-secret` and `scanner-admin.json`, are already inside what it
copies; `scanner-admin-password` is the only copy of TEST's admin password and
belongs wherever the operator keeps credentials.

## Production's one-time move to this release

**Not yet rehearsed.** PRODUCTION still runs the last revision its Ansible
release activated, as two Compose projects: the commerce project
`agentify-commerce` and the old scanner project `agentify`. Until the steps
below are done, an `app-v*` tag publishes the npm packages and deploys nothing.
The change that carries out this move proves these steps on the host and then
deletes this section.

First make sure nothing will fight the move: root's password state as above,
and no release running (`systemctl is-active agentify-pull@production.service`
must not print `activating`). Do it away from 04:23, when the old scheduled
privacy job runs.

Write `/etc/agentify/production.env` by hand. PRODUCTION's last Ansible release
predates the merged stack, so its rendered file
(`<home>/agentify-releases/<revision>/agentify.env`) holds the commerce
settings only, and the scanner's live in the old scanner project's own
environment file, beside the compose file `docker compose ls` names for the
project `agentify`. Start from the commerce file, append the scanner's lines,
and leave out what named machinery that is gone: every `*_DATABASE_URL` and
`DATABASE_MODE`, every `POSTGRES_*_PASSWORD` but the commerce one,
`RECONCILE_RUNTIME_ROLE_PASSWORDS`, `ROLE_PASSWORD_ROTATION_MAINTENANCE_ACK`,
`AGENTIFY_BACKUP_DIRECTORY`, `AGENTIFY_SCANNER_DB_NETWORK`,
`AGENTIFY_ALPINE_IMAGE`, and every `*_IMAGE` line. Keep `TOKEN_HMAC_SECRET` and
`EMAIL_ENCRYPTION_KEY` above all: a changed one breaks every report link and
every stored address already out there. `REPORT_IDENTITY_SECRET` comes from the
old configuration directory's `report-identity-secret`, and the admin user and
hash from the running edge's environment; the hash goes inside single quotes.
The public browser settings the old scanner read under `NEXT_PUBLIC_` names are
read under their plain names now: `TURNSTILE_SITE_KEY`, `PRIVACY_EMAIL`,
`ABUSE_EMAIL`, `LEGAL_OPERATOR`, `LEGAL_IDENTITY_CONFIRMED`,
`STRIPE_PUBLISHABLE_KEY`, `POSTHOG_BROWSER_KEY`, `POSTHOG_BROWSER_HOST`,
`POSTHOG_DESTINATION_ENV`, `META_PIXEL_ID`, `META_DESTINATION_ENV`, and
`ANALYTICS_RUNTIME_ENV` for `NEXT_PUBLIC_ANALYTICS_ENV`. Write it with mode 600,
owned by root, and keep the originals.

Then install the command, which also disables and removes the old
`agentify-pull@production` timer and service:

```sh
sudo deploy/install.sh production
```

Take a backup of both databases as they are, before anything else changes. It
goes into `/var/backups/agentify/production-before-move/`, outside the
channel's own directory, so the rotation of restore points never deletes it,
and it is written with umask 077, since the commerce dump holds merchants' keys
and WooCommerce credentials. `restore.sh` restores it like any restore point.

```sh
sudo sh -c 'umask 077; d=/var/backups/agentify/production-before-move; mkdir -p "$d"; for db in agentify_commerce agentify_scanner; do docker exec agentify-commerce-postgres-1 pg_dump -U agentify_commerce -Fc "$db" > "$d/$db.dump"; done; ls -l "$d"'
```

Retire the old scanner project. List its containers by the label Compose
wrote on them, read the list, and remove those and nothing else; the scanner's
data lives in the commerce database, which stays:

```sh
sudo docker ps -a --filter label=com.docker.compose.project=agentify --format '{{.Names}}'
sudo docker rm -f <the names that command printed>
```

From that moment the front page answers 502 until the release starts the new
scanner. Release, with the `app-v*` tag of the revision to move to. This first
release has no `current` to move forward from, so check first that the tag is
ahead of the revision production runs, which the cabinet's image label names:

```sh
sudo docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$(sudo docker inspect -f '{{.Image}}' agentify-commerce-cabinet-1)"
git merge-base --is-ancestor <that revision> app-v<X.Y.Z> && echo forward
sudo agentify-release app-v<X.Y.Z>
```

Two things the old scanner can leave behind hold `/api/health` at 503 and fail
the route check: a scan its worker was running when it was removed, and a scan
its web had queued. Find them in the scanner database and give them the
terminal status they never reached, then run the release again:

```sh
sudo docker exec agentify-commerce-postgres-1 psql -U agentify_commerce -d agentify_scanner -c \
  "update public.scans set status = 'failed' where status in ('accepted', 'queued', 'running') and accepted_at < now() - interval '10 minutes'"
```

Last, remove the private database network the old scanner project used, once
`docker network inspect` shows it has no containers left (`docker network ls`
names it).

## The Woo acceptance route on TEST

The experimental WooCommerce fixture is no part of a release. For its
acceptance runs, one explicit TEST operation installs a systemd unit that
translates the two named Compose networks' connections to the reviewed public
address, so DNS stays public and TLS keeps the public names. It lives in
`deploy/ansible/` with its own inventory, and is run from a clean checkout of
`main` at the reviewed revision:

```sh
ansible-playbook -i deploy/ansible/inventory.yml \
  -e @deploy/ansible/inventory.local.yml \
  deploy/ansible/woo-test-hairpin.yml --limit test \
  -e woo_hairpin_channel_ack=test -e woo_hairpin_action=reconcile \
  -e "woo_hairpin_revision=$(git rev-parse HEAD)"
```

`woo_hairpin_action=remove` removes the unit, its rules and its two files and
proves the rules are gone. A missing or malformed fixture, a different DNS
answer, or a failed connection in either direction refuses the operation.
