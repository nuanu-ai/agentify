# Independent public probes

This producer-owned Compose project runs on Joglo, independently of both
Agentify application hosts. It uses each channel's existing write-only metrics
identity. It changes no shared receiver, access policy or alert configuration.

The three anonymous GETs check the scanner HTML page, the catalog's JSON
envelope and the sign-in HTML page. Public DNS, trusted public TLS, a 2xx
answer, expected content type and page-specific markers must all succeed;
redirects fail. Scanner HTML must contain its URL input; sign-in HTML must
contain the email input and sign-in form action. Generic HTML and the wrong
surface fail even with HTTP 200. The fixed probe user agent lets application
metrics separate probes from client traffic without retaining header values. These
checks do not prove that a user can sign in, finish a scan or buy a product.
The vantage point is one independent host, not a multi-region uptime service.

## Install on Joglo after review

Copy this directory from the merged Agentify revision to
`/opt/agentify-public-probes`. First check that host loopback ports 12347 and
12348 are free. In a root shell, copy the existing issued bundles without
printing or sourcing them:

```sh
install -d -m 0700 /etc/agentify-public-probes
install -m 0400 /etc/observability-runtime/writers/agentify-test.env /etc/agentify-public-probes/test.env
install -m 0400 /etc/observability-runtime/writers/agentify-production.env /etc/agentify-public-probes/production.env
install -m 0400 /etc/observability-runtime/caddy-root.crt /etc/agentify-public-probes/joglo-ca.crt
cd /opt/agentify-public-probes
docker compose config --quiet
docker compose run --rm --no-deps test validate /etc/alloy/config.alloy
docker compose run --rm --no-deps production validate /etc/alloy/config.alloy
docker compose up -d
```

Compose overrides the CA path to the installed copy while preserving the
issued URLs and credentials. It supplies no tenant override. Both containers
use the same digest-pinned Alloy image as the host collectors. Each has its
own write-ahead log, 256 MiB memory and a quarter CPU. Logs rotate at three
10 MiB files. The containers mount only their configuration, pinned CA and
own state volume. They have no Docker socket, host filesystem or PID access.
The host network provides normal public routing; Alloy's management listeners
bind only to loopback on 12347 and 12348.

## Accept delivery

Check the installed source revision and container health, then query the
self-hosted Mimir reader through Grafana:

```promql
probe_success{app="agentify",job="agentify/public",vantage="joglo"}
time() - timestamp(probe_success{app="agentify",job="agentify/public",vantage="joglo"})
probe_duration_seconds{app="agentify",job="agentify/public",vantage="joglo"}
```

Expect six distinct fresh series: `test` and `production`, each with
`scanner_page`, `catalog` and `sign_in_page`. Their `instance` is `joglo`.
Every probe runs every thirty seconds with an eight-second request limit.
Read back actual success values and freshness; a running container alone
does not prove delivery. A zero indicates a failed public check from Joglo;
missing data is unknown. Compare host-local readiness and application
telemetry before assigning a cause. Confirm a deliberately wrong body
marker fails in a local disposable validation, never by altering a live site.

`docker compose stop` stops this project without touching shared observability
or Agentify. Keep its state volumes; do not use `down -v`. Writer rotation
follows the shared writer procedure and updates these protected copies too.

## Local acceptance check

Run `python3 deploy/observability/public-probes/smoke.py` from the repository.
It needs Docker with the pinned Alloy image and `python:3.12-slim-bookworm`
already cached. An internal Docker network contains its HTTP fixture and
collector; it contacts no public site or remote receiver. The check reads real
remote-write samples, verifies all canonical labels and three successes, then
changes the fixture to an HTTP-200 HTML error page, swapped page contents,
wrong JSON and a redirect and requires failures. Each phase waits for fresh
observations, so an earlier failed sample cannot satisfy a later check. The
fixture also requires the probe traffic tag. It removes only the containers
and network it creates.
