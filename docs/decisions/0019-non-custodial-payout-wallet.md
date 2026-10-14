# 0019. The merchant's share arrives at their own wallet, through their split

Date: 2026-08-28
Status: accepted (the product owner, 2026-09-24 and 2026-09-25; the split,
2026-10-14); the write left `/v0` with the dashboard's key
(`docs/research/35-one-process.md`), 2026-10-09

## Context

An x402 payment settles on the chain to the `payTo` its request names, the
merchant's split, which pays the merchant's share only to the wallet written
into it (ADR-0037). Whose wallet that is decides whether this is a payments
business or a catalogue (`docs/research/07-custody-spectrum.md`), and changing
it redirects money, so the threat to it is a dashboard session not the owner's.

## Decision

Payments are non-custodial: a payment request pays the split of the merchant
who published the card, as recorded for their wallet in force when the request
is written (ADR-0037, ADR-0038), and a verified payment settles where it was
verified.
The wallet is a column on the merchant, held to `EvmAddressSchema`: `0x` and
forty hexadecimal characters, in lower case or the exact EIP-55 spelling a
wallet shows, refused in between, because a typo is somebody else's valid
address and the checksum is the only warning. It is written checksummed, which
a person can check by eye (ADR-0017); a row holding it in lower case is the
same wallet, paid through the same split. Outside the sandbox
(ADR-0026 §5) a merchant without one cannot publish (`no_payout_wallet`). It is
changed, never removed: the pause ends sales. Saving it on the screen that
names the commission is consent to the commission. The wire keeps
`payout_wallet` as it is, meaning where the merchant's share arrives, and tells
merchant code neither the split nor the commission.

Any key of the merchant's reads it at `GET /v0/payout-wallet`; only a person
signed in to the dashboard writes it, with its split, by a call inside the
process the two share (`docs/research/35-one-process.md`). No route writes it,
so no key can, the first address included, and no terminal command writes it,
so the gateway sees every change.

On the live deployment (ADR-0020) the first address, replacing nothing, applies
at once and is announced afterwards. A replacement is announced first, answered
as pending, and applies, with its split, forty-eight hours after every message
is handed over; asking again for it is a safe retry, another address restarts
the wait, and the current one cancels it. None of this moves `CONTRACT_VERSION`
(ADR-0006 §2). Elsewhere a change applies at once, unannounced.

The gateway announces through the dashboard's teller in their shared process
(`docs/research/35-one-process.md`), never through the scanner's route
(ADR-0026), which can end sessions. Unless a message to every account naming
the merchant is handed to the mail provider within twenty seconds, nothing is
written: the change is refused as nobody to tell, or as not announced, whose
words say some messages may have gone out. A conditional write, not a lock held
across the mail, refuses one overtaken meanwhile, in words that say whether its
own message went out. The dashboard words these refusals, on the one screen
that asks, and they carry no published code. This reverses ADR-0013 on purpose:
a change nobody was told of is the dangerous failure, and a message about one
that did not land is the safe one, since every message says the change applies
only if the wallet screen shows it.

The message names the wallet and the split buyers will pay into, and says what
changes, the earliest moment it can apply and that it was asked for in the
dashboard from a session signed in as which account, naming no person, since
the gateway knows the account and not who holds the session; it links to the
wallet screen without a token. A cancel there ends every session of every
account naming the merchant but the one that pressed, and, moving money nowhere
new, is announced afterwards and never refused. So is a key issued for the
merchant's own code, its message naming who asked: the account a dashboard
session was signed in as, or the key a call was made with.

## Consequences

Agentify cannot move the merchant's money, and the money waits in the split
until somebody, the merchant included, sends a payout (ADR-0037). The gateway
keeps no ledger, only a registry of the splits it named, and runs no payout
job; the operator sends one over every split by hand. The merchant checks the
wallet by eye but not the split, whose recipients a block explorer shows from
its first payout. The checksum's Keccak-256 is hand-written in the contracts
package, whose published tree is `zod` alone (ADR-0003 §1); the split's address
is a second need for a hash, met in the gateway, outside that tree, by an
audited library. A replacement costs two days of sales to the old wallet's
split. An intruding session can ask again after each cancel, or set a first
address; the owner answers with the immediate pause, signing out other devices
(ADR-0026 §3) and the cancel, all of which hold only while the mailbox is
theirs (ADR-0026 §1). A replacement waits on the mail provider, and a merchant
no account names, such as the one every database starts with (ADR-0010),
cannot have its wallet replaced.

Rejected: one address per deployment, which is custody; an address per card,
fifty chances for one to be wrong; defaulting to the configured
`PAY_TO_ADDRESS`, silent and irreversible on a chain, so it stands in only in
the sandbox (ADR-0020); refusing the sale, not the publish, which the agent
finds before the merchant; lower case as the canon, uncheckable by eye;
normalizing on read, a parser in every reader; a mailed confirmation in place of
the wait, sent to the mailbox a session opens from; a short session, which only
narrows the window; any key setting the wallet, so a leaked key moves the money;
a field naming the split in `GET /v0/payout-wallet`, area that everyone who
reconciles payments must learn and that no merchant has asked for.
