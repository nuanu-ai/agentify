# Agentify server preparation

The public records now point at the new production VM. The scanner uses its
original external database and configuration; commerce merchant data still
needs its final restore and acceptance. The maintenance edge answers unavailable
routes honestly. For a new reviewed runtime release, run `prepare-production.yml`
first, then:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/start-maintenance-edge.yml \
  -e release_sha=REVIEWED_40_CHARACTER_SHA --check
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/start-maintenance-edge.yml \
  -e release_sha=REVIEWED_40_CHARACTER_SHA
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/start-maintenance-edge.yml \
  -e release_sha=REVIEWED_40_CHARACTER_SHA
```

The second real run must report `changed=0`. Check the public apex and app over
HTTP and HTTPS: all nonredirected routes must return 503 with `Retry-After: 300`
and `Cache-Control: no-store`; www redirects to the apex. HTTPS acceptance also
requires an issued certificate for each hostname. This edge uses the existing
`agentify-ingress` bridge and Caddy's persistent certificate volumes, but no
database, scanner, or commerce process. It refuses to replace a different
active Caddy configuration. All server changes, including this temporary edge,
are made by Ansible.

The commerce process can be checked independently of restored merchant data:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/warmup-commerce.yml \
  -e release_sha=REVIEWED_40_CHARACTER_SHA --check
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/warmup-commerce.yml \
  -e release_sha=REVIEWED_40_CHARACTER_SHA
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/warmup-commerce.yml \
  -e release_sha=REVIEWED_40_CHARACTER_SHA
```

This starts only Postgres, migrations, gateway, cabinet, and inner Caddy in
`agentify-commerce-warmup`. The new `agentify-commerce-warmup-postgres` volume
is separate from the final commerce project's restore target and is never
deleted or replaced by the playbook. Its Docker network is internal, and neither
Postgres nor Caddy has a published port. Gateway seeding and registration are
empty; cabinet mail is disabled. The empty database has no connected
WooCommerce shops, so its cabinet worker has nothing to draw. Warmup proves
startup and container health only; it does not prove existing accounts,
catalogues, paid orders, or money movement. Do not import donor data into this
warmup volume or route public traffic to it.

These playbooks own the application-level server preparation for the coordinated
`agentify.ad`, `www.agentify.ad`, `app.agentify.ad`, and `test.agentify.ad` switch.
The machine baseline remains in `nuanu-ai/infra`. The production and test hosts
already exist, so this directory neither provisions them nor changes DNS. The
production edge serves the apex, www, and commerce names on `agentify-prod-1`.
The test name points directly to the existing test ingress on `dmitry-dev`.

Run with `ansible-core==2.19.13`; no third-party collection is required. The
inventory uses the existing SSH aliases `agentify` and `codex-vm`. All release
commands require `release_sha` as an explicit forty-character lowercase commit
SHA. Use a reviewed commit containing the edge and test overrides, with its
exact-SHA CI complete. The earlier `0aba1f0` commerce candidate does not yet
contain those overrides and is intentionally refused by preparation.

The preparation commands are:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/prepare-production.yml \
  -e release_sha=REVIEWED_40_CHARACTER_SHA --check
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/prepare-production.yml \
  -e release_sha=REVIEWED_40_CHARACTER_SHA
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/prepare-production.yml \
  -e release_sha=REVIEWED_40_CHARACTER_SHA

ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/prepare-test.yml \
  -e release_sha=REVIEWED_40_CHARACTER_SHA --check
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/prepare-test.yml \
  -e release_sha=REVIEWED_40_CHARACTER_SHA
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/prepare-test.yml \
  -e release_sha=REVIEWED_40_CHARACTER_SHA
```

The second real run of each playbook must report `changed=0`. Check mode shows
the prospective Git change and current Docker state. It cannot validate files
that the prospective checkout has not installed, create a missing Docker
network, or build a missing image, so the playbook says this explicitly. Syntax
checks require no server connection:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/prepare-production.yml --syntax-check
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/prepare-test.yml --syntax-check
```

On production, preparation preserves the existing dmitry-owned `.env` at
`/home/dmitry/agentify-commerce/.env` and refuses a missing or non-0600 file.
It checks out the exact release, validates the commerce Compose file chain,
checks the exact resolved app/web/Postgres image set, creates the private
`agentify-ingress` network only if absent, and verifies its
fixed `172.30.80.0/24` IPAM if already present. The fixed edge peer is
`172.30.80.2`; the inner commerce Caddy trusts that peer alone. Inspect VM
Docker networks and routes before the first apply; a subnet collision stops
preparation for a reviewed topology change. The playbook builds only the absent
SHA-tagged commerce gateway and web images, once each, and pulls the edge's
declared Caddy image only if absent. A transient network-free container runs
the release's `commerce` preflight against the resolved production config;
its secret-bearing input and output are suppressed by Ansible. It does not
start a resident service, create a production database volume, change a machine firewall, or
touch either old live deployment. It refuses an active final commerce/scanner
project or a nonmaintenance edge; a single reviewed maintenance edge may remain
active while the next release is prepared.

The scanner worker image can be prepared on the new VM without scanner secrets
by explicitly passing `-e prepare_scanner_worker_image=true`. It is built only
if `agentify-scanner-worker:<release_sha>` is missing. Scanner website and
privacy-job images are not prepared from guessed public auth or provider
configuration; those values still require an inventory from the old donor.

On test, preparation checks out source into
`/home/dmitry/agentify-test-candidate`, leaving the running
`/home/dmitry/coinslot-test` untouched. It copies the existing test `.env`
only once into the candidate directory with mode 0600, changes only the public
origin, Caddy hostname, existing private ingress binding, and SHA-tagged test
app/web image names. It resolves the new direct HTTPS Compose config and checks
that only those image names and pinned Postgres are selected. Test preflight
remains unchecked because the test images are not built during preparation.
It does not build an image or start, stop, or
reconfigure the running test stack. The candidate binding is
`10.20.10.20:8443:443`; the eventual external DNS A record for
`test.agentify.ad` targets `153.124.160.16`. There is no production-to-test
network path to establish.

The scanner runtime move retains its existing external Supabase database and
Supabase Auth project. `prepare-scanner-production.yml` reads the donor's
protected environment, verifies it is in external-database mode, preserves its
exact bytes on the new VM, builds web/privacy images and verifies the existing
scoped database roles without migrations or role reconciliation. Never substitute
the old donor's local PostgreSQL volume for its current Supabase database.

Run preparation with the reviewed release SHA and then `activate-scanner.yml`
with that same SHA. Activation starts only web, verifies its database and the
existing worker, and replaces the maintenance edge with the real scanner routes.
Commerce remains at HTTP 503. The original HMAC/encryption keys, Supabase Auth
settings and admin protection remain in use. A separate controlled worker and
cron handoff is required before the donor can be retired; the two workers must
never run concurrently with the same worker identity. Keep protected recovery
copies of configuration and database backups, including the donor machine, until
acceptance. Moving Supabase data or auth is a separate migration.

Commerce production data has not moved as part of scanner activation. Its
private warmup database is not a production restore target. Final commerce
activation still needs a consistent source backup, verified restore, writer
handoff and application acceptance; test keeps its separate existing database.

The coordinated external Namecheap records are `@` A `37.27.10.179`, `test` A
`153.124.160.16`, `app` CNAME `agentify.ad`, and `www` CNAME `agentify.ad`.
Public TLS, routing and application behavior must be checked independently after
the switch. A running container is not evidence that data or user flows passed.

The worker and scheduled-job handoff is run separately after scanner web and
edge acceptance. The controller can hold a newer playbook commit while the new
VM remains at its already prepared runtime SHA; pass that runtime SHA explicitly:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/handoff-scanner-worker.yml \
  -e release_sha=PREPARED_RUNTIME_40_CHARACTER_SHA --check
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/handoff-scanner-worker.yml \
  -e release_sha=PREPARED_RUNTIME_40_CHARACTER_SHA
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/handoff-scanner-worker.yml \
  -e release_sha=PREPARED_RUNTIME_40_CHARACTER_SHA
```

Handoff checks equal protected donor/new-VM environment hashes, the actual
donor container's worker ID, the same external database URL, exact images and
public scanner readiness. It makes a recent backup on the new VM when needed,
verifies the archive, and fetches the dump and matching protected scanner
environment byte-identically to the controller's `.local/scanner-backups/`
directory. It never probes privacy cleanup by running it. The donor's original
cron file is archived outside `/etc/cron.d` and its
already launched jobs must drain; the old worker stops before the new worker
starts with `--no-deps`. The backup and privacy schedule appears on the new VM
only after new worker readiness. The target job script and backup mount override
live outside the clean runtime checkout.

After handoff acceptance, retire the donor web and Caddy with a separate
readiness gate:

```sh
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/retire-scanner-donor.yml \
  -e release_sha=PREPARED_RUNTIME_40_CHARACTER_SHA --check
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/retire-scanner-donor.yml \
  -e release_sha=PREPARED_RUNTIME_40_CHARACTER_SHA
ansible-playbook -i deploy/ansible/inventory.yml deploy/ansible/retire-scanner-donor.yml \
  -e release_sha=PREPARED_RUNTIME_40_CHARACTER_SHA
```

Retirement leaves donor containers, credentials and backups intact for recovery,
but stops its resident scanner processes and keeps its cron inactive. Supabase
remains the single production database and Auth project.

The commerce data move uses the already prepared production runtime SHA. The
controller may contain newer Ansible playbooks; it does not check out or rebuild
that newer commit on the VM. The ordered stages are `freeze-backup-commerce`,
`restore-commerce`, `start-commerce-private`, `activate-commerce-public`, and
`retire-old-commerce`. Run one stage at a time, reviewing its `--check` output
and the resulting recovery evidence before applying the next stage:

```sh
step=freeze-backup-commerce
ansible-playbook -i deploy/ansible/inventory.yml "deploy/ansible/${step}.yml" \
  -e release_sha=PREPARED_RUNTIME_40_CHARACTER_SHA --check
```

After the preview and its prerequisites pass, apply the same stage:

```sh
step=freeze-backup-commerce
ansible-playbook -i deploy/ansible/inventory.yml "deploy/ansible/${step}.yml" \
  -e release_sha=PREPARED_RUNTIME_40_CHARACTER_SHA
```

Keep the steps separate in practice. `freeze-backup-commerce.yml` pins the old
live project's release, images, configuration, volume and actual running
environment, and refuses unfinished orders or active queue jobs. It gracefully
stops only its gateway, cabinet worker and web, leaving the old Postgres and the
test stack intact. A final dump, the exact old and new protected environments,
and a row fingerprint go to the source, new VM and ignored off-VM controller
storage. The release-specific dump is never replaced on a retry. The ten
original business tables are compared using the observed source column lists;
later migration-added fields do not hide or falsely change an original row.

`restore-commerce.yml` requires the old writers still stopped and all protected
backup copies equal. It uses the distinct final `agentify-commerce` PostgreSQL
volume, never the private warmup volume. It restores only an empty database in
one transaction, verifies original-row counts and hashes, runs migrations
as a synchronous one-off service, and verifies those original rows again before
writing protected restore proof. A complete matching restore can be retried;
partial, foreign or changed data is refused without deleting a volume.

`start-commerce-private.yml` takes writer ownership only after restore proof and
starts the final gateway, cabinet and inner Caddy in order. It probes health,
the public catalog and documentation over the private Docker network while
`app.agentify.ad` still returns 503. It refuses a connected WooCommerce shop in
the new database before the first cabinet start and checks that original rows
and the old stopped state remain intact. `activate-commerce-public.yml` then
switches only the Caddyfile in the shared scanner/commerce edge project, keeping
its admin credentials, certificate volumes and scanner routes. Valid HTTPS GET
probes must pass for commerce and scanner. If acceptance fails or an unmarked
public edge is found on retry, Ansible attempts both writer stop and the app
maintenance route, then reports the observed result of each action. Both
databases remain for reviewed reconciliation even if either recovery attempt
fails.

Only after the public probes pass does `retire-old-commerce.yml` stop the old
Postgres and the private warmup containers. It keeps their volumes, original
configurations and backups; it never runs `down -v` or prunes Docker data. The
old commerce web has been stopped since freeze, so the old hostname no longer
serves that application. Existing clients need the new `app.agentify.ad` origin;
an HTTP redirect does not transfer payment or API requests safely.

Each stage has a retry boundary. Freeze cannot be repeated if source rows or
secrets drift from the protected dump; restore cannot be repeated after final
writers change data; private startup requires app maintenance; public activation
requires old Postgres still preserved and running; retirement can be rerun after
all old processes stop. Never restore an earlier dump over newer target effects
or restart the old writer set against stale data. The read-only probes and row
hashes prove retained records and routes. Real account-password login and a
purchase are not performed by these playbooks and require separate acceptance
without using a production payment as a deployment probe.
