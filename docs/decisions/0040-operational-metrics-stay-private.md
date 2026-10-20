# Operational metrics stay private

Status: accepted, 2026-10-20.

## Context

The owner and on-call operator need request latency and failure measurements,
queue progress and unresolved payment outcomes. Public health endpoints do not
establish these facts. Logs can help investigate an operation but are not an
authoritative count of durable orders or scans.

## Decision

Application processes expose aggregate Prometheus metrics on a separate
container listener. Deployed channels publish these listeners only on host
loopback; the public router forwards no request to them. The existing host
collector reads them and uses the channel's existing metrics writer.

Metrics contain bounded operation classes, methods, response classes and
domain states. A fixed probe tag separates synthetic and client HTTP
observations without retaining user-agent values or granting authority.
They contain no customer, merchant, product, order or request
identifiers, URLs, credentials or payloads. The source revision is baked into
the image by CI. A local image without one identifies its revision as unknown.

Operational database reads use a separate read-only connection with bounded
connection and statement time. A failed or incomplete observation omits its
business measurements and reports its scope as unavailable. It never supplies
an assumed healthy zero. Monitoring cannot write business state, retry an
operation or move money.

Public probes run independently of the application hosts and perform only
anonymous reads. Their results identify the probe's vantage point and do not
claim that a purchase, sign-in or scan completed end to end.

## Alternatives rejected

Publishing metrics through the public router exposes internal operational
state unnecessarily. Deriving purchase counts from HTTP responses or retry
logs mistakes attempts for durable outcomes. Reusing the application's
connection pool allows observability work to consume its serving capacity.
