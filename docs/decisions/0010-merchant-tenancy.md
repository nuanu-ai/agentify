# 0010. Every merchant is a row, and a key names its merchant

Date: 2026-08-27
Status: accepted (the product owner, 2026-08-27: the product is self-service)

## Context

The product is self-service: a merchant signs up with an email address, makes a
key in the dashboard, integrates against the SDK on their own and starts selling
(ADR-0014). Registration without tenancy would show the second merchant to
register the first one's cards, orders and receipts, a stranger's money on the
first screen, so tenancy comes before registration.

## Decision

A merchant is a row with an identity, and its selling switch is its own. Every
card, order, receipt and key carries its merchant, not null, so no such row
exists without an owner. The one table without a merchant records which order
claimed a payment, because an agent's single signature must not be spendable
once at each merchant.

A key is a row that names its merchant. Its secret is generated, shown once and
stored as a SHA-256 digest, and a request is resolved by looking the digest up,
which is constant-time by construction. A key carries a label, what it was made
for (ADR-0014 §5), when it was created and disabled, and its last use, written
at most once every few minutes. Disabling a key is instant and touches no other
key and no session.

Every route a merchant's key reaches acts on that key's merchant alone: the card
list, the orders, the receipts, the pause switches, the worker poll and the
answer routes. A worker draws from a queue its merchant has to themselves, since
the queue hands out work by name and a filter on a shared queue would draw a
stranger's envelope to read it, after which it is offered to nobody again.

The buying surface is one catalog across every merchant, which is the product,
and a purchase reaches the merchant whose card it was made against. The
merchant's identifier never reaches a buyer; what an agent learns about who
sells is the name and site of ADR-0034. A dashboard account names at most one
merchant, and every screen is scoped to it.

`docker compose up` brings the sandbox up selling with no manual step: every
database is created with one merchant, the laptop's gateway seeds a key for it
from the compose file, and the compose file hands the same key to the merchant
process, a sandbox value in a file like the database password beside it. A
deployed channel seeds nothing, because a merchant there comes into being only
by the one way in (ADR-0014).

## Consequences

Registration hands nobody a stranger's money. Every query of a merchant's data
carries the merchant, and one that forgets it is caught only by the store's
tests, which therefore seed two merchants and assert about both.

Rejected: a database per merchant, real isolation whose migrations, connection
pools and provisioning per tenant nothing at this scale earns, against a failure
the store's tests exist to catch; keys in the environment, one per merchant,
where every key change is a deployment, nobody can revoke one key of several and
no merchant can make a key for themselves; scoping in the dashboard alone, which
leaves the API it calls answering everything to anybody with any key, when the
gateway is the boundary both sides trust.
