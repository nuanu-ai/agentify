# 0005. The web surface: one origin, one door

Date: 2026-08-27
Status: accepted; code from outside Agentify in the origin, 2026-10-15, on the
product owner's choice of Coinbase Wallet

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
makes are left out of the gateway's paths (ADR-0014, ADR-0019). The dashboard
calls the gateway's application inside the process the two share
(`docs/research/35-one-process.md`), so one rule keeps the published contract
complete: a dashboard screen that needs what a merchant's code could need gets
a contract route, never a private call.

Code from outside Agentify runs in the origin only from a package pinned in
the lockfile and served by the origin itself, loaded on the page that needs it
when the person presses for it, and holding no power the person does not
approve each time outside this origin. The one such package is Coinbase
Wallet's SDK on the dashboard's settings page: every signature and transaction
it asks for is approved in Coinbase's window, its analytics are off, and its
sub-accounts, which keep a key in the page that signs without asking, are
never used (`docs/research/48-merchant-wallet-onboarding.md`).

`/healthz` sits outside the contract's prefixes, because a probe is not
something a merchant's code calls, and answers for the gateway alone; the
dashboard answers at `/dashboard/healthz`. There is no aggregate verdict,
which would be wrong the first time one service went down by itself.

## Consequences

A merchant's engineer has one address to integrate against, and a person's
session crosses every surface. One origin is one script authority: an escaping
defect on any surface reaches the session for all of them, and so does a
defect in the pinned Coinbase package, which can do whatever the merchant's
session can, a replacement of the payout wallet included; on the live channel
that change waits forty-eight hours behind a message to every account
(ADR-0019).

Rejected: an origin per surface, which isolates scripts but stops the session
crossing between them and gives a merchant's engineer several addresses. That
is the way out if script isolation becomes a requirement. Rejected as well: a
provider's script fetched from its own servers, which changes under the page
without review; and a wallet whose code in this origin moves money without
the person approving it in a window outside it, such as Coinbase Developer
Platform's embedded wallet, which would leave Agentify's pages able to spend a
signed-in merchant's money.
