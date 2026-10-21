# Agentify telemetry

This separate Compose project sends Agentify logs to the shared self-hosted
Loki and application, host, collector and readiness metrics to Mimir. Grafana reads
both through the existing Joglo data sources. It defines no alerts or external
notifications. Application releases do not restart this collector.

The matching shared changes live in `nuanu-ai/observability` (two dedicated
writer identities, metrics and logs only) and `nuanu-ai/infra` (two narrow mesh
routes). Those changes must pass their reviewed deployment before either
collector can deliver data. On the owner's instruction the Agentify overview
is created directly in Grafana for later adoption. Delivery does not depend on
dashboard provisioning. A running collector alone does not establish delivery.

The [Service health dashboard](https://grafana.nuanu.ai/d/agentify-overview/service-health)
opens on production and lets the operator select TEST separately. Its questions
and signal definitions are in the [design note](../../docs/research/53-self-hosted-observability.md).
Missing measurements mean unknown. They do not establish that the product works.

## What is collected

Docker discovery follows container replacement during releases. Only the
`agentify` and `agentify-edge` projects' `app`, `scanner`, `scanner-worker`,
`web` and `caddy` services are selected. The Woo fixture, other applications,
the host journal and raw PostgreSQL logs are excluded. Database errors can
contain SQL values, and the scanner's structured diagnostics already describe
database connectivity without those values.

Loki labels are `app`, `environment`, `job`, `service`, and JSON severity when
present. Request and scan identifiers stay in the log body. An order's
identifier does not, nor its status address, because whoever holds either can
read the order and its goods, and these logs are read by more people than the
database; how a line names an order instead is under
[Finding an order a log line names](#finding-an-order-a-log-line-names).
Neither does a WooCommerce order key (`wc_order_…`) or a download link: in a
link, `order` and `uid` are that one buyer's secrets, while its `key` is the
file's download identifier, which every buyer of the product shares. TEST's
sandbox email is excluded: its first line is dropped explicitly, and commerce
lines without the application's diagnostic prefix are dropped as well. This
also excludes unprefixed commerce stack continuations; the source Docker logs
remain available on the host. Caddy keeps its existing URI/header redaction. PRODUCTION collects the edge's
access log; TEST has Caddy runtime logs and scanner request logs, with no
separate Caddy access log.

Host metrics describe CPU, memory, filesystem, disks and network; the collector's
own metrics describe scrape and write status. Three same-host public checks remain
under `job="agentify/health"`. `/api/health`
also checks the scanner worker, database, queue and analytics outbox.
`/healthz` and `/dashboard/healthz` check their respective listeners. These
requests do not make purchases or start scans. A public probe can fail because
of the producer's egress as well as the application itself; this is not an
independent external uptime service. TEST shares a machine with other
workloads, so its host metrics describe that whole machine.

Application metrics use `job="agentify/application"`, with services `app`,
`scanner` and `scanner-worker`. They are available only after an application
image containing this instrumentation is released. Their private container
listener is port 9464; Compose publishes it on host loopback ports 19464,
19465 and 19466 respectively. The public router exposes none of these routes.
Local development opens no listener unless `AGENTIFY_METRICS_PORT` is set.
CI bakes the full source commit into `agentify_build_info{revision}`. A local
build without that argument reports `unknown`.

HTTP counters and histograms use bounded component, route template, method,
response-class and `traffic=client|probe` labels. Public probes send the fixed
`Agentify-Observability-Probe/1.0` user agent; raw user agents are never exported.
The tag separates diagnostic populations and grants no authority. Exclude
`traffic="probe"` from client traffic and latency; synthetic traffic stays
available separately. Expected payment challenges are 4xx, not server errors.
Abandoned answers have the separate `aborted` class. Exclude health, assets and
the intentional `/v0/worker/poll` long poll from interactive request latency;
show its sample count beside p50/p95. No requests, identifiers or payloads are
added to logs by this instrumentation.

Commerce gauges read durable order records. They count open orders, overdue
core deadlines and every `payment=outcome_unknown`, including closed rejected
orders. Unknown settlement age starts at `settleStartedAt`; overdue age uses
the order's stored policy through the core deadline function. Recent orders
are a fifteen-minute creation cohort grouped by their current state, not a
purchase-success rate or cumulative counter. Reads stop at 1,001 matching rows;
above the 1,000-row observation limit the whole commerce snapshot is unavailable.

Scanner gauges describe queued/running/stale-running work, oldest queued age
and durable outcomes finished in the last fifteen minutes. Completion duration
is acceptance to completion for completed/partial scans; quantiles are absent
when their observation count is zero. Analytics metrics include pending,
processing and dead-letter rows; retry lag includes expired processing leases.
Worker readiness, dependency state and heartbeat remain separately observable
when its database snapshot cannot be read.

Each database reader uses its own single-connection, read-only pool with a
1.5-second connection/statement timeout and a two-second query timeout. Scrapes
coalesce while an export is running. Check `agentify_snapshot_success`, last
successful `agentify_snapshot_timestamp_seconds`, and `agentify_snapshot_error`
alongside business gauges. A failed or incomplete snapshot removes those gauges
instead of repeating stale values or replacing them with zero.

[Independent public probes](public-probes/README.md) run on Joglo under
`job="agentify/public",vantage="joglo"`. They check the scanner HTML page,
catalog JSON and sign-in HTML page over public DNS and verified TLS. They do
not submit a scan, authenticate, invoke a payment or prove those journeys work.

## Install after the shared changes are accepted

Use `agentify-test` for TEST and `agentify` for PRODUCTION. No public address of
either host belongs in this repository. On each host, copy this directory from
the reviewed revision to `/opt/agentify-observability`. Keep that copy outside
the application release checkouts.

Transfer only that channel's root-owned writer bundle from Joglo:
`agentify-test.env` or `agentify-production.env` under
`/etc/observability-runtime/writers/`, and Joglo's pinned
`/etc/observability-runtime/caddy-root.crt`. Do not print either credential,
pass a password as a command argument, source the file, or use a shared writer.
Install them as root at these paths:

```text
/etc/agentify-observability/                 mode 0700
/etc/agentify-observability/writer.env       mode 0400
/etc/agentify-observability/joglo-ca.crt     mode 0400
```

In the installed bundle, set `OBSERVABILITY_CA_FILE` to
`/etc/agentify-observability/joglo-ca.crt`. Preserve the issued username,
password and URLs. The gateway assigns its tenant; the collector must not send
an `X-Scope-OrgID` header. TLS verifies the pinned CA and gateway hostname.

Create `/etc/agentify-observability/collector.env`, root-owned mode 0600, with
`AGENTIFY_CHANNEL=test` or `AGENTIFY_CHANNEL=production`. The two exact mesh
routes are delivered by [infra PR 370](https://github.com/nuanu-ai/infra/pull/370).
Both hosts resolve `joglo.tail.nuanu.ai` through mesh DNS. Verify hostname
resolution and pinned TLS from the collector's host network before starting
delivery; no hosts-file override is required.

From a root shell, on each host:

```sh
cd /opt/agentify-observability
docker compose --env-file /etc/agentify-observability/collector.env config --quiet
docker compose --env-file /etc/agentify-observability/collector.env run --rm --no-deps alloy validate /etc/alloy/config.alloy
docker compose --env-file /etc/agentify-observability/collector.env up -d
```

The image is pinned by digest. The collector has a 512 MiB memory limit and a
half-CPU limit; its own Docker log rotates at three 10 MiB files. Docker socket
access is effectively host administration even with a read-only mount. This
collector therefore runs in the host operator's trust boundary. Its HTTP
interface listens only on host loopback port 12346. Its state volume retains
Docker reading positions and the metrics write-ahead log across restarts.
Loki writes use the standard in-memory retry queue: an extended outage or
collector restart can lose pending log batches, visible in delivery counters.

## Application release and collector rollout

Keep the ordinary release discipline: CI builds the reviewed commit once,
TEST follows the coordinated `deploy-test` tag, and production receives an
approved `app-v*` release. Updating this collector does not release application
code. Before rolling out, check that host ports 19464–19466 are unused. After
releasing the images, verify loopback-only binds and fetch all three local
`/metrics` endpoints without a public proxy. Verify their `revision` matches
the actual deployed image's source commit.

Then copy the reviewed collector files and validate/restart the separate
Compose project with the commands above. Its application scrape may be
installed before the app release, but `up=0` then means missing instrumentation,
not a product outage. Install the Joglo probes separately using their runbook.
Neither step changes a writer identity, tenant, network ACL or shared receiver.

## Verify delivery

Check the deployed source revision against the merged Agentify revision. Make
one ordinary GET to each public health route and one scanner page on
each channel. From the Grafana Agentify dashboard, verify fresh log entries
under both environments, including a real scanner request and PRODUCTION's
edge log. Verify three distinct `probe_success` series per environment and
fresh host and collector metrics. Verify three fresh application targets,
matching image revisions, successful commerce/scanner/worker snapshots and
three independent public probes per environment. A missing series is unknown,
not healthy. Probe failures identify their vantage point: TEST's current
same-host public probes time out while its public site is reachable externally.
Do not infer product downtime from that path alone.

Bounded queries in Explore include:

```logql
{app="agentify",environment="test",service="scanner"}
```

```promql
probe_success{app="agentify",job="agentify/health"}
up{app="agentify",job=~"agentify/(host|collector)"}
up{app="agentify",job="agentify/application"}
agentify_build_info{app="agentify"}
agentify_snapshot_success{app="agentify"}
probe_success{app="agentify",job="agentify/public",vantage="joglo"}
sum by (environment, reason) (increase(loki_write_dropped_entries_total{app="agentify",component_id="loki.write.joglo"}[5m]))
```

Confirm missing and invalid credentials are rejected, writer credentials cannot
read data or write traces, and a client tenant override is refused. Inspect collection
errors and delivery counters as well as container status. Sign in on TEST and
verify its sandbox mail is still available locally and absent from Loki.

PRODUCTION's old Cloud `alloy.service` is stopped and disabled after verified
self-hosted delivery. Retain its files; enabling it is not a verified recovery
destination.

Rollback stops this separate project with `docker compose --env-file
/etc/agentify-observability/collector.env stop`. Keep its volume and the
application containers; do not run `down -v`. Local application logs continue.
Do not change `deploy-test` or release an application merely to change this
collector.

## Finding an order a log line names

A line about one order names it by a fingerprint: the word `order` and the
first twelve hex characters of the SHA-256 of the order's identifier, as in
`order a61ee826a3a0`. Every line about that order, from the gateway and from
the WooCommerce worker alike, carries the same fingerprint, so searching the
logs for it follows the order. Its identifier comes from the database, on the
host of the channel the line came from, with the fingerprint in place of the
example:

```sh
sudo "$(ls -dt /var/lib/agentify/production/checkouts/*/ | head -n 1)deploy/stack.sh" production exec -T postgres \
  psql -U agentify -d agentify -c "select id, state, merchant_id from orders where left(encode(sha256(convert_to(id, 'UTF8')), 'hex'), 12) = 'a61ee826a3a0'"
```

On TEST the path and the channel are `test`. The query computes the fingerprint
of every order in the table, a full read that grows with it. Two rows mean two
orders share a fingerprint, and the line's time and what else it says tell
them apart. No row means no order in the database has it now: an attempt that
lapsed unpaid is deleted thirty days after it ended. The identifier the query
prints opens the order, so it stays out of anything shared, this log stack
included.

The other way round, from an order's identifier to its lines, the
fingerprint is computed on the operator's own machine, so the identifier goes
to no service, and the logs are searched for `order` followed by what this
prints, `order a61ee826a3a0` for the example:

```sh
printf %s 'ord_7c1e05a9c4d84f0b9e2d6c3b1a8f5e47' | shasum -a 256 | cut -c1-12
```

## Local checks

`python3 deploy/observability/smoke.py` runs the real Docker discovery and Loki
pipeline against temporary synthetic containers and a local echo receiver.
It preserves the production selection logic and checks both allowed Docker
projects, useful diagnostics, channel labels, mail exclusion and unrelated
project/service exclusion, and removes only its temporary containers. It needs Docker
and the pinned image already cached; it performs no remote writes or public
health probes. It is separate from the deterministic `pnpm test` suite.
