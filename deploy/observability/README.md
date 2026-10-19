# Agentify telemetry

This separate Compose project sends Agentify logs to the shared self-hosted
Loki and host, collector and public readiness metrics to Mimir. Grafana reads
both through the existing Joglo data sources. It defines no alerts or external
notifications. Application releases do not restart this collector.

The matching shared changes live in `nuanu-ai/observability` (two dedicated
writer identities, metrics and logs only) and `nuanu-ai/infra` (two narrow mesh
routes and the Agentify dashboard). Those changes must pass their reviewed
deployment before either collector can deliver data. A running collector alone
does not establish delivery.

## What is collected

Docker discovery follows container replacement during releases. Only the
`agentify` and `agentify-edge` projects' `app`, `scanner`, `scanner-worker`,
`web` and `caddy` services are selected. The Woo fixture, other applications,
the host journal and raw PostgreSQL logs are excluded. Database errors can
contain SQL values, and the scanner's structured diagnostics already describe
database connectivity without those values.

Loki labels are `app`, `environment`, `job`, `service`, and JSON severity when
present. Request, scan and order identifiers stay in the log body. TEST's
sandbox email is excluded: its first line is dropped explicitly, and commerce
lines without the application's diagnostic prefix are dropped as well. This
also excludes unprefixed commerce stack continuations; the source Docker logs
remain available on the host. Caddy keeps its existing URI/header redaction. PRODUCTION collects the edge's
access log; TEST has Caddy runtime logs and scanner request logs, with no
separate Caddy access log.

Metrics describe CPU, memory, filesystem, disks and network; the collector's
own scrape and write status; and three public readiness checks. `/api/health`
also checks the scanner worker, database, queue and analytics outbox.
`/healthz` and `/dashboard/healthz` check their respective listeners. These
requests do not make purchases or start scans. A public probe can fail because
of the producer's egress as well as the application itself; this is not an
independent external uptime service. TEST shares a machine with other
workloads, so its host metrics describe that whole machine.

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
`AGENTIFY_CHANNEL=test` or `AGENTIFY_CHANNEL=production` and
`OBSERVABILITY_GATEWAY_IP` set to Joglo's inspected mesh address. This address
is installed as a container-local hosts entry because TEST does not resolve
mesh names through its system DNS. It grants no network access: the mesh route
must already permit TCP/8443 from the exact producer.

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

## Verify delivery and stop the failed Cloud collector

Make one ordinary GET to each public health route and one scanner page on
each channel. From the Grafana Agentify dashboard, verify fresh log entries
under both environments, including a real scanner request and PRODUCTION's
edge log. Verify three distinct `probe_success` series per environment and
fresh host and collector metrics. A missing series is unknown, not healthy.

Bounded queries in Explore include:

```logql
{app="agentify",environment="test",service="scanner"}
```

```promql
probe_success{app="agentify",job="agentify/health"}
up{app="agentify",job=~"agentify/(host|collector)"}
sum by (environment, reason) (increase(loki_write_dropped_entries_total{app="agentify",component_id="loki.write.joglo"}[5m]))
```

Confirm writer credentials cannot read data or write traces. Inspect collection
errors and delivery counters as well as container status. Sign in on TEST and
verify its sandbox mail is still available locally and absent from Loki.

After both destinations are verified on PRODUCTION, disable only its old
`alloy.service`. Keep the new Compose collector running. Cloud writes already
return 401; enabling the old service is not a verified recovery destination.

Rollback stops this separate project with `docker compose --env-file
/etc/agentify-observability/collector.env stop`. Keep its volume and the
application containers; do not run `down -v`. Local application logs continue.
Do not change `deploy-test` or release an application merely to change this
collector.

## Local checks

`python3 deploy/observability/smoke.py` runs the real Docker discovery and Loki
pipeline against temporary synthetic containers and a local echo receiver.
It checks useful diagnostics, channel labels, mail exclusion and unrelated
service exclusion, and removes only its temporary containers. It needs Docker
and the pinned image already cached; it performs no remote writes or public
health probes. It is separate from the deterministic `pnpm test` suite.
