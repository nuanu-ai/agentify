# 0030. The gateway and the cabinet are one process

Date: 2026-09-25
Status: proposed (direction set by Dmitry on 2026-09-25; details await his word)

## Context

ADR-0005 made the gateway, the money path under `/v0` and `/x402`, and the
cabinet, the merchant's pages, two processes, with the cabinet a client of the
public API. The cabinet owns people (ADR-0009) and the gateway knows none, so
everything between them is a network call with a credential, and three things
exist for that alone: a key per account for the cabinet to call as its
merchant, stored as issued, renewed at sign-in and daily, and left alive when a
renewal breaks off (ADR-0014 §2, §5); a route with its own secret for the
gateway to have a merchant mailed about a payout wallet change or a new key
(ADR-0019); and the refusal `wallet_change_unconfirmed`, for a cabinet that did
not answer. The boundary protects little: both processes write the one
database as its superuser (ADR-0024), payout wallets included, run from one
image and are released together (`deploy/activate.sh`). The survey is
`docs/research/35-one-process.md`.

## Decision

**One process**, the `app` service, named after the image it runs from. Two
public listeners let each surface keep its middleware and Caddy change only
host names: port 3000 serves `/v0`, `/x402` and `/healthz`, port 3001 serves
`/cabinet` and `/cabinet/healthz`, and the health check asks both. Port 3002
stays the scanner's route to the cabinet (ADR-0026 §2); the scanner stays
apart, and Caddy the one door.

**The cabinet calls the application, not the HTTP API.** Its screens, its
WooCommerce worker and its registration call the `Gateway` methods the `/v0`
handlers call, as the merchant on the signed-in account's row, recorded as the
cabinet rather than as a key, with requests and answers still held to the
contract's schemas. The cabinet then proves that the application and the
contract's documents are enough to draw every screen, and no longer that the
HTTP API is. What proves that is what a merchant's engineer uses: the SDK's
tests, the purchase through the real gateway in `packages/slice`, the portal's
examples run as fixtures, and the gateway's HTTP test of every `/v0` route. A
screen that needs what a merchant's code could need still gets a contract route.

**What goes.** The cabinet key, with its renewal, its leftovers, the
`merchant_key` column, the routes at `/v0/keys/cabinet` and their two
refusals, so that every key left is one the merchant issued; the route on port
3003 with `GATEWAY_CABINET_SECRET` and `CABINET_INTERNAL_URL`;
`wallet_change_unconfirmed`; the cabinet's HTTP client with `GATEWAY_URL`; and
the public registration route with its invitation, if the registration change
in flight leaves them. Besides the race, two wallet refusals remain, because
the mail provider is still outside: nobody to tell, and a message the provider
did not take while others may have gone out.

**The move** is four pull requests, each leaving `main` releasable: one
process with both calls still made over loopback, the only step that touches
deployment; the gateway telling the cabinet in-process; the cabinet calling the
application in-process; the key deleted from the contract, the gateway and the
data. The contract version stays, since no SDK worker calls these routes or
reads these codes: the reasoning of ADR-0006 §2, whose exception this widens
beyond the payout wallet route.

## Consequences

A defect in the cabinet now stops sales: a crash, a leak or a blocked event
loop ends the process holding every parked purchase and worker poll. Orders
resume from Postgres after the restart (ADR-0013); a synchronous purchase in
flight is lost to its agent, which retries. That is accepted because the two
are already released and restarted together, and at this scale a crash is a
defect to fix rather than a load to isolate. The money path shares a process
with sessions, mail and the power to remove a person, kept apart by the package
boundary and review, as they already were in the database. The release's checks
per service become one service's, and the preflight's comparisons of the two
environments go. The trigger to split again is a measured incident in which
the cabinet took sales down, or a cabinet that needs a runtime the gateway
cannot share.

Rejected. **Microservices**: more network, more secrets and more states of "did
not answer", the cost removed here. **A growing internal route**: each fact
about people the money path needs becomes one more call with its own refusal
for silence. **Keeping the cabinet on `/v0`**: over loopback, something on the
public listener must name the merchant, the second mode of authentication
ADR-0014 rejected; through the handlers in-process, the published contract
keeps describing a caller with no key. **Merging the scanner**: a Next.js
server and a browser-driving worker, whose one call to the cabinet is about
identity rather than money, would add the crash cost above for nothing, until
that call grows.
