# 0027. A silent charge is recovered from payment evidence

Date: 2026-09-22
Status: accepted (automatic recovery: the product owner, 2026-10-19).

## Context

A settle that times out may have moved money. The facilitator has no outcome
lookup for an already submitted charge; settling again is not a safe lookup.
Agentify has no person assigned to investigate these orders. Recovery uses
chain evidence when available, without making RPC availability a condition
for ordinary facilitator payments (the product owner, 2026-10-19).

## Decision

Real payments use x402 version 2, exact USDC on Base or Base Sepolia, and an
EIP-3009 transfer authorization. Unsupported methods, including Permit2, are
refused before verification or submission. The signed recipient and amount
must match the order. The authorization's expiry is bounded by the offered
payment timeout with clock-skew allowance. Smart-wallet signatures are allowed.

Acceptance permanently reserves the network, token, payer and authorization
nonce for this order, atomically with its saved payment. Before submission the
order stores an attempt identifier and recovery terms, including when the
authorization was verified unused. Ordinary verification and settlement make
no RPC requests; neither restarts nor recovery submit again.

An indeterminate result is `payment_unresolved`, including on closed orders.
Pending, unfamiliar and contradictory failure responses remain unknown; only an
established refusal before broadcast establishes nonpayment at once. A
configured RPC, by default the channel's free public Base RPC, is checked in the
background after the response deadline. An empty address disables it; one that
answers another chain id at start-up, or none, leaves recovery off and says so.
Facilitator payments never depend on it. Every poll logs a read failure and the
count and age of unresolved payments. RPC errors and missing evidence never
establish failure.

Success requires a successful receipt in a canonical finalized block, with the
canonical USDC token's `AuthorizationUsed(payer, nonce)` immediately followed
by its `Transfer(payer, recipient, amount)` at the next full-receipt log index,
which Circle's implementation emits without an intervening external call. This
proves the reserved nonce's exact financial effect, not the signature bytes.
A finalized cancellation, or an unused nonce in a finalized block at or after
the expiry, proves nonpayment; a reverted transaction, an elapsed timer or an
unsuccessful search does not.

Without a hash, recovery reads the receipts of only the blocks where the
authorization could execute: from its verification time, found by bisecting
block times, to its `validBefore`, with a durable cursor and no log queries. A
used nonce absent from that window is unpaid only if it was unused at the
window's last block. Older records search from the order's creation and reserve
their nonce first; missing or conflicting context stays unresolved.

The RPC is trusted as payment evidence, as the facilitator is. Recovery checks
the token contract, chain id, payer, merchant split, amount, nonce, finality
and canonical block hash, but cannot detect an endpoint serving a consistent
false receipt or nonce state; choosing the endpoint is a security decision.

The original answer and recovery share one conditional completion under the
order lock, which applies any due settlement deadline first; state, receipt
and merchant messages commit together. Held synchronous goods are released once
unless the merchant closed fulfillment (ADR-0028); a payment found after a
prepaid order's deadline is recorded without new fulfillment. A recovered
receipt uses the block's time and cannot manufacture the facilitator's payment
response header. No merchant, administrator or command may declare success or
failure without verification; refunds remain the merchant's business.

## Alternatives rejected

A second settle; outcome buttons; staffed reconciliation; an inspection-time
receipt; reading an unavailable RPC as nonpayment; a log search from genesis,
which public Base endpoints refuse or cap at 200 blocks. Public RPC gives no
recovery-time guarantee. Details: `../research/54-self-service.md`.
