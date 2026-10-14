# 0037. Every payment goes to the merchant's split, which nobody owns

Date: 2026-10-14
Status: accepted (the product owner, 2026-10-14: a commission on every
payment, payouts by hand, a Safe for the commission). Built, not yet released;
at its release the wallets already set move to their splits unannounced, since
nobody sells on the live channel.

## Context

Agentify takes a commission on every payment, or it has nothing to live on, and
never holds a merchant's money (ADR-0019). In x402's `exact` scheme a USDC
transfer the buyer signed goes to the request's `payTo`, and no code runs there
as it arrives, so a contract can divide it only in a later call
(`docs/research/38-service-commission.md`).

## Decision

`payTo` is the merchant's split, a PullSplit of 0xSplits v2.2, which keeps the
USDC paid into it until a distribution credits each share in the shared 0xSplits
warehouse, from which a withdrawal pays that recipient alone. PullSplitFactory
v2.2 `0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1` clones it from
`0x98254AeDb6B2c30b70483064367f0BA24ca86244`, with the warehouse
`0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8`, at the same addresses on Base
(8453) and Base Sepolia (84532). The one public audit of v2 read v2.0, whose
warehouse is still the one in use; v2.2 is taken unaudited, under Splits' bounty
programme, because the 0xSplits SDK creates it and creating an existing split
returns it instead of failing. With no owner (`address(0)`) nobody, Agentify
and Splits included, can change its recipients or shares, pause it or make it
call anything. It pulls rather than pushes because Circle can block any address
from USDC, and a push fails whole on one blocked recipient while a pull stops
only that recipient's withdrawal. The distribution incentive is zero.

The recipients are the merchant's payout wallet and then the commission wallet,
with allocations `1000000 − rate` and `rate` of `1000000`. The rate, 1000
(0.1%), and each network's commission wallet are constants in the gateway's
code, and it does not start for a network without one: both enter every split's
address, so a change moves every merchant's money to new addresses, which a
setting on the host would allow without review. On Base the commission wallet is
a Safe, whose signers change while its address does not. The address is computed
offline from the factory's CREATE2, with a salt hashing a fixed label, the chain
id, which parts the two networks, and the merchant's identifier, which parts two
merchants with one wallet; with no ordinal, a merchant and wallet always give
the same split. Every split named as a payment address is recorded as ADR-0038
says.

A payout is one transaction anybody may send, the merchant included, for gas
alone: a batch through Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`
that creates each split with no code yet, distributes its USDC and withdraws the
merchant's share, over every split that can hold money. Agentify holds no key,
writes to no chain and reads no node.

## Consequences

Agentify cannot move a merchant's money, which waits in a contract nobody owns
until somebody pays it out, even after Agentify is gone. Buyers pay a split
before it has code, as both facilitators did on Base Sepolia
(`docs/research/39-commission-split-experiment.md`); the check of
`docs/research/47-commission-in-the-product.md` must pass on Base before the
live channel sells into one. A payout puts the rate and the tie between the
merchant's wallet and ours on the public chain. A new rate or commission wallet
is a new split for every merchant and is not designed, and a block on the shared
warehouse would freeze every unwithdrawn share.

Rejected: a PushSplit, which one blocked address stops for all; an owner,
custody if it is Agentify and no commission if it is the merchant; `auth-capture`
division, which no facilitator offers and which would make Agentify the
facilitator, against ADR-0020; OpenZeppelin's PaymentSplitter, whose token path
no outside audit read and which Agentify would deploy per wallet; deploying a
split when its wallet is saved, or a distributor job, each of which takes a key
of ours; the rate or wallet in configuration; an ordinal in the salt, which
would give a merchant back on an old wallet a second split.
