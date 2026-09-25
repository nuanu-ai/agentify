# One process for the gateway and the cabinet

Date: 2026-09-25. A design note: a survey of how the gateway and the cabinet
are two processes today, what that boundary costs and buys, and the design for
making them one. Dmitry set the direction on 2026-09-25 and agreed with the
note's recommendations the same day; the decision is ADR-0030, and this note
holds the detail it rests on.

## How to read this note

Every fact about the code was read at commit 33f8c43d on `main` and names its
file. Nothing was run: no test, no stack, nothing on either deployed host.
Where a claim could not be checked by reading, it says so.

Two branches change the same files and are expected to merge before any of
this is built. One renames the gateway's route to the cabinet. The names it
introduces were read from that branch's uncommitted work on 2026-09-25 and may
still move: the secret `ANNOUNCEMENT_SECRET` becomes `GATEWAY_CABINET_SECRET`,
the gateway's variable `CABINET_ANNOUNCEMENT_URL` becomes
`CABINET_INTERNAL_URL`, the path `/internal/announcements` becomes
`/internal/gateway` on the same port 3003, and the cabinet's listener moves
from `apps/cabinet/src/announcement-server.ts` to `gateway-server.ts`. This
note uses the new names and cites the old files. The other branch removes
every way a merchant comes into being except the link mailed to a person and
the cabinet's one control; where this note depends on what it leaves behind,
it says so.

Three words are used throughout. The *money path* is the gateway: the merchant
API under `/v0`, the storefront an agent buys at under `/x402`, the order
machine and its queue. The *cabinet key* is the key the cabinet calls the
gateway with on a merchant's behalf, one per account. A *hop* is a call from
one of the two processes to the other over the network.

## The two processes today

### Entry points and listeners

The gateway starts in `apps/gateway/src/main.ts`. It reads its configuration
(`apps/gateway/src/config.ts`), opens the store's connection pool, builds the
pg-boss queue, makes the facilitator's credentials sign once, chooses the
announcer (the cabinet's route on a live deployment, nobody anywhere else,
lines 148-149), starts the order machine with `gateway.start()`, seeds the
sandbox key if one is configured, and listens. Its surface is built in
`apps/gateway/src/http/server.ts` from the contract's route table: `/healthz`,
then every route the contract calls mountable, which is everything under
`/v0` and `/x402`, then a JSON 404. On a signal it closes the listener and
wakes every parked worker poll and parked purchase with nothing, so an agent
sees a restart it can retry.

The cabinet starts in `apps/cabinet/src/main.ts`. It reads its own
configuration (`apps/cabinet/src/config.ts`), opens its own pool, builds the
identity component (Better Auth, ADR-0009), and opens up to three listeners.
It also starts the WooCommerce worker (`apps/cabinet/src/woo-worker.ts`), a
loop that fills the orders of merchants who connected a shop by drawing their
stream from the gateway, the way a merchant's own worker would.

| Port | Process | What it serves | Who reaches it | What guards it |
|---|---|---|---|---|
| 3000 | gateway | `/v0/*`, `/x402/*`, `/healthz` | Caddy, `@gateway` matcher | a merchant key per route, as the contract's `auth` says |
| 3001 | cabinet | `/cabinet/*`, `/cabinet/healthz` | Caddy, `@cabinet` matcher | the session cookie and a same-origin check |
| 3002 | cabinet | `/internal/report-identity` | the scanner, on the compose network | `REPORT_IDENTITY_SECRET` |
| 3003 | cabinet | `/internal/gateway` | the gateway, on the compose network | `GATEWAY_CABINET_SECRET` |

The two internal listeners open only where their secret is set
(`startReportIdentityServer` in `apps/cabinet/src/report-identity-server.ts`,
`startAnnouncementServer` in `apps/cabinet/src/announcement-server.ts`), and
neither port is published on the host; the preflight refuses a cabinet that
publishes any port (`packages/core/src/deployment/preflight.mjs`, line 352).

### Images, containers and the release

Both run from one image. `compose.yaml` builds `deploy/Dockerfile.app` once,
as `agentify-app` (the `x-app` anchor at line 169), and four services use it:
the one-shot `migrate`, `gateway`, `cabinet`, and the laptop's mock merchant,
which `deploy/compose.public.yaml` puts under a `fixtures` profile so no
deployed channel runs it. Deployed channels pin the image by digest in
`deploy/compose.images.yaml`. So a deployed channel already runs one image as
two long-lived containers and one migration, which is the shape ADR-0030
collapses. Each service names its own command; the image's default
starts the gateway (`deploy/Dockerfile.app`, line 48).

Each container has its own health check: the gateway's fetches
`127.0.0.1:3000/healthz`, the cabinet's `127.0.0.1:3001/healthz`
(`compose.yaml`). The cabinet waits for the gateway to have started, and Caddy
(`web`) for both to be healthy. Caddy routes by path in `deploy/Caddyfile`:
`/v0`, `/x402` and `/healthz` to `AGENTIFY_GATEWAY_UPSTREAM`, default
`gateway:3000` (lines 192-194), and `/cabinet` with everything under it to
`AGENTIFY_CABINET_UPSTREAM`, default `cabinet:3001` (lines 207-210). The
scanner reaches the identity route at `CABINET_IDENTITY_URL`,
`http://cabinet:3002`, which the preflight requires exactly (line 267).

The release treats the two as one unit already. `deploy/activate.sh` stops
`gateway cabinet scanner scanner-worker` together (line 264), runs `migrate`,
which applies the gateway's and then the cabinet's migrations (the root
`db:migrate` script in `package.json`), starts `gateway cabinet web` in one
`docker compose up --wait` (line 303), and then asks the public origin for
ten paths, `/healthz` and `/cabinet/healthz` among them (line 319), and reads
the catalog. Its `restart` and `running` helpers name both services (lines
57-58). There is no path in the release that starts one without the other.

### How the cabinet calls the gateway

The cabinet's client is `apps/cabinet/src/gateway.ts`. It builds every
address from the contract's route table, sends the merchant key in its header,
holds each call to ten seconds, and parses every answer against the schema the
table names. One call carries no key: registration, which presents the
invitation value from the cabinet's configuration. The client is built in five
places, each from the key on the account row: the screens and registration
(`apps/cabinet/src/server.ts`, lines 356-358), the key renewal after the
scanner's question (`apps/cabinet/src/main.ts`, line 42), the WooCommerce
worker (`main.ts`, line 65), and two terminal commands, `woo:recover`
(`apps/cabinet/src/woo-recover.ts`, line 35) and `account add`
(`apps/cabinet/src/account.ts`, line 84).

Each of the client's calls is one route, and each route's handler in
`apps/gateway/src/http/routes.ts` is one call to a method of `Gateway`
(`apps/gateway/src/app/gateway.ts`) plus the status and the words of any
refusal. That thinness is what makes the design below cheap.

| The cabinet's call | Route | `Gateway` method | Also called by the SDK |
|---|---|---|---|
| cards, pause and resume a card | `list_merchant_cards`, `pause_card`, `resume_card` | `merchantCards`, `setCardPaused` | no |
| stop and resume selling | `pause_selling`, `resume_selling` | `setSelling` | no |
| orders, one order | `list_orders`, `get_order` | `orders`, `merchantOrder` | yes |
| receipts | `list_receipts` | `receipts` | no |
| seller name | `get_seller_name`, `set_seller_name` | `sellerName`, `setSellerName` | no |
| payout wallet | `get_payout_wallet`, `set_payout_wallet` | `payoutWallet`, `setPayoutWallet` | no |
| keys | `list_keys`, `issue_key`, `disable_key` | `merchantKeys`, `issueMerchantKey`, `disableMerchantKey` | no |
| its own key | `issue_cabinet_key`, `forget_cabinet_key` | `issueCabinetKey`, `forgetCabinetKey` | no |
| registration | `register_merchant` | `registerMerchant` | no |
| publishing (WooCommerce import) | `publish_card` | `publishCard` | yes |
| filling orders (WooCommerce worker) | `poll_worker`, `answer_order`, `deliver_order`, `answer_quote` | `poll`, `answerOrder`, `deliverOrder`, `answerQuote` | yes |

The SDK column was read off the route names `packages/sdk/src` calls: it uses
`publish_card`, `poll_worker`, `answer_order`, `deliver_order`,
`refuse_order`, `accept_order`, `answer_quote`, `get_order` and `list_orders`.
Everything else under `/v0` has had exactly one client, the cabinet, and the
portal names only `/v0/payout-wallet` (`apps/docs/quickstart.md`).

### The cabinet key's life

Registration makes the merchant and a key of the cabinet's kind in one
transaction (`Gateway.registerMerchant`, line 636; the store writes
`purpose: "cabinet"` in `apps/gateway/src/adapters/postgres/store.ts`, line
177). The cabinet writes the merchant and the key, as issued, onto the
account row (`cabinet_accounts.merchant_id` and `merchant_key`,
`apps/cabinet/src/schema.ts`, lines 62-64, with a check that both or neither
are set). The key is renewed at every sign-in (`server.ts`, line 686) and on
the first reading of a session's day, whether that reading is a cabinet page
(`sessionReader`, `apps/cabinet/src/cabinet-key.ts`, line 177) or the
scanner's question about a cookie, which renews after it answers
(`report-identity-server.ts`, lines 103-106). A renewal is three calls: ask
for a fresh key with the one on the row, move the row to it on the condition
that it still holds the old one, and forget the old one with itself
(`keyRenewal`, `cabinet-key.ts`, line 93). An interruption between the second
and the third leaves a working key nobody holds, and nothing sweeps those
(`cabinet-key.ts`, lines 65-71; ADR-0014 §5).

The gateway treats the kind specially in six places. The `purpose` column
tells the two kinds apart (`apps/gateway/src/adapters/postgres/schema.ts`,
lines 150-159). The list of keys leaves cabinet keys out, so the list's
`this_call` may name a key that is not among its rows (`merchantKeys`,
`gateway.ts`, line 974; `MerchantKeyListSchema` in
`packages/contracts/src/merchant.ts`). Disabling refuses a cabinet key with
`key_made_for_a_cabinet` (`routes.ts`, line 372 onward). The two routes at
`/v0/keys/cabinet` refuse any other kind with `not_a_cabinet_key` (lines 129
and 351-369). A call made with a cabinet key is named in a message as "the
cabinet" rather than by label (`#named`, `gateway.ts`, line 943), and issuing
one announces nothing (`issueCabinetKey`, `apps/gateway/src/app/merchants.ts`,
line 244). The terminal's `merchant` command prints the kind beside each key
(`apps/gateway/src/merchant-command.ts`, lines 345-349). The published
contract carries the kind too: three routes, the schemas `CabinetKeySchema`,
`ForgottenCabinetKeySchema` and `RegisteredMerchantSchema`, and the codes
`key_made_for_a_cabinet`, `not_a_cabinet_key` and `not_invited`
(`packages/contracts/src/api.ts`).

None of this can have a caller outside the cabinet. The cabinet-key routes
refuse every key a merchant can hold, and registration needs a value only the
cabinet's configuration carries. A search of the repository finds no other
caller; callers outside it could not be searched, but they would be refused.

### How the gateway calls the cabinet

The gateway's port is `apps/gateway/src/ports/announcer.ts`: one method,
`announce`, with five outcomes. The cabinet's teller
(`tellerFor` in `apps/cabinet/src/announcement-server.ts`, lines 54-79) can
return three of them: every account naming the merchant was sent a message the
mail provider took, no account names the merchant, or at least one message was
not taken. The HTTP adapter (`apps/gateway/src/adapters/cabinet/announcer.ts`)
adds two: a 4xx means the listener turned the request away before telling
anybody, and every other ending, including silence past twenty seconds, means
the cabinet did not answer and a message may have gone out. `Gateway.#announce`
(`gateway.ts`, line 914) reads a thrown announcer as the second of those.

A wallet change waits on the announcement; a first wallet, a new key and a
cancelled change are announced afterwards and wait on nothing
(`#announceAfterwards`, line 928). The whole mechanism runs only on a live
deployment, where the configuration carries the route and the secret
(`config.ts`, the `announcements` field near the end).

`walletChangeRefused` (`routes.ts`, line 159) turns the outcomes into
refusals:

| Outcome | Code | Status | Why it exists |
|---|---|---|---|
| nobody to tell | `wallet_change_nobody_to_tell` | 409 | no account names the merchant |
| not handed over | `wallet_change_not_announced` | 503 | the mail provider did not take every message |
| refused by the cabinet | `wallet_change_not_announced`, second wording | 503 | the hop's listener turned the request away |
| unconfirmed | `wallet_change_unconfirmed` | 503 | the hop went silent |
| raced, before or after announcing | `wallet_change_raced`, two wordings | 409 | another change landed first |

Two rows exist only because of the hop. In one process the teller is a
function call, so nothing can turn the request away, and "did not answer" has
two remaining causes. The mail provider's silence is already caught inside the
postman and reported as a message not taken (`apps/cabinet/src/mail.ts`, lines
117-159, ten seconds a message). What is left is a throw from our own code,
the read of the addresses or a defect, before any message or between two of
them. That is exactly "not every message was handed over, and some may have
been", which is what `wallet_change_not_announced` already says. So
`#announce` maps a throw to "not handed over", and the port shrinks to the
teller's three outcomes.

The wait and the announcement live in `Gateway.setPayoutWallet` (line 784),
not in the route's handler, so the guard ADR-0019 puts on the one field money
is sent to holds for a call from the cabinet in the same process exactly as it
holds for a key over HTTP.

### Shared resources

Both processes reach one database, `agentify`, with one account, the
instance's bootstrap superuser (ADR-0003 §2, ADR-0024), and on production the
preflight requires every service's `DATABASE_URL` to be the same one (line
180). Either process can therefore read and write every table, the merchant's
payout wallet included, which is the part of the boundary that no longer
protects anything.

| | Gateway | Cabinet |
|---|---|---|
| Tables | `merchants`, `merchant_keys`, `cards`, `orders`, `receipts`, `payment_claims` (`apps/gateway/src/adapters/postgres/schema.ts`) | eleven `cabinet_*` tables: accounts, sessions, credentials, verifications, link sends, report identity secrets, deletion tombstones, and four for WooCommerce (`apps/cabinet/src/schema.ts`) |
| Migration history | `drizzle.__drizzle_migrations`, eleven files | `drizzle.cabinet_migrations`, thirteen files |
| Queue | pg-boss (`apps/gateway/src/adapters/pgboss/queue.ts`) | none |
| Pools | the store's, and pg-boss's own | one, for identity and WooCommerce |

The two histories stay separate after the merge. ADR-0003 §2 explains why
there are several: the drizzle migrator compares with the newest entry of the
history it is given and would take another set's entry for its own. Merging
them buys nothing a person would notice.

Two terminal commands already use the gateway's application code in a process
of their own, with no HTTP and no key. `pnpm approve`
(`apps/cabinet/src/approve.ts`) shares one pool between the cabinet's account
directory and the gateway's store and calls `grantLiveApproval`. The payment
report command (`apps/gateway/src/payment-report.ts`) starts the queue as a
writer that sends and does not consume (`startWriter`,
`apps/gateway/src/adapters/pgboss/queue.ts`, line 337), so it cannot take work
away from the running gateway. These are the pattern for the two terminal
commands that today borrow an account's cabinet key.

Configuration overlaps more than it differs:

| Variable | Gateway | Cabinet | In one process |
|---|---|---|---|
| `DATABASE_URL` | yes | yes | one value |
| `PORT` | 3000 | 3001 | two fixed ports, the way 3002 and 3003 are fixed today |
| `PUBLIC_BASE_URL` | yes | yes | one value; the preflight compares each with the channel's origin today |
| `PAYMENT_NETWORK`, `FACILITATOR_URL` | yes | yes | one value; the preflight's check that the cabinet was handed the gateway's pair (line 130) goes |
| `REGISTRATION_INVITATION` | yes | yes | goes with the public registration route, if the registration branch leaves it |
| `GATEWAY_CABINET_SECRET` | yes | yes | goes |
| `CABINET_INTERNAL_URL` | yes | no | goes |
| `GATEWAY_URL` | no | yes | goes |
| `AUTH_SECRET`, `MAIL_*`, `COOKIE_SECURE`, `BASE_PATH`, `REPORT_IDENTITY_SECRET` | no | yes | stay |
| `SANDBOX_MERCHANT_KEY`, `CDP_*`, `PAY_TO_ADDRESS`, the timings | yes | no | stay |

The preflight is written per service. Besides the checks already named, it
lists the values published in this repository per service (line 52 onward),
proves that the scanner's secret is held by the cabinet and the scanner and
nobody else (line 251 onward), proves the same for the gateway's route to the
cabinet (line 297 onward), and requires the cabinet's `COOKIE_SECURE` and both
services' `PUBLIC_BASE_URL` (lines 366-374). The two rendered channels its
tests read, `packages/core/src/deployment/fixtures/live-channel.json` and
`test-channel.json`, name both services.

### Tests

The gateway is tested on in-memory ports. `apps/gateway/src/testing/harness.ts`
wires the real flows and the real order machine to a memory store, a memory
queue, a scripted facilitator and a recording announcer; its `serve` puts that
gateway on a loopback port, and the HTTP tests in `apps/gateway/src/http/`
call it there. The store's contract runs against memory and against Postgres
(`testing/store-contract.ts`, the `*.db-test.ts` files under `pnpm test:db`).
The HTTP announcer is tested against servers that answer badly or not at all
(`adapters/cabinet/announcer.test.ts`).

The cabinet is already assembled with the gateway in one test process.
`apps/cabinet/src/server.test.ts` starts the gateway harness, serves it on
loopback, and drives the cabinet's pages over HTTP against it, so every screen
under test is drawn from what the real API produced. `gateway.test.ts` holds
the client's own promises on the wire: that a call ends when the gateway goes
quiet, which header carries the key, that registration carries none.
`announcement-server.test.ts` holds the listener's authentication and
validation. Identity and the WooCommerce tables have database tests of their
own.

`packages/slice` is the end-to-end test in which a sandbox buyer purchases
through the real gateway from a mock merchant built on the SDK. It runs no
cabinet; the only trace of one is the pair of placeholder values its live
gateway sets because a live configuration demands a route to announce through
(`packages/slice/src/gateway-harness.ts`, lines 106-115), which go when that
demand does.

Every route only the cabinet calls already has an HTTP test of its own:
cards, pausing and selling in `server.test.ts`, `tenancy.test.ts` and
`live-approval.test.ts`; receipts in `server.test.ts` and `tenancy.test.ts`;
the seller name in `seller-name.test.ts`; the payout wallet in
`payout-wallet.test.ts` and `payout-wallet-wait.test.ts`; keys in
`keys.test.ts`, all under `apps/gateway/src/http/`. The portal's examples are
test fixtures (`packages/contracts/src/portal-fixtures.test.ts`,
`packages/sdk/src/portal-fences.test.ts`).

## The design

### One process

One Node process, the `app` service of `compose.yaml`, named after the image it
already runs from. The word `deploy/activate.sh` uses for the pair, "commerce",
was not chosen, because it names a boundary inside one product rather than what
the process is. A small workspace package, `apps/app`, holds only its entry
point: it reads both configurations from one environment, starts the gateway,
then the cabinet, and stops them in the reverse order. `apps/gateway` and
`apps/cabinet` stay packages with their own tests, migrations and terminal
commands, and lose their `main.ts`. The gateway's package does not import the
cabinet's; the entry point is the one place the cabinet's teller is handed to
the gateway as its announcer. The cabinet's package already imports the
gateway's (for the announcement types, and in `approve.ts` for the store), so
the dependency keeps its direction.

It keeps two public listeners. Port 3000 serves the gateway's surface and
port 3001 the cabinet's pages. One listener with an in-process router would
duplicate Caddy's path table and mix two middleware stacks that disagree on
purpose: the gateway parses JSON, trusts the proxy's forwarding headers and
answers an unknown path with a JSON refusal, while the cabinet parses forms,
checks that a post is same-origin and answers with pages. Kept apart, Caddy's
route table changes only in two default host names. Port 3002 stays the
scanner's route. Port 3003 goes in the second step below.

Both health probes stay. `/healthz` and `/cabinet/healthz` now answer from one
process, and each still proves that its own listener is up. The container's
health check asks both, because a check on one would call a process healthy
whose other surface nobody can reach. ADR-0005 §1's reason for having no
aggregate health document still holds for the scanner and Postgres.

The shutdown keeps the gateway's promise: on a signal the process closes both
public listeners and the scanner's, stops the WooCommerce worker, then stops
the gateway, which wakes every parked poll and parked purchase with nothing,
then closes identity and the pools. Two pools and pg-boss's own stay as they
are at first; one shared pool is possible later and changes nothing a person
sees.

### What dogfooding turns into

Three shapes were weighed for how the cabinet's screens reach the money path
once there is no network between them.

The cabinet could keep calling `/v0` over loopback with no key. Something
would then have to tell the gateway which merchant a call is for: a header, or
a process-wide secret beside it. Either is a second way through the public
door, on the listener Caddy forwards the internet to, which is the
"privileged key naming the merchant per request" ADR-0014 rejected.

The cabinet could call the `/v0` handlers in-process, skipping only the key
lookup. That keeps the most of today's proof, but the handlers' documents are
written for a caller that holds a key. The list of keys must name the key the
call was made with (`this_call`, required by `MerchantKeyListSchema`), and
disabling refuses the caller's own key (`key_opened_this_call`). A caller with
no key would have to be described in the published contract, which would go on
explaining to every merchant's engineer a kind of caller none of them can be.

The decision is the third: the cabinet calls the application, the same
`Gateway` methods the handlers call, as the merchant named on the signed-in
account's row. It keeps its own port, the `GatewayClient` interface in
`apps/cabinet/src/gateway.ts`, whose methods already return the contract's
document types and already carry the refusal as a sentence a page can show. The
port loses its two methods about the cabinet key, and its list of keys loses
`this_call`; otherwise only the implementation behind it changes, from `fetch`
to a call. That implementation holds what it passes to the request schema the
route table names for the same call, and what comes back to the response
schema, so a mistyped wallet address is still refused in the schema's words, as
the door refuses it today. A refusal the handler would word, such as a wallet
change that could not be announced, reaches the page in the same words, because
the wording moves out of `routes.ts` into a function both call. Each call keeps
the page's ten-second deadline; the work behind a call that runs out is not
cancelled, as it is not today when a request times out on the client.

The caller is a signed-in person, not a key. `KeyOnTheCall` in `gateway.ts`
becomes a caller that is either a key or a person in the cabinet, and a message
about a payout wallet change names who acted: a change asked for in the
cabinet names the signed-in person's address, and one asked for with a key
names the key, as it does today. Today a change from the cabinet is named only
as "the cabinet" (`AskedWithSchema` in `apps/gateway/src/announcements.ts`),
because the gateway sees the cabinet's key and not the person behind it. Two
more things follow. The cabinet's list of
keys has no `this_call`, because a page acting for a signed-in person holds no
key, and every key on it can be disabled from there. And a merchant can no
longer lock themselves out by disabling keys: the way back in is always the
mailed link, which needs no key.

So the cabinet stops proving that the HTTP API is enough, and the decision
says so rather than pretending otherwise. It still proves that the
application's operations and the contract's documents are enough to draw every
screen. The HTTP door itself — the key lookup, the JSON, the statuses and the
envelope of every refusal — is proven by what a merchant's engineer actually
touches: the SDK's tests, the slice's purchase through the real gateway, the
portal's examples run as fixtures, and the gateway's HTTP test for every
`/v0` route listed above. The rule that keeps the cabinet from growing a
private API stays as text, where ADR-0005's consequences already put it: a
screen that needs something a merchant's code could also need gets it as a
contract route in the same change.

### The WooCommerce worker and the terminal commands

The worker fills orders for merchants who wrote no code, and it is the one part
of the cabinet that uses the API the way the SDK does. It calls the application
in-process like the screens, drawing with `Gateway.poll`, which a purchase in
the same process wakes at once. Keeping it an HTTP client of `/v0` would take
an ordinary key issued when a shop is connected, listed and disableable like
any other, and that key would have to be stored as issued in order to be used,
which is the property of the cabinet key this decision removes, beside a shop
credential of the same kind ADR-0023 already keeps. The dogfooding it would
keep is the one the SDK's own tests already give. If the connector ever leaves
the process, as a plugin in the shop for instance, it becomes an ordinary
client of the SDK with an ordinary key.

`woo:recover` reads one order and delivers late goods for it with the
account's cabinet key. Once the key is gone it builds the application in its
own process on the one database, with a writer-only queue, the way the payment
report command does. Whether `deliverOrder` needs anything from a queue that
does not consume was not verified. `account add` checks a pasted key by
calling the cabinet-key route; if the registration branch leaves it, it
becomes a binding of an address to a merchant identifier and takes no key.

### Registration

Registration becomes a call to `Gateway.registerMerchant` with no invitation,
made, as today, inside the transaction and the lock on the account that
`attachMerchant` holds (`apps/cabinet/src/identity.ts`, line 719), followed by
the cabinet's write of the merchant onto the account. The case "the gateway
did not answer" becomes "the database did not answer", and the
person presses again from inside the session, as ADR-0026 §4 says. The case
"the cabinet failed after the gateway answered" remains: two transactions in
one process can still leave a merchant nobody names. The tables now share a
database and a process, so the two writes could become one transaction; that
means the gateway's store and the identity component sharing a connection, and
it is a separate change.

### What is lost

A defect in the cabinet's code now stops sales. An uncaught error, a leak or a
blocked event loop in a page, in Better Auth or in the WooCommerce worker ends
the process that holds every parked purchase and every parked worker poll;
`queueOn` in `apps/gateway/src/adapters/pgboss/queue.ts` already explains why
that process is the one that must not die. Orders survive in Postgres and
resume after the restart the container's policy makes (ADR-0013); a
synchronous purchase in flight is lost to its agent, which retries. Today the
same defect stops sign-in, full reports and wallet changes and leaves selling
running. What makes it acceptable is that the two are already released and
restarted together, and that at this scale a crash is a defect to fix rather
than a load to isolate. The trigger to split again is a measured incident in
which the cabinet took sales down, or a cabinet that needs a runtime the
gateway cannot share, such as the client framework ADR-0005 §4 names as its own
trigger.

The money path shares a process with sessions, mail and the power to remove a
person, powers ADR-0019 refused to give it by way of the scanner's route. What
separates them now is the package boundary and review, which is what already
separated them in the database.

The release's per-service checks collapse into one service's. Its
cross-service comparisons go because there is one environment; its proof of
who holds the gateway's secret goes with the secret; its proof for the
scanner's secret names `app` and the scanner. `deploy/activate.sh` names `app`
where it named the two, and its route checks keep both probes. Nothing in the
release could start one of the two without the other before, so no ability is
lost there.

Every container name an operator types changes: `docker compose exec cabinet`
and `exec gateway` in `deploy/README.md` and in the headers of
`apps/cabinet/src/account.ts`, `apps/gateway/src/merchant.ts` and
`apps/gateway/src/payment-report.ts`; the container `agentify-cabinet-1` in
`scripts/approve.mjs` and in `deploy/ansible/woo-test-hairpin.yml`; the
upstream ports in `ops/scripts/caddy-routing-smoke.mjs`; and the
service lists in `deploy/test_activate.py`.

### The order of the move

Each step is one pull request that leaves `main` working and releasable, and
the steps are ordered so that the one that touches deployment carries no
change of behaviour and the ones that change behaviour touch no deployment.

1. **One process, hops unchanged.** The entry point in `apps/app` starts
   both, the cabinet calls the gateway at `http://127.0.0.1:3000` with its
   key, and the gateway calls the cabinet at `http://127.0.0.1:3003` with its
   secret. `compose.yaml` replaces `gateway` and `cabinet` with `app`, with one
   health check over both listeners; Caddy's defaults, the scanner's
   `CABINET_IDENTITY_URL`, the preflight and its fixtures, `activate.sh` and
   its test, and the operator commands name `app`. Nothing a merchant or an
   agent sees changes.
2. **The gateway tells the cabinet in-process.** An announcer that calls the
   teller replaces the HTTP adapter; the listener on 3003, its route,
   `GATEWAY_CABINET_SECRET` and `CABINET_INTERNAL_URL` go from the code, the
   compose files, the preflight, the slice's live gateway and the hosts'
   environment files; the outcomes "refused by the cabinet" and "unconfirmed"
   go from the port, and `wallet_change_unconfirmed` from the contract's codes
   and from `apps/docs/quickstart.md`. The contracts package is released.
3. **The cabinet calls the application in-process.** The screens, the
   registration and the WooCommerce worker get the in-process implementation
   of their port; the fetch client and its wire tests, `GATEWAY_URL` and
   `REGISTRATION_INVITATION` go; the renewal and its two triggers go, so the
   key on the account row is no longer read or renewed, though registration
   still writes one until step 4 drops the column; a message about a wallet
   change asked for in the cabinet names the signed-in person; `woo:recover`
   builds the application in its own process.
4. **The cabinet key is deleted.** The gateway loses the kind and its six
   special cases; a migration in the gateway's history deletes the rows made
   for a cabinet, leftovers included, and the `purpose` column, and one in the
   cabinet's history drops `merchant_key` and the check beside it; the account
   directory `pnpm approve` reads treats an account as bound when it names a
   merchant (`apps/cabinet/src/approval-directory.ts`); the three routes, their
   schemas and their three codes leave the contract, and `this_call` is always
   one of the listed keys. The contracts package is released.

The contract version does not move in steps 2 and 4: no SDK worker calls
these routes or reads these codes, and moving it would stop every installed
worker for words none of them sees. ADR-0006 §2's exception, which names only
the payout-wallet route, widens to cover the routes and codes only the cabinet
ever used.

## Records each step changes

No other decision is edited with ADR-0030 itself. Each step's pull request
edits, in the same change, the paragraphs that step makes true, and none
earlier, for two reasons. A decision must not describe a state the code has
not reached. And ADR-0014 and ADR-0019 are being edited now by the
registration change, so an edit made ahead of the step would collide with it
and might describe a registration that change does not leave.

**Step 1, one process.**

- ADR-0003 §2: `apps/app` joins the workspace's split beside `apps/gateway`.
- ADR-0005 §1, the paragraph on `/healthz`: it answers for the process's
  gateway listener and `/cabinet/healthz` for its cabinet listener, and the
  reason for having no aggregate health document stays, for the scanner and
  Postgres. §2, "the cabinet is its own process", becomes a pointer to
  ADR-0030, and the rejected alternative "the cabinet inside the gateway" is
  deleted, since ADR-0030 answers its objection.
- ADR-0024, the consequences: where each of the cabinet's internal credentials
  is held by its own two processes, the scanner's is held by `app` and the
  scanner, and the gateway's by `app` alone.
- ADR-0026, the consequences: the cabinet's absence stops sales as well as
  every sign-in, every full report and the dashboard.

**Step 2, the gateway tells the cabinet in-process.**

- ADR-0005 §3, the narrowing paragraph: the one call the other way is a call
  inside the process.
- ADR-0019: the paragraph on how the gateway asks the cabinet loses the
  internal route, its secret, the caution about the scanner's route and the
  case of a cabinet that did not answer, leaving nobody to tell, a message not
  handed over, and the race; the serialization sentence's "a call to another
  process and a mail provider" becomes a call to a mail provider; the
  consequence "depends on the cabinet and the mail provider being up" keeps
  only the mail provider.
- ADR-0024, the consequences: the gateway's credential goes, and the scanner's
  is the cabinet's only internal credential.

**Step 3, the cabinet calls the application in-process.**

- ADR-0005 §3: the cabinet calls the application as the signed-in account's
  merchant rather than the public API with a key, and the proof of the API is
  named as in ADR-0030; the consequences' "the cabinet proves the API is usable
  by construction" narrows to the application and the contract's documents;
  the rejected "the cabinet talking to Postgres directly" becomes "the cabinet
  querying the gateway's tables".
- ADR-0009 §2: "that merchant's key, the gateway client built per request from
  it" becomes the calls made as that merchant.
- ADR-0010, the rejected "scoping in the cabinet only": the cabinet is a caller
  of the application, and scoping still lives in the gateway's store.
- ADR-0014 §1: registration is a call inside the process, and a gateway that
  does not answer becomes a database that does not answer. §2: the renewal and
  its schedule go. §3, as far as the registration change leaves it: the
  invitation leaves the configuration.
- ADR-0019: the context's "the cabinet's, or one that lives in the merchant's
  own server environment" becomes a key or a person in the cabinet; the
  message names the signed-in person for a change asked for in the cabinet,
  and the key for one asked for with a key; the cancel paragraph's "if the key
  that asked is the cabinet's own, a session acted" becomes a person in the
  cabinet.
- ADR-0023: "Cabinet fills the order as the merchant's worker" does so
  in-process.
- ADR-0026 §4: the press asks the application for the merchant, and a gateway
  that does not answer becomes a database that does not answer.

**Step 4, the cabinet key is deleted.**

- ADR-0006 §2: the exception covers the routes and codes only the cabinet ever
  used.
- ADR-0014: the title and §1 lose the key; §2 reduces to "an account names its
  merchant"; §3 loses the public registration route, as far as the
  registration change leaves it; §5 keeps the three routes over the merchant's
  own keys and the rule about the key on the call, and loses the two
  cabinet-key routes, the unswept leftovers and "the way back in is a key of
  the other kind"; the rejected "encrypting the stored key" goes.
- ADR-0019: "the cabinet's own key, renewed daily, is announced to nobody"
  goes.
- ADR-0023: "the same host boundary as the cabinet key" becomes the account's;
  the rejected "putting shop credentials in Gateway" stays true of the
  gateway's tables.
- ADR-0026 §4 and its table: the press makes the merchant with no key.

## What was not verified

Nothing was executed, so every consequence for running code is read, not
measured: the memory and event-loop profile of one process carrying both, and
whether Better Auth and the gateway's express application share a process
without surprises, though both packages pin the same express, 5.2.1. Whether
`deliverOrder` works from a process whose queue only writes. Whether any caller
outside this repository ever called the cabinet-key routes or registration;
the argument that none could rests on their refusals, read in `routes.ts`. The
names from the rename branch were read from uncommitted work.
