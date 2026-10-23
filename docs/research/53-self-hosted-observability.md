# Agentify service health

The primary reader is the owner acting as the on-call operator. The dashboard
answers whether the product is serving users, which workflow is stalled and
where to investigate next. The folder is `Agentify`; the dashboard is
[`Service health`](https://grafana.nuanu.ai/d/agentify-overview/service-health).
It opens on production, with TEST selected separately. The owner manages it
directly in Grafana and adopts it afterward. No dashboard provisioning change,
alert rule or notification route belongs to this work.

The design follows [Google SRE's monitoring guidance](https://sre.google/sre-book/monitoring-distributed-systems/):
user-visible symptoms precede causes, and traffic, errors, latency and saturation
answer different questions. [Grafana's RED guidance](https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/)
organizes HTTP request measurements. [Prometheus instrumentation guidance](https://prometheus.io/docs/practices/instrumentation/)
requires bounded dimensions and distinguishes absent observations from zero.
These methods structure the questions; the application state machine and actual
measurements determine the signals.

## Questions and evidence

| Operator question | Evidence | Interpretation and limit |
| --- | --- | --- |
| Can someone reach the product? | Public DNS/TLS/HTTP/body checks from Joglo for the scanner, catalog and sign-in page | Independent of both app hosts; anonymous surface checks do not prove sign-in, scanning or payment completion. |
| Are requests arriving and failing? | HTTP request counts by bounded route/method/response class; 5xx and abandoned answers separate | Expected x402 payment challenges are 4xx. No requests means idle, not demonstrated success. Health/assets and merchant long polling are excluded from interactive latency. |
| Is it responsive? | Request-duration histogram p50/p95 and observation count, split by component | No latency without observations. A percentile with few requests is weak evidence. No invented SLO or arbitrary healthy-latency threshold. |
| Are scans progressing? | Queue length/oldest age, running/stale workers, accepted and finished outcomes over fifteen minutes, completion p50/p95 and count | Durable scan rows avoid double-counting retries. Acceptance-to-finish duration differs from HTTP response time. |
| Is commerce stuck or financially uncertain? | Open and overdue orders, oldest overdue age, unknown payment outcomes and oldest settlement uncertainty | Core deadlines use each order's stored policy. Unknown payments include closed orders. These gauges are neither payment retry instructions nor purchase-success rates. |
| What version and evidence am I looking at? | Source SHA from each image, target reachability, snapshot success and last-success timestamp | A reachable listener can still have a failed business snapshot. Missing or incomplete data stays unknown. |
| What explains the symptom? | Worker dependencies/heartbeat, analytics leases and dead letters, host capacity, collector delivery and scoped error logs | These are diagnosis signals below the product view. TEST host capacity covers a shared VM. Log volume is not a count of purchases. |

## Layout and interpretation

The first row presents independent public access, telemetry coverage and
request symptoms. The workflow row shows scans and commerce, with the meaning
of the fifteen-minute cohort stated beside its charts. Diagnostics and
telemetry delivery are collapsed by default. Log panels preserve the selected
environment and time range; the service filter applies to log investigation,
not to the product-level questions above it.

Public probes and same-host readiness have separate labels and panels.
`job="agentify/public",vantage="joglo"` answers the public-access question.
`job="agentify/health"` describes the producer's path to its own public
health routes. TEST's same-host checks currently time out even though its
public surfaces answer externally; the cause of that path failure is not
proved. It must not become a product-down verdict.

A missing series is unknown, and a failed snapshot removes business gauges.
Each expected public surface and application target remains explicitly visible
as unknown when just that source disappears; a partial set of green fields
does not represent complete coverage. Tagged public probes are excluded from
client HTTP counts and latency and remain visible in diagnostics separately.
A current successful snapshot with a zero count establishes an empty queue or
cohort. HTTP 5xx, abandoned answers and expected 4xx remain distinct. Request
latency excludes intentional worker long polling; scan completion latency is
shown independently. No aggregate success percentage mixes these denominators.

## Collection and delivery

Producer collectors send filtered Docker logs to self-hosted Loki, and host,
collector, readiness and private application measurements to Mimir. Each
channel uses its own existing write-only identity and the pinned Joglo CA.
Shared receiver ownership stays in `nuanu-ai/observability`; narrow mesh access
stays in `nuanu-ai/infra`. Neither needs a further change for these measurements.
The [producer runbook](../../deploy/observability/README.md) and
[public-probe runbook](../../deploy/observability/public-probes/README.md)
define installation, readback and rollback.

The installed collectors already deliver logs and baseline metrics from both
channels. The application instrumentation and Joglo probe source in this change
are pending review and rollout. The dashboard prepares their queries but reports
missing data until those measurements arrive. Dashboard existence, a successful
build or a running collector is not acceptance of live telemetry.

Application instrumentation adds no user events or request payload logs.
No log line carries a buyer's key, an order's status address, a WooCommerce
order key or a WooCommerce download link, since each opens an order or its
goods to whoever reads the shared stack. A line names an order by its
identifier, which opens nothing, and an operator with the database reads the
order with the query in the [producer runbook](../../deploy/observability/README.md#finding-an-order-a-log-line-names).
Database snapshots use a separate read-only pool with bounded execution time.
Commerce observes at most 1,000 matching orders; exceeding that limit marks
coverage unavailable rather than reporting a truncated healthy count.
[The security boundary](../decisions/0040-operational-metrics-stay-private.md)
keeps listeners private and prohibits observability from modifying business state.

## Acceptance

Unit checks cover actual HTTP completion/abandonment, bounded routing, expected
payment challenges, snapshot failures and time semantics. Disposable Postgres
checks exercise the real queries, migrations, read-only enforcement and statement
timeout. A separate adversarial reader checks the source and deployment boundary.
Local Alloy validation and positive/negative probe-content checks establish the
configuration's behavior without sending credentials or writes to a live receiver.

After the reviewed source is released, verify the exact image source SHA, the
three private listeners and application scrapes per channel, successful business
snapshots, and six independent public checks. Read back fresh samples through
Mimir and actual logs through Loki. Inspect missing-data behavior as well as
successful samples. A real end-to-end paid purchase, authenticated sign-in or
completed scan remains a separate acceptance exercise with its own authority
and spending limits; this dashboard does not claim to perform those exercises.
