# Compatible workers admit new purchases

The merchant report's F11 describes an SDK 0.9.1 worker publishing successfully
and stopping when the gateway answers in another contract. Publishing is not
proof that anybody can fulfill an order. On 27 October 2026 the product owner
approved publication before startup, with sales opening only after a compatible
worker connects. ADR-0006 records that rule.

The SDK supplies its contract version in every poll. The gateway compares it
before recording contact or drawing an envelope. A mismatched version receives
the gateway's version and no work; a missing version receives an update
instruction in the error sentence. Compatible contact is stored with its
version, so an earlier deployment's contact cannot keep sales open. Historical
connections remain visible in the operator's counts and merchant history.

This changes the poll request contract to version 5 and carries a minor
Changeset for the SDK and contracts. A production release requires the matching
SDK to be published and merchant workers prepared before gateway activation.
TEST runs the branch with a matching worker built from its sources; npm
publication and production activation remain pending.

## Evidence

The red test commit fails on missing request versions, incompatible polls,
the SDK's omitted version and a persisted connection from an earlier gateway.
The green implementation refuses purchases before pricing or verification,
leaves queued work for compatible workers and allows an already paid order to
reach delivery with exactly one settlement call. A separate compatible worker
remains able to sell when an outdated process polls beside it.

- The complete offline unit suite passes 7,385 tests in 380 files on Node
  24.22.1 with four workers; the operations suite passes 14 tests. The first
  run on Node 26 with default parallelism had three failures in adjacent
  time-sensitive tests
  and a duplicate contract-version literal assertion. The duplicate assertion
  was removed; HTTP behavior checks reject the earlier contract instead.
- The complete database suite passes 574 tests in 26 files against a disposable
  PostgreSQL 17 instance. After the historical-connection review correction,
  all three affected database suites pass 213 tests. The correction's added
  assertions first fail when a prior connection is counted as never connected.
- The outside-fixtures purchase and operator-view suites pass 26 tests after
  the correction. They use a real loopback HTTP server with local adapters;
  no chain, facilitator or merchant service is contacted.
- Type checking, the workspace build and rendered documentation examples,
  dead-code checks, formatting, decision checks and retired-claim checks pass.

Three temporary mutations were applied individually: bypass the admission
comparison, send the wrong contract from the SDK, and remove the persisted
version predicates. Each is killed by its owning behavior test. No mutation
survives and none fails to apply. Each source is restored byte for byte and
the owning admission tests pass again. Compatible polling alongside an
incompatible process is the negative control against refusing all workers.

The independent adversarial review finds one regression in an intermediate
implementation: compatibility filtering incorrectly erases historical
connection facts from operator views. The PostgreSQL regression catches it,
the fix preserves those facts, and the second review has no actionable finding.

Installation from npm and upgrades of a remote merchant's service are not
exercised. Production still needs its normal release checks with matching
merchant workers.

Integration with main preserves its order index migration as 0032 and adds
worker contact as 0033. The generated worker migration adds only
`merchant_contact.contract_version`. The complete database suite passes 583
tests in 26 files after the merge, and the offline suite passes 7,411 tests in
380 files. A separate review confirms that current compatible contact and
historical operator facts remain separate.

The coordinated TEST release of `90a445c68ad6a8c9f5481678b97be0e592ee6983`
passes its route and six-card checks. An isolated merchant's card is refused
before a compatible poll, with no order created. Missing and earlier poll
versions do not open sales; a worker on the branch's SDK does. Two paid
asynchronous orders reach delivery, and recovery after a lost paid answer adds
no charge. The total is 0.02 test USDC on Base Sepolia. The temporary merchant
and card are paused and its key is disabled. The chain receipts and limits of
this check are in [buyer recovery](2026-10-27-buyer-example-recovery.md#remote-test-acceptance).
