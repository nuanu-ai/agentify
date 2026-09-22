# 0027. A silent charge is recorded by an operator, not asked again

Date: 2026-09-22
Status: accepted

## Context

A settle that times out may have moved the money. The facilitator client can
verify, settle and list what it supports, and cannot ask what became of a
charge already sent. The machine forbids a second settle. It can still accept
a later `payment_settled` or `payment_settle_failed`, and nothing in the
running gateway produced those events. While the order stayed open, the
status said `in_progress`, which is what a restarted worker treats as work it
owes. This amends ADR-0002 §3, which records a silent decision about the
charge as always a closed failure: after the goods are made it is not one,
and the order stays open with the buyer holding them.

## Decision

The status of a charge nobody heard back from is `payment_unresolved`,
whether or not the order is still open. No new wire value: the word already
existed, and it no longer claims the order is closed.

A later fact enters through an operator command, `report-payment`, not
through a merchant route and not through another call to the facilitator.
It writes only after the charge now out has returned — a settle word is on
the order, written no earlier than the moment the payment was last handed
over for execution — because the deadline can declare a silence while that
call is still in flight, and the second writer is dropped. A repeat of the
purchase sends a second charge, so any settle word is not enough. It does not
record a failure on an open order: that would allow a second charge on a
guess about the first. It does not check the chain. The word stored beside
the order says the facilitator was not asked and the chain was not read.
The purchase header that carries the facilitator's receipt is left empty.
No receipt is written: its paid_at would be a time nobody observed. A wrong
transaction cannot be taken back.

`open=true` is the list a restarted worker walks. An order that was priced
and never paid, and never reached the handler, is not on it. The buyer's
status of that order stays `in_progress`.

## Consequences

What this buys: a silence can be finished, and it is not offered to a
merchant as an order waiting on them. What it costs: whoever can run the
command can assert that a charge landed. That is the same terminal that
already holds the database, and the assertion is marked as one. A refund
event from that assertion still carries `deadline_passed`: the wire has no
word for it, and inventing one is not this decision.

Rejected: asking the facilitator again; writing while the original call
is still out; recording a failure that would lift the second-charge guard;
a new status word; a merchant button; reading the chain to confirm a hash
this gateway does not know how to decode; a receipt dated from a time the
payment layer did not name; putting the operator's string in the
payment-layer header.
