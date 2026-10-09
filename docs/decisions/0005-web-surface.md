# 0005. The web surface: one origin, server-rendered pages, no client build

Date: 2026-08-27
Status: accepted

## Context

Four things answer a browser or an agent on Agentify: the scanner, the
documentation portal, the merchant's dashboard and the gateway (the merchant's
API under `/v0`, the storefront an agent buys at under `/x402`). How they share
addresses and a session is a security boundary, and how the dashboard is built
decides whether it can drift from the API merchants integrate against; both are
expensive to change once merchants hold links, keys and code against them.

## Decision

1. **One origin, one door.** Caddy is the only address anybody types: `/docs`
   is the portal, `/dashboard` the dashboard, `/v0` and `/x402` the gateway,
   `/healthz` the gateway's readiness probe, and every path nobody else claims
   is the scanner's. One route table, `deploy/Caddyfile`, serves a laptop and
   both channels, `agentify.ad` and `test.agentify.ad`, which differ in data,
   secrets and payment network but not in routing; the whole chain, Postgres
   included, comes up locally from `docker compose up`.

   The origin is the boundary between the surfaces. One session cookie reaches
   all of them (ADR-0026 §2) and a script injected into any page acts with it,
   so whatever the scanner renders from somebody else's site is escaped. The
   door also decides what the origin does not carry: the calls only the
   dashboard makes are left out of the gateway's paths (ADR-0014, ADR-0019).
   `/healthz` sits outside the contract's prefixes, because a probe is not
   something a merchant's code calls, and answers for the gateway alone; the
   dashboard answers at `/dashboard/healthz`. There is no aggregate verdict,
   which would be wrong the first time one service went down by itself.

2. **The dashboard runs in one process with the gateway, on a listener of its
   own (ADR-0030).** The gateway's surface stays the contract's route table,
   mounted in one generic loop; the pages for people stay `apps/dashboard`.

3. **The dashboard calls the gateway's application** as the merchant on the
   signed-in account's row (ADR-0030): the `Gateway` operations the `/v0`
   handlers call, inside the shared process, with requests and answers held to
   the contract's schemas. So the dashboard proves that the application and the
   contract's documents can draw every screen, and what a merchant's engineer
   uses proves the HTTP API: the SDK's tests, the purchase through the real
   gateway in `packages/slice`, the portal's examples run as fixtures and the
   gateway's HTTP test of every `/v0` route. A screen that needs what a
   merchant's code could need gets a contract route, never a private call. No
   query in the dashboard reaches the gateway's tables. Its own tables hold the
   people who sign in and their sessions (ADR-0026 §2) and the WooCommerce
   connector's bookkeeping (ADR-0023), never a card, an order or a receipt. One
   call goes the other way, inside the shared process: the gateway has the
   dashboard tell a merchant of a change to their payout wallet or keys
   (ADR-0019).

4. **Server-rendered HTML, no client-side framework, no client build.** Pages
   are tested over HTTP against the real gateway. Interactivity is form posts,
   and an inline script only where a control has a wait to draw, which takes
   the control away and gives it back while the HTML stays the working page; a
   screen that needs more argues for a framework on its own merits, as a
   recorded decision.

5. **The front page is the scanner's**, everywhere. The scanner is a Next.js
   application and not the dashboard, so §4 does not bind it.

## Consequences

A person clicks through the chain end to end, the dashboard proves by
construction that the application and the contract's documents can draw every
screen, and the local stack rehearses the deployment. One origin is one script
authority: an escaping defect on any surface reaches the session for all of
them. Rich interaction is awkward on server-rendered pages.

Rejected: a single-page application, which buys a build pipeline and a
dependency tree before any screen needs them; a dashboard querying the
gateway's tables, a second reader of the money path's data that would hide the
gaps in the contract's documents it exists to expose; and an origin per
surface, which isolates scripts but stops the session crossing between them and
gives a merchant's engineer several addresses. That last one is the way out if
script isolation becomes a requirement.
