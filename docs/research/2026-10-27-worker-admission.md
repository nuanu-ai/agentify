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
Changeset for the SDK and contracts. A matching SDK must be published and
merchant workers prepared before gateway activation. No release tag, npm
publication or deployed channel was changed for this work.

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

Live SDK installation, deployed upgrades, paid purchases and delivery on a
remote merchant's service were not exercised. The release still needs its
normal channel acceptance with matching merchant workers.
