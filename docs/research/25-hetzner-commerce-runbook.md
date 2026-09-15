# Hetzner commerce migration

This is an operator procedure for moving the existing live commerce database to
`commerce.agentify.ad`. It does not authorize a server change or assert that a
cutover has happened. The test cabinet and its database remain on `dmitry-dev`.
The scanner site, worker, database and credentials are a later, separate move;
their production data must also be preserved. This procedure uses the existing
commerce Dockerfiles, `compose.yaml`, public override and database suite. It
does not replace the old live receiver, whose channel is tied to
`coinslot.nuanu.ai` and its old ingress.

## Prepare a release candidate

Use one reviewed 40-character commit SHA with successful CI for that exact SHA.
On the new VM, install the Ubuntu Docker, Compose v2 and Buildx packages, start
Docker, and verify `docker compose version` supports Compose's `!override` tag
(v2.24.4 or newer). The application checkout is
`/home/dmitry/agentify-commerce`; keep its `.env` mode 0600 and the directory
private. The Compose project is `agentify-commerce`. A preparation checkout
with uncommitted changes may be used for isolated testing but is not a
production release identity.

The live `.env` carries the existing live facilitator credentials, seeded key,
session-signing secret, invitation and mail configuration from the old live
instance. Copy these through a protected channel without printing their values.
Do not take anything from the test `.env`. Change only the target origin/address
and set a new URL-safe database password; `openssl rand -hex 32` yields a suitable
value. `deploy/hetzner-commerce.env.example` lists the required names. The new
database password is not a copy of the repository's laptop password. The
production Postgres volume starts empty and stays private to its Compose
project. Keep a protected off-VM copy of the final dump and configuration.

From the candidate checkout, the following commands refuse an incorrect live
chain, a laptop fixture, the wrong door, a public database port, unresolved
template values, a mail logger or local mail sender, and inconsistent database
credentials before a build or resident migration. `config --format json`
contains secrets; send it only down the pipe, never into a log or terminal.
Run candidate setup, scratch and final restore in one persistent Bash shell on
the new VM: the arrays and image names remain in that shell.

```bash
set -euo pipefail
cd /home/dmitry/agentify-commerce
approved_sha='REPLACE_WITH_REVIEWED_40_CHARACTER_SHA'
test "$(git rev-parse HEAD)" = "$approved_sha"
test -z "$(git status --porcelain --untracked-files=all)"
export COINSLOT_APP_IMAGE="agentify-commerce-app:${approved_sha}"
export COINSLOT_WEB_IMAGE="agentify-commerce-web:${approved_sha}"
compose=(sudo env COINSLOT_APP_IMAGE="$COINSLOT_APP_IMAGE" \
  COINSLOT_WEB_IMAGE="$COINSLOT_WEB_IMAGE" docker compose \
  --project-name agentify-commerce --env-file .env \
  -f compose.yaml -f deploy/compose.public.yaml \
  -f deploy/compose.hetzner-commerce.yaml)
actual_images="$("${compose[@]}" config --images | LC_ALL=C sort -u)"
expected_images="$(printf '%s\n' "$COINSLOT_APP_IMAGE" "$COINSLOT_WEB_IMAGE" \
  postgres:17-alpine | LC_ALL=C sort -u)"
test "$actual_images" = "$expected_images"
"${compose[@]}" config --format json | sudo docker run --rm -i --network none \
  -v "$PWD:/app:ro" -w /app node:24.21.0-alpine \
  node packages/core/src/deployment/preflight.mjs commerce
# Gateway, cabinet and migrate share one app image/tag. Build that image once
# through gateway; web is the other distinct image. Building every service in
# parallel races identical exports on Docker 29 / Compose 2.40.
"${compose[@]}" build gateway web
```

Run the dedicated database gate on a disposable Compose project, not on either
production database. The project's Postgres initializes `coinslot_test`; the
command rewrites only the container's `DATABASE_URL` to that scratch database.
The application images still carry Node 24.21.0 and pnpm 11.12.0.

```bash
test -n "${COINSLOT_APP_IMAGE:?run candidate setup first}"
test -n "${COINSLOT_WEB_IMAGE:?run candidate setup first}"
scratch=(sudo env COINSLOT_APP_IMAGE="$COINSLOT_APP_IMAGE" \
  COINSLOT_WEB_IMAGE="$COINSLOT_WEB_IMAGE" docker compose \
  --project-name agentify-commerce-scratch \
  --env-file .env -f compose.yaml -f deploy/compose.public.yaml \
  -f deploy/compose.hetzner-commerce.yaml)
"${scratch[@]}" up -d --wait postgres
"${scratch[@]}" run --rm --no-deps --user root gateway sh -c \
  'DATABASE_URL="${DATABASE_URL%/*}/coinslot_test" pnpm test:db'
"${scratch[@]}" down -v --remove-orphans
```

The scratch project must not start `web`: the production override binds port
443. In preparation, use the already protected, point-in-time source dump only
to prove a restore into a disposable Postgres instance with outbound network
disabled. Starting the production gateway or cabinet against a rehearsal copy
could send mail, poll a facilitator, or write state; it is outside this check.
A restored count proves the dump reads, not that it is the final cutover snapshot.

## Maintenance window and final backup

Before freezing writes, inspect incomplete payment claims and open orders in the
old live database. Record their identifiers and disposition without exposing
private customer details in the hand-over. Recheck immediately before stopping
the live application. Hold the existing shared release lock so an old receiver
cannot restart it mid-dump; keep the lock session open throughout backup and
activation. Stop only the old `coinslot` live `gateway`, `cabinet`, `merchant`
and `web` services. Keep old Postgres running, its volume unchanged, and the
`coinslot-test` project untouched.

In one persistent shell on `dmitry-dev`, hold the lock and stop just those
services. Do not close that shell until the final backup, restoration and
activation decision are finished.

```bash
set -euo pipefail
mkdir -p "$HOME/.cache"
exec 9>"$HOME/.cache/coinslot-deploy.lock"
flock -n 9
cd "$HOME/coinslot"
sudo docker compose --project-name coinslot stop gateway cabinet merchant web
sudo docker exec coinslot-postgres-1 psql -U coinslot -d coinslot -At \
  -v ON_ERROR_STOP=1 -c \
  "SELECT 'merchants='||count(*) FROM merchants UNION ALL
   SELECT 'accounts='||count(*) FROM cabinet_accounts UNION ALL
   SELECT 'cards='||count(*) FROM cards UNION ALL
   SELECT 'keys='||count(*) FROM merchant_keys UNION ALL
   SELECT 'orders='||count(*) FROM orders UNION ALL
   SELECT 'receipts='||count(*) FROM receipts UNION ALL
   SELECT 'claims='||count(*) FROM payment_claims"
```

Take a fresh custom-format `pg_dump` from the stopped-writes live database and
stream it to a 0700 directory on the new VM; avoid staging a second large file
on the source host. Transfer the old live `.env` through a protected channel as
0600, then create the new `.env` from it as described above. Record source
table counts for merchants, accounts, cards, keys, orders, receipts and payment
claims at the same freeze point. Retain the dump's SHA-256 and `pg_restore
--list` output, copy it to protected off-VM recovery storage, and prove a
throwaway restore before using it for the new production volume. A stream that
exits successfully but cannot be restored is not an accepted backup.

From a separate operator shell with both existing SSH aliases, stream the
stopped-writes database and configuration without printing the latter. The
destination directory is created as mode 0700 first. Preserve these files as
mode 0600, record the SHA-256, and validate the dump's catalog with the same
major PostgreSQL version before restoration. The filename identifies the
*final* stopped-writes dump; a preparation snapshot is kept under a different
name.

```bash
set -euo pipefail
ssh agentify 'install -d -m 700 /home/dmitry/agentify-backups'
ssh codex-vm 'sudo docker exec coinslot-postgres-1 pg_dump -U coinslot -d coinslot -Fc --no-owner --no-privileges' \
  | ssh agentify 'umask 077; cat > /home/dmitry/agentify-backups/commerce-final.dump'
ssh codex-vm 'cat /home/dmitry/coinslot/.env' \
  | ssh agentify 'umask 077; cat > /home/dmitry/agentify-backups/commerce-final.env'
ssh agentify 'sha256sum /home/dmitry/agentify-backups/commerce-final.dump; \
  sudo docker run --rm --network none \
    -v /home/dmitry/agentify-backups:/backup:ro postgres:17-alpine \
    pg_restore --list /backup/commerce-final.dump >/dev/null'
```

Create the new Compose project only after checking that its production volume
does not contain an earlier database. Start only `postgres`, restore the final
dump into its empty `coinslot` database with `pg_restore --single-transaction
--exit-on-error --no-owner --no-privileges`, and compare all recorded counts.
Refuse activation on a mismatch. Do not run `down -v` on either live project.
The new password belongs to the new Postgres service; the dump carries rows and
schema, not the old server password.

On the new VM, use the same Compose array as above. Reject an already existing
production data volume before `up`; a second invocation against a restored
volume needs an explicit inspection, never another blind import. The final
dump is fed to `pg_restore` without a shell log. Repeat the seven counts above
on the new `postgres` and compare them with the frozen source output.

```bash
test -z "$(sudo docker volume ls -q --filter name=agentify-commerce_coinslot-postgres)"
"${compose[@]}" up -d --wait postgres
"${compose[@]}" exec -T postgres pg_restore -U coinslot -d coinslot \
  --single-transaction --exit-on-error --no-owner --no-privileges \
  </home/dmitry/agentify-backups/commerce-final.dump
```

After the preflight/build/scratch gate and restore have passed, mark the
candidate as `activating`, then start `migrate`, `gateway` and `cabinet` for
that same approved SHA. The existing migration service runs both commerce
histories once, before either process becomes ready. Check Compose health and
database accounts, existing merchants/keys/cards/orders/receipts, login using
an existing account, and the catalog/API over the new internal network. Do not
use a real purchase as a deployment probe. A `healthz` answer alone does not
prove the database or paid-order history. Keep the old live application stopped
and old data intact.

The gateway can work in the background even while public DNS points
elsewhere. Before any decision to resume the old live application, stop the
new gateway and cabinet, compare orders, receipts, payment claims, keys and
merchant state with the restored baseline, and inspect their logs for
facilitator calls or other external effects. Unopened DNS is not evidence
that the new database and external payment state stayed unchanged.

The existing Caddy config issues via TLS-ALPN on port 443. The new VM's public
443 is free, but before `commerce.agentify.ad` points at it Caddy cannot prove
control of the name and a valid public certificate is not established. Opening
traffic is a later operator action: point the domain to the new VM, start
`web`, wait for its certificate and container health, then check `/`, `/docs/`,
`/cabinet/sign-in`, `/healthz`, `/cabinet/healthz` and `/x402/catalog` from an
external machine. The three HTML pages must say the `live` surface. Verify the
public API origin in a payment challenge without settling a charge. Give early
adopters the new URL and update integration origins explicitly; a redirect does
not make payment/API requests safe. Mark the SHA `origin-verified` only after
these outside-path checks and a recorded old/new data-owner inventory.

## Recovery

Before the new door opens, an acceptance failure stops the new application.
Resume the old live application against its unchanged database and domain only
after comparing the new instance with the restored baseline and ruling out
new payment or delivery effects. Keep the failed new volume and dump for
diagnosis; never treat a failed health check after migrations as proof that the
new schema did not move. If the new instance has accepted any write, preserve
a fresh new-database dump first and reconcile its orders/payment claims and
external effects before restoring service on the old instance. Never roll
back by blindly restoring the earlier source dump over newer data. The test
project remains untouched throughout.

When commerce has been accepted, plan the scanner move separately from the
same approved repository: inspect its actual production database, encryption
and signing material, external auth/Actor settings, running tasks and worker
effects; freeze acceptance and writes; take and validate a separate final dump
and off-VM backup; restore into a separate database/project; verify site,
reports, login and worker before DNS/worker activation. Do not combine scanner
and commerce databases or transfer private donor research into this repository.
