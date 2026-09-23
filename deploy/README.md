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
/var/lib/agentify/<channel>/checkouts/   one checkout per revision; the current one stays
/var/lib/agentify/<channel>/release.lock the command's lock: one release at a time
/run/lock/agentify-release.lock          activation's lock, which the nightly privacy job shares
/var/backups/agentify/<channel>/         the restore points, one directory per release
/etc/cron.d/agentify-release             the nightly privacy job, written by each release
```

Everything about a running channel goes through one command line,
`deploy/stack.sh <channel> <compose arguments>`, run from the checkout of the
revision it runs. That checkout is named by `current`:

```sh
ssh -t agentify-test 'sudo /var/lib/agentify/test/checkouts/$(cat /var/lib/agentify/test/current)/deploy/stack.sh test ps'
```

The state directory holds nothing secret — revision names and checkouts of
this public repository — so anyone on the host can read it; the environment
file, which the stack needs, is root's alone, hence `sudo`.

## How a release works

A release is one command on the host, `agentify-release <name>`. It asks the
public repository which commit the name stands for, then asks GitHub's public
API for the five images that commit's image build published
(`.github/workflows/images.yml` builds them for every commit pushed as the
head of a branch and publishes their digests in a notice; the header of that
file states how the notice is read). It fetches the commit into its own
checkout and runs that checkout's `deploy/activate.sh`, which pulls the images
by digest, has the release's own preflight check the channel's configuration,
stops the gateway, the cabinet, the scanner and its worker, takes a restore
point of both databases, runs the migrations, starts everything again, on
PRODUCTION installs the edge's route table, checks ten public routes and
schedules the nightly privacy job. Nothing before the stop touches the running
release. The command needs no GitHub credential, and nothing in GitHub can
reach a host.

On PRODUCTION the name has to be an `app-v*` tag, the image build has to be a
push to `main`, `main`'s CI run for the commit has to have succeeded, and the
commit has to move forward from the one the host runs. TEST takes a tag, a
branch or a full commit SHA, as long as its images were built.

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

Pushing the tag publishes the npm packages (`publish-sdk.yml`) and nothing
else. The release itself is one command, run by a person with mesh access:

```sh
ssh -t agentify sudo agentify-release app-v<X.Y.Z> 2>&1 | tee release-app-v<X.Y.Z>.log
```

`-t` gives `sudo` a terminal to ask for a password on, and `tee` keeps the
output on your machine, because on PRODUCTION the terminal is the only place
it goes. The output reads top to bottom as the release goes. The command
prints `agentify-release: activating app-v<X.Y.Z> (<sha>) on production`, and
then activation prints one line per step, each beginning `activate:` —
pulling the images, checking the channel's configuration (followed by the
preflight's own `preflight: the production channel is what it claims to be`),
stopping the four applications, taking the restore point, the two migrations,
starting the scanner, starting commerce and the route table, installing the
edge's route table, checking the public routes, scheduling the privacy job
and, when the previous release's images are no longer needed, removing them.
Compose's own lines about containers stopping, starting and becoming healthy
come in between. A finished and verified release ends with these two lines and
exit status 0:

```text
activate: production runs <sha> and answers on every route checked.
agentify-release: production runs <sha>, verified
```

How long that takes has been measured only in the rehearsal on a laptop,
with empty databases and the images already present: a first release took 25
seconds from the command to its last line, the same revision again 24
seconds, and a release whose migration sleeps for forty seconds 94. Pulling
the five images of one revision of `main` from the registry, measured
separately over the same laptop's connection, took 1 minute 26 seconds, and
that happens before anything stops. On a host the dump grows with the data,
and the applications are down from the stop to the end of the route check.

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
failed; it waits, quietly, while the commit's images are still being built,
which takes a few minutes after a push; otherwise it releases. So a revision
reaches TEST within a minute of its images being ready. Watch it happen, and
see what TEST runs afterwards:

```sh
ssh agentify-test journalctl -u agentify-release.service -f
ssh agentify-test cat /var/lib/agentify/test/current
```

A person can also release on TEST directly, with any tag, branch or SHA that
has images; this is also how a failed TEST revision is tried again:

```sh
ssh -t agentify-test sudo agentify-release my-branch
```

## When a release fails

A refusal is one sentence that begins `agentify-release: refused:` or
`activate:` and says what was wrong. What it leaves behind depends on where it
stopped.

A refusal before the four applications stop changes nothing: the previous
release keeps running as it was. This covers a name that is not what the
channel accepts, images still being built or never built, a failed CI run, a
move backwards, images that cannot be pulled or do not carry the revision's
label, a configuration that does not render or that the preflight refuses, a
PostgreSQL image different from the pinned one, a PRODUCTION edge that is not
the reviewed one, and too little room for the restore point. Fix the cause
and run the same command again.

A failure between the stop and the end of the migrations — the restore point,
the scanner's migration, the gateway's and the cabinet's — starts the four
applications again on the previous release and names the step and the newest
restore point. The migrations run one set after another, each set in one
transaction: the scanner's, then the gateway's, then the cabinet's. The set
that failed changed nothing, but the sets before it stay applied, and the
previous release now runs on top of them. That is safe while migrations only
add, which is how they are written; when one did more, restore.

If the scanner does not start after the migrations, commerce is started anyway
and runs the new revision; the scanner stays down until the cause is fixed and
the command is run again. A failure after that — commerce not becoming
healthy, the edge, the routes — leaves the new revision partly running on the
migrated databases, where the previous release cannot simply start again. Fix
the cause and run the command again; it takes no second restore point while
the gateway already runs the new revision.

A release killed in the middle, by a lost SSH session or a reboot, records
nothing. On TEST the next tick runs it again; on PRODUCTION run the command
again. Activation can always be run again, so trying again is the same
command: on TEST, `sudo agentify-release deploy-test` (a person's run never
skips a revision that failed), and on PRODUCTION the same `app-v*` tag.

The log is the terminal on PRODUCTION (hence the `tee` above) and the journal
on TEST, `journalctl -u agentify-release.service`.

Restore from a restore point only when the databases have to go back: a
migration that did more than add, or data a release damaged. Each release that
switches revisions dumps both databases with `pg_dump -Fc` into
`/var/backups/agentify/<channel>/<time>-<revision>/`, with the PRODUCTION edge's
previous `Caddyfile` beside them, before its first migration. A retry never
overwrites an earlier one, and the five newest are kept. To restore, stop the
applications and recreate both databases from their dumps, as root:

```sh
channel=<test or production>
stack=/var/lib/agentify/$channel/checkouts/$(cat /var/lib/agentify/$channel/current)/deploy/stack.sh
backup=/var/backups/agentify/$channel/<time>-<revision>
$stack $channel stop gateway cabinet scanner scanner-worker
for database in agentify_commerce agentify_scanner; do
  $stack $channel exec -T postgres pg_restore -U agentify_commerce -d postgres --clean --create < $backup/$database.dump
done
```

`--create` drops each database and makes it again from the dump, so tables a
migration added go too. Then release the revision the dumps belong to: on
TEST, `sudo agentify-release <that revision>`; on PRODUCTION, that revision's
`app-v*` tag, which the command accepts as long as it is the one `current`
names — a release that failed never became `current`. Going back past a
verified release is a move backwards, which the command refuses; that is a
decision to make with the team, not a command.

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
`/var/lib/agentify-pull-agent`. Running it again updates the command.

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
whatever the file says. The first release renders the file and refuses, before
it stops anything, if a variable is missing or the preflight disagrees.

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
hash from the running edge's environment. The public browser settings the old
scanner read under `NEXT_PUBLIC_` names are read under their plain names now:
`TURNSTILE_SITE_KEY`, `PRIVACY_EMAIL`, `ABUSE_EMAIL`, `LEGAL_OPERATOR`,
`LEGAL_IDENTITY_CONFIRMED`, `STRIPE_PUBLISHABLE_KEY`, `POSTHOG_BROWSER_KEY`,
`POSTHOG_BROWSER_HOST`, `POSTHOG_DESTINATION_ENV`, `META_PIXEL_ID`,
`META_DESTINATION_ENV`, and `ANALYTICS_RUNTIME_ENV` for `NEXT_PUBLIC_ANALYTICS_ENV`.
Write it with mode 600, owned by root, and keep the originals.

Then install the command, which also disables and removes the old
`agentify-pull@production` timer and service:

```sh
sudo deploy/install.sh production
```

Take a backup of both databases as they are, before anything else changes:

```sh
sudo sh -c 'd=/var/backups/agentify/production/$(date -u +%Y%m%dT%H%M%SZ)-before-move; mkdir -p "$d"; for db in agentify_commerce agentify_scanner; do docker exec agentify-commerce-postgres-1 pg_dump -U agentify_commerce -Fc "$db" > "$d/$db.dump"; done; ls -l "$d"'
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
