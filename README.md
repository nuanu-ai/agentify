# Agentify

[![CI](https://github.com/nuanu-ai/agentify/actions/workflows/ci.yml/badge.svg)](https://github.com/nuanu-ai/agentify/actions/workflows/ci.yml)
[![npm: @nuanu-ai/agentify](https://img.shields.io/npm/v/@nuanu-ai/agentify?label=%40nuanu-ai%2Fagentify)](https://www.npmjs.com/package/@nuanu-ai/agentify)
[![npm: @nuanu-ai/agentify-contracts](https://img.shields.io/npm/v/@nuanu-ai/agentify-contracts?label=%40nuanu-ai%2Fagentify-contracts)](https://www.npmjs.com/package/@nuanu-ai/agentify-contracts)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Agentify is two things on one origin. The first is a scanner: a public site
where the owner of an ordinary online business enters their address and reads
what their site exposes to AI agents — the robots file and the sitemap, the
structured data, the machine-readable output — as a report of named checks
with the evidence behind each verdict. The second is a channel: the gateway
through which that business sells its goods to AI agents, paid in stablecoins
over the x402 protocol, with the money going from the buyer's wallet to the
merchant's and never passing through us.

This file orients an engineer who has just opened the repository. What a
merchant reads is at [agentify.ad/docs](https://agentify.ad/docs/), built from
`apps/docs` here.

## Contents

- [The path through the product](#the-path-through-the-product)
- [Prerequisites](#prerequisites)
- [Run it](#run-it)
- [What happens in a sale](#what-happens-in-a-sale)
- [Repository layout](#repository-layout)
- [Checks](#checks)
- [Releasing the SDK](#releasing-the-sdk)
- [Deploying](#deploying)
- [Where to read more](#where-to-read-more)
- [License](#license)

## The path through the product

A business owner arrives at the scanner, enters the address of their site and
watches the checks run. The full report is unlocked with an email address and
the one-time link sent to it. The same address is the key to the rest: the
report carries one control that opens the merchant cabinet, and the cabinet's
own door is that one field and that one link — there is no password and no
invitation code (ADR-0026). The first visit creates the merchant and asks for
the seller name buyers will see.

From there the merchant's engineer takes over. The cabinet issues the key
their code calls with, the SDK publishes the product cards and runs a handler
beside the shop's existing API, and the first sale happens on the test
channel, where payments settle on Base Sepolia with test funds. Live
publication needs a seller name, a payout wallet and the operator's one-time
approval of that merchant; publication lists whatever is still missing. The
whole integration, from an empty project to a test sale, is the portal's
[quickstart](apps/docs/quickstart.md).

Deployed, one origin serves all of it: the scanner at `/`, the merchant
documentation at `/docs`, the cabinet at `/cabinet`, the merchant's own calls
at `/v0` and the storefront an agent buys from under `/x402`. The static
landing in `apps/landing` is not part of a deployment; it stands in for the
scanner in the local stack below, which is a commerce fixture and nothing more.

## Prerequisites

Node.js 24.21 — the exact version is in `.nvmrc`, and `pnpm install` refuses
another one because `.npmrc` sets `engine-strict`. pnpm 11.12 arrives through
Corepack from the `packageManager` field of the root `package.json`, the same
way CI gets it:

```sh
corepack enable
pnpm install
```

Installing also points git at `.githooks`, where a `commit-msg` hook holds the
Conventional Commits format. Docker with Compose v2 runs the stacks below, and
`pnpm test` needs a `python3` on the path for the scanner's operational tests.

## Run it

The commerce stack is one command:

```sh
docker compose up --build
open http://localhost:8080
```

One origin, one port: the landing at `/`, the merchant documentation at
`/docs`, the cabinet at `/cabinet`, the merchant's own calls at `/v0`, the
storefront an agent buys from under `/x402`, Postgres behind them. A merchant
process comes up beside it and publishes two cards — a rented phone number
sold synchronously, an eSIM sold asynchronously.

Nothing buys by itself. The buyer is the one thing that runs on the host rather
than in the stack, so the workspace needs its dependencies first:

```sh
pnpm buy                      # the first card in the catalogue
pnpm buy esim                 # the one delivered later
```

The gateway settles against nothing locally (ADR-0008): a purchase completes
with no wallet, no network and no faucet, and the first line of its log says so.

The cabinet is where a merchant sets the name buyers see and issues the keys
their own code calls with. Open `http://localhost:8080/cabinet/sign-in`, enter
an email address, and take the one-time link from the cabinet's log — the
local sandbox writes the message there instead of sending it. Pressing the
link's confirmation button signs you in, creates your merchant if you have
none, and asks for the seller name. That merchant is a new one, and it is not
`the_merchant` — the merchant the stack seeds, whose two cards the merchant
process publishes and `pnpm buy` buys. Somebody who has just signed in has no
cards and no keys of their own, which is the truth about a merchant who has
written no code yet (ADR-0014).

If port 8080 is taken, `AGENTIFY_HOST_PORT=8090 docker compose up` moves the
stack and nothing else — the buy command runs on the host and needs
`GATEWAY_URL=http://localhost:8090 pnpm buy`.

The scanner runs separately, on its own PostgreSQL 16.9 at `127.0.0.1:55432`,
and never reads the commerce `.env`:

```sh
cp .env.scanner.example .env.scanner
pnpm scanner:db:up
pnpm scanner:db:migrate
pnpm scanner:dev
```

The web application listens on port 3000 and the worker's health endpoint on
8081; `pnpm scanner:db:down` stops the database without deleting its volume.
Scanning needs nothing else. Unlocking a report does: the scanner asks the
cabinet's private identity route to send and verify the link, so a cabinet
started with `REPORT_IDENTITY_SECRET` and a scanner configured with the same
secret and `CABINET_IDENTITY_URL` pointing at the cabinet's private listener
on port 3002 are the two halves of that path. Report sessions stay separate
from cabinet sessions, and a person becomes a merchant only when they enter
the cabinet; ADR-0026 draws the boundary and ADR-0024 says what the scanner
keeps of its own.

## What happens in a sale

A card is one product written so that a program can decide to buy it: a title,
a description, a price, and the list of what has to be given at purchase. A
merchant publishes cards through the SDK, and every card is an address an agent
can pay against.

The purchase is an HTTP request to that address. The gateway answers `402
Payment Required` with a challenge naming the price, the network and the asset;
the agent signs a payment and repeats the request carrying it. That exchange is
x402, and the protocol itself comes from the official packages — what this
repository adds is knowing which order a payment is for.

The merchant's side is one process standing beside their existing API: a
handler. It listens on no port — it opens a single outgoing subscription and
receives paid orders, price questions and order events on that one stream
(ADR-0004). Everything it is written against is `@nuanu-ai/agentify`. The
package and the gateway agree on a contract version — `"2"` today — and a
change the package could not read moves that version before the gateway sends
it (ADR-0006).

The order is a state machine in `packages/core`, a pure function with no IO.
The gateway feeds it events and gets back the next state together with the
effects that state implies, and those effects are written down in the same
transaction as the state itself (ADR-0013). What the card declares before
payment is which sequence the sale follows. With synchronous fulfillment the
goods come back in the answer to the purchase and the money moves only once
the merchant has produced them, so a refusal costs the buyer nothing. With
asynchronous fulfillment the money moves at the purchase and the agent leaves
with an order identifier, which is the whole of its proof when it comes back
for the goods (ADR-0011). Fulfillment against the merchant's confirmation is
designed in the machine and refused at the door: a card asking for it is not
published, because the message that would tell the agent it may now pay does
not exist yet (ADR-0007). The portal's [orders page](apps/docs/orders.md)
draws each of the three, and its table of how an order can end is the test
suite's own fixture.

The stand is our own instrument for walking a purchase from all three seats —
catalogue, agent and merchant — in one local console, with a log threaded by
the order. It is not a product surface and it needs a throwaway buyer key in
`.env.stand` as `STAND_BUYER_KEY`; `pnpm stand` starts it on `127.0.0.1:8787`.
Its merchant half is written to be read by somebody integrating against the
SDK, in `packages/slice/src/stand-merchant.ts`, and
`docs/research/24-stand-boundary.md` says what it does and does not prove.

## Repository layout

One pnpm workspace holds the commerce product and the scanner. They share the
toolchain and the lockfile; their check, test and build commands are scoped
separately in the root `package.json` because the two keep different compiler,
lint and test policies — the commerce side is checked by Biome, the scanner by
Prettier and ESLint under the `*.scanner.*` configurations at the root.

| Path | What it is |
| --- | --- |
| `apps/web` | The scanner: the public site, the checks, the report. |
| `apps/scanner-worker`, `apps/browser-observer-actor` | The scanner's background process and its passive browser observation. |
| `apps/gateway` | The payment edge, the order runner and the queue. Ports in `src/ports`, their implementations in `src/adapters`. |
| `apps/cabinet` | The merchant's screens: sign-in, cards, orders, receipts, keys, and the identity route the scanner calls. Server-rendered, no client build (ADR-0005). |
| `apps/docs` | The merchant documentation, a VitePress site served at `/docs`. Its JSON examples are test fixtures (see below). |
| `apps/landing` | The static page the local stack serves at `/`; not deployed. |
| `packages/contracts` | `@nuanu-ai/agentify-contracts`: every shape that crosses a boundary, as zod schemas, and the route table both sides import instead of transcribing. |
| `packages/core` | The order state machine: pure logic, zero IO, zero runtime dependencies. |
| `packages/sdk` | `@nuanu-ai/agentify`: what a merchant integrates against. Its runtime tree is the contracts package and zod, and nothing else. |
| `packages/slice` | A mock merchant and a buyer, driving the offline gate, the `buy` and `smoke` commands, and the stand. |
| `packages/scanner-contracts`, `packages/scanner-database`, `packages/scanner` | The scanner's private contracts, storage and evaluation engine. |
| `packages/analytics`, `packages/observability`, `packages/remediation` | The scanner's remaining packages, kept separate from the engine. |
| `deploy/` | Dockerfiles, the Compose overlays for test and production, the Caddy route table and the Ansible release playbooks. |
| `ops/`, `fixtures/` | The scanner's local database definition, operational checks and runtime test inputs. The health monitor under `ops/deploy/workflows/` is retained configuration, not an active GitHub workflow. |
| `scripts/` | The commands the root `package.json` calls: the decision-log check, the outside install, the mutation run, worktree hygiene. |
| `docs/decisions/` | The numbered decisions — what is expensive to reverse, and why it was decided that way. |
| `docs/research/` | The working material behind them: research, runbooks, acceptance protocols. |

Gateway and cabinet share one Postgres and each owns its migrations under
`drizzle/`; `pnpm db:migrate` runs both. The scanner's schema and migrations
live in `packages/scanner-database`.

## Checks

```sh
pnpm check          # formatting and lint
pnpm typecheck
pnpm test           # offline, free, no network
pnpm check:decisions
```

That is the gate before a push. CI runs the same four on every push and pull
request, and beyond them the database suite, the build of every package and of
the portal, and the scanner's integration tests; the workflow is
`.github/workflows/ci.yml`. A green run publishes nothing and deploys nothing.

The portal's JSON examples and its tables of how an order can end are read by
the contracts and core test suites out of the very files the pages render, so a
page and the behavior it describes cannot drift apart quietly.

A few more checks cost something — a database, the network, or money — and are
kept apart for that reason:

- `pnpm test:db` needs a Postgres (`docker compose up -d --wait postgres`) and
  fails rather than skipping when there is none.
- `pnpm outside` packs the tarballs npm would publish, installs them into a
  directory with no path back here, and runs the commands the quickstart gives
  a merchant.
- `pnpm smoke:listing <https address>` asks Coinbase whether our resource would
  be listed, and reports no verdict rather than a pass when it cannot reach us.
- `pnpm smoke` walks the same buyer and mock merchant against the real
  facilitator on the Base Sepolia testnet. It refuses to start without
  `AGENTIFY_SMOKE=1`, is a dry run unless `--confirm` is given, and caps every
  payment at `SMOKE_MAX_USD`; the header of `packages/slice/src/smoke.ts` lists
  everything it needs.
- `pnpm mutate <package>` runs Stryker over one workspace package and prints
  the survivors. It is a triage tool for the hand-over ritual, not a gate.
- The scanner's own gates are `pnpm scanner:check` for lint, types and unit
  tests, `pnpm scanner:test:integration` and `pnpm scanner:test:db` against
  its database, `pnpm scanner:test:actor` for the browser observer, and
  `pnpm scanner:build`.

## Releasing the SDK

Two packages are public, `@nuanu-ai/agentify-contracts` and
`@nuanu-ai/agentify`, and they are released together from one commit. Every
change to either carries a Changeset (`pnpm changeset`). A release is prepared
on `main` with `pnpm changeset version`, and pushing a tag `sdk-v<version>` runs
`.github/workflows/publish-sdk.yml`: it waits for CI to pass on that exact
commit, refuses a tag whose version differs from the SDK manifest, publishes
through npm Trusted Publishing with no stored token, and then installs the
exact versions back from the registry and imports them. The full procedure,
including the one-time bootstrap of the package names, is in
[`docs/research/22-sdk-release.md`](docs/research/22-sdk-release.md).

## Deploying

Production is served at `agentify.ad` and the test channel at
`test.agentify.ad`, on separate hosts with isolated data, and both run the same
source revision and the same service graph (ADR-0016). Nothing deploys
automatically — not a tag, not a green CI run. An operator stages a full commit
SHA on test with the Ansible playbook, activates and accepts it there, and only
then stages and activates the same SHA on production. The procedure is the
[release operations guide](deploy/ansible/README.md); the Compose overlays it
applies live under `deploy/`.

Switching a merchant on for live sales is an application command rather than a
deployment: `pnpm approve <email>` from the operator's checkout reaches the
production host over SSH, resolves the cabinet account's merchant and records
its one-time approval, and it says so when the approval already exists or the
account is unknown. Approval publishes nothing and supplies no missing seller
name or payout wallet; the test channel never needs it.

## Where to read more

- [`apps/docs/`](apps/docs/) — what a merchant reads: the owner's decision, the
  engineer's integration, the operator's questions. Published at
  [agentify.ad/docs](https://agentify.ad/docs/).
- [`packages/sdk/README.md`](packages/sdk/README.md) — the npm page of the
  merchant SDK, and [`packages/contracts/README.md`](packages/contracts/README.md)
  the same for the contracts.
- [`docs/decisions/`](docs/decisions/) — what is expensive to reverse, and why
  it was decided that way.
- [`docs/vision.md`](docs/vision.md) — the product vision, for whoever is
  deciding whether to connect.
- [`AGENTS.md`](AGENTS.md) — the working discipline: how decisions are
  recorded, what a test has to answer for, why a check that did not run never
  reports success.

Engineering artifacts are written in English; research and product documents in
the language of their readers, which is why some of the above is in Russian.

## License

Agentify is licensed under the Apache License 2.0. Distributions must retain
the notices required by that license, including the attribution to Nuanu AI in
[`NOTICE`](NOTICE). See [`LICENSE`](LICENSE) for the license terms. The scanner
was imported from `nuanu-ai/agent-first-project` at commit
`33f3385d2be825022133b55d889f8a690f736e69` under the same terms, without its
private research, local configuration, secrets or source history.
