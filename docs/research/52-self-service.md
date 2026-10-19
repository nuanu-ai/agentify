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
| Refund | The merchant's system executes; Agentify verifies | Evidence of the full transfer to the original payer and coordination with Agentify's delivery | Recording, payer view and concurrency protection are missing; ADR-0028 |
| Silent payment | Automatic reconciliation, with evidence supplied if needed | Proof bound to the original payment attempt | Status is honest and a second settle is forbidden; verified recovery is missing; ADR-0027 |
| WooCommerce recovery | The merchant, with system checks | The original shop and sale match exactly; an uncertain creation is never repeated blindly | Authenticated page from the merchant's Orders links an existing download order or retries its saved delivery; no shop creation action; ADR-0023 |

## The shop's responsibility

The merchant owns stock, fulfillment and the policy for cancellations and
refunds. Obligations on accepted Agentify sales still hold, including the whole
price when a refund is owed. The connector validates the shop's evidence and
translates it into Agentify's existing purchase and delivery contracts. The
recovery action attaches the exact existing shop order to its sale; it does
not create a shop order again or decide what the shop should do. This applies
the connector boundary in ADR-0023 and the unchanged public contract and SDK in
ADR-0036: WooCommerce-specific rules do not become business decisions in
Agentify's core or SDK.

The merchant's system decides and executes refunds, including stopping its own
fulfillment. Agentify is responsible for reliable debt and payment facts,
repayment verification, recording the result and coordinating its own delivery.
The dashboard is for showing the debt, verified result or unresolved outcome;
verified refund recording is still missing. The merchant's returns workflow
and payment execution belong in their system. A WooCommerce order marked
refunded does not establish that the original payer received USDC.

## Admission to real sales

The admin screen finds a merchant through the account's normalized email,
shows their name and identifier, and asks for explicit confirmation before
admission to real sales. It requires the account's administrative flag on every
request. It grants nothing on a test channel, creates no merchant, and changes
neither orders nor wallet balances. Other publication and purchase guards
remain in force, including the live restriction on WooCommerce and parcels.
A lost write response is shown as unknown; reading the merchant again recovers
the status, and a repeated approval preserves the original approval time.

## WooCommerce recovery

The merchant opens an authenticated recovery page from their own Orders. The
owner is checked before recovery details are disclosed or the shop is called.
For a download whose shop-order creation is uncertain (`create_unknown`), the
merchant supplies the exact existing WooCommerce order ID. The connector uses
the shared sale and product checks before binding that order and attempting
delivery. The page offers no shop creation action. Parcels and refusals before
shop creation are unavailable here; address erasure and live-channel gates
remain in force.

A recorded shop order and delivery (`placed`) can retry the saved delivery
after the shop is disconnected or the merchant switches to their own SDK
integration. An unknown delivery result retains the shop-order binding and
remains unresolved. Confirmed delivery removes the action. These operations
reuse the connector's existing contracts and add no shop-specific core or SDK
states.

## Remaining work

Verified refund recording needs a complete integration design under ADR-0028.
It must bind the original payer, sale's network and token, whole price and
unique evidence to that sale. Unknown payer and unavailable evidence remain
unresolved. A merchant or shop status cannot substitute for payment evidence.

The gateway keeps the verified payer, the original payment payload and the
facilitator's settlement transaction. Where the facilitator named no payer,
the stored owner is a payment fingerprint, not an address to refund. The saved
x402 version 2 payload can carry the sale's network, token and amount: these
were checked against the gateway's own requirements at verification. A refund
must validate that saved context against the order and the original settlement;
it cannot infer old terms from today's deployment settings. Missing or
inconsistent evidence makes a sale ineligible until its payment is established.

A reservation must precede the merchant's repayment and durably block Agentify
from releasing or recording late goods. It cannot cancel an already-running
merchant handler, a shop email or other external fulfillment in flight. A lost
transfer response and a restart need recoverable evidence; accepting a hash
afterwards does not justify another debit or resolve concurrent delivery.

A plain transfer matching sender, recipient and amount proves movement, but
does not identify the refund it was intended for. Verification needs an exact
successful transfer, a defined finality rule and permanent evidence uniqueness
across orders and merchants, committed atomically with the recorded outcome.
The existing payment claims are swept by age, and the gateway has no chain
reader. Both gaps remain. An unavailable network or a timeout establishes
neither repayment nor permission to restore Agentify's delivery.

USDC's EIP-3009 authorization is one possible evidence protocol for a merchant
integration: its signed sender, recipient, amount, validity and one-use nonce
could bind an attempt to a sale and support safe resubmission. Installed
libraries contain its types for Base and Base Sepolia, but this protocol is
unchosen and unimplemented. No refund wallet journey in Agentify's dashboard
follows from that possibility ([EIP-3009](https://eips.ethereum.org/EIPS/eip-3009)).

Silent charges need a separate proof of the original authorization's outcome;
a generic transfer matching an amount and address is not enough. This work must
preserve the prohibition on a second charge. Neither merchant nor admin gets
a button that asserts success, failure or refund without evidence.

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
