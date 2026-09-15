# Scanner database and Auth exit

This procedure is prepared but has not been run against production. The current
scanner web and worker, on `agentify.ad`, still use the original Supabase
PostgreSQL and Supabase Auth. Commerce merchant data stays in the `coinslot`
database of `agentify-commerce-postgres-1`. The scanner moves into a new
`agentify_scanner` database on that same PostgreSQL 17 server, with the four
existing scanner runtime role names and its own `public`, `pgboss`, `drizzle`
and `metabase` schemas. Nothing in this procedure restores into `coinslot` or
deletes the Supabase project.

The currently observed live runtime is
`b7cf3cecb5836465370e533463b8c56899005ba6`. The private-mode code bridge
begins at `4512fd86029a39f60d6f88291029f72069fb4224`; the complete
DB-only bridge with this procedure is
`ebb8fce71c6767ab73c3e9b1e55639efbf9cda6f`. Use that exact reviewed,
CI-green `bridge_release_sha` and rebuild the scanner web, worker and privacy
images at it. The existing b7 images reject the new private DB
configuration, so a URL replacement with b7 cannot be the handoff. Supabase
Auth remains in the browser and server during this database-only release.
The final Better Auth application release is a separate reviewed SHA and a
separate acceptance step.

The only secret input is a local, ignored, 0600 YAML file such as
`.local/scanner-exit/operation-vars.yml`. Its `scanner_operation_vars_path` is
its own absolute path. Use the existing commerce database password as
`admin_password`, and four newly generated, distinct URL-safe scanner role
passwords. Do not paste the file, source environments, dump, Auth custody or
identity report into an issue, CI output or command line. This is the required
shape; the values below are placeholders:

```yaml
scanner_operation_vars_path: /ABSOLUTE/LOCAL/PATH/.local/scanner-exit/operation-vars.yml
source_release_sha: b7cf3cecb5836465370e533463b8c56899005ba6
bridge_release_sha: ebb8fce71c6767ab73c3e9b1e55639efbf9cda6f
release_sha: ebb8fce71c6767ab73c3e9b1e55639efbf9cda6f
auth_release_sha: REVIEWED_40_CHARACTER_FINAL_AUTH_AND_OPS_SHA
scanner_private_credentials:
  admin_password: EXISTING_COMMERCE_DB_PASSWORD
  web_password: NEW_URL_SAFE_PASSWORD
  worker_password: NEW_DIFFERENT_URL_SAFE_PASSWORD
  privacy_password: NEW_DIFFERENT_URL_SAFE_PASSWORD
  dashboard_password: NEW_DIFFERENT_URL_SAFE_PASSWORD
scanner_stage_release_ack: source-containers-remain-running
scanner_network_ack: existing-commerce-postgres-private-bridge
scanner_edge_maintenance_ack: scanner-503-commerce-remains-live
scanner_freeze_ack: source-web-worker-and-cron-maintenance
scanner_restore_ack: new-scanner-database-only
scanner_activate_ack: private-db-one-web-one-worker
scanner_edge_resume_ack: private-scanner-and-commerce-health-accepted
scanner_resume_ack: no-private-writer-ever-started
scanner_auth_stage_ack: bridge-running-build-auth-separately
scanner_auth_freeze_ack: maintenance-hold-bridge-fresh-custody
scanner_auth_identity_review_ack: fresh-private-baseline-report-reviewed
scanner_auth_activate_ack: bridge-private-db-held-one-auth-writer
scanner_auth_resume_ack: no-final-auth-writer-attempt
```

Run `bash ops/scripts/scanner-db-rehearsal.sh` and
`bash ops/scripts/scanner-db-real-schema-rehearsal.sh` first. Each creates and removes
only its task-prefixed disposable PostgreSQL container, restores synthetic lead,
report, queue, migration and setting rows, proves that a commerce marker is
unchanged, rejects a bad checksum and existing scanner DB, and detects a
queue-row mutation. The real-schema rehearsal runs the scanner's actual
migrations, queue grants and row policies and checks all four role access
boundaries after full-schema restore. Then run the syntax checks with the pinned
`ansible-core==2.19.13`. The rehearsal proves the helper's behavior with
synthetic data; it does not prove live source access, a real mail flow, or
production acceptance.

Every production mutation below is performed by Ansible. Run each command
with `--check` first, inspect its intended target, and then run that same
command without `--check`. The stage-release check cannot fetch or build a
prospective SHA; the freeze check cannot create a dump. Their real runs are
the proof. Each command takes the same protected vars file:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-db-stage-release.yml -e @.local/scanner-exit/operation-vars.yml
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-db-stage-env.yml -e @.local/scanner-exit/operation-vars.yml
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-db-network.yml -e @.local/scanner-exit/operation-vars.yml
```

These three steps occur while the b7 scanner stays active. The first checks
out the reviewed bridge and builds all three SHA-tagged images from that clean
checkout, recording their image IDs in protected staging custody without replacing
the running containers. The second preserves the original scanner environment
and its HMAC, email-encryption, Resend and Supabase Auth settings, then appends
private DB overrides in a new protected `.env.private`. The third creates one
internal network and attaches the existing commerce PostgreSQL container by
`agentify-scanner-postgres` alias without a PostgreSQL restart. The opt-in
Compose overlays are the desired state for later commerce/scanner releases;
all future Compose invocations and the cron wrapper must include them. If the
PostgreSQL container is ever recreated without its overlay, the network alias
vanishes and scanner deployment must stop until Ansible restores it.

Inspect the public edge and commerce health before maintenance. The active
scanner route must be the normal Caddyfile; the maintenance playbook refuses
another route. Its Caddyfile returns 503 with `Retry-After: 300` for
`agentify.ad` and keeps `app.agentify.ad` on the same commerce proxy. The
certificate volumes remain attached:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-db-edge-maintenance.yml -e @.local/scanner-exit/operation-vars.yml
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-db-freeze.yml -e @.local/scanner-exit/operation-vars.yml
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-db-restore.yml -e @.local/scanner-exit/operation-vars.yml
```

Freeze checks that the running source web/worker are the exact b7 containers
and still point at the rendered external DB. It requires the exact two-job cron
schedule and source b7 wrapper. It tests Auth inventory read access and
PostgreSQL major compatibility in protected scratch custody before creating
frozen custody or stopping anything. A failed pre-stop probe can be corrected
and the same Ansible freeze playbook retried. If the edge is already in
maintenance, `scanner-db-edge-resume-source.yml` restores normal routing while
the original b7 web and worker remain active. It holds
the two known cron jobs, gracefully stops the scanner web/worker, refuses any
running scanner job or pg-boss job still marked `active`, and produces a fresh
application-schema dump, per-table count/data fingerprints, source PG major,
and a minimal `auth.users` ID/email/confirmation inventory. The dump does not
carry Auth credentials or sessions. Copies with SHA256 evidence are retained
both in the protected VM custody directory and under the controller's ignored
`.local/scanner-exit/<source-sha-prefix>/`, outside the VM. Ordinary source
backups and the original Supabase DB/Auth remain untouched.

Restore checks the frozen manifest and off-VM checksums, refuses a revived
source writer and any existing `agentify_scanner` database, and creates the
target exactly once. A failed restore leaves its named target for inspection;
the playbook never clears or retries over it. It compares every application
table's count and order-independent row digest, and proves the live commerce
PostgreSQL container and data volume identity did not change. Commerce orders
can continue to move during this operation, so row equality is not a guard.
The linked-lead reconciliation
produces a protected report. Confirmed Supabase users with no lead, pending
emails that need a resend, changed lead links and foreign Auth references are
listed there; no address appears in the Ansible log. A flagged source-only
account does not invalidate the database-only move while Supabase Auth remains
live, but it blocks silent final Auth retirement.

Only after the restore and the scanner's role, queue and mail settings are
reviewed, activate the DB-only bridge. It runs private role reconciliation,
reviewed migrations, queue grants, dashboards, privilege finalization and
the live database access verifier before starting a single web/worker pair.
It checks that the original HMAC/email keys, Resend key, worker identity and
staged image IDs are unchanged; it compares frozen rows again before the worker
can make new effects. A durable marker is written before any private writer
start attempt. The private backup/privacy cron wrapper is installed only after the
new scanner's live and database-ready health routes pass:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-db-activate.yml -e @.local/scanner-exit/operation-vars.yml
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-db-edge-resume.yml -e @.local/scanner-exit/operation-vars.yml
```

Before the private web or worker has ever started, a failed freeze, restore or
role setup can return to the unchanged Supabase source through Ansible. Resume
the old web/worker and byte-identical held cron first, then return the normal
edge. The `scanner_resume_ack` value is valid only when no private writer start
has been attempted; the durable marker blocks revival even if new containers
later stop. Once private writers have started, old and new databases may contain different
effects; reconcile them before any rollback instead of reviving old writers:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-db-resume-source.yml -e @.local/scanner-exit/operation-vars.yml
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-db-edge-resume-source.yml -e @.local/scanner-exit/operation-vars.yml
```

The database handoff is accepted only after the live scanner, report sessions,
registration, queue processing, backup/privacy schedule and commerce health
are checked on the actual host. The Better Auth application and migration
begin at `aa375ec5b65dc78a3fc35e1f17c43dc971613ad8`; use a later
reviewed, CI-green `auth_release_sha` that also contains the final operational
playbooks. This SHA is separate from the DB-only bridge. Keep the accepted
bridge web/worker and their private backup/privacy cron active while staging:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-auth-stage-release.yml -e @.local/scanner-exit/operation-vars.yml
```

The stage playbook creates protected `.env.ba` from `.env.private` by removing
all `SUPABASE_*` and `NEXT_PUBLIC_SUPABASE_*` entries. It preserves the
private scanner DB URLs, HMAC and email-encryption keys, Resend settings and
the current `REGISTRATION_ENABLED` value exactly. It fetches the final SHA
into a detached staging checkout, builds all three final images there, records
their IDs and verifies that running bridge and commerce containers did not
change. The active checkout and private cron wrapper continue reading the
DB bridge files during this preparation.

When the final Auth maintenance window opens, return only the scanner edge to
the existing 503 route, leaving `app.agentify.ad` on its exact commerce proxy.
Then freeze the bridge and stop before the identity-review boundary:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-db-edge-maintenance.yml -e @.local/scanner-exit/operation-vars.yml
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-auth-freeze.yml -e @.local/scanner-exit/operation-vars.yml
```

This freeze requires the exact bridge image/DB target, two-job cron and
wrapper. It holds that cron, stops only the bridge web/worker and refuses
remaining scheduled or active pg-boss jobs. It makes a fresh private scanner
DB dump under the held schedule, exports current managed `auth.users` IDs,
emails and confirmation states from the preserved original source env, and
exports current private lead-to-Auth links. External `public.leads` is stale
after the DB bridge and is never used as this phase's link-count baseline.
The protected reconciliation counts links from the current private DB and
flags confirmed Auth-only users, pending emails needing resend and foreign
links. The dump, identity files and old lead/report row digest are SHA256
checked on the VM and copied to ignored 0600 off-VM custody at
`.local/scanner-exit/ebb8fce7/auth-window/`. Inspect its protected
`identity-reconciliation.json` before using the review acknowledgment in the
same vars file. The managed Auth identity inventory excludes passwords, Auth
sessions, tokens and encrypted lead fields; the full protected application
dump contains scanner lead and report data. A confirmed Auth-only user can be
asked for a fresh verified email;
an email still pending at cutover requires a new magic link. These dispositions
remain a gate to retiring managed Supabase Auth.

Only after that report and the fresh backup are reviewed, activate the final
application on the same `agentify_scanner` database and network:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-auth-activate.yml -e @.local/scanner-exit/operation-vars.yml
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-db-edge-resume.yml -e @.local/scanner-exit/operation-vars.yml -e scanner_edge_release_phase=auth
```

Activation checks the off-VM recovery hashes and that the held bridge made no
new lead/report changes. It then changes the active checkout to the reviewed
final SHA, runs private-URL validation, migration 0015, queue initialization,
database privilege finalization and the runtime access verifier. A separate
read-only check requires all four `scanner_auth_*` tables, the unique lead FK,
RLS, web CRUD, privacy select/delete, and denial of identity reads to
worker/dashboard after queue initialization. Existing lead fields and report
sessions must match the fresh pre-migration digest. The commerce PostgreSQL
container and private network alias must retain their staged IDs. A durable
Auth-writer start marker is written before Docker up; only one final web/worker
pair then starts, and the two-job cron uses the exact final image SHA and
sanitized `.env.ba` only after live and DB-ready health checks.

Before any final Auth writer start attempt, an interrupted freeze or migration
can resume the accepted private-DB bridge and its byte-identical held cron
through Ansible, then restore the normal edge. The presence of the durable
Auth-writer marker blocks this path even if the new containers later stop;
effects must be reconciled before any bridge revival:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-auth-resume-bridge.yml -e @.local/scanner-exit/operation-vars.yml
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/scanner-db-edge-resume.yml -e @.local/scanner-exit/operation-vars.yml
```

Accept the final release only after an authorized real magic-link delivery,
freshly verified email login, lead and report-session continuity, queue and
privacy deletion checks, fresh private backup, and scanner/commerce health
on the host. If the preserved registration flag is false, mail/login acceptance
remains pending until a separately reviewed release intentionally enables it;
do not claim it succeeded from this preparation. This preparation sends no
email and makes no live submission. Before retiring Supabase, repeat the
protected identity audit against the then-current managed Auth users and
freshly verified scanner users and resolve every source-only/pending account.
Retirement is an explicit separate decision; no playbook deletes the managed
project, external DB/Auth or recovery copies.
