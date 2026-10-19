# Architecture Decision Records

One decision — one file, `NNNN-slug.md`. An ADR records a decision that is
expensive to reverse: a dependency in a published package's tree, a schema on
disk, a wire contract, a security boundary, what money means, and the custody
boundary that keeps Agentify from holding money or goods. Everything else —
screens, flows, internal mechanics, process topology, toolchain, release
procedure and operations — is a design note in `docs/research/`, and the
measurements and surveys a decision rests on are there too
([index](../research/README.md)). How the product works for a merchant is the
documentation at [agentify.ad/docs](https://agentify.ad/docs/); these files
say why it works that way.

## The decisions by topic

ADR-0002 and ADR-0003 are written in Russian, the language they were first
written in; the rest are in English.

### Money

| Decision | What it decides |
| --- | --- |
| [0019](0019-non-custodial-payout-wallet.md) | Agentify never holds the money: a payment goes to the split of the merchant's wallet in force, and replacing that wallet on the live channel waits forty-eight hours after every account of the merchant is told. |
| [0037](0037-every-payment-goes-to-the-merchants-split.md) | Every payment goes to the merchant's own split, a contract nobody owns, which pays 99.9% to the merchant's wallet and 0.1% to Agentify whenever somebody pays it out. |
| [0038](0038-the-registry-of-payout-splits-is-never-rewritten.md) | Every split ever named as a payment address is recorded with all its parameters, and the record is never rewritten, so the money paid into a split can always be paid out. |
| [0028](0028-late-goods-settle-a-refund-owed.md) | Goods delivered late settle a refund owed until a refund is recorded; once it is, the order is `refunded` and final. |
| [0027](0027-recording-a-silent-charge.md) | A charge nobody heard back from reads `payment_unresolved`, and what became of it is recorded by an operator's command, never asked of the facilitator again. |
| [0020](0020-environment-derived-from-the-chain.md) | Whether money is real follows from the payment network alone: Base Sepolia is a test deployment, Base a live one, and any other chain stops the process. |

### What the agent sees

| Decision | What it decides |
| --- | --- |
| [0006](0006-wire-version.md) | What the contract version promises and when it moves: from the first merchant Agentify does not control, every change a strict reader cannot read moves it, so an old worker stops with words instead of misreading an order. |
| [0012](0012-discovery-declaration.md) | Every card on sale declares itself in its payment challenge for outside catalogues such as the x402 Bazaar, as a projection of the card. |
| [0018](0018-one-envelope-one-document.md) | Every call says no in one shape — a `code`, a `message` and `retryable` — and an order is one document. |
| [0011](0011-agent-collection-door.md) | For now, knowing an order's identifier is the proof that opens that order, which is how an agent collects goods delivered later; a payment names its order by a separate reference that nothing answers with the order, so no listing can carry the identifier. |
| [0034](0034-an-agent-knows-the-seller-by-their-site.md) | An agent knows who sells by the seller's name and the address of the shop's own site, on every card and order. |
| [0017](0017-leniency-at-the-door.md) | The wire may accept shorter spellings, but they are opened into the one canonical shape at the door, before anything is stored or served. |

### Merchant integration

| Decision | What it decides |
| --- | --- |
| [0002](0002-merchant-integration-model.md) | The merchant pushes cards to Agentify, the price is checked with the merchant at the purchase, and orders reach the merchant through a queue. |
| [0004](0004-worker-transport-long-poll.md) | The merchant's process receives orders by HTTP long polling against the gateway, with its API key, and listens on no port. |
| [0010](0010-merchant-tenancy.md) | Every merchant is a row with its own selling switch, and every card, order, receipt and key names its merchant. |
| [0014](0014-registration.md) | An account comes into being only at a sign-in, and a merchant only when that person presses the dashboard's one control for it; no terminal command makes either. |
| [0035](0035-agentify-is-not-the-store.md) | Agentify is not the store: a product comes from the merchant's own system, and Agentify holds no goods. |
| [0036](0036-a-merchant-sells-through-one-integration-at-a-time.md) | A merchant sells through one integration at a time, the SDK or one WooCommerce shop, and the other's cards are off sale. |
| [0023](0023-woocommerce-connect.md) | A connected WooCommerce shop's keys are a merchant credential Agentify holds and fulfills orders with, importing the shop's products as cards. |

### Parcels

| Decision | What it decides |
| --- | --- |
| [0032](0032-a-buyers-address-passes-through.md) | A buyer's address passes through Agentify to the merchant and is erased once the merchant holds it or the order ends without them. |
| [0033](0033-a-shipped-order-ends-at-the-carrier.md) | A shipped order ends at the carrier: the merchant records the shipment, the agent is told `shipped`, and parcels sell on the test channel only for now. |

### Sign-in and the one origin

| Decision | What it decides |
| --- | --- |
| [0005](0005-web-surface.md) | One origin and one door: the scanner, the documentation, the dashboard and the gateway share one address and one route table, on a laptop and on both channels. |
| [0026](0026-one-way-in.md) | One identity for the whole site: email links and Google, one session, live publication guarded by the operator's approval, and the operator flag for `/admin`. |
| [0039](0039-a-first-registration-from-an-ad-is-reported-once.md) | A first registration that came from an ad is reported once to the ad's tracker, and only with the person's consent. |

### Data and operations

| Decision | What it decides |
| --- | --- |
| [0003](0003-stack.md) | The stack: the published packages ask for Node 24 and bring only the contracts and zod into a merchant's tree, and the product keeps one PostgreSQL database. |
| [0013](0013-effects-commit-with-the-state.md) | An effect that cannot be re-driven commits in the same transaction as the order state that implies it. |
| [0016](0016-two-channel-releases.md) | Two isolated release channels that pull their releases: images built once in CI, TEST following a tag, production taking an `app-v*` tag a person releases, which also publishes the SDK. |
| [0029](0029-production-backups-leave-the-host.md) | Production's data and secrets leave the host every ten minutes for one encrypted bucket; TEST is not backed up. |

### The scanner

| Decision | What it decides |
| --- | --- |
| [0031](0031-browser-observer-contract.md) | The scanner's browser observer answers one versioned contract and stays on the site it observes. |

## Words the decisions use

A *card* is one product written so that a program can decide to buy it: a
title, a description, a price, and what has to be given at purchase.

A *channel* is a deployment the product runs on. The test channel,
`test.agentify.ad`, settles payments on Base Sepolia with test funds; the live
channel, `agentify.ad`, settles them on Base with real money. TEST and
PRODUCTION name the same two, as hosts. The *sandbox* is the stack on a laptop,
where payments settle against nothing.

The *door* is where a request first meets the system and is checked: the
publish call, the purchase route, sign-in. A refusal at the door happens before
anything is stored or charged.

An *envelope* is the wrapper a message travels in. On a merchant's stream it is
one paid order, price question or order event handed over to their process
(ADR-0004, ADR-0013); in an answer, it is the one shape every route answers in
(ADR-0018).

The *facilitator* is the payment service that verifies the buyer's signed
x402 payment and executes it on the chain. The money goes from the buyer's
wallet to the merchant's split without passing through Agentify.

The *handler*, or *worker*, is the merchant's process written against the SDK:
it subscribes to the gateway and answers paid orders and price questions. For
a WooCommerce shop, a connector inside Agentify plays its part.

An *operator* is a person who runs a channel: they approve a merchant for live
sales, record what became of a charge or a refund, and read `/admin`. On the
site an operator is an account carrying the operator flag (ADR-0026).

The *pilot* is the controlled launch before the first merchant Agentify does
not control. Some rules hold only during it, and the decisions that carry them
say so.

The *product owner* is the one person who holds the final word on the
product; decisions name the role, not the person.

A *split*, or *payout split*, is the merchant's own payment contract, an
immutable 0xSplits PullSplit with no owner. Every payment goes into it, and
whenever anybody pays it out it sends 99.9% to the merchant's wallet and 0.1%
to Agentify's commission wallet (ADR-0037).

The *teller* is the part of the dashboard that sends mail to a merchant's
accounts on the gateway's behalf, in the process the two share (ADR-0019).

## Format

The ceiling is about sixty lines. Enough to reconstruct the reasoning, not to
exhaust the subject; measurements and their status live in research, linked.
Decisions are living documents until the first external merchant or a second
permanent participant: an accepted change is an edit to the file itself, and
the history lives in git. A cancelled decision is deleted, and its number is
retired below.

Template:

```markdown
# NNNN. The decision, named as a sentence

Date: YYYY-MM-DD
Status: accepted

## Context
Why the question arose, and the constraint that decides it.

## Decision
What is decided, in a couple of paragraphs.

## Consequences
What this buys and what it costs. Alternatives rejected, and why.
```

## Retired numbers

A number is never reused. When a decision is merged into another or moved into
research, its number is retired and listed here with where its content now
lives, so that a citation in git history, a commit message or a changelog
still leads somewhere. Before this list was kept, 0004, 0021 and 0023 were each
given out twice; git history shows the first uses.

- 0001 (the pilot is exposed on the x402 Bazaar through the CDP facilitator):
  the closing section of `docs/research/04-spike-bazaar-listing.md`; what is
  expensive to reverse stands in ADR-0012, ADR-0019 and ADR-0020.
- 0007 (the confirmation mode's seam):
  `docs/research/40-confirmation-mode-seam.md`.
- 0008 (the sandbox facilitator): ADR-0020.
- 0009 (signing in to the dashboard): ADR-0026.
- 0015 (mail and confirming an address): ADR-0026.
- 0021 (what a payment challenge says):
  `docs/research/25-what-the-challenge-says.md`.
- 0022 (one answer envelope): ADR-0018.
- 0024 (the scanner's identity without Supabase): ADR-0026.
- 0025 (the Agentify namespace): a finished rename; its schema URN rule stands
  in ADR-0006 §4, and the names it fixed live in `deploy/README.md`.
- 0030 (the gateway and the dashboard are one process):
  `docs/research/35-one-process.md`.
