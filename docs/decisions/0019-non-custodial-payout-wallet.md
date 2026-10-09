# 0019. The money goes straight to the merchant's own wallet

Date: 2026-08-28
Status: accepted (the product owner, 2026-09-24 and 2026-09-25)

## Context

An x402 payment settles on the chain to the `payTo` its request names, and whose
address that is decides whether this is a payments business or a catalogue
(`docs/research/07-custody-spectrum.md`). Changing that address redirects money,
so the threat to it is a dashboard session that is not the owner's.

## Decision

Payments are non-custodial: a payment request pays the address of the merchant
who published the card, read as the request is written, and a verified payment
settles where it was verified. The address is a column on the merchant, held to
`EvmAddressSchema`: `0x` and forty hexadecimal characters, in lower case or the
exact EIP-55 spelling a wallet shows, refused in between, because a typo is
somebody else's valid address and the checksum is the only warning. It is stored
and answered checksummed, which a person can check by eye (ADR-0017). Outside
the sandbox (ADR-0026 §5) a merchant without one cannot publish
(`no_payout_wallet`). It is changed, never removed: the pause ends sales.

Any key of the merchant's reads it at `/v0/payout-wallet`; only the dashboard
writes it, with its own key, from inside the stack. The public door routes no
write there, the gateway refuses a key made for the merchant's own code
(`not_a_dashboard_key`), first address included, and no terminal command writes
it, so the gateway sees every change.

On the live deployment (ADR-0020) the first address, replacing nothing, applies
at once and is announced afterwards. A replacement is announced first, answered
as pending, and applies forty-eight hours after every message is handed over;
asking again for it is a safe retry, another address restarts the wait, and the
current one cancels it. None of this moves `CONTRACT_VERSION` (ADR-0006 §2).
Elsewhere a change applies at once, unannounced.

The gateway announces through the dashboard's teller in their shared process
(ADR-0030), never through the scanner's route (ADR-0026), which can end
sessions. Unless a message to every account naming the merchant is handed to the
mail provider within twenty seconds, nothing is written: the change is refused
as `wallet_change_nobody_to_tell`, or as `wallet_change_not_announced`, which
says some messages may have gone out. A conditional write, not a lock held
across the mail, refuses one overtaken meanwhile (`wallet_change_raced`). This
reverses ADR-0013 on purpose: a change nobody was told of is the dangerous
failure, and a message about one that did not land is the safe one, since every
message says the change applies only if the wallet screen shows it.

The message says what changes, the earliest moment it can apply and that it was
asked for in the dashboard, and links to the wallet screen without a token. A
cancel there ends every session of every account naming the merchant but the one
that pressed, and, moving money nowhere new, is announced afterwards and never
refused. So is a key issued for the merchant's own code, its message naming the
key that asked; the dashboard's own key (ADR-0014 §2) is never announced.

## Consequences

The gateway holds no money, so it needs no custody, ledger or payout run. The
checksum's Keccak-256 is hand-written in the contracts package, whose published
tree is `zod` alone (ADR-0003 §8), until a second need for a hash brings an
audited library. A replacement costs two days of sales to the old wallet. An
intruding session can ask again after each cancel, or set a first address; the
owner answers with the immediate pause, signing out other devices (ADR-0026 §3)
and the cancel, all of which hold only while the mailbox is theirs (ADR-0026 §1). A
replacement waits on the mail provider, and a merchant no account names, such as
the one every database starts with (ADR-0010), cannot have its wallet replaced.

Rejected: one address per deployment, which is custody; an address per card,
fifty chances for one to be wrong; defaulting to the configured
`PAY_TO_ADDRESS`, silent and irreversible on a chain, so it stands in only in
the sandbox (ADR-0020); refusing the sale, not the publish, which the agent
finds before the merchant; lower case as the canon, uncheckable by eye;
normalizing on read, a parser in every reader; a mailed confirmation in place of
the wait, sent to the mailbox a session opens from; a short session, which only
narrows the window; any key setting the wallet, so a leaked key moves the money.
