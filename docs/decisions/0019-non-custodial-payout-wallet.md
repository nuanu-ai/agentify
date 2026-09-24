# 0019. The money goes straight to the merchant's own wallet

Date: 2026-08-28
Status: accepted (Dmitry, 2026-09-24, on the wait before a change: "деньги
защищать нужно другим способом (cooldown например)"; on the message: "думаю что
обязательно. для gateway же не должно быть разницы как сменили. это api вызов";
on where the wait holds: "да, только prod")

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

That address is also the one setting whose change redirects money, and any
key of the merchant's reaches it — the cabinet's, or one that lives in the
merchant's own server environment — so a guard on a change has to hold
however the caller got in.

## Decision

Payments are non-custodial. The `payTo` of every payment request is the
address of the merchant who published the card, read at the moment the
request is written — so a merchant who moves their wallet moves every
card of theirs with it, with no republishing. A payment already verified
is settled to the address it was verified against: a wallet moved
mid-sale governs the merchant's next sale, never the one whose payer has
already signed. There is no balance, no settlement run, and no moment at
which a merchant's money is ours.

The address is a nullable column on the merchant, set and read through
`/v0/payout-wallet`, held to `EvmAddressSchema` in the contracts: `0x`
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

A merchant with no address cannot publish: the publish call refuses with
`no_payout_wallet` beside `no_seller_name`, because a card with nowhere
for its money to go is a product offered for sale that cannot be bought
honestly. An address is changed, never taken away — taking it
away would put every published card off sale under the name of editing
a setting, and the act somebody reaching for that wants is the pause.

The first address a merchant sets applies at once, or a new merchant could
not start selling. Replacing it takes effect forty-eight hours after the
change is announced, whichever key asks, and until then payment requests
name the address that applies now. A change asked for while another is
pending replaces it and starts the forty-eight hours again, and asking for
the address that applies now cancels the pending one. Setting and reading
the wallet answer with the pending address and the moment it takes effect,
always present and null when nothing is pending, so a caller that reads
the old address back does not take it for a failed write. These fields are
added without moving `CONTRACT_VERSION` (ADR-0006 §2; Dmitry: "не надо
поднимать согласен"): the published SDK never reads this answer, and
moving the version would stop every installed worker for a field no worker
sees. The price is that a merchant's own code validating this answer with
the strict `PayoutWalletSchema` of an already-published contracts package
refuses it until that package is upgraded.

No wallet change applies unless the merchant has been told of it. The
wallet is set only through `/v0/payout-wallet`, and no terminal command
writes it, so every change reaches the gateway as the same call and the
gateway is the one place that sees them all. Before writing anything, the
gateway asks the cabinet, which holds the addresses, to tell every account
that names the merchant, since several accounts may name one merchant. It
asks over an internal route on the cabinet, reachable only on the compose
network and authenticated by a secret the two processes share, as the
scanner's route is (ADR-0026). If the message has been handed to the mail
provider, the gateway records the pending change, answers with it and
counts the forty-eight hours from then. If there is nobody to tell, or the
message could not be handed over, the gateway refuses the change in words
that say which and writes nothing, so a retry is safe.

The message says what changes, when and which key asked. Its cancel
control is a one-time link built as the sign-in link is (ADR-0026 §1),
landing on a page with one control so that a mail preview cannot cancel a
change somebody meant. Pressing it cancels the change, ends every session
of every account naming the merchant, and signs this browser in afresh. It
disables no key (Dmitry: "перебор. отключить могли по ошибке"): the
message names the key that asked, so a person who does not recognise it
disables it in the cabinet.

The same route announces a key the merchant issues for their own code, but
the key never waits on its message: if there is nobody to tell or the
message cannot be handed over, the key is issued all the same. A key moves
no money, any wallet change made with it is itself announced and waited
on, and a merchant must not be kept from a key, their first above all,
because mail is down. The cabinet's own key, renewed daily (ADR-0014 §2),
is announced to nobody. The pause stays immediate, because it is the act
for "stop selling now".

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
cannot reach. A leaked key can ask again after every cancel: the wait and
the message hold as long as the owner answers them, and the lasting remedy
is disabling the key. A wallet change also depends on the cabinet and the
mail provider being up, which is accepted: changes are rare, and a refusal
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
the one that misses serves the second spelling (ADR-0017). A fresh
confirmation in the cabinet, or a short session, in place of the wait —
either guards the cabinet alone and leaves the merchant's own keys, which
reach the same route, unguarded.
