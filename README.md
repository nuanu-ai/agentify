# Agentify

[![CI](https://github.com/nuanu-ai/agentify/actions/workflows/ci.yml/badge.svg)](https://github.com/nuanu-ai/agentify/actions/workflows/ci.yml)
[![npm: @nuanu-ai/agentify](https://img.shields.io/npm/v/@nuanu-ai/agentify?label=%40nuanu-ai%2Fagentify)](https://www.npmjs.com/package/@nuanu-ai/agentify)
[![npm: @nuanu-ai/agentify-contracts](https://img.shields.io/npm/v/@nuanu-ai/agentify-contracts?label=%40nuanu-ai%2Fagentify-contracts)](https://www.npmjs.com/package/@nuanu-ai/agentify-contracts)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Agentify is a site for the owner of an ordinary online business. They enter the
address of their shop and read what it exposes to AI agents — the robots file
and the sitemap, the structured data, the machine-readable output — as a report
of named checks with the evidence behind each verdict. Through the same site
they then sell their goods to those agents: the gateway behind it takes the
purchase, and the agent pays in stablecoins over the x402 protocol into the
merchant's payout split, a contract nobody owns, which pays 99.9% to the
merchant's wallet and 0.1% to Agentify whenever somebody pays it out
(ADR-0037).

| You are | Start here |
| --- | --- |
| The owner of a business deciding whether to sell to AI agents | the documentation at [agentify.ad/docs](https://agentify.ad/docs/) |
| The engineer connecting a shop's own code | the SDK on npm, [`@nuanu-ai/agentify`](https://www.npmjs.com/package/@nuanu-ai/agentify), and the [quickstart](https://agentify.ad/docs/quickstart), from an empty project to a test sale |
| A contributor to this repository | the rest of this file, from [Prerequisites](#prerequisites) on |
| An operator of the test or the production channel | the runbook, [`deploy/README.md`](deploy/README.md) |

A security problem is reported privately, as [`SECURITY.md`](SECURITY.md)
describes.

## The path through the product

A business owner arrives at the scanner, enters the address of their site and
watches the checks run. The full report is unlocked with an email address and
the one-time link sent to it, and that sign-in is the whole site's: the report
carries one control that opens the merchant dashboard, whose own sign-in takes
the same kind of link or, where it is configured, a Google account. There is no
password and no invitation code (ADR-0026). The dashboard then offers one
control, and its press creates the merchant and asks for the seller name buyers
will see. That is the only way an account or a merchant comes into being; no
command at a server's terminal makes either (ADR-0014).

A merchant then sells in one of two ways, one at a time (ADR-0036). Either
their engineer writes code against the SDK: the dashboard issues the key that
code calls with, and the SDK publishes the product cards and runs a process
beside the shop's existing API that fulfills the orders. Or the owner connects
a WooCommerce shop from the dashboard, with no code: the connector imports the
shop's products as cards and creates each paid order in the shop. The
connector is offered on the test channel only, until its orders pass end to
end there. Either way the first sale happens on the test channel, where
payments settle on Base Sepolia with test funds. Publishing there needs a
seller name and a payout wallet, and live publication also needs the
operator's one-time approval of that merchant, given from `/admin` or with
`pnpm approve <email>`; publication lists whatever is still missing. The
approval publishes nothing and bypasses no seller or payout check.

One origin serves all of it, on a laptop and on a server alike: the scanner at
`/`, the merchant documentation at `/docs`, the dashboard at `/dashboard`, the
merchant's own calls at `/v0` and the storefront an agent buys from under
`/x402`.

## Prerequisites

Node.js 24.21 or newer. CI and every image run exactly the version in
`.nvmrc`, so a difference between it and a newer local Node shows up in CI.
pnpm 11.12 arrives through Corepack from the `packageManager` field of the
root `package.json`, the same way CI gets it:

```sh
corepack enable
pnpm install
```

Installing also points git at `.githooks`, where a `commit-msg` hook holds the
Conventional Commits format. Docker with Compose v2 runs the stacks below, and
`pnpm test` needs a `python3` on the path for one test of the deployment
scripts.

## Run it

### The whole product

The stack is one command:

```sh
docker compose up --build
open http://localhost:8080
```

Everything answers on that one port, with one Postgres behind it holding one
database, `agentify`, for the gateway, the dashboard and the scanner alike. A
merchant process comes up beside it and publishes two cards — a rented phone
number sold synchronously, an eSIM sold asynchronously.

Nothing buys by itself. The buyer is the one thing that runs on the host rather
than in the stack, so the workspace needs its dependencies first:

```sh
pnpm buy                      # the first card in the catalogue
pnpm buy esim                 # the one delivered later
```

The gateway settles against nothing locally (ADR-0020): a purchase completes
with no wallet, no network and no faucet, and the first line of its log says so.

To sign in, open `http://localhost:8080/dashboard/sign-in`, enter an email
address, and take the one-time link from the application's log
(`docker compose logs app`, where the gateway and the dashboard run as one
process); the local stack writes every message there instead of sending it.
Pressing the link's confirmation button signs you in, and the dashboard then
offers one button, "Open my seller dashboard", whose press creates your
merchant and asks for the seller name. That merchant is a new one, and it is
not `the_merchant` — the merchant this laptop's stack seeds at start-up, whose
two cards the merchant process publishes and `pnpm buy` buys. A deployed
channel seeds nothing. Somebody who has just signed in has no cards and no
keys, which is the truth about a merchant who has written no code yet
(ADR-0014).

The scanner answers the front page. Submit an address and the worker behind it
runs the scan; the report asks for an email before it opens in full, and the
link arrives in the application's log like every other message here. The
scanner keeps no accounts of its own: it asks the dashboard to send the link
and to read a session, over the dashboard's private identity route, a second
listener on port 3002 that nothing publishes and that only the application
and the scanner hold the secret for. ADR-0026 draws that boundary.

If port 8080 is taken, `AGENTIFY_HOST_PORT=8090 docker compose up` moves the
stack and nothing else — the buy command runs on the host and needs
`GATEWAY_URL=http://localhost:8090 pnpm buy`.

### The scanner on the host

Editing the scanner is faster outside a container, and `pnpm scanner:dev` runs
its two processes on the host against the same database the stack uses — the
web application on port 3000 of loopback, compiled from its source by Vite on
each request, and the worker's health endpoint on 8081. It reads
`.env.scanner` rather than the `.env` the stack takes its settings from:

```sh
cp .env.scanner.example .env.scanner
docker compose up -d --wait postgres
pnpm scanner:db:migrate
pnpm scanner:dev
```

Nothing published on the host reaches the dashboard's identity listener, so a
scanner started this way scans and reports but cannot unlock one; that path is
walked in the stack.

### The dashboard on the host

`pnpm --filter @agentify/app dev` runs the application, the gateway and the
dashboard in one process, on the host, with the pages compiled from their
source by Vite on each request, so an edit to a page shows at the next reload
with no build. It takes the settings the stack's `app` service is given in
`compose.yaml`, with the database on the published port and the dashboard's own
port as the address mailed links are built on:

```sh
docker compose up -d --wait postgres
export DATABASE_URL=postgres://agentify:agentify@localhost:5432/agentify
pnpm db:migrate
PUBLIC_BASE_URL=http://localhost:3001 BASE_PATH=/dashboard \
  AUTH_SECRET=a-sandbox-secret-nobody-should-reuse-anywhere \
  REPORT_IDENTITY_SECRET=a-sandbox-report-identity-secret-nobody-should-reuse \
  FACILITATOR_URL=sandbox:scripted PAYMENT_NETWORK=eip155:84532 \
  PAY_TO_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  MAIL_URL=sandbox:log COOKIE_SECURE=false \
  pnpm --filter @agentify/app dev
```

The dashboard is then at `http://localhost:3001/dashboard/sign-in`, and the
sign-in link is in the terminal. In this mode the dashboard's listener and
Vite's update socket answer on loopback only, because Vite serves source files
from across the workspace. The shared mark and faces that Caddy serves
beside the stack are missing there, and the pages fall back to the system's
faces. `pnpm --filter @agentify/dashboard build` compiles the pages as the
image does, into `apps/dashboard/dist`, and `pnpm --filter @agentify/app start`
serves that build instead.

## What happens in a sale

A card is one product written so that a program can decide to buy it: a title,
a description, a price, and the list of what has to be given at purchase. A
merchant publishes cards through the SDK or the WooCommerce connector, and
every card is an address an agent can pay against.

The purchase is an HTTP request to that address. The gateway answers `402
Payment Required` with a challenge naming the price, the network, the asset and
the merchant's split as the recipient; the agent signs a payment and repeats
the request carrying it, and a facilitator verifies the payment and executes it
on the chain. That exchange is x402, and the protocol itself comes from the
official packages — what this repository adds is knowing which order a
payment is for.

The merchant's side is one process standing beside their existing API: a
handler. It listens on no port — it opens a single outgoing subscription and
receives paid orders, price questions and order events on that one stream
(ADR-0004). Everything it is written against is `@nuanu-ai/agentify`. The
package and the gateway agree on a contract version — `"2"` today — and a
change the package could not read moves that version before the gateway sends
it (ADR-0006). For a WooCommerce shop, the connector inside Agentify plays the
handler's part.

The order is a state machine in `packages/core`, a pure function with no IO.
The gateway feeds it events and gets back the next state together with the
effects that state implies, and those effects are written down in the same
transaction as the state itself (ADR-0013). What the card declares before
payment is which sequence the sale follows. With synchronous fulfillment the
goods come back in the answer to the purchase and the money moves only once
the merchant has produced them, so a refusal costs the buyer nothing. With
asynchronous fulfillment the money moves at the purchase and the agent leaves
with an order identifier, which is the whole of its proof when it comes back
for the goods (ADR-0011). A parcel, the `ship` mode, is paid at the purchase
too, carries the buyer's address to the merchant and ends when the merchant
records the shipment; it sells on the test channel only (ADR-0032, ADR-0033).
A paid order not delivered in time reads `unfulfilled`, and a late delivery
still counts until the merchant closes fulfillment, which stops Agentify
accepting deliveries and confirms no refund (ADR-0028). A charge whose answer
was lost reads `payment_unresolved` until a late answer or the chain settles
it; Agentify looks for the transfer in the background, with no promise of
when (ADR-0027). Nobody at Agentify staffs orders, payments or refunds; what
the merchant does for themselves and what is still missing are in
[`docs/research/54-self-service.md`](docs/research/54-self-service.md).
There is no fulfillment against the merchant's confirmation; what bringing it
back would take is in `docs/research/40-confirmation-mode-seam.md`.

The documentation explains all of this with its diagrams, and this file draws
none of them, so each picture has one copy: the purchase and the order's
statuses are on [Orders](https://agentify.ad/docs/orders), the money on
[Money](https://agentify.ad/docs/money). The table there of how an order can
end is the test suite's own fixture.

The stand is our own instrument for walking a purchase from all three seats —
catalogue, agent and merchant — in one local console, with a log threaded by
the order. It is not a product surface and it needs a throwaway buyer key in
`.env.stand` as `STAND_BUYER_KEY`; `pnpm stand` starts it on `127.0.0.1:8787`.
Its merchant half is written to be read by somebody integrating against the
SDK, in `packages/slice/src/stand-merchant.ts`, and
`docs/research/24-stand-boundary.md` says what it does and does not prove.

## Repository layout

One pnpm workspace holds all of it, on one toolchain and one lockfile. Biome
reads the JavaScript, TypeScript, JSON and CSS of every package — the Markdown,
the YAML, the shell scripts and the Python are read by no linter — every
package extends one compiler base and overrides it only where its runtime
differs, and one command runs every test that costs nothing. What needs a
database, a browser or the network is not in `pnpm test` and has a command of
its own.

| Path | What it is |
| --- | --- |
| `apps/app` | The application process: the gateway and the dashboard in one, which `pnpm --filter @agentify/app dev` runs on the host and the `app` image runs on a channel. |
| `apps/gateway` | The payment edge, the order runner and the queue. Ports in `src/ports`, their implementations in `src/adapters`. |
| `apps/dashboard` | The merchant's screens: sign-in, cards, orders, receipts, integrations, keys, settings and the WooCommerce connector, and the identity route the scanner calls. React Router pages under `app/`, server-rendered in the application's process and built by `pnpm --filter @agentify/dashboard build`; their server half is in `src/` (`docs/research/35-one-process.md`). |
| `apps/web` | The scanner: the public site, the checks, the report, and the merchant landing at `/sell`. React Router pages and API routes under `app/`, on Express in `server/`; `pnpm --filter @agentify/web build` makes one process with every package it imports bundled in, which its image runs with nothing installed beside it. |
| `apps/scanner-worker`, `apps/browser-observer-actor` | The scanner's background process and its passive browser observation. |
| `apps/docs` | The documentation at `/docs`: the merchant pages and the scanner's, written in Markdown and drawn by React Router into static files at build time (`pnpm --filter @agentify/docs build`), which Caddy serves. Its JSON examples are test fixtures (see below); `WRITING.md` says how it is written and which Markdown it understands. |
| `packages/contracts` | `@nuanu-ai/agentify-contracts`: every shape that crosses a boundary, as zod schemas, and the route table both sides import instead of transcribing. |
| `packages/core` | The order state machine: pure logic, zero IO, zero runtime dependencies. |
| `packages/sdk` | `@nuanu-ai/agentify`: what a merchant integrates against. Its runtime tree is the contracts package and zod, and nothing else. |
| `packages/slice` | A mock merchant and a buyer, driving the offline gate, the `buy` and `smoke` commands, and the stand. |
| `packages/ui` | `@agentify/ui`: the React components every surface draws with, among them the site header over the public pages and the working header over the dashboard's frame, thin wrappers over the classes of `packages/visual`. |
| `packages/visual` | `@agentify/visual`: the stylesheet of tokens, base element rules and shared primitives every surface on the origin is drawn with, the editorial layout the reading pages share, and under `public/`, the mark and the faces Caddy serves at `/assets` and `/styles`. No build step and no JavaScript. |
| `packages/consent` | `@agentify/consent`: the one choice about measuring a visit, for the whole origin — the consent banner and its preferences, and the measuring services a choice lets a page load. |
| `packages/gallery` | `@agentify/gallery`: every screen of every surface in every state, drawn by the surfaces' own components into one static page (`pnpm gallery`), which CI checks. |
| `packages/scanner-contracts`, `packages/scanner-database`, `packages/scanner` | The scanner's private contracts, storage and evaluation engine. |
| `packages/analytics`, `packages/observability`, `packages/remediation` | The scanner's remaining packages, kept separate from the engine. |
| `deploy/` | Every Dockerfile, the Compose overlays for test and production, the Caddy route table, and the release: `agentify-release`, the activation script and the one Compose command line per channel. `deploy/README.md` is the runbook. |
| `ops/`, `fixtures/` | The scanner's operational checks and runtime test inputs. |
| `scripts/` | The commands the root `package.json` calls: the decision-log check, the outside install, the mutation run, worktree hygiene, and the operator's `approve` and `forget`. |
| `docs/decisions/` | The numbered decisions — what is expensive to reverse, and why it was decided that way — with an index by topic. |
| `docs/research/` | The evidence behind the decisions: measurements, experiments and surveys, and the design notes; its index says which are current. |

One PostgreSQL, one database and one account for the whole product
(ADR-0003). The gateway and the dashboard each own their migrations under
`drizzle/`, and `pnpm db:migrate` runs both; the scanner's schema and
migrations live in `packages/scanner-database`, and `pnpm scanner:db:migrate`
runs them. Each set keeps a history table of its own in the schema `drizzle`,
so none of them mistakes another's entries for its own.

## Checks

Six checks cost nothing and are the gate before a push:

| Command | What it holds |
| --- | --- |
| `pnpm check` | formatting and lint, by Biome |
| `pnpm typecheck` | the compiler over every package |
| `pnpm deadcode` | no file, export or dependency that nothing uses |
| `pnpm test` | every test that needs no database, browser or network: offline, free and deterministic |
| `pnpm check:decisions` | every decision named and numbered once, and no code citing a decision or a note by number |
| `pnpm check:retired` | no sentence the repository has found false and retired written back into it |

CI, `.github/workflows/ci.yml`, runs on every pull request and every push to
`main`. It runs those six, with Biome as `biome ci .` so its diagnostics are
annotated in GitHub, and beyond them the database suite, the scanner's
integration and migration tests, the build of every package and of the
documentation, the speed budgets, the browser suites, the screen gallery and a
scan of the history for secrets. A green run publishes nothing and deploys
nothing.

The documentation's JSON examples and its tables of how an order can end are
read by the contracts and core test suites out of the very files the pages
render, so a page and the behavior it describes cannot drift apart quietly.

The other checks cost something — a database, a browser, the network, or
money — and are kept apart for that reason:

| Command | What it needs | What it holds |
| --- | --- | --- |
| `pnpm test:db` | Postgres: `docker compose up -d --wait postgres` | the database suite; it fails rather than skipping when there is no server |
| `pnpm scanner:test:integration`, `pnpm scanner:test:db` | the same Postgres, and `.env.scanner` | the scanner's integration tests and its migrations; the second half of `scanner:test:db` is `drizzle-kit check`, which reads the migration files and no database |
| `pnpm outside` | the public npm registry | packs the tarballs npm would publish, installs them into a directory with no path back here, and runs the commands the quickstart gives a merchant |
| `pnpm scanner:test:actor` | Chromium | the scanner's browser observer |
| `pnpm dashboard:test:browser` | Chromium | builds the dashboard and drives it: what the browser does with the page data it may keep, a click answered from the hover's fetch, and a press answered on its own page leaving the merchant where they were |
| `pnpm scanner:test:browser` | Chromium | builds the scanner and drives it: its pages come alive without a complaint, a click shows at once, a hover's fetch serves the click, and the consent banner takes a choice without a reload |
| `pnpm docs:test:browser` | Chromium | builds the documentation and drives its pages |
| `pnpm scanner:test:start` | a scanner build | starts the build the way its image does, with nothing installed beside it, and stops it |
| `pnpm --filter @agentify/dashboard budget`, `pnpm --filter @agentify/web budget` | a build | no page's first visit asks for more compressed script than its limit: 100 KB on the dashboard, 105 KB on a scanner page a stranger lands on, 130 KB on one reached by somebody already using the scanner |
| `pnpm smoke:listing <https address>` | the network | asks Coinbase whether our resource would be listed, and reports no verdict rather than a pass when it cannot reach us |
| `pnpm smoke` | `AGENTIFY_SMOKE=1`, a buyer key holding testnet USDC, and the facilitator's credentials | the same buyer and mock merchant against the real facilitator on Base Sepolia; a dry run unless `--confirm` is given, every payment capped at `SMOKE_MAX_USD`, and everything it needs listed in the header of `packages/slice/src/smoke.ts` |
| `pnpm mutate <package>` | nothing but patience | Stryker over one workspace package, printing the survivors: a triage tool for the hand-over ritual, not a gate |

The Chromium is put there once with
`pnpm --filter @agentify/browser-observer-actor exec playwright install chromium`,
and every browser suite drives that same build on every machine, as CI does,
though the runner's Linux fonts and system still differ from a Mac's.
`AGENTIFY_TEST_BROWSER=chrome pnpm scanner:test:browser` runs a suite in the
Google Chrome installed on the machine instead, which presents itself as a
person's Chrome and updates on its own, so its pass says nothing about CI's.

## Releasing

Every change reaches `main` through a reviewed pull request, and every change a
merchant can see in the published packages carries a Changeset
(`pnpm changeset`). A branch can be tried on the test channel,
`test.agentify.ad`; production, `agentify.ad`, runs a commit of `main` tagged
`app-v<release>`, and the same tag publishes the SDK and its contracts to npm
when their versions are new. The servers pull their releases, and GitHub holds
no credential to them (ADR-0016). Everything past the merge — moving the test
channel, the tag, the release command, the npm publication, and the operator's
commands on a channel — is in the runbook, [`deploy/README.md`](deploy/README.md).

## Where to read more

- [agentify.ad/docs](https://agentify.ad/docs/) — what a merchant reads: the
  owner's decision, the engineer's integration, the operator's questions. Its
  source is `apps/docs`.
- [`packages/sdk/README.md`](packages/sdk/README.md) — the npm page of the
  merchant SDK, and [`packages/contracts/README.md`](packages/contracts/README.md)
  the same for the contracts.
- [`docs/decisions/`](docs/decisions/) — what is expensive to reverse, and why
  it was decided that way, indexed by topic.
- [`docs/research/`](docs/research/) — the measurements, experiments and
  surveys behind those decisions.
- [`deploy/README.md`](deploy/README.md) — the runbook for both channels.
- [`AGENTS.md`](AGENTS.md) — the working discipline: how decisions are
  recorded, and what a test has to answer for.

Engineering artifacts are written in English; research and product documents in
the language of their readers, which is why some of the above is in Russian.

## License

Agentify is licensed under the Apache License 2.0. Distributions must retain
the notices required by that license, including the attribution to Nuanu AI in
[`NOTICE`](NOTICE). See [`LICENSE`](LICENSE) for the license terms. The scanner
was imported from `nuanu-ai/agent-first-project` at commit
`33f3385d2be825022133b55d889f8a690f736e69` under the same terms, without its
private research, local configuration, secrets or source history.
