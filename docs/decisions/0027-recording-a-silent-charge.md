# 0027. A silent charge is recovered from payment evidence

Date: 2026-09-22
Status: accepted (automatic recovery: the product owner, 2026-10-19).

## Context

A settle that times out may have moved money. The facilitator has no outcome
lookup for a submitted charge, and settling again is not a safe lookup. No
person is assigned to investigate these orders. Recovery uses chain evidence
without making an RPC a condition for ordinary facilitator payments.

## Decision

Real payments use x402 version 2, exact USDC on Base or Base Sepolia, and an
EIP-3009 authorization; other methods, Permit2 included, are refused before
verification. The signed recipient and amount must match the order, and the
expiry is bounded by the offered timeout plus a clock allowance; smart-wallet
signatures are allowed. Acceptance reserves the network, token, payer and nonce
for the order, atomically with its saved payment. Before submission the order
stores an attempt identifier and recovery terms, including when the
authorization was verified unused. Ordinary verification and settlement make no
RPC requests; neither restarts nor recovery submit again.

An indeterminate result is `payment_unresolved`, including on closed orders.
Pending, unfamiliar and contradictory failure answers stay unknown; only an
established refusal before broadcast establishes nonpayment at once. A
configured RPC, by default the channel's public Base RPC, is checked in the
background after the response deadline; an empty address disables it. Its chain
id is asked at start-up and on every poll, so a wrong or silent endpoint is
reported and a recovered one resumes without a restart. Every poll logs read
failures and the count and age of unresolved payments. RPC errors and missing
evidence never establish failure.

Success requires a successful receipt in a canonical finalized block where the
canonical USDC token's `AuthorizationUsed(payer, nonce)` is immediately followed
by its `Transfer(payer, recipient, amount)` at the next log index, as Circle's
implementation emits them. A finalized cancellation, or an unused nonce in a
finalized block at or after the expiry, proves nonpayment; a reverted
transaction, an elapsed timer or a failed search does not.

Without a hash, recovery reads the receipts of only the blocks where the
authorization could execute, from its verification time (found by bisecting
block times) to its `validBefore`, with a cursor kept across polls and through a
refused read; it sends no log queries. A used nonce absent from that window is
unpaid only if it was unused at the window's last block. Orders saved before
recovery terms existed search from their creation and reserve their nonce first;
missing or conflicting context stays unresolved.

The RPC is trusted as payment evidence, as the facilitator is. Recovery checks
the token contract, chain id, payer, merchant split, amount, nonce, finality and
canonical block hash, but cannot detect an endpoint serving a consistent false
receipt or nonce state; choosing the endpoint is a security decision.

The original answer and recovery share one conditional completion under the
order lock, which applies a due settlement deadline first; state, receipt and
merchant messages commit together. Held goods are released once unless the
merchant closed fulfillment (ADR-0028); a payment found after a prepaid order's
deadline is recorded without new fulfillment. A recovered receipt uses the
block's time and never manufactures the facilitator's payment response header.
No merchant, administrator or command may declare success or failure without
verification; refunds remain the merchant's business.

## Alternatives rejected

A second settle; outcome buttons; staffed reconciliation; an inspection-time
receipt; reading an unavailable RPC as nonpayment; a log search from genesis,
which public Base endpoints refuse or cap at 200 blocks. Public RPC gives no
recovery-time guarantee. Details: `../research/54-self-service.md`.
