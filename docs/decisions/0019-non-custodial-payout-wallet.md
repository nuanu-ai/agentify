# 0019. The money goes straight to the merchant's own wallet

Date: 2026-08-28
Status: accepted (the product owner, 2026-09-24, on the wait before a change,
as the way the money is protected; on the message, which is required and
announces every change whichever way it is made, since to the gateway every
change is the same API call; on where the wait holds, on production only;
2026-09-25, on the dashboard alone setting it; 2026-10-09, the write leaves
`/v0` with the dashboard's key, ADR-0030)

## Context

Until now every payment request this gateway wrote named one address:
`PAY_TO_ADDRESS`, out of the deployment's configuration. That was
survivable while the operator was the only merchant. It stopped being
survivable the moment merchants became rows somebody else registers into
(ADR-0010, ADR-0014): every sale would be paid into the operator's
wallet, and paying each merchant what they were owed would take a ledger,
a reconciliation and a promise to hold other people's money — none of
which exists, and all of which would have to.

x402 asks us to hold nothing. The buying agent signs an authorisation to
a `payTo` address and the facilitator settles it on the chain, and
nothing passes through us. So the only question is whose address goes in
that field, and the answer decides whether this is a payments business
or a catalogue.

That address is also the one setting whose change redirects money, and it
is changed in the dashboard, so the threat to it is a session that is not the
owner's: one left open on a device they no longer hold, or one somebody took.

## Decision

Payments are non-custodial. The `payTo` of every payment request is the
address of the merchant who published the card, read at the moment the
request is written — so a merchant who moves their wallet moves every
card of theirs with it, with no republishing. A payment already verified
is settled to the address it was verified against: a wallet moved
mid-sale governs the merchant's next sale, never the one whose payer has
already signed. There is no balance, no settlement run, and no moment at
which a merchant's money is ours.

The keys a merchant issues operate the shop; where its money goes is a
person's act, done on the dashboard's Settings screen. Any key of the
merchant's reads the address at `GET /v0/payout-wallet`, and only a person
signed in to the dashboard sets it, by a call inside the process the dashboard
shares with the gateway (ADR-0030). No route sets it, so no key can, the first
address included.

The address is a nullable column on the merchant, held to `EvmAddressSchema`
in the contracts: `0x`
and forty hexadecimal characters, accepted in lower case or in the exact
EIP-55 spelling a wallet shows, refused in between. A mistyped address is
not a malformed one — it is another perfectly good address belonging to
somebody else — so the checksum is the only warning anybody gets, and it
is read where the merchant can still be told.

Two spellings at the door, one behind it (ADR-0017), and the canon is
the wallet's: what is stored, answered with and put in a payment request
is the checksummed form, written by `checksummedAddressOf`. The reason is
the person rather than the storage. A merchant pastes forty characters
out of their wallet and later reads them back on a settings screen;
handed the same address in lower case they cannot tell it from a
different address without going character by character, and nobody does
that. On the one field money is sent to, that glance is the whole of the
checking anybody performs.

A merchant with no address cannot publish wherever a payment settles,
which is every surface but the sandbox (ADR-0026 §5): the publish call
refuses with `no_payout_wallet` beside any other finding, because a card
with nowhere for its money to go is a product offered for sale that
cannot be bought honestly. An address is changed, never taken away — taking it
away would put every published card off sale under the name of editing
a setting, and the act somebody reaching for that wants is the pause.

The first address a merchant sets applies at once, or a new merchant could
not start selling; it replaces nothing, so no money that was going somewhere
starts going somewhere else, and it is announced once it applies, the way a
new key is. Replacing it takes
effect forty-eight hours after the change is announced, and until then payment requests
name the address that applies now. Asking again for the address already
pending changes nothing, sends no new message and restarts no clock, and
answers with the pending change, so a retry after a dropped connection
stays safe; only a different address replaces a pending change and starts
the forty-eight hours again, and asking for the address that applies now
cancels the pending one. Setting and reading the wallet answer with the
pending address and the moment it takes effect, always present and null
when nothing is pending, so a caller that reads the old address back does
not take it for a failed write. These fields are added without moving
`CONTRACT_VERSION` (ADR-0006 §2), as the product owner agreed: no SDK worker
reads the wallet, and moving the version would stop every installed worker
for words no worker sees. The price is that a merchant's own code validating
this answer with the strict `PayoutWalletSchema` of an already-published
contracts package refuses it until that package is upgraded. A change the
gateway would not record is refused in the dashboard's words, on the one
screen that asks, and carries no published code.

No replacement of an address already set applies unless the merchant has
been told of it, and every address set is told to them; the first is told
afterwards, for the reason above. No terminal command
writes the wallet, so every change reaches the gateway as the same call and the
gateway is the one place that sees them all. Before writing anything, the
gateway asks the dashboard, which holds the addresses, to tell every account
that names the merchant, since several accounts may name one merchant, and
the message to every one of them must be handed to the mail provider. The
two run in one process (ADR-0030), and the gateway asks by a call: the
process hands it the dashboard's way of telling. It never reaches the
scanner's route (ADR-0026), which would give the money path the power to
look up sessions and remove people. When every message has been handed over,
the gateway records the pending change, answers with it and counts the
forty-eight hours from then. Otherwise it writes nothing and refuses the
change in words that say which of two cases it met: there is nobody to tell;
or a message could not be confirmed as sent, because the provider refused
one or the telling failed or did not finish within twenty seconds, so a
message may have gone out to some account although nothing was recorded, and
the refusal does not read as "not sent". Changes
for one merchant are serialized without a lock held across the announcement,
which is a call to a mail provider: a change is recorded only where the
wallet still stands as it was read before its message went out, and one that
another change overtook meanwhile is refused in words of its own, a third
refusal, which says a message went out only when this change's own did. A
change that finds the wallet already holding exactly what it asked for, a
retry that overtook its own first attempt, is answered with it instead. So nothing recorded is ever written over by a change announced
beside it, and the one that loses — which may be the one announced last — is
refused, its message saying, like every message, that it applies only if the
wallet screen shows it.

This runs the effect before the state, the reverse of ADR-0013, and on
purpose: a change nobody was told about is the dangerous failure, while a
message about a change that then did not land is the safe one, because
every message says the change takes effect only if the dashboard's wallet
screen shows it.

The message says what changes, when — not before a moment it names, since
the forty-eight hours are counted from after it is handed over, while the
wallet screen shows the exact one — and that it was asked for in the
dashboard, from a session signed in as which account: the gateway knows the
account, not who holds the session, so the message names no person. It links
plainly
to the dashboard's wallet screen, a named dashboard screen that an ordinary
sign-in reaches when the person is signed out; the message carries no
token. That screen shows the pending change with a cancel control, a
same-origin POST by a signed-in person. The dashboard cancels by asking the
gateway for the address that applies now, which is what cancelling is, and
on success ends every session of every account naming the merchant except
the one that pressed. A cancel is never refused for want of a message,
because it moves money nowhere new: it is announced the way a new key is,
and a failed announcement refuses nothing. Every change comes from a
session, which is why the cancel ends the others.

The same call announces a key the merchant issues for their own code, but
the key never waits on its message: if there is nobody to tell or the
message cannot be handed over, the key is issued all the same. A key moves
no money and cannot set the wallet, and a merchant must not be kept from a
key, their first above all,
because mail is down. A new key's message names who asked: the account a
dashboard session was signed in as, or the key a call was made with. No
command at a server's terminal issues a key (ADR-0014), so every key is issued
through the gateway's keys route or from the dashboard, and announced as
above, the laptop sandbox's seed aside.
The pause stays immediate, because it is the act for "stop selling now".

The wait and the messages hold on a live deployment, the one whose chain
makes the money real (ADR-0020). A test deployment and the sandbox apply a
change at once and announce nothing: no real money moves on either, and
forty-eight hours would only stall an integrator's testing.

The sandbox asks for none. It settles against nothing (ADR-0008), so the
configured `PAY_TO_ADDRESS` stands in as the placeholder a challenge has
to name. It stands in nowhere else: on every deployment that settles on a
chain, test or live, a merchant with no address is refused rather than
defaulted, because that address is the operator's.

## Consequences

What this buys: the gateway never holds anyone's money, so it needs no
custody, no ledger and no payout run, and a merchant is paid the instant
a buyer's agent settles. What it costs: a merchant has one more thing to
set before they can sell, and the checksum needs a hash — Keccak-256,
written out in `packages/contracts/src/evm-address.ts` rather than
installed, because the published contracts tree is `zod` alone and a
package in it is its own decision (ADR-0003 §8). The trigger to replace
it with an audited library is the first other thing in that package that
needs a hash.

The wait costs a merchant who replaces a wallet in earnest two days in
which sales are still paid to the old one; a merchant who has lost the old
wallet pauses selling for those two days rather than be paid where they
cannot reach. A session that is not the owner's can pull against the owner:
ask again after each cancel, cancel the owner's own replacement, and so end
the owner's session. The wait and the message hold only while the owner
answers them. The answer is the pause, which is immediate, and signing out
every other device from Settings (ADR-0026 §3), which reaches the pressing
account only, where the cancel ends every session of every account naming
the merchant. It ends the pull only if the intruder cannot sign in again:
the message and every sign-in link go to the same mailbox (ADR-0009), so it
holds only while that mailbox is the owner's. Such a session, open before any
address is set, can still set the first one,
which applies at once; the owner learns of it from the message that follows,
when mail works, or from the wallet screen, and replacing it waits like any
other change, so they stop selling until it does. A merchant no account names
has nobody to tell, so every replacement of its wallet is refused. A merchant is
made only by a signed-in person's press (ADR-0014), so that is the litter of a
press whose dashboard failed after the gateway answered, which no account names,
or the merchant every database is created with (ADR-0010), for which no
deployed channel seeds a key and nobody can ask for live approval. A test
deployment never shows a pending change, so an integrator meets that shape
only on production. A wallet change also depends on the mail provider being
up, which is accepted: changes are rare, and a refusal
at the door is honest where a silent change is not.

Rejected: one address per deployment, kept as it was — custody with
extra steps, and the reconciliation it implies is a product nobody has
decided to build. An address per card — a merchant with fifty products
is paid at one address, and fifty copies are forty-nine chances for one
to be somebody else's. Falling back to the configured address for a
merchant who has set none — the failure is silent, on a chain, and
irreversible. Refusing the sale rather than the publish — the merchant
finds out at the till, and the agent finds out instead of them. Lower
case as the canon — cheaper to compute and impossible to check by eye,
which trades the one safeguard a person has for nothing. Storing what
was sent and normalizing on read — every reader becomes a parser, and
the one that misses serves the second spelling (ADR-0017). A confirmation
by mail in place of the wait (the product owner keeps the wait in any
case) — it goes to the mailbox a session opens from (ADR-0009). A short
session in place of it — it narrows the window without closing it. Any key
of the merchant's setting the wallet — every copy of a key could redirect
the takings, held back only by an owner answering each message in time.
