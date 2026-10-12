# 0005. The web surface: one origin, one door

Date: 2026-08-27
Status: accepted

## Context

Four things answer a browser or an agent on Agentify: the scanner, the
documentation portal, the merchant's dashboard and the gateway (the merchant's
API under `/v0`, the storefront an agent buys at under `/x402`). How they share
addresses and a session is a security boundary, and it is expensive to change
once merchants hold links, keys and code against those addresses. Where the
dashboard runs and how its pages are built is a design note,
`docs/research/35-one-process.md`.

## Decision

Caddy is the only address anybody types: `/docs` is the portal, `/dashboard`
the dashboard, `/v0` and `/x402` the gateway, `/healthz` the gateway's
readiness probe, and every path nobody else claims is the scanner's. One route
table, `deploy/Caddyfile`, serves a laptop and both channels, `agentify.ad` and
`test.agentify.ad`, which differ in data, secrets and payment network but not
in routing.

The origin is the boundary between the surfaces. One session cookie reaches
all of them (ADR-0026 §2) and a script injected into any page acts with it, so
whatever the scanner renders from somebody else's site is escaped. The door
also decides what the origin does not carry: the calls only the dashboard
makes are left out of the gateway's paths (ADR-0014, ADR-0019).

`/healthz` sits outside the contract's prefixes, because a probe is not
something a merchant's code calls, and answers for the gateway alone; the
dashboard answers at `/dashboard/healthz`. There is no aggregate verdict,
which would be wrong the first time one service went down by itself.

## Consequences

A merchant's engineer has one address to integrate against, and a person's
session crosses every surface. One origin is one script authority: an escaping
defect on any surface reaches the session for all of them.

Rejected: an origin per surface, which isolates scripts but stops the session
crossing between them and gives a merchant's engineer several addresses. That
is the way out if script isolation becomes a requirement.
