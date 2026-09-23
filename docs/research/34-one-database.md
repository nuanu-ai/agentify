# One database

Date: 2026-09-23. A design note, not a decision: a survey of the two
databases the product keeps on one PostgreSQL server, and a proposal for
making them one. The code for it follows the branch that replaces the Ansible
release with `deploy/activate.sh` and the `agentify-release` command, because
both change the release path and the migrations; the release of it follows
production's move onto that path and the off-host backup.

## How to read this note

The facts below were collected on 2026-09-23 between 10:40 and 11:15 UTC. On
the two deployed hosts only read-only catalog queries, row counts and
`pg_dump --schema-only` were run, in sessions forced read-only; nothing was
written, stopped or moved. The hosts are TEST (`ssh agentify-test`, hostname
`dmitry-dev`) and PRODUCTION (`ssh agentify`, hostname `agentify-prod-1`).
The comparison with the repository used a throwaway PostgreSQL 17.11 on a
laptop, migrated by the repository's own commands at commit a7ee2dc and then
removed.

Every fact carries where it comes from. [TEST] and [PRODUCTION] mean measured
on that host; [both hosts] means measured on each with the same answer;
[code] means read in the repository at a7ee2dc; [rehearsal] means measured on
the laptop copy; [guess] means not measured. Where the answer is not known the
note says "I don't know" and names what would settle it. Row data appears
nowhere; counts do.

Some words are used in one sense throughout. The *commerce database* is
`agentify_commerce`, which the gateway and the cabinet use. The *scanner
database* is `agentify_scanner`, which the scanner's web application
(`apps/web`), its worker (`apps/scanner-worker`) and its nightly privacy job
use. A *migration set* is one folder of drizzle SQL files with its journal:
the gateway's `apps/gateway/drizzle`, the cabinet's `apps/cabinet/drizzle`
and the scanner's `packages/scanner-database/migrations`. A *history table*
is the table in which drizzle's migrator records what it has applied from one
set; the migrator runs every file whose journal timestamp is later than the
newest timestamp recorded there, and it compares nothing else [code]. The
*bootstrap account* is `agentify_commerce`, the superuser the PostgreSQL image
creates. The *four service roles* are `agentify_web`, `agentify_worker`,
`agentify_privacy` and `agentify_dashboard`, which ADR-0024 records as
deleted. The *identity route* is the cabinet's internal
`POST /internal/report-identity` on port 3002, which only the scanner calls.
A *restore point* is the set of `pg_dump -Fc` files `deploy/activate.sh`
writes to `/var/backups/agentify/<channel>/<time>-<revision>/` before it
migrates. The *cutover* is the one stop during which the data moves. A
*fingerprint* of a table is its row count together with the md5 of the text
of all its rows in a fixed order. The *seam* is the boundary at which the
scanner's data and the rest of the product's data meet. The *route table* is
the Compose service `web`, a Caddy that sends each path to the application
that answers it.

## The two databases today

### The server

Both hosts run one PostgreSQL 17.11 server, the Alpine image with digest
`sha256:18cfe3ef…5d73`; CI pins the same digest, and the laptop's floating
`postgres:17-alpine` tag resolves to it today [both hosts, code]. Each server
holds `agentify_commerce`, `agentify_scanner`, the scratch database
`agentify_commerce_test`, `postgres` and the two templates, all owned by the
bootstrap account, UTF-8, `en_US.utf8`, libc collation [both hosts]. The only
extension is `plpgsql`. There is no trigger, no event trigger, no publication,
no subscription, and no function outside the `pgboss` schema, in either
database [both hosts].

| | TEST | PRODUCTION |
|---|---|---|
| `agentify_commerce` | 10,417,843 bytes (10174 kB) | 9,942,707 bytes (9710 kB) |
| `agentify_scanner` | 11,253,427 bytes (11 MB) | 13,039,283 bytes (12 MB) |
| Postgres volume on disk, all databases | 84 MB | 85 MB |

Besides the bootstrap account the server has the four service roles, each
with `LOGIN` and a password set [both hosts]. They hold `CONNECT` on
`agentify_scanner` and everything listed under "Where the hosts differ" below.

### Who connects

On TEST every running process connects with the bootstrap account, the
gateway and the cabinet to the commerce database and the scanner and its
worker to the scanner database, all through the Compose service name
`postgres` [TEST]; the nightly privacy job's connection names the same
account and database [code]. At the moment of measurement the commerce
database had four pg-boss sessions and two unnamed ones, and the scanner
database two sessions of the worker, two of the web application's queue
client and one unnamed [TEST].

PRODUCTION runs revision b096f83 in two Compose projects: `agentify-commerce`
holds the server, the gateway, the cabinet and the route table, and the
retired scanner project `agentify` still runs the scanner and its worker
[PRODUCTION]. The gateway and the cabinet connect with the bootstrap account.
The scanner connects as `agentify_web`, its `DASHBOARD_DATABASE_URL` names
`agentify_dashboard`, and the worker connects as `agentify_worker`, all
through the network alias `agentify-scanner-postgres` [PRODUCTION]. At the
moment of measurement six sessions of `agentify_worker` were open and none of
`agentify_web` or `agentify_dashboard` [PRODUCTION]. On PRODUCTION, then, the
service roles are live and their grants are what limits the scanner. ADR-0024
says the scanner schema's row-level security is inert and that no policy
exists. The second half holds for a fresh build and on neither host, as the
section on differences shows; the first holds on TEST, where only the
superuser connects, and will hold on PRODUCTION once it runs one Compose
project the way TEST does.

Every application reads its connection from one environment key,
`DATABASE_URL`; the scanner web application also reads the optional
`DASHBOARD_DATABASE_URL` and falls back to `DATABASE_URL` when it is empty
[code]. No production code derives one URL from another [code]. The host
overlay `deploy/compose.hetzner-commerce.yaml` writes each URL out with the
password from `AGENTIFY_DB_PASSWORD` and names `agentify_scanner` for the
four scanner services [code].

### Who migrates what

| Command | What it creates | History table | Database |
|---|---|---|---|
| `pnpm --filter @agentify/gateway db:migrate` | `cards`, `merchant_keys`, `merchants`, `orders`, `payment_claims`, `receipts` in `public` | `drizzle.__drizzle_migrations` | commerce |
| `pnpm --filter @agentify/cabinet db:migrate` | twelve `cabinet_*` tables in `public` | `drizzle.cabinet_migrations` | commerce |
| `node packages/scanner-database/dist/migrate-cli.js` (Compose service `scanner-migrate`) | 26 tables and 10 enums in `public` | `drizzle.__drizzle_migrations` | scanner |

The root `pnpm db:migrate`, which the Compose service `migrate` runs, is the
first two commands in turn [code]. The `pgboss` schema in each database
belongs to no migration command: every pg-boss client installs it on
`start()` and migrates it up to its own version. The gateway uses pg-boss
12.28.0 with the default schema name `pgboss`, which is schema version 38; the
scanner's web application and worker use pg-boss 12.26.0 with `schema:
"pgboss"` set explicitly, which is schema version 37 [code, both hosts]. The
two versions differ by one partial index for queues with the
`key_strict_fifo` policy, which version 38 also adds to the function that
creates queues [rehearsal]. The `metabase` schema that exists on both hosts
belongs to nothing in the repository.

Each host's history tables match the repository: the gateway's ten entries
and the cabinet's eleven have the checksums and timestamps of the files at
a7ee2dc on both hosts, and so do the scanner's twenty on PRODUCTION [both
hosts, PRODUCTION]. TEST's scanner history differs in one entry, described
below.

### Objects and rows

The commerce database has the schemas `drizzle`, `pgboss` and `public`. Its
`public` schema holds the eighteen tables of the gateway and the cabinet, no
enum, no sequence and no row-level security; nothing in it is granted to any
role but its owner [both hosts].

The scanner database has the schemas `drizzle`, `metabase`, `pgboss` and
`public`. Its `public` schema holds 26 tables, all 26 with row-level security
enabled and three of them (`browser_observations`,
`browser_observation_findings`, `browser_observation_budget_days`) with it
forced, and ten enums: `browser_observation_status`, `check_status`,
`delivery_destination`, `diagnostic_level`, `outbox_status`,
`payment_signal_status`, `scan_status`, `segment`, `share_status` and
`webhook_receipt_status` [both hosts]. A superuser bypasses row-level
security, so once every connection is the bootstrap account the flags and any
policy decide nothing.

In both databases the only sequences are the ones behind the history tables'
`id` columns, and the `pgboss` schema holds pg-boss's tables and partitions,
its enum `job_state` and five functions, `create_queue`, `delete_queue`,
`job_table_format`, `job_table_run` and `job_table_run_async` [both hosts].

Row counts, exact, taken with `count(*)` per table:

| Commerce database | TEST | PRODUCTION |
|---|---|---|
| `drizzle.__drizzle_migrations` | 10 | 10 |
| `drizzle.cabinet_migrations` | 11 | 11 |
| `pgboss.job` | 83 | 28 |
| `pgboss.queue` | 11 | 9 |
| `pgboss.schedule` | 2 | 2 |
| `pgboss.version` | 1 | 1 |
| `pgboss.bam`, `job_dependency`, `queue_stats`, `subscription`, `warning` | 0 each | 0 each |
| `public.cabinet_accounts` | 7 | 3 |
| `public.cabinet_credentials` | 0 | 0 |
| `public.cabinet_link_sends` | 22 | 1 |
| `public.cabinet_report_deletion_tombstones` | 0 | 0 |
| `public.cabinet_report_identity_secrets` | 1 | 0 |
| `public.cabinet_report_receipts` | 2 | 0 |
| `public.cabinet_sessions` | 5 | 1 |
| `public.cabinet_verifications` | 7 | 0 |
| `public.cabinet_woo_grants` | 0 | 0 |
| `public.cabinet_woo_orders` | 3 | 0 |
| `public.cabinet_woo_quotes` | 5 | 0 |
| `public.cabinet_woo_shops` | 1 | 0 |
| `public.cards` | 7 | 1 |
| `public.merchant_keys` | 11 | 6 |
| `public.merchants` | 8 | 4 |
| `public.orders` | 41 | 2 |
| `public.payment_claims` | 23 | 1 |
| `public.receipts` | 14 | 1 |

| Scanner database | TEST | PRODUCTION |
|---|---|---|
| `drizzle.__drizzle_migrations` | 20 | 20 |
| `pgboss.job` | 7 | 2 |
| `pgboss.queue` | 3 | 3 |
| `pgboss.version` | 1 | 1 |
| other `pgboss` tables | 0 each | 0 each |
| `public.analytics_events` | 37 | 729 |
| `public.browser_observation_budget_days` | 0 | 6 |
| `public.browser_observation_findings` | 0 | 210 |
| `public.browser_observations` | 0 | 15 |
| `public.consent_snapshots` | 16 | 583 |
| `public.delivery_outbox` | 0 | 0 |
| `public.lead_scans` | 2 | 14 |
| `public.leads` | 2 | 9 |
| `public.merchant_applications` | 0 | 0 |
| `public.payment_signals` | 0 | 0 |
| `public.rate_limit_events` | 1 | 11 |
| `public.rate_windows` | 1 | 3 |
| `public.registration_intents` | 3 | 2 |
| `public.report_sessions` | 2 | 16 |
| `public.scan_checks` | 126 | 1296 |
| `public.scan_fingerprints` | 7 | 72 |
| `public.scan_shares` | 0 | 15 |
| `public.scan_snapshots` | 3 | 32 |
| `public.scanner_identity_completions` | 2 | 0 |
| `public.scanner_identity_deletion_operations` | 0 | 0 |
| `public.scanner_recovery_intents` | 0 | 0 |
| `public.scans` | 7 | 73 |
| `public.sessions` | 11 | 547 |
| `public.waitlist_entries` | 2 | 14 |
| `public.webhook_receipts` | 0 | 0 |
| `public.worker_heartbeats` | 2 | 1 |

In the queues, the scanner's three queue definitions are `scan-v1`,
`browser-observation-v1` and pg-boss's own `__pgboss__send-it`, and every job
in them had finished [both hosts]. The commerce queue on TEST held two
envelope jobs in state `created`, that is, work not yet handed out; on
PRODUCTION every job had finished [TEST, PRODUCTION]. On each host the
commerce database's queue also holds four queue definitions named under the
product's former name, with two finished jobs; they are rows left from before
ADR-0025's rename, not part of any schema [both hosts].

## What a merge into one database collides with

A qualified name is a collision when both databases define it, so that
restoring one database's objects into the other fails or, worse, succeeds
into the wrong object. The comparison was made over every relation, index,
sequence, type, function, schema and constraint in both databases [both
hosts]; the answer is the same on both hosts.

The first collision is the history table. The gateway and the scanner both
keep their history in drizzle's default `drizzle.__drizzle_migrations`, so the
table, its sequence `__drizzle_migrations_id_seq` and its primary key exist in
both databases [both hosts, code]. Restoring the scanner's rows into the
commerce table would give each migrator the other set's newest timestamp as
its own. The scanner's newest entry is dated 2026-09-21 and the gateway's
2026-09-17 [both hosts], so from then on a migration of either set whose
journal timestamp falls before the other set's newest entry would be skipped
as though it had run [code]. The cabinet already keeps its history in
`drizzle.cabinet_migrations` for exactly this reason
(`apps/cabinet/src/database.ts`).

The second collision is the `pgboss` schema: its eleven tables and partitions,
the enum `pgboss.job_state`, five functions, their indexes and eighteen
constraints exist under the same names in both databases, at schema versions
38 and 37 [both hosts]. The pg-boss internal queue `__pgboss__send-it` is a
row in both.

The schemas `public`, `drizzle` and `pgboss` themselves exist in both
databases; that only means the move puts objects into existing schemas.

Nothing else collides. The 26 scanner tables, their 10 enums, indexes and
constraints share no name with the 18 commerce tables, and neither database
has a function in `public` [both hosts, code]. All three migration sets
applied to one empty database, one after another, without an error
[rehearsal].

Two things that are not collisions still travel if nothing stops them: the
grants and policies naming the four service roles, and the `metabase` views,
which read the scanner's tables. Advisory locks are another quiet change: a
lock key is scoped to one database today, so after the merge the scanner's
and the cabinet's `hashtextextended` keys, the gateway's widened `hashtext`
keys and pg-boss's keys share one key space. A collision needs a 64-bit hash
coincidence, and the gateway's store explains what one would cost
(`apps/gateway/src/adapters/postgres/store.ts`) [code].

## Where the hosts differ from the repository

The repository's commands were run against an empty PostgreSQL 17.11: the
root `pnpm db:migrate` into one database, the scanner's migration command into
a second, and each application's pg-boss client started once to install its
schema. The hosts were then compared with that build in two ways, a
schema-only dump compared as text once the random `\restrict` key and the
dates in pg-boss's partition names are removed, and a catalog query over
every column, default, constraint, index, row-level-security flag, sequence
and enum.

The commerce database is identical to the build on both hosts, down to the
text of the schema-only dump [both hosts].

In the scanner database every table, column, default, constraint, index,
row-level-security flag, sequence and enum in `public` and `drizzle` is
identical to the build [both hosts]. What the build does not have is the
following, on both hosts alike.

- The four service roles, their `CONNECT` on the database, `USAGE` on
  `public`, `pgboss` and `metabase`, grants on the tables of `public` and
  `pgboss` and on the pg-boss functions, and default privileges in `pgboss`
  for `agentify_web` and `agentify_worker`.
- Seventy-one policies on the tables of `public`. Sixty of them, named
  `agentify_web_service`, `agentify_worker_service` and
  `agentify_privacy_service`, come from release tooling that managed the roles
  and that the repository no longer has. The other eleven come from the
  repository's own scanner migrations 0013, 0014 and 0016, which create them
  only when the roles exist at the moment they run: a build without the roles
  has no policy, and a build with them has exactly those eleven [rehearsal].
- The `metabase` schema with fifteen security-barrier views, four of them
  readable by `agentify_dashboard`.

Two differences belong to one host each. TEST's scanner history records
migration 0017 with the checksum of that file as it was at commit 01468e8,
before commit b1da8a6 added the block that rewrites the `metabase` audit view;
PRODUCTION records the checksum of the file as it is now [TEST, PRODUCTION].
Drizzle compares no checksums, so this changes nothing until something does.
And PRODUCTION's scanner `public` schema has no `USAGE` for `PUBLIC`, which
TEST and the build have [PRODUCTION].

## Where TEST and PRODUCTION differ

The schemas are the same on both hosts except for the two items just above;
what differs is everything around them.

TEST runs revision fb086fc in one Compose project, `agentify-test`, and every
process uses the bootstrap account [TEST]. PRODUCTION runs b096f83 in the two
projects described above, with three of the service roles in use [PRODUCTION].
PRODUCTION also keeps the retired project's networks (`agentify_backend`,
`agentify_egress`, `agentify_frontend`, `agentify-scanner-db`) and four
volumes from earlier deployments: a warm-up Postgres volume of 71 MB, and a
Postgres volume of 84 MB and two Caddy volumes whose names carry the product's
former name [PRODUCTION]. No running container mounts any of them
[PRODUCTION], and none of them is part of this step.

The data differs as the tables show. PRODUCTION's scanner holds about sixteen
times TEST's rows (3,648 rows in `public` against 224), and TEST's commerce
database holds more orders. On PRODUCTION the report identity flow has never
completed: `cabinet_report_identity_secrets`, `cabinet_report_receipts` and
`scanner_identity_completions` are empty there, and hold 1, 2 and 2 rows on
TEST [TEST, PRODUCTION].

The scheduled jobs differ too. PRODUCTION's `/etc/cron.d/agentify-release`
runs a nightly `backup` and a nightly `privacy` job; TEST's runs only
`privacy` [TEST, PRODUCTION]. On PRODUCTION every root cron job failed from at
least 2026-09-15 08:15 UTC until the morning of 2026-09-23 with "Authentication
token is no longer valid", because root's password had expired; the journal
holds 2,726 lines of that refusal [PRODUCTION]. So the scanner's privacy
retention job and the backup job did not run on PRODUCTION in that time. The
newest scanner dump found on the host, under
`/home/dmitry/agentify-backups/scanner`, is from 2026-09-16 [PRODUCTION].
Whether tonight's backup run produces anything I don't know; the journal after
03:17 UTC tonight settles it.

## What crosses between the scanner and the cabinet

No runtime code of either side reads or writes the other side's database
[code]. The two sides meet in three places: the identity route, the
*handoff cookie* that the browser carries from a report to the cabinet so the
cabinet can open for the address the report just confirmed, and the release
and test tooling.

The identity route is served by `apps/cabinet/src/report-identity-server.ts`
on port 3002 of the cabinet container, publishes no host port, and starts
only when `REPORT_IDENTITY_SECRET` is set. The scanner reaches it through
`CABINET_IDENTITY_URL` (`http://cabinet:3002`) with the header
`Authorization: Bearer <secret>`; the cabinet compares SHA-256 digests of the
expected and the received header in constant time [code]. It has five
operations. *send* mails a report link: the cabinet records the link send and
a Better Auth verification, and the scanner records an inert registration or
recovery intent before the call and activates it after. *verify/consume*
spends the link, creates the cabinet account if there is none, and records a
pending receipt. *verify/acknowledge* completes that receipt after the scanner
has committed the report session. *issue* creates a cabinet link for the
confirmed address. *delete* removes the cabinet side of a person when the
scanner deletes their data [code].

ADR-0024 calls the verification a two-phase handshake. The cabinet consumes
the link and records a pending receipt in its own transaction; the scanner
then commits the report session and a row in `scanner_identity_completions`
in its own transaction and acknowledges; a retry within five minutes finishes
the same operation without spending the link again. The receipt table
`cabinet_report_receipts`, the completion table, the acknowledge phase, the
five-minute window, the retry branches and the failure in which a report
session is committed but never delivered exist because the two halves commit
in two databases [code]. The deletion path has the same shape: a lease on
`scanner_identity_deletion_operations`, a stored `cabinet_result`, a retry
every thirty seconds from the scanner's web process, and a permanent
`cabinet_report_deletion_tombstones` row on the cabinet's side [code].

The shared secret does a second job. It is also the HMAC key of the handoff
cookie that the scanner seals and the cabinet opens (ADR-0026, paragraph 3),
so it outlives the route unless the handoff changes [code]. The cabinet's
`cabinet_report_identity_secrets.digest_key` is a different key, created
inside the first report transaction and never sent to the scanner; it hashes
report link sends, receipt addresses and tombstones [code].

Nothing is keyed across the seam by an address or a person. The scanner keeps
an address encrypted and hashed under its own key, the cabinet keeps it in
plain text, and the two normalize it differently (the scanner applies NFKC,
the cabinet's door trims and lowercases) [code]. What does correspond are
three values, and they are what a single database could turn into foreign
keys: `scanner_identity_completions.receipt_id` (uuid) and
`cabinet_report_receipts.id` (text), the deletion operation id (uuid on the
scanner's side, text on the cabinet's), and the token hash, which is
byte-equal on both sides [code]. No option below adds such a key: each would
tie two processes' migrations and delete orders together, and only the last
option removes the reason the values are duplicated.

## The options, smallest first

Everything in this section applies to each option unless its own part says
otherwise.

The scanner's data moves into the commerce database, and not the other way
round. The commerce queue can hold undelivered work at any moment (two jobs on
TEST during this survey), while the scanner's queue can be drained to empty
before a stop, and the commerce database is the one `activate.sh`, the
approval command and the test guards already name [TEST, code].

The two pg-boss clients share one `pgboss` schema, and the scanner's pg-boss
is raised to the gateway's 12.28.0 so that the workspace pins one version.
Queue names do not collide (`scan-v1` and `browser-observation-v1` against
`agentify_envelopes*` and `agentify_reminders`), and pg-boss is built for
several processes on one schema [code]. The scanner's own pg-boss schema is
not moved: at the cutover it must hold no job in the states `created`, `retry`
or `active`, and on start the scanner creates its two queues again, which
pg-boss does with an insert that ignores an existing row [code]. The risk of a
shared schema is two versions again, since a newer client migrates the schema
under an older one; the two `package.json` files carry one version and the two
queue files say why. The alternative, a second installation under another
schema name, costs a second set of pg-boss tables and maintenance in the same
database and is not proposed. The scanner worker leaves pg-boss's scheduling
on by default, so it would also fire the gateway's two nightly schedules into
the gateway's queues; that is harmless, and `schedule: false` on the worker
keeps each schedule with its owner [code].

The four service roles, their grants and policies, the `metabase` views and
the scanner database itself go at the cutover, as ADR-0024 already decided for
the roles and the views. The scanner's services connect to the one database
with the bootstrap account, and `DASHBOARD_DATABASE_URL` is deleted, since it
exists to name the dashboard role.

The identity route and its handshake stay in every option but the last.

### Option 1: the scanner's tables join `public`

The scanner's 26 tables and 10 enums move into the commerce database's
`public` schema unchanged, beside the eighteen tables already there. Each
migration set keeps its own history: the scanner's moves to
`drizzle.scanner_migrations`, the same pattern the cabinet follows, which is
one option passed to drizzle's migrator in
`packages/scanner-database/src/migrate.ts`. The three database packages stay.

#### What it deletes

The scanner database goes, and with it the second connection string on every
scanner service, `DASHBOARD_DATABASE_URL`, the second dump in the restore
point and the second migration step in `activate.sh`. The `scanner-migrate`
Compose service folds into `migrate`, because the root `pnpm db:migrate` can
run all three sets and the app image already carries the whole workspace
[code]. The `CREATE DATABASE agentify_scanner` line leaves
`deploy/postgres-init/02-scanner-database.sql`. The four roles, their
seventy-one policies and the `metabase` views go, and so do the second pg-boss
installation and pg-boss 12.26.0 in the lockfile. No query changes: the
scanner's raw SQL names its tables without a schema and finds them in
`public`, as it does today [code].

#### How the data moves

Within the stopped window, one transaction in the commerce database receives
the scanner's `public` schema and its history. The scanner database is dumped
with `pg_dump -Fc -n public`, and the dump's table of contents is filtered
before restoring: the entries of type `SCHEMA`, `COMMENT` (on the schema),
`ACL` and `POLICY` are dropped, while the tables, types, constraints, foreign
keys, indexes, row-level-security flags and data stay. On TEST's catalog that
keeps 26 tables, 10 types, 26 constraints, 30 foreign keys, 44 indexes, 26
row-security entries and 26 table-data entries, and drops 1 schema, 1
comment, 27 grants and 71 policies [rehearsal on TEST's schema].
`pg_restore -L <list> -f -` renders the kept entries as SQL. That SQL is
preceded by `CREATE TABLE drizzle.scanner_migrations (id serial PRIMARY KEY,
hash text NOT NULL, created_at bigint)`, the shape drizzle creates, and by a
`COPY` of the source's history rows in their order, and `psql
--single-transaction` applies the whole file, so either everything arrives or
nothing does [rehearsal]. After verification the scanner database is dropped,
which takes its `pgboss` and `metabase` schemas with it, and then the four
roles are dropped. They own nothing and hold privileges only in the scanner
database, so the drop succeeds once that database is gone [both hosts,
rehearsal]. A role that still holds a grant anywhere makes `DROP ROLE` refuse
and name the database, which is a check worth keeping.

The move refuses before it writes anything when any name in the source's
`public` also exists in the target's, when the scanner's queue holds a job in
`created`, `retry` or `active`, when any session other than the move's own is
connected to the scanner database, or when the target already has
`drizzle.scanner_migrations`. That last case is a second run, and a second run
is safe: if the scanner database is gone the move has finished and is
skipped, and if both exist the committed move is verified again and the drop
repeated, or the run refuses on a mismatch.

The verification has four parts, all before the scanner database is dropped.
Every scanner table's fingerprint in the target equals the source's; every
commerce table's fingerprint equals what it was before the move; the history
in `drizzle.scanner_migrations` equals the source's twenty rows; and each of
the three migrators then applies nothing. A stronger check is cheap and worth
keeping: the move builds a scratch database from the revision's three
migration sets, compares its catalog with the moved database by the query
this survey used, and drops it. On a copy of TEST's scanner schema with
synthetic rows the moved commerce database was catalog-identical to such a
fresh build (930 lines of columns, constraints, indexes, flags and types, and
379 qualified names, all equal), carried no policy and no service-role grant,
kept 26 tables with row-level security and 3 with it forced, and matched every
fingerprint; the move itself took half a second [rehearsal]. On PRODUCTION's
3,648 scanner rows and 12 MB it should take seconds, and at ten times the data
the dump, the restore and the fingerprints grow linearly and stay well under a
minute [guess].

The applications are down for the drain, the restore point, the move, the
migrations and the start. The drain waits for the scanner's queue to empty:
at most a minute for a scan job, whose expiry is 60 seconds, and up to
`APIFY_BROWSER_TIMEOUT_SECONDS` plus 30 seconds for a browser observation
[code]. The rest is what `activate.sh` already costs, about a minute by its
own account, plus seconds for the move [code, guess]. Two to four minutes in
all is a guess; TEST's run measures it before PRODUCTION's.

#### How it is undone

`activate.sh` takes its restore point after it stops the applications and
before it migrates, one `pg_dump -Fc` file per database, whenever it switches
revisions [code on the branch `agent/one-activate`]. The move runs after the
restore point, so the point holds both databases as they were. To undo, stop
the applications, drop and create `agentify_commerce` and `pg_restore` its
dump, create `agentify_scanner` and restore its dump with `--no-privileges`
and a table of contents without the `POLICY` entries (the roles no longer
exist), then activate the previous revision. A scanner database restored that
way, with the roles already gone, comes back with its tables, data and
`metabase` views and no policy [rehearsal]. Anything written after the cutover
is lost on this path, which is why the verification comes before the
applications start.

#### The laptop and CI

On a laptop the scanner's services name the one database, and
`02-scanner-database.sql` keeps only `agentify_scanner_migration_test`, which
the scanner's integration tests need because they drop and recreate `public`,
`drizzle` and `pgboss` in the database they are given [code]. A laptop volume
made before the change still holds `agentify_scanner`, and the first `docker
compose up` would create empty scanner tables in the one database and leave
the old ones unseen. The README says so and offers the same move, run through
`docker compose exec postgres`, or `docker compose down -v`.

In CI the gate job keeps its one server. `pnpm test:db` is unchanged, since it
works in `agentify_commerce_test` and in databases it makes itself [code]. One
step is added: the root `pnpm db:migrate` run twice against an empty
database, the second run applying nothing. It guards against a table name in
one set colliding with another and against two sets sharing a history. The CI
role `agentify_scanner` can become the bootstrap account, which deletes the
step that creates it.

#### The host rename

ADR-0025 moves the host project and container names with the database. The
move itself needs only the applications stopped; the rename needs the server
stopped and every container recreated under the new project, because a
project name is the prefix of every container name. Both fit one window, which
"The cutover" below describes. On PRODUCTION the retired scanner project is
already called `agentify`, so it must be gone before a project of that name
exists [PRODUCTION].

### Option 2: the scanner's tables in a schema of their own

This is Option 1 with the scanner's tables and enums in a schema `scanner`
instead of `public`; the histories and the packages stay as in Option 1, and
it deletes what Option 1 deletes. What it adds is the difference. The
scanner's drizzle schema declares its tables and enums through
`pgSchema("scanner")`. One new scanner migration moves the 26 tables and 10
enums with `ALTER TABLE … SET SCHEMA` and `ALTER TYPE … SET SCHEMA`, and
indexes, constraints and owned sequences follow their table [rehearsal: all
96 relations and 10 enums moved, none left in `public`]. The scanner's raw SQL
names its tables and enum types without a schema in about forty places across
seven files (`browser-observation-repository.ts`, `scan-job-repository.ts`,
`privacy-cleanup.ts`, `rate-limit.ts`, `stripe-card-signal.ts`,
`analytics-outbox.ts` and the health route) [code, counted by pattern]. After
the move those fail with "relation does not exist" [rehearsal], so either each
is qualified or every scanner connection string carries `options=-c
search_path=scanner`. The second is a setting that must be right on four
services; forgetting it fails loudly rather than silently, but it is one more
thing to know. The scanner's migration integration test lists the tables of
`public` and changes with it [code].

The data moves by Option 1's move followed by the new migration, which runs as
the first pending scanner migration of the release in the same stop. A fresh
database reaches the same shape by running the old migrations into `public`
and the new one after them, so hosts and laptops converge. The downtime is
Option 1's plus the migration's seconds [guess]. The undo, the laptop, CI and
the rename are as in Option 1, except that the scanner's migration test
checks `scanner` where it checked `public`.

What Option 2 buys is ownership visible in the catalog: `pg_dump -n scanner`
takes the scanner alone, and a name collision between the sets becomes
impossible rather than caught in CI. What it keeps is the seam, now as a
schema name.

### Option 3: one history and one database package

This goes on top of Option 1 or Option 2. The three drizzle schemas move into
one package, for example `packages/database`, with one migrations folder, one
history table and one migrate command. The package is private and never
enters the published SDK's dependency tree (ADR-0003, point 8).

It deletes forty-one migration files and three journals in favour of one
baseline, three history tables in favour of one, and the reasoning about
separate histories in `apps/cabinet/src/database.ts`. The scanner's migration
test, which applies the scanner's set to an empty database, lists its tables
and runs a hand-written down script, becomes a test of the one baseline.

The baseline is one SQL file that creates today's catalog. Drizzle generates
most of it from the combined schema but not all: its table builder has
`enableRLS()` and nothing for forced row-level security, so the three `FORCE
ROW LEVEL SECURITY` statements, and anything else the current migrations
wrote by hand that the schema does not express, are written into it by hand
[code]. On a host the release first proves that the database equals a fresh
baseline build by the catalog comparison above, which here is the gate rather
than a spare check, and then, in one transaction, creates the new history
table with the baseline's single row and drops the three old tables. TEST's
odd checksum for migration 0017 goes with its table. Once Option 1 or 2 has
moved the data this needs no stop beyond an ordinary activation [guess].

The undo is the restore point and the previous revision, as in Option 1. A
laptop volume that already exists gets the baseline row by the same check,
and a new one runs the baseline. In CI the scanner's migration test and
`drizzle-kit check` become the one package's, and Option 1's guard step
stays. The rename has nothing to do with this option; it rides with the move
of Option 1 or 2.

### Option 4: direct access in place of the identity route

This goes on top of any of the others. In one database the scanner's process
could consume a link, commit the report session and complete the receipt in
one transaction, and delete the cabinet side of a person in the same
transaction as its own.

It deletes the cabinet's second listener on port 3002 and the release checks
around it, `CABINET_IDENTITY_URL`, the receipt state machine of
`cabinet_report_receipts`, the table `scanner_identity_completions`, the
acknowledge phase with its five-minute window and retry branches, the scan of
every account's address in *issue*, and in deletion the lease, the stored
cabinet result, the thirty-second retry and arguably the tombstones [code].
`REPORT_IDENTITY_SECRET` stays as long as it seals the handoff cookie.

What it needs is larger than what it deletes. The scanner's web process takes
in the cabinet's identity code, Better Auth's magic-link component included,
and writes the cabinet's tables. What keeps the two apart today is, in
ADR-0024's words, the identity route and a secret only those two processes
hold; with this option it becomes a convention in code. The two sides' address
normalization must first agree, and the corresponding ids must share one type
[code]. ADR-0024 and ADR-0026, paragraph 3, change with it.

There is no data to move beyond Option 1 or 2 and no host step of its own: the
receipt and completion tables are dropped by a migration once nothing reads
them, the undo is the previous revision and the restore point, and neither
the laptop, CI nor the rename changes beyond the tests of the new code. It is
an identity decision with a security boundary in it, not a storage one, and
nothing in the database merge requires it.

## The cutover

This is Option 1 with the host rename, as one window per host, TEST first.
It runs from the checkout of the revision that expects one database, by a
person, with the timer that releases TEST automatically stopped. It is a
one-time script, `deploy/one-database.sh`, which is deleted in the change
after both hosts have run it. It needs production on the new release path,
the retired scanner project gone from PRODUCTION, the off-host backup in
place, and pg-boss aligned in the revision.

1. Refuse unless the old project runs its server, no container of the new
   project exists, the scanner database exists, and the disk has room for a
   restore point and a copy of the Postgres and Caddy volumes.
2. Stop the scanner's web application, so no new scan is accepted, and wait,
   bounded, until the scanner's queue has no job in `created`, `retry` or
   `active`; otherwise start it again and refuse.
3. Stop the gateway, the cabinet, the worker and the route table, and write
   the restore point exactly as `activate.sh` writes it, both databases,
   together with the fingerprints of every table in both. Read each dump
   back with `pg_restore --list` before going on.
4. Take the old project down without removing volumes. Copy its Postgres and
   Caddy volumes into volumes under the new names, file by file, from a
   container that mounts the old ones read-only. The old volumes are not
   written again.
5. Start the server under the new project on the new volumes, and run the
   move of Option 1 with its refusals and its verification, including the
   scratch-database comparison.
6. Drop the scanner database and the four roles.
7. Run `deploy/activate.sh` for the same revision. It takes a restore point
   of the one database, applies whatever migrations the revision adds (none,
   if the revision carries the move alone), starts the applications and
   checks the public routes.

Until the new release takes a write, the fastest undo is the old volumes: the
new project goes down and the previous revision starts the old project on
volumes nobody has touched since step 4. After that the restore point of step
3 is the undo, as in Option 1. The old and the new server must never run on
one volume at the same time; the copy in step 4 is what makes that
impossible, and it is why the rename copies volumes instead of pointing the
new project at the old ones.

If the rename does not ride with the move, the server keeps running under its
old project and step 4 disappears. The move then becomes one guarded step of
`activate.sh`, between its restore point and its migrations, deleted once both
hosts have run it, and the undo is the restore point alone.

The rename touches, besides `deploy/stack.sh` and the two host overlays, the
container names in `scripts/approve.mjs`, the TEST WooCommerce hairpin unit
and its test, and the deployment preflight fixtures in
`packages/core/src/deployment/fixtures/` [code].

## Recommendation

Option 1, with the host rename in the same cutover as ADR-0025 says.

It is the smallest change that reaches one database. No query, no drizzle
schema and no migration file of the scanner changes; what changes is one
history table's name, one pg-boss version, the connection strings and the
Compose services around them. It removes the seam between the scanner's data
and the rest instead of keeping it under a schema name. The one risk it
leaves, a future table name shared by two sets, fails loudly in the CI step it
adds and never silently. The moved database is identical to a
fresh build of the repository, which was shown on a copy of TEST's catalog
rather than assumed. And it keeps the identity handshake exactly as tested:
the handshake's cost is already paid, and replacing it is a decision about
who may write whose tables, which deserves its own branch if it is wanted at
all.

Option 2 is the right choice if the scanner's ownership should stay visible
in the catalog; it costs about forty query edits or a connection setting on
four services. Option 3 becomes worth it when a change first has to touch two
migration sets at once; until then three histories cost nothing. Option 4 is
not proposed now.

## Decision records the implementation edits

ADR-0003, points 2 and 6, say that the scanner and commerce use separate
databases in one instance and that one database is the goal. They become one
database, one account, the migration sets' histories as the chosen option
has them, and one pg-boss schema shared by the gateway and the scanner.

ADR-0024 says the scanner uses a separate database and that the separate
database is the present state, not the destination. That paragraph becomes
the one database. Its statement that the two-phase handshake exists "because
the two databases share no transaction" stops being true of the storage and
is restated as the reason that remains: the scanner and the cabinet are
separate processes that commit their own halves. Its remark that the account
reaches the commerce database by changing one word in a connection string
goes, and its statements that the service roles and the dashboard views are
deleted and that no policy exists become true on the hosts as well.

ADR-0025 says "Scanner storage remains separate", fixes the database name
`agentify_commerce`, and keeps each host's project and container names until
the one-database step. The first sentence goes, the database name is restated
or changed as the choice below settles, and the exception for host names is
replaced by the names the hosts then carry.

ADR-0016, in the form the branch that introduces `activate.sh` gives it,
changes wherever it describes a restore point of two databases. ADR-0026,
paragraph 3, and ADR-0024 change further only with Option 4.

## Dmitry's decisions

Dmitry decided on 2026-09-23, choice by choice as this note put them.

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

## What I don't know

Whether a scan left in `queued` without a queue job ever finishes. I found no
reconciler for that state in the web application or the worker [code]; the
cutover sidesteps it by draining the queue, and a test that deletes a queued
scan's job would settle it.

The real downtime on each host. The parts are measured or bounded above, the
sum is a guess, and TEST's cutover measures it.

Whether PRODUCTION's nightly backup job works now that root's cron runs
again; tonight's journal shows it.

## Appendix: how the survey was taken

Queries ran through `docker exec <postgres container> sh -c 'psql -U
"$POSTGRES_USER" …'`, with `SET default_transaction_read_only = on` sent
first, so no user name appeared on a command line and no statement could
write. Row counts came from `count(*)` per table through `query_to_xml`.
Collisions came from one query listing every schema, relation, type, function
and constraint by qualified name in each database, compared between the two.
The catalog comparison listed every column with its type, nullability and
default, every constraint definition, every index definition, the
row-level-security flags, the sequences and the enums with their labels, for
`public`, `drizzle` and `pgboss`. Container settings were read as key names
only, and database URLs only as their host, database name and whether the
account was one of the service roles.
