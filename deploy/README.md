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
/var/lib/agentify/<channel>/current      the revision whose data the channel holds: the last one verified, or the one a restore went back to
/var/lib/agentify/<channel>/failed       the last revision that was refused or failed
/var/lib/agentify/<channel>/transition   a release or a restore under way or unfinished ("When a release fails")
/var/lib/agentify/<channel>/cards-before the cards on sale before that release, one per line
/var/lib/agentify/<channel>/tags         which app-v* tag points at which revision, as the last run found them
/var/lib/agentify/<channel>/seen         the revision TEST's timer is waiting for, and since when
/var/lib/agentify/<channel>/checkouts/   one checkout per revision; the current one stays
/var/lib/agentify/<channel>/postgres-init/ the database's init scripts, copied from the release's checkout
/var/lib/agentify/<channel>/release.lock the command's lock: one release at a time
/run/lock/agentify-release.lock          activation's lock, shared by restores and the nightly privacy job
/var/backups/agentify/<channel>/         the restore points, one directory per release
/etc/cron.d/agentify-release             the nightly privacy job, written by each verified release
/etc/agentify/backup.env                 PRODUCTION only: the backup repository's password and S3 key, root, mode 600
/var/lib/agentify/production/backup-status  the last backup and the last restore rehearsal ("Backups")
```

The database mounts its init scripts from `postgres-init/` rather than from a
checkout, so a release whose scripts and PostgreSQL image are unchanged leaves
the database's container as it is: same container, no restart. The first
release that mounts them from there recreates the container once, as TEST's
did on 2026-09-23.

Everything under `/var/lib/agentify` holds nothing secret — revision names,
checkouts of this public repository — so it is readable by anyone on the host,
and the status commands below need no `sudo`. The environment file and the
restore points are root's alone, so listing them takes `sudo`. Everything
about a running channel goes through one command line,
`deploy/stack.sh <channel> <compose arguments>`, run as root from a checkout
under `checkouts/`; every checkout there describes the same project, and the
newest is the one to use:

```sh
ssh -t agentify-test 'sudo "$(ls -dt /var/lib/agentify/test/checkouts/*/ | head -n 1)deploy/stack.sh" test ps'
ssh -t agentify-test sudo ls /var/backups/agentify/test
```

A revision here is a full commit SHA. PRODUCTION is released by `app-v*` tag,
so messages and the transition record name the tags that point at a revision
where there are any; `tags` holds them as the last run found them. From a
checkout of this repository, `git fetch --tags origin` and then
`git tag --points-at <sha>` names them too.

## How a release works

A release is one command on the host, `agentify-release <name>`. Started by a
person, it does not release from the terminal: it hands the release to a
transient systemd unit, `agentify-release-<channel>.service`, and follows that
unit's journal until it ends, so a dropped connection or Ctrl-C stops only the
following and the release goes on. A restore, `agentify-release --restore`,
runs the same way in the same unit. Nothing restores a database but a person
running that.

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
writes the channel's transition record, stops the gateway, the cabinet, the
scanner and its worker, takes a restore point of both databases, runs the
migrations, starts everything again, on PRODUCTION installs the edge's route
table, which the edge's own Caddy has validated before the stop, checks ten
public routes, checks that every card on sale before the stop is still on sale
and answers its payment challenge on the channel's network, schedules the
nightly privacy job, writes `current`, removes the record, and drops the
databases an earlier restore replaced. The command needs no GitHub credential, and nothing in GitHub can reach a
host.

The card check spends nothing: a GET on a purchase address is always answered
with the challenge and never read for payment. It reads the catalog as the one
document the catalog is, since paging is not designed yet, and it asks every
card in turn, so it takes a request per card. What the checks leave out is
recorded in `docs/research/00-open-questions.md`.

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

If the connection drops, the release goes on: on TEST an SSH connection killed
three seconds into a release left the unit to finish and verify it. Follow it
again, or read it afterwards, with:

```sh
ssh -t agentify sudo journalctl -u agentify-release-production.service -f
```

The releases timed on a host so far are TEST's. On 2026-09-23 its timer
released a revision in 1 minute 50 seconds from moving the tag to the verified
line: the pull took 12 seconds and activation 30, with about 22 seconds of
downtime, and the card check covered the 3 cards then on sale. On 2026-09-24
activation took 33 seconds, the database's container stayed as it was, and
the card check again covered 3 cards. The pull is the part that varies, and it
happens before anything stops: it took 12 minutes 53 seconds on 2026-09-23 and
9 minutes 37 seconds on 2026-09-24, both times held up by scanner images that
GHCR served slowly, for a reason not found yet. On PRODUCTION the dumps, and
so the downtime, grow with the data.

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
failed, and nothing while an earlier release waits for a person ("When a
release fails"); it does not record the tag's revision as failed for that. It
waits while GitHub lists no build of the commit yet, or the build is still
running, or the images did not arrive, and asks again at the next tick; after
30 minutes of waiting for one revision since the host last started, it records
the wait as a failure. Otherwise it releases, so a revision reaches TEST within
a minute of its images being ready. Watch it happen, and see what TEST runs
afterwards:

```sh
ssh -t agentify-test "sudo journalctl -u 'agentify-release*' -f"
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
go through; on TEST, a person's run while something else held the release lock
returned 75 through the unit and recorded nothing as failed. Both are in the
journal: a person's runs under `agentify-release-<channel>.service`, TEST's
timer's under `agentify-release.service`.

A refusal before the four applications stop changes nothing: the previous
release keeps running as it was. This covers a name the channel does not take;
a build that failed or was not listed, CI that failed or has not finished, a
move backwards; images that did not arrive within 30 minutes or do not carry
the revision's label; an environment file with a `$` outside single quotes, a
configuration that does not render, that the preflight refuses or that the
scanner refuses at its own start; a PostgreSQL image other than the pinned
one; a PRODUCTION edge other than the reviewed one, or a route table its Caddy
does not accept; too little room for the restore point; and an earlier release
or restore that waits for a person, below. Fix the cause and run the same
command again.

### The transition record

From just before the four applications stop until the release is verified, the
channel has a transition record, `/var/lib/agentify/<channel>/transition`. It
is a small JSON file that names the revision that ran before (`from`), the one
being released (`to`) and the `app-v*` tags of each, its restore point
(`restore`), the file of the cards on sale before the release (`cards`), and
how far the release got (`phase`). Anyone on the host can read it:

```sh
ssh agentify-test cat /var/lib/agentify/test/transition
```

The phase is `stopped` once the applications are stopping, `dumped` once the
restore point is whole and on disk, `migrating` from just before the first
migration, and `started` from just before the new release starts, from which
moment it may take orders. A verified release writes `current` and only then
removes the record, so the two never disagree about the revision whose data
the databases hold. While a record is open, the nightly privacy job does not
run; it logs to the journal that it skipped, and why.

Nothing restores a database by itself. What a failure leaves depends on the
phase, and the failure's last line says which applications run afterwards and
whether the channel is down:

- `stopped` or `dumped`: no migration ran, so the databases are untouched, and
  the stopped applications start again on the previous release. Once they
  have, the transition is over and the record goes. When the release was a
  fix-forward, the release it was to fix was itself unverified, so that
  release's `started` record comes back instead. If the applications do not
  start, the record stays, and running the same revision again carries the
  release on.
- `migrating`: the databases may hold part of the new release's migrations,
  so all four applications stay stopped and the record stays: the channel is
  down until a person acts. There are two ways out, and the message prints
  both. Once the cause is fixed, run the same release again: it carries the
  migrations on from the same record and starts the release. Or put the
  databases back with the restore command the message prints, below.
- `started`: nothing is restored, whether by the failure or by running again,
  because the new release may already have taken orders. It runs, unverified,
  on the migrated databases. If the scanner does not start, commerce is
  started anyway and the scanner stays down.

A release killed outright — `kill -9`, a crash, the power — leaves the record
at the phase it had reached. From `stopped` until `started` the applications
are stopped, so the site stays down until someone runs the same command again;
on PRODUCTION nothing retries by itself. A stop request from systemd, and an
interrupt, take the same way as a failure at the same point.

A release that finds a record acts on it. The same revision carries the
release on: before `started` it reuses the record's restore point and cards,
taking the restore point only if the first run did not get that far; from
`started` it only goes forward, with no stop and no dump, running the
migrations again (they are already applied), starting, and checking the
routes, and the cards against those on sale before the first run rather than
what the failed run left. A revision that moves forward from a `started`
record's revision goes ahead: it stops the applications, takes a fresh restore
point of the data as it is now, named after the started revision, and
replaces the record, keeping its cards; this is how a release that started but
failed its checks is fixed forward. A revision that does not move forward from
it is refused. While the record is before `started`, any other revision waits
(exit 75), naming the unfinished release and the ways out: release that
revision again, or restore its restore point; when it stopped before its
restore point was taken, no migration ran and moving the record aside, as
below, is enough. While a restore is unfinished, every release waits until
the restore has been run again and has succeeded. Every refusal and wait while
an earlier run left the applications stopped says what runs, and that the
channel is down when nothing does.

A record the command cannot read — a disk fault, a hand edit — holds every
release and restore back with a refusal. Move it aside, which tells the
command that no transition is open:

```sh
ssh -t agentify-test sudo mv /var/lib/agentify/test/transition /var/lib/agentify/test/transition.unreadable
```

Before releasing anything after that, check that `current` names the
revision whose data the databases hold. The gateway's image names the
revision that last started, and `docker ps` shows whether the applications
run; when the two disagree with `current`, write the revision that ran into
`current` by hand, since the next release decides between checking again and
migrating by it:

```sh
ssh -t agentify-test 'sudo docker inspect -f "{{index .Config.Labels \"org.opencontainers.image.revision\"}}" $(sudo docker inspect -f "{{.Image}}" agentify-test-gateway-1)'
```

On PRODUCTION the gateway's container is `agentify-commerce-gateway-1`.

With no record open, running the revision the channel already runs stops
nothing: it pulls, checks the configuration, starts whatever is not running
and checks the routes and the cards again. On TEST that took 11 seconds and
ended with exit status 0. Trying again is always the same command: on TEST,
`sudo agentify-release deploy-test`, and on PRODUCTION the same `app-v*` tag.

### Restoring

A restore point is `/var/backups/agentify/<channel>/<time>-<previous>-before-<new>/`:
the data of the revision `<previous>`, as it was just before `<new>` began to
migrate it, with the PRODUCTION edge's previous `Caddyfile` beside it. Every
release that switches revisions takes one, a rerun of an unfinished release
reuses its own, and the five newest are kept. Restoring one loses everything
written to the databases after it was taken. Restore when a release left the
channel down while migrating and running it again is not the way out, or when
a person has decided the data has to go back. The failure message prints the
command; otherwise it is:

```sh
ssh -t agentify-test sudo agentify-release --restore /var/backups/agentify/test/<time>-<previous>-before-<new>
```

On PRODUCTION the same command runs over `ssh -t agentify`, with `production`
in the path. Like a release, it runs as `agentify-release-<channel>.service`,
so a dropped connection does not stop it halfway, and it waits while a release
runs. It restores every database the directory holds a dump of,
`<database>.dump`; a release's restore point holds both. It checks that the
database volume has room for a second copy of them, marks the record as
restoring, which holds every release back, stops the four applications,
restores each dump into a scratch database, and only when all are whole swaps
them in, in one transaction. The databases it replaced stay beside them as
`<database>_replaced_<time>` until the next verified release drops them, so a
restore made by mistake can still be undone by hand until then.

A bad dump or a failure before the swap leaves the databases as they were and
the record as the restore found it, so it holds no release back, and the
message says what to try: the same restore again if the cause has passed,
another restore point if the dump itself is bad, or a release of the revision
the databases hold. A restore killed outright leaves the record marked as
restoring, and running it again starts over. When a restore succeeds,
`current` names `<previous>`, the revision whose data the databases now hold,
or no revision at all when the directory is not named after one, as with a
restore point taken before the first release or the backup of PRODUCTION's
move; the record is gone, and the applications are stopped, so the channel is
down until a release starts them. Then release `<previous>` again, on TEST with
`sudo agentify-release <previous>` and on PRODUCTION with its `app-v*` tag:
since `current` names it, that release stops nothing and starts it, while a
release of `<new>` or of anything later migrates again. The edge's previous
`Caddyfile` is for a person to copy back if the route table was the problem; a
restore does not touch the edge.

A release that passed its checks and turns out bad later is fixed forward, not
restored: revert or fix it on a branch, merge to `main`, tag the new commit and
release that tag. Restoring its restore point would lose every order and
receipt written since, and the command refuses to move production backwards
from the revision `current` names.

## Backups

PRODUCTION is backed up off the host every ten minutes into the restic
repository in the bucket `nuanu-agentify-backups` (Hetzner Object Storage,
fsn1, project "Nuanu AI prod backups"); ADR-0029 says why this way. The
recovery point is ten minutes: whatever was written in the ten minutes before a
loss is gone, and nothing sooner can be recovered. A snapshot holds a dump of
each of the channel's databases, the server's roles, the row count of every
table, `production.env` and `release.json`. It never holds
`/etc/agentify/backup.env`, which holds the repository's password and the S3
key; the password is also in Dmitry's 1Password, and the key can be issued
again in the Hetzner console. Snapshots are kept for the last day, one an hour
for two days and one a day for thirty days.

A restore is rehearsed by a person, never on a schedule: the rehearsal restores
the latest snapshot into scratch databases `check_<database>` beside the live
ones, which it never touches, compares every table's row count with the count
the snapshot recorded, drops the scratch databases however it ends, and writes
its result into the status file. It takes seconds and exits non-zero if the
snapshot does not restore whole:

```sh
ssh agentify sudo systemctl start agentify-backup-check.service
ssh agentify cat /var/lib/agentify/production/backup-status
```

There is no alert yet. A failed backup or rehearsal writes one line at priority
err to the journal, and the status file says when each last succeeded, so look
at both:

```sh
ssh agentify cat /var/lib/agentify/production/backup-status
ssh -t agentify sudo journalctl -t agentify-backup -p err --since -2d
ssh agentify systemctl list-timers 'agentify-backup*'
```

A backup waits up to five minutes for a release to let go of the release lock
and then gives up until the next run, which the journal also records as a
failure. Everything else below runs in a root shell on the host that has read
`backup.env`, which lists the snapshots, newest last:

```sh
ssh -t agentify sudo -i
set -a; . /etc/agentify/backup.env; set +a
restic snapshots --compact
```

To put one database back as a snapshot holds it, restore its dump into a
directory and restore that directory, which stops the applications, swaps the
database in and keeps the one it replaced, as under "Restoring" above. Leave
out `--include` to restore every database. No revision is current afterwards,
so release the tag PRODUCTION ran, which migrates the data forward if the
snapshot is older and starts the applications:

```sh
point=/var/backups/agentify/production/$(date -u +%Y%m%dT%H%M%SZ)-snapshot-<id>
restic restore <id> --target "$point" --include /agentify_scanner.dump
agentify-release --restore "$point"
agentify-release app-v<X.Y.Z>
```

A new S3 key goes from the Hetzner console to the host through the Mac's
clipboard, so it never shows on a screen: run this on the Mac, copy each value
in the console when it asks, and press Enter. Nothing typed or pasted at these
prompts is shown. Then run a backup to see that the key works:

```sh
/bin/bash -c 'for value in "the access key" "the secret key"; do
  read -rs -p "Copy $value in the Hetzner console, then press Enter. " _ </dev/tty; echo >&2
  printf "%s\n" "$(pbpaste)"; done' | ssh agentify sudo agentify-backup-credentials --stdin
ssh agentify sudo systemctl start agentify-backup.service
```

The bucket keeps an object's older versions, and a lifecycle rule deletes a
version 30 days after it stopped being current, so a snapshot restic prunes can
still be fetched from the bucket for a month. Object Lock retention is not
set, so whoever holds the S3 key can delete every version. The rule was set
once, with nothing but curl, and the second call shows it:

```sh
ssh agentify sudo bash -s <<'SH'
set -a; . /etc/agentify/backup.env; set +a
rule='<LifecycleConfiguration><Rule><ID>noncurrent-30-days</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status><NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>'
s3() { printf 'user = "%s:%s"\n' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" | curl -fsS -K - --aws-sigv4 "aws:amz:$AWS_DEFAULT_REGION:s3" "$@" "${RESTIC_REPOSITORY#s3:}?lifecycle"; }
s3 -X PUT -H "Content-MD5: $(printf %s "$rule" | openssl dgst -md5 -binary | base64)" --data-binary "$rule"
s3; echo
SH
```

To rebuild PRODUCTION on a new host, start from Ubuntu 24.04 with Docker and
Compose on the nuanu mesh and a checkout of `main`, and give the host
`backup.env`: the bucket and the password first, the password copied from
1Password, then a new S3 key issued in the console, as above but with
`sudo deploy/backup-credentials.sh --stdin` from the checkout:

```sh
ssh <new host> "sudo sh -c 'umask 077; printf \"RESTIC_REPOSITORY=s3:https://fsn1.your-objectstorage.com/nuanu-agentify-backups\nAWS_DEFAULT_REGION=fsn1\n\" > /etc/agentify/backup.env'"
/bin/bash -c 'read -rs -p "Copy the repository password in 1Password, then press Enter. " _ </dev/tty; echo >&2
  printf "RESTIC_PASSWORD=%q\n" "$(pbpaste)"' | ssh <new host> "sudo sh -c 'cat >> /etc/agentify/backup.env'"
```

Then, in a root shell on the new host that has read `backup.env`, take
`production.env` out of the snapshot to rebuild from, install, and hold the
backup timer until the data is back, so no snapshot of empty databases becomes
the latest. The edge Caddy, with the network `agentify-ingress` it needs, is set
up from `deploy/edge/` and the name `agentify.ad` pointed at the new host as on
the old one; neither is in this runbook. The production overlay refuses to
start on volumes it did not find, so the two are created empty. The first
release creates empty databases, the snapshot's roles go in before its dumps,
whose grants name them, and the second release starts the applications on the
restored data:

```sh
restic restore <id> --target /root/from-backup
install -m 600 /root/from-backup/production.env /etc/agentify/production.env
deploy/install.sh production && systemctl stop agentify-backup.timer
docker volume create agentify-commerce-postgres && docker volume create agentify-commerce-caddy
agentify-release app-v<X.Y.Z>
"$(ls -d /var/lib/agentify/production/checkouts/*/ | head -n 1)deploy/stack.sh" production exec -T postgres psql -U agentify_commerce -d postgres < /root/from-backup/roles.sql
point=/var/backups/agentify/production/$(date -u +%Y%m%dT%H%M%SZ)-snapshot-<id>
mkdir -m 700 "$point" && cp /root/from-backup/*.dump "$point/"
agentify-release --restore "$point" && agentify-release app-v<X.Y.Z>
systemctl start agentify-backup.timer && rm -rf /root/from-backup
```

The roles' replay reports that `agentify_commerce` already exists, which is
expected.

## Setting up a host

A host needs Docker with Compose, `flock`, `curl`, `git` and `python3`, and
its channel's environment file in place before anything else. From a checkout
of `main` on the host:

```sh
sudo deploy/install.sh test          # or: production
```

It installs `agentify-release`, `/etc/agentify/release.json` and, where
needrestart is installed, the rule that keeps needrestart from restarting a
release in the middle of an activation, the timer's unit and a person's alike.
On TEST it also installs and starts the timer (`agentify-release.timer`);
PRODUCTION gets no timer. The first release writes the nightly privacy job's
line; until then a new host has none. The command on a host is whatever this
last installed, and a release does not update it: when a change reaches
`main` that touches `deploy/agentify-release`, `deploy/install.sh`, the backup
scripts or any of the units, run `install.sh` again from a checkout of that
`main`. On PRODUCTION it also installs the backup ("Backups" below) and refuses
until `/etc/agentify/backup.env` exists, root's with mode 600. TEST takes no
backups, since its data is test data.

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
