# Self-service and administrative decisions

2026-10-19. Product direction and implementation inventory.

Agentify has no staffed service that watches purchases, reconciles payments or
contacts merchants about overdue delivery. The product owner's explicit human
approval is admission of a merchant to sales for real money. Administrative
access is a permission on an account, not a promise of an employee handling
orders. Maintenance tools can exist without being a required step in a sale.

## What belongs where

| Operation | Who acts | What establishes the result | Current implementation |
| --- | --- | --- | --- |
| Admission to real sales | An administrator | Explicit approval of an identified merchant | Admin screen linked from `/admin`; the same idempotent grant is available at the terminal |
| Registration, keys, seller details, pause and resume | The merchant | Their authenticated account and existing selling checks | Dashboard and relevant SDK operations |
| Payout | The merchant or anyone sending the immutable split's payout | The contract's fixed recipients; wallet confirmation authorizes the transaction | Merchant payout screen; no Agentify signer |
| Test purchase | The merchant's buyer or agent | An actual test-channel purchase and delivery | Purchase protocol and internal buyer exist; a ready-to-use merchant test buyer is missing |
| Full offboarding | The merchant | Accepted orders and refund debts remain accounted for; deletion is explicit | Pause and key revocation exist; complete offboarding is missing |
| Late delivery | The merchant's integration | The order's delivery rules | SDK and WooCommerce worker; a recorded refund refuses delivery |
| Refund | The merchant, with system verification | Evidence of the full transfer to the original payer and protection against concurrent delivery | Recording, payer view and concurrency protection are missing; ADR-0028 |
| Silent payment | Automatic reconciliation, with evidence supplied if needed | Proof bound to the original payment attempt | Status is honest and a second settle is forbidden; verified recovery is missing; ADR-0027 |
| WooCommerce recovery | The merchant, with system checks | The original shop and sale match exactly; an uncertain creation is never repeated blindly | Maintenance command exists; authenticated merchant screen is missing; ADR-0023 |

## First change

The admin screen finds a merchant through the account's normalized email,
shows their name and identifier, and asks for explicit confirmation before
admission to real sales. It requires the account's administrative flag on every
request. It grants nothing on a test channel, creates no merchant, and changes
neither orders nor wallet balances. Other publication and purchase guards
remain in force, including the live restriction on WooCommerce and parcels.
A lost write response is shown as unknown; reading the merchant again recovers
the status, and a repeated approval preserves the original approval time.

## Remaining work in order

The first payment change is the refund flow. A design must cover the moment
before a wallet transfer, a late delivery racing it, a submitted transaction
whose result cannot be read, and recovery after a browser or process restart.
Verification must bind the exact network, token, original payer, whole price
and sale; one transfer cannot discharge several debts. Transferring first and
reporting a hash afterwards leaves the double-outcome race open. Unknown payer
must remain an explicit limitation rather than an editable recipient guessed
by the merchant. These checks are not implemented by the admin approval screen.

Silent charges need a separate proof of the original authorization's outcome;
a generic transfer matching an amount and address is not enough. This work must
preserve the prohibition on a second charge. Neither merchant nor admin gets
a button that asserts success, failure or refund without evidence.

WooCommerce recovery can reuse its existing sale checks behind a merchant
account gate. The owner must be checked before reading a recovery record or
calling a shop. An uncertain create can bind an exact shop order after checking
its contents; it cannot search by guess or make a fresh order. Parcel recovery
continues to respect address erasure and the live-channel gates.

The test buyer should let a merchant exercise their own product without staff
or a shared funded wallet. The payment remains a test-chain payment from a
wallet the buyer controls; the screen must not call a mocked payment a test
sale. Choosing its packaging and the acquisition of test funds is still open.

Full offboarding also needs a self-service path. Pausing sales and revoking
keys are available; neither cancels accepted orders, settles debts or deletes
an account. A merchant must not be sent to a nonexistent support process to
finish leaving.

The public documentation states these gaps. It promises neither scheduled
manual intervention nor an Agentify-funded refund. An open item here is not a
claim that self-service exists.
