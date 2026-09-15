# Agentify deployment preparation

The target has two public IP addresses. `agentify.ad`, `www.agentify.ad` and
`app.agentify.ad` reach the production VM; `test.agentify.ad` reaches the
existing Comino ingress and test cabinet on `dmitry-dev`. Production has no
route to the test application. Moving the data does not combine the commerce
and scanner databases or authentication systems.

All server changes use [the Ansible playbooks](../../deploy/ansible/README.md).
Provider VM and shared ingress configuration remain owned by `nuanu-ai/infra`.
The application repository owns the application checkout, images and Compose
configuration. The earlier manual bootstrap is existing state for Ansible to
adopt; it is not a second deployment procedure.

## Prepare before changing DNS

Use one reviewed full commit SHA and successful CI for that SHA. Run the
production and test preparation playbooks in check mode, then apply them and
repeat. Require the second apply to report `changed=0`. These operations stage
an exact release and protected configuration without starting production or
changing the running test stack. The playbooks document their validation and
check-mode limits; staging files is not evidence of a working application.

The production edge in `deploy/edge` is the only public HTTP/HTTPS listener.
It preserves the scanner admin authentication and privacy-filtered access log,
redirects www to the apex, and proxies app to the private commerce Caddy.
The ingress network has a fixed edge address; the inner commerce Caddy trusts
forwarded headers only from that address. Both applications retain their own
private database/project and independent images.

Use the commerce base Compose file, public override and Hetzner override.
The scanner uses its existing production Compose file with
`ops/deploy/droplet/compose.hetzner.yaml`; its old Caddy service stays disabled.
Build each shared image once rather than building its consumers concurrently.
The test candidate uses `deploy/compose.agentify-test.yaml` and its own secrets,
with the existing `10.20.10.20:8443:443` listener. The shared ingress's SNI map,
HTTP redirect and acceptance checks must name `test.agentify.ad` before its
public switch. This is an owner-run Ansible change in the infra repository.

Preserve source production keys and configuration through protected transfer:
commerce merchant seed, session-signing material, mail and facilitator keys;
scanner signing/encryption keys, database roles, auth/provider settings and
worker configuration. Scanner browser auth values must match its server values
at image build time. A missing source configuration is a preparation blocker,
not a reason to invent production secrets or disable authentication.

## Acceptance and the maintenance window

A rehearsal dump may be taken while the old application is live, but it is
not the final migration snapshot. Prove a restore and both migration histories
on an isolated database, comparing existing account, merchant, key, card,
order, receipt and payment-claim data. Run database tests only against their
separate scratch database. Keep protected recovery copies off the new VM.

The final cutover playbooks require the actual source inventory. They must
freeze source writes and jobs, prevent an old receiver from restarting them,
take fresh stopped-writes backups and configuration, restore into verified
empty targets, compare data and apply migrations. Keep the old volumes intact.
Do not use real purchases as probes. Validate existing-account login, catalog,
orders and reports as well as health endpoints; health alone cannot prove data
or authentication. Test data must not become production data.

Start neither a scanner worker nor a live gateway against rehearsal data with
external access: both can produce effects before public traffic opens. Before
resuming an old instance after a failed activation, stop new writers, preserve
a new dump, and reconcile any writes, settlements, deliveries or jobs. DNS
still pointing at the old host does not prove that no effects occurred. Never
restore an earlier dump over newer accepted state.

## One external DNS change

After server and data acceptance, send the complete apex/www/app/test record
set to the Namecheap owner once. The apex and app target production; test uses
its own public ingress address. Keep the existing mail and verification DNS
records and nameservers. Public certificates and outside-path acceptance are
verified after the names resolve to their prepared endpoints.

Check apex, www redirect, app landing/docs/cabinet/catalog, test cabinet and
all public health routes. Verify Host, HTTPS scheme and client-address handling
through the production edge, including refusal of spoofed forwarded headers.
Mark the release accepted only after these checks and an updated inventory of
active domains, data owners and paused/retired old deployment triggers.
