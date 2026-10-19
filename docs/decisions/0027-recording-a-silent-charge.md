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
order stores an attempt identifier and recovery terms. Ordinary verification
and settlement make no RPC requests. Recovery searches from genesis when no
transaction hint exists; neither restarts nor recovery submit again.

An indeterminate result is `payment_unresolved`, including on closed orders.
Pending, unfamiliar and contradictory failure responses remain unknown. Only
an established refusal before broadcast can immediately establish nonpayment.
A configured RPC enables background checks after the response deadline, including
closed orders. The channel defaults to its free public Base RPC; an explicit
empty address disables it. Without RPC or during an outage, verified facilitator
payments continue; a lost result stays unknown
until a late answer or verified recovery arrives. Connecting RPC later checks
the saved attempts. RPC errors and missing evidence never establish failure.

Success requires a successful receipt in a canonical finalized block, with the
canonical USDC token's `AuthorizationUsed(payer, nonce)` immediately followed
by its `Transfer(payer, recipient, amount)` at the next full-receipt log index.
Circle's implementation emits these together without an intervening external
call. The evidence establishes this reserved nonce's exact financial effect;
it does not identify signature bytes or distinguish identical authorizations
sharing that nonce. Conflicting evidence cannot settle an order.

A finalized cancellation, or an unused nonce in a finalized block at or after
the authorization's expiry, proves it cannot execute. A reverted transaction,
an elapsed local timer or an unsuccessful search does not. A lost hash is
recovered by nonce events, with bounded scans and a durable cursor. Older
records use their saved payment terms and reserve their nonce before recovery;
missing or conflicting context stays unresolved. Historical state reads can
locate an old consumed nonce; unavailable history leaves the scan progressing.

The original answer and recovery share one conditional completion under the
order lock. It checks the attempt and applies any due settlement deadline
before the result. State, receipt and merchant messages commit together.
Synchronous goods already held are released once. A payment discovered after
a prepaid order's deadline records payment without dispatching new fulfillment.
The current `refund_due` semantics require the changes in ADR-0028; refund
policy and execution remain the merchant's business.

A recovered receipt uses the transaction block's time. Chain evidence is kept
separate from the facilitator's answer and cannot manufacture its payment
response header. No merchant, administrator or maintenance command may declare
success or failure without verification.

## Alternatives rejected

A second settle; unchecked outcome buttons; staffed reconciliation; an
inspection-time receipt; and interpreting an unavailable RPC as nonpayment.
Public RPC has no recovery-time guarantee. Facilitator payments stay available
when RPC cannot answer; unresolved results are retained, never guessed. Details
and acceptance evidence live in `../research/52-self-service.md`.
