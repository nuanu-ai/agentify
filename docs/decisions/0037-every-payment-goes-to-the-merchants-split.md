# 0037. Every payment goes to the merchant's split, which nobody owns

Date: 2026-10-14
Status: accepted (the product owner, 2026-10-14: a commission on every
payment, payouts by hand, a Safe for the commission). Not built yet; at its
release the wallets already set move to their splits unannounced, since
nobody sells on the live channel.

## Context

Agentify takes a commission on every payment, since without one the project has
nothing to live on, and never holds a merchant's money (ADR-0019). In the
`exact` scheme of x402, the HTTP payment protocol, a facilitator, the service
that settles a payment, sends a transfer of USDC, Circle's dollar stablecoin,
signed by the buyer to the request's `payTo`. No code runs there as the money
arrives, so a contract at that address can divide it only in a later call
(`docs/research/38-service-commission.md`).

## Decision

`payTo` is the merchant's split, a PullSplit of 0xSplits v2.2: a contract that
keeps the USDC paid into it until a distribution credits each share in the
shared 0xSplits warehouse, from which a withdrawal pays that recipient alone.
PullSplitFactory v2.2 `0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1` clones it
from the implementation `0x98254AeDb6B2c30b70483064367f0BA24ca86244`, with the
warehouse `0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8`, each at the same
address on Base (chain 8453) and on Base Sepolia (84532). The word audited
covers v2.0 alone. The one public audit of v2, Zach Obront's review of February
2024, read v2.0, whose warehouse is the instance still in use; v2.1 and v2.2
changed the split and the factory with no public audit, under Splits' bounty
programme alone. v2.2 is taken because the 0xSplits SDK creates it, and
creating an existing split returns it instead of failing.

With no owner (`address(0)`), nobody, Agentify and Splits included, can change
the split's recipients or allocations, pause it, or make it call anything; an
owner could, and so take what it holds. It pulls rather than pushes, because
Circle can block any address from sending or receiving USDC: a PushSplit pays
every share at once and fails whole when one transfer does, so a block on the
commission wallet would stop every merchant's payout, while in the warehouse a
blocked recipient stops only its own withdrawal. Its distribution incentive, a
cut for whoever sends the distribution, is zero.

The recipients are the merchant's payout wallet and then the commission wallet,
with allocations `1000000 − rate` and `rate` of `1000000`. The rate, 1000
(0.1%), and each network's commission wallet are constants in the gateway's code,
and the gateway does not start for a network without one: both enter every
split's address, so a change moves every merchant's money to new addresses at
once, which a setting on the host would allow without review. On Base the
commission wallet is a Safe, a contract wallet whose signers change while its
address does not, so a lost or added key leaves every split as it is.

The address is computed offline, since CREATE2, the deployment the factory
uses, fixes it from the factory, the code, the parameters and a salt. The salt
hashes a fixed label; the chain id, since with the factory at one address on
both networks a test split would otherwise be an address on Base too; and the
merchant's identifier, which parts two merchants with one wallet. With no
ordinal in it, the same merchant and wallet always give the same split.

A registry table records every split ever named as a payment address, with all
its parameters: address, merchant, network, both wallets, rate, salt, factory
and when it was written. A row is written in the database transaction that
writes its wallet, a first one or a pending replacement, and is never changed
or deleted, because until a split's first payout its parameters exist nowhere
else, and without them nobody can deploy it or divide what it holds. `payTo` is
read from the row of the merchant's wallet in force and never recomputed from
the constants, since after a change to one the recomputed address would have no
row. Until a change of rate is designed, the gateway refuses to start while its
constants disagree with the rows of the current wallets.

A payout is one transaction anybody may send, the merchant included, for gas
alone: a batch through Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`,
a public contract that runs several calls at once, which creates the split if
it has no code, distributes its USDC and withdraws the merchant's share. The
dashboard shows each merchant theirs; the operator sends one over every split
of a network, with the commission's withdrawal, by hand. Agentify holds no key,
writes to no chain and reads no node.

## Consequences

Agentify cannot move a merchant's money, and the money waits in a contract
nobody owns until somebody pays it out, which a payout transaction the merchant
kept can do even after Agentify is gone. Buyers pay a split before it has code:
both facilitators did on Base Sepolia
(`docs/research/39-commission-split-experiment.md`), none yet on Base, and the
pre-registered check of `docs/research/47-commission-in-the-product.md` must
pass before the live channel sells into a split. The first payout puts each
merchant's rate and the tie between their wallet and ours on the public chain.
A new rate or commission wallet is a new split for every merchant and is not
designed; the startup refusal stands in. Unwithdrawn shares sit in a warehouse
every 0xSplits user shares, and a block on it would freeze them for good.

Rejected: a PushSplit, which one blocked address stops for all; an owner,
custody if it is Agentify and no commission if it is the merchant; the atomic
division of the `auth-capture` scheme, which no facilitator offers and which
would make Agentify the facilitator, against ADR-0020; OpenZeppelin's
PaymentSplitter, whose token path no outside audit read, which its library
dropped, and which Agentify would deploy per wallet before it could be paid;
deploying a split when its wallet is saved, which takes a key of ours; a
distributor job with a hot key, set aside by the product owner for payouts by
hand, since it brings a secret and stops silently when its gas runs out, and
which may return, sending the same transaction, once one person's batch no
longer serves every split; the rate or wallet in configuration, the knob above;
an ordinal in the salt, which would give a merchant back on an old wallet a
second split and leave no address computable from its parameters alone.
