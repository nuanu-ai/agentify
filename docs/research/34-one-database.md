# One database

Date: 2026-09-23. A design note: how the two databases the product kept on one
PostgreSQL server, one for commerce and one for the scanner, became one
database, `agentify`, with one account; the choices the product owner made
and how they were built. ADR-0003 rests on it. The survey of the two databases
and of the hosts as they stood, and the plan of the cutover, are in git
history.

## The options

The survey put four ways to one database, smallest first. In Option 1 the
scanner's tables join `public` in one database: no query, drizzle schema or
migration file of the scanner changes, only one history table's name, one
pg-boss version, the connection strings and the Compose services around them,
and the risk it leaves, a future table name shared by two migration sets,
fails loudly in a check rather than silently. In Option 2 the scanner's
tables keep a schema of their own, which keeps the scanner's ownership visible
in the catalog at the price of about forty query edits or a connection setting
on four services. Option 3 gives the product one migration history and one
database package, which is worth it only when a change first has to touch two
migration sets at once. Option 4 lets the scanner read the dashboard's
tables directly instead of through the identity route, which is a decision
about who may write whose tables rather than about storage, and was not
proposed. The survey recommended Option 1, with the hosts' project renamed
in the same cutover.

## Decisions of 2026-09-23

The product owner decided the choices on 2026-09-23, one by one as this note
put them.

The scanner's tables join `public` (Option 1). The host rename rides with the
move, and the project becomes `agentify` on both hosts, with the volumes
`agentify-postgres` and `agentify-caddy`. The one database becomes `agentify`;
the account follows it to the same name if a second superuser for the moment
makes that work, which the implementation settles and records. The gateway
and the scanner share one `pgboss` schema on one pg-boss version. The scanner
database is dropped at the cutover once the move is verified, with the restore
point and the old volume holding it. Option 4 is not wanted now.

Nothing outside the repository reads the `metabase` views, and they go. Their
definitions stay reachable in git: `ops/dashboards/install-aggregate-views.sql`
and the dashboard queries beside it, as they were before commit `ad5a772`
deleted them. The cutover compares the hosts' view definitions with that file
before it drops them and records any difference in its report, and the
restore point taken before the move holds the views as the hosts had them.

## How it was built

Option 1 with the host rename, as decided, and the recommendation holds: the
scanner's tables sit in `public` of `agentify`, its history in
`drizzle.scanner_migrations`, and the gateway and the scanner share one
`pgboss` schema on pg-boss 12.28.0. Where the build departs from what this
note proposed, the proposal was wrong or incomplete, and the build is what
stands.

The `scanner-migrate` service stays. The app image leaves the scanner's
packages out (`deploy/Dockerfile.app.dockerignore`), so `migrate` cannot run
the scanner's set; both services now point at the one database. The guard
against a table name shared by two sets, or two sets sharing a history, is
not a CI step but a test in `pnpm scanner:test:db`, which applies the three
sets to one database twice and then a gateway migration dated inside the
scanner's range.

Something in the repository did read the `metabase` views: the operator page
at `/admin`, through four of them. A database built from the migrations has
none, so that page answered with an error on every laptop, and dropping the
views would have broken it on both hosts. The four queries now live in
`apps/web/lib/server/operator-dashboard.ts`, read the tables, and are tested
on a database the migrations built. `DASHBOARD_DATABASE_URL` and its second
pool are gone.

The account follows the database. PostgreSQL refuses to reassign or drop the
role initdb created ("required by the database system"), so "create,
reassign, drop" cannot work, but a temporary superuser can rename it, and a
SCRAM password survives a rename; both were measured on 17.11. TEST's
database password was the laptop default printed in `compose.yaml`, which is
now `agentify`, so the cutover gives the account the password the new
configuration names on each host, PRODUCTION's own included.

The cutover was a script run once on each host and removed afterwards, with
its section of the runbook. It ran after a first release of the revision had
pulled its images and been refused for want of the new volume, which the
release checks before it stops anything; it wrote no transition record, since
`current` still named the revision whose data the moved database held, and
the second release took its own restore point of the one database. A
rehearsal on a laptop, with the four roles, 88 policies, 15 metabase views
and data seeded through the applications, found defects in the script before
any host saw it; the comparison with a fresh build by catalog was done there
once. TEST moved on 2026-09-25 in 14 seconds, 59 tables row for row, with
about 54 seconds of downtime. PRODUCTION moved the same day with `app-v0.5.0`
in 11 seconds, 59 tables row for row; an outside observer saw it answer 502
for about a minute, and the first snapshot of the new database restored whole.
The `metabase` views on both hosts differed from the file in git only in the
order of one column.
