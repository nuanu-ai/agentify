# 0030. The gateway and the dashboard are one process

Date: 2026-09-25
Status: accepted (the product owner, 2026-09-25). Built up to the dashboard
calling the application; the key made for a dashboard, its routes and the
registration route remain until the last step in
`docs/research/35-one-process.md` lands.

## Context

The gateway is the money path under `/v0` and `/x402`, and the dashboard is the
merchant's pages; the dashboard owns people (ADR-0026 §2) and the gateway knows
none. As two processes, everything between them is a network call with a
credential, which takes a key per account for the dashboard to call as its
merchant (ADR-0014), a route with its own secret for the gateway to have a
merchant mailed (ADR-0019), and a refusal for a dashboard that did not answer.
That boundary protects little: both write the one database as its superuser
(ADR-0003 §2), payout wallets included, and run from one image, released together.

## Decision

One process, the `app` service, named after the image it runs from. Two public
listeners let each surface keep its middleware and Caddy change only host
names: port 3000 serves `/v0`, `/x402` and `/healthz`, port 3001 serves
`/dashboard` and `/dashboard/healthz`, and the health check asks both. Port
3002 stays the scanner's route to the dashboard (ADR-0026 §2); the scanner
stays apart, and Caddy is the one door.

The dashboard calls the application, not the HTTP API. Its screens, its
WooCommerce worker and its registration call the `Gateway` methods the `/v0`
handlers call, as the signed-in account's merchant, held to the contract's
schemas, and the message about a payout wallet change, asked for only in the
dashboard (ADR-0019), names the signed-in person. The dashboard then proves
that the application and the contract's documents can draw every screen. What
proves the HTTP API is what a merchant's engineer uses: the SDK's tests, the
purchase through the real gateway in `packages/slice`, the portal's examples
run as fixtures and the gateway's HTTP test of every `/v0` route. A screen that
needs what a merchant's code could need still gets a contract route.

Inside the process nothing between the two needs a credential: the gateway
tells the dashboard by a call, with no route, secret or refusal for silence.
The dashboard key goes, with its routes at `/v0/keys/dashboard`, their refusals
and the `merchant_key` column, so that every key the gateway knows is one the
merchant issued, and the registration route and its invitation code go too. Of
the payout wallet refusals, only the race and those about the mail provider,
still outside, remain. No SDK worker calls these routes or reads these codes,
so the contract version does not move: ADR-0006 §2's exception widens to them.

## Consequences

A defect in the dashboard stops sales: a crash, a leak or a blocked event
loop ends the process holding every parked purchase and worker poll. Orders
resume from Postgres after the restart (ADR-0013), and a synchronous purchase
in flight is lost to its agent, which retries. That is accepted because the two
are already released and restarted together, and at this scale a crash is a
defect to fix rather than a load to isolate. The money path shares a process
with sessions, mail and the power to remove a person, kept apart by the package
boundary and review, as in the database. The trigger to split again is a
measured incident in which the dashboard took sales down, or a dashboard that
needs a runtime the gateway cannot share.

Rejected: microservices (more network, more secrets and more states of "did not
answer", the cost removed here); a growing internal route (each fact about
people the money path needs becomes one more call with its own refusal for
silence); keeping the dashboard on `/v0` (over loopback something on the public
listener must name the merchant, the second mode of authentication ADR-0014
rejected; in-process the published contract would describe a caller with no
key); merging the scanner (a browser-driving worker whose one call to the
dashboard is about identity, not money, would add the crash cost for nothing).
