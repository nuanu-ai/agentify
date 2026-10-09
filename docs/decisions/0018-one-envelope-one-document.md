# 0018. Every call says no in one shape, and an order is one document

Date: 2026-08-28
Status: accepted; merges what was ADR-0022

## Context

A stranger's engineer integrates against the merchant's routes and the agent's.
Each difference in how two routes say "no" or describe one order is a lesson
with no meaning, and each shape is a wire contract that changes, once a
consumer we do not control reads it, only by moving the contract version
(ADR-0006). Two traps shape the details: an object under a key is falsy in
Python and in PHP, so success marked by a key's presence reads as yes for one
answer and no for another; and a key that may be absent exports nothing for a
generated client to switch on.

## Decision

Why a call did not go through is one object on every route: a `code` to branch
on, a `message` a person can act on, and `retryable`, all three required. A
refused call answers `{ error: { ... } }` with nothing beside it, never under a
success status, and a reader that does not know a further field inside `error`
still reads the three. The code is open on the wire and closed on our side:
`ERROR_CODES` in the contracts package lists the codes the gateway sends, to
switch over rather than to validate against, and every refusal is built by one
function that accepts only a code from that list. An unknown code still parses
as the failure it is.

`retryable` says whether this same call could succeed if made again — a fact,
not an instruction — and is required because a caller left to guess turns one
reading into a retry loop and the other into an abandoned call. The gateway
sets it per code, in a table the compiler forces every code into, true only
where repeating the call is itself the way through and false otherwise; the two
refusals about a payment carry what the payment layer said instead.

Publishing a card and answering, delivering, refusing or taking on an order end
in outcomes the merchant's code branches on, so these calls return a failure
rather than throw it, in one envelope: `ok` is the literal `true` or `false`
and exports as a `const` on each branch, a success carries its own fields
beside it, and a failure carries one `error`, never under a success status.

`error` is why a call did not go through, always one; `problems` is the list of
findings about what was sent — a path, a code and a message each — inside
`error` and never empty when present. A refused publish is `card_rejected`,
always carries findings and is never retryable, since the same card gets the
same answer; a delivery that does not match its card carries them too, and the
SDK's local `checkCard` reports findings in the same shape.

What the SDK throws, `AgentifyError`, carries the same `code` and `retryable`
and the route: the gateway's own where it refused in words, otherwise one of
three codes the SDK makes for an answer that never came or could not be read,
which are retryable. A client built wrong throws a `TypeError`.

A purchase answers with the same order document the status route serves: what
was bought, the price, whether the money was real and how the order can end.
The merchant's item id, parameters, price id and receipt stay out of it.

## Consequences

One branch for "no", one success shape per route, a discriminator that behaves
alike in every language, and nothing in an agent's view to leak. A new code
costs a step: it enters the dictionary and the retry table first.

Rejected: per-route shapes documented well — documentation does not shrink a
surface. A vocabulary closed on the wire — an error nobody anticipated must
reach the reader in its own words, and every new code would move the version.
Success marked by a key's presence, for the traps above. Refusals thrown as
exceptions — the failure branch of a money call must be unskippable in the
types. A purchase response of its own — two shapes for one fact drift apart,
and the agent that bought and the one that polls would read different orders.
