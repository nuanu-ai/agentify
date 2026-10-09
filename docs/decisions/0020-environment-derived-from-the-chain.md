# 0020. What environment this is, the chain answers

Date: 2026-08-31
Status: accepted; merges what was ADR-0008

## Context

One image runs three ways, told apart by configuration alone: the test site,
test.agentify.ad, settles on Base Sepolia with test funds; the live site,
agentify.ad, settles on Base mainnet with real money; and a laptop runs the
stack with no chain behind it, so an engineer completes a purchase without a
network, a wallet or a faucet. How a commit reaches each site is ADR-0016. The
answer leaves the building in every key's prefix, the `test` field of every
order and receipt, and what pages and logs say: it is our claim, to somebody
else's agent, about whether somebody else's money moved.

## Decision

Whether money is real is derived from `PAYMENT_NETWORK` alone. A chain on the
written testnet list makes a test deployment, Base mainnet a live one, and the
default is Base Sepolia, so nobody goes live by forgetting a variable. A chain
on neither list stops the process, because a guess is wrong either way: an
unlisted testnet read as live writes `test: false` onto orders, and the reverse
calls real money play money. Adding a chain edits this decision and
`packages/core/src/deployment/environment.ts`; Ethereum and Polygon mainnet,
where we do not sell, are absent.

Whether anything settles is a value of `FACILITATOR_URL`, never a flag beside
it: `sandbox:scripted` selects a facilitator that verifies and settles against
nothing, any other value must be the http address of a real one, and one field
cannot also say the opposite. The sandbox still refuses an unwritten chain,
says in its log and on its pages that nothing it accepts is real, and alone may
stand the configured `PAY_TO_ADDRESS` in for a merchant who set no wallet,
since a payment challenge needs an address and nothing there settles; elsewhere
that merchant is refused (ADR-0019).

Credentials go to Coinbase's facilitator or nowhere, decided by the address,
never by whether they are set. `CDP_API_KEY_ID` or `CDP_API_KEY_SECRET` beside
`sandbox:scripted` stops the process, as a production file copied onto a
sandbox. Any spelling of a host under `cdp.coinbase.com` stops it unless both
are set, naming the one missing, since that facilitator answers nothing
unsigned. Any other host under `coinbase.com` stops it, since the gateway can
sign for none of them; a look-alike elsewhere is handed nothing.

A live chain settles through `https://api.cdp.coinbase.com/platform/v2/x402`
with both credentials and through nothing else. Every part is compared: the
scheme, since `http:` sends credentials in the clear; host and default port; no
user name, query or fragment; and the path up to trailing slashes, since
`/verify` and `/settle` are built under it and a wrong one starts healthy.

Every key carries its environment as its prefix, `csk_test_` or `csk_live_`,
which its holder can read and the gateway reads before any lookup. A key from
the other site gets the usual `not_authorised` and 401 with a sentence naming
the site it works on; a key naming no environment gets the plain refusal, since
telling it from a guess would confirm which guesses were once real keys.

## Consequences

An unwritten chain cannot be tried by editing a file, the live facilitator is
not an operator's choice, and a sandbox an agent can reach takes payments that
never happened, so it stays on a laptop; a receipt proves nothing until its
reader knows which gateway wrote it. The facilitator becomes a list when a
second one holds our credentials and its settlements reach the catalog a
listing depends on (ADR-0001); the prefix becomes the set a site accepts when a
live gateway must issue test keys.

Rejected: `AGENTIFY_ENV` or `PAYMENT_SANDBOX=1` beside these fields — two
fields can disagree, and the one surviving a copied file says "test" where
money is real. A separate sandbox entry point — the wiring not run in earnest
rots. Reading an unknown chain as live — safe for spending, wrong on the wire.
The live facilitator named by host alone — credentials ask who may hold a
bearer token, a live chain asks where real money settles. A code of its own for
a key from the other site — a program would act no differently, and a sentence
says it.
