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

The complete offline suite passes 7,398 tests in 380 files; the operations suite
passes 14 tests. Type checking, formatting, dead-code checks, decision and
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
was not simulated. This run does not establish acceptance on the remote TEST
channel or compatibility with every external wallet.

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
already paid order without another charge. The regression and a separate Node
run both lose the paid response and recover the same order after restart.
