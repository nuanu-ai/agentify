# Recovering a purchase from the quickstart buyer

Date: 2026-10-27. The product owner selects the example-only fix for the
lost-response finding. The gateway and ADR-0011 retain their recovery contract.

The buyer keeps the original payment requirements before signing or sending
payment. A saved file identifies one purchase. The default is `purchase.json`;
running with another filename starts another purchase and keeps the first file.
The record binds the site, product, wallet, request body and spending limit.
After an order answer arrives it also keeps the private status address. A
restart reads that address, or signs the saved requirements again if the
address has not arrived. It makes no new request for a price on that path.

The journal is written through a private temporary file. Publishing the first
record refuses to replace an existing purchase. Updates replace the whole
record atomically. File contents and the containing directory are flushed
before payment; resumed runs check both again. Existing file permissions are
corrected to 0600 before use. A damaged file, changed purchase identity or
storage failure stops the program. Unknown payment outcomes and expired prices
never trigger an automatic new purchase.

The buyer-created-key alternative remains in
[its consequence map](2026-10-27-buyer-key-impact-map.md). It changes who can
open an order, requires a rule for forgotten keys and needs a transition for
existing purchases whose buyers do not know their server-generated keys.
The number of rows in that map is not an implementation estimate. Failure
frequency was not measured. The reported example failure can be corrected
within the existing contract, so the product owner defers the broader change.

## Verification

The regression first fails against the original example. The updated program
is exercised as a child process on Node 24.22.1 with a gateway over loopback
HTTP and a merchant on the SDK. Tests cover loss of a successful paid answer
followed by restart, a known order whose card leaves the catalogue, simultaneous
runs, separate files for separate purchases, storage refusal, damaged state,
changed wallet/site/product, an unknown charge, an expired price and permissions
on an existing file.

After integrating main, the complete offline suite passes 7,411 tests in 380
files; the operations suite passes 14 tests. The complete database suite passes
583 tests in 26 files on a disposable PostgreSQL 17 instance. Both migrations
apply in sequence: main's order index is 0032 and worker contact is 0033.
Type checking, formatting, dead-code checks, decision and
retired-claim checks pass. The portal build confirms that the rendered
quickstart includes the program tested from disk.

A separate Node run uses the documented command from a temporary directory,
without the test preload. A loopback proxy drops the first paid HTTP response
after the gateway answers it. Restart returns the same order with one
settlement call, one merchant delivery and no second price request. A further
run reads the saved status address. A different filename produces a second
purchase while preserving the first journal. The gateway uses its memory
adapters and scripted facilitator with the existing eSIM demo card; no chain
or external merchant is contacted.

Four hand mutations are killed: removing the prepayment save, ignoring the
saved purchase, leaving an existing file readable, and skipping directory
flushes. All apply, none survive, and the source is restored byte for byte.
The affected scenarios pass again after restoration. Separate purchase files
are the negative control: an intentional second purchase still works.

The independent review finds a missing directory flush in an intermediate
implementation. The fix adds it before payment and on resume, with a storage
failure test. The second review has no actionable finding. Host power loss
was not simulated. External wallet integrations are outside this check.

## Remote TEST acceptance

With the product owner's permission, `deploy-test` moves to
`90a445c68ad6a8c9f5481678b97be0e592ee6983`. CI and Images pass on that
commit. The host verifies the release, both migrations apply, and all six
existing public cards remain available with a Base Sepolia payment challenge.

A separate test merchant uses the SDK from this branch. Its initial identity,
key and payout wallet are created through internal test setup, so this run
does not test merchant signup or installation from npm. The merchant publishes
the existing gift-message text file at 0.01 test USDC with asynchronous delivery.
Before its worker connects, the card is absent from the catalogue and purchase
returns `409 seller_not_taking_orders`, without creating an order. A poll with
no version returns 400; contract 4 receives contract 5 with no envelopes.
The compatible SDK connects and the card becomes available.

The unmodified buyer program runs through its documented Node command. A
loopback HTTP proxy routes the catalogue's purchase addresses to TEST and drops
the first paid answer after TEST reports payment. The saved file survives.
Restart returns the same order and the exact gift-message file. The buyer's
USDC balance is 4.682000 after payment and remains 4.682000 after recovery.
Another run reads the saved status address without signing. A different
filename starts a second purchase, preserves the first journal byte for byte
and brings the balance to 4.672000 from its initial 4.692000.

Both chain receipts succeed on Base Sepolia. Each contains exactly one USDC
transfer of 10,000 atomic units from the buyer to its merchant's payout split:

- Original purchase: [transaction c9ccd40b](https://sepolia.basescan.org/tx/0xc9ccd40b418f4e34e5ac90409ebe666aa641ae8d08483867f46dba1566f1f588).
- Explicit second purchase: [transaction a6505695](https://sepolia.basescan.org/tx/0xa6505695e3ae8997ffd6205950653428c1a38d6f161cae90adb9f80080f6bf19).

The total is 0.02 test USDC against a 0.05 cap. The proxy forwards three
signatures, including the recovery signature, with a combined authorized
amount of 0.03 test USDC. The merchant receives two paid orders and delivers
both. The journal is mode 0600. The test card and merchant are paused, the
worker stops, its temporary API key is disabled and the temporary buyer-key
copy is removed. All six original catalogue entries remain.

There is also one expired, unpaid attempt with `email: "string"`, matching the
Bazaar declaration's generated input. The buyer sends `you@example.com` and
makes only two unsigned purchase requests. The additional caller is not
established; identifying it as Bazaar would be an inference. It reaches no
settlement or merchant hand-over. The initial unpaid setup checks stop on a
wrong expected error code in the check script; this is corrected to the
existing `seller_not_taking_orders` response before any payment is signed.

The private local report, process logs, purchase journals and check script are
under `2026-10-27-pr211-z3bhOy` in the operator's Agentify acceptance directory.
This is bounded TEST evidence. Mainnet, third-party wallets, npm installation,
host power loss and upgrades of a remote merchant's service are untested.

## Draft reply to the report author

We confirmed that the buyer example could start another purchase after losing
a paid response. In PR #211, the example saves the original payment
requirements before sending payment and resumes that purchase after a restart.
A different filename starts another purchase and preserves the first journal.
The journal is private even when an existing file had broader permissions.

We kept the gateway's existing recovery contract. Introducing a mandatory
buyer-generated secret would also change order authorization, retry retention
and recovery for existing purchases. We deferred that change because the
reported example failure can be fixed within the current contract. The design
and consequence map are kept in research for a later decision if buyer
integrations encounter the limitations of signature-based recovery.

Recovery still requires the saved requirements and the original wallet, and it
uses a fresh payment signature when the status address was lost. It returns an
already paid order without another charge. The regression and the deployed
TEST run both lose the paid response and recover the same order after restart. On Base Sepolia, recovery leaves the
buyer balance unchanged; an explicit second purchase produces its own
0.01 test USDC transfer.
