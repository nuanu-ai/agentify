# 0045. Every administrative action leaves a row in the operator's journal

Date: 2026-10-23
Status: accepted (the product owner, 2026-10-23: the admin takes over the
terminal's administrative commands and is built as designed in
[research 85](../research/85-operator-admin.md))

## Context

Administrative actions decide who may sell and who may sign in, and nothing
remembers them today. Withdrawing a merchant's admission empties
`live_approved_at` and keeps no trace; the line the dashboard logs for an
administrative press is a process log that rotates away with its container; a
terminal command does not know who typed it. With every such action moving
into the operator's workspace (ADR-0026 §6), a durable record of who did what,
to whom and why becomes the only way to answer for it.

## Decision

One table, `operator_journal`, in the gateway's schema, holds a row for every
administrative action and for every refused attempt at one. A row holds when
it happened; who acted, as an account's identifier, or `terminal` for a
command at the host while one remains, or `configuration` for a channel's
first operator; the action, from a closed list (admit, withdraw, take the
listing name, disable a key, end sessions, grant the operator flag, remove it,
forget an account on the test channel, first operator); its subject, as a
merchant's or an account's identifier; the reason the operator wrote, bounded
like a merchant's closing message; and the outcome, done, or refused with the
refusal's code. Accounts and merchants are named by identifier, never by an
address or a name, so forgetting or erasing a person leaves their rows with an
identifier that no longer resolves, which the admin reads as a deleted
account. The screen that asks for a reason says that it is kept and must not
name a buyer.

The application only inserts rows. An action and its row commit in one
database transaction: a gateway action takes the row into the store's
transaction, as it takes an analytics event today; a dashboard action opens a
transaction around its own change and the row. A refused attempt, which
changes nothing, writes its row in a transaction of its own. Whoever holds the
database's own credentials can still change a row; nothing here claims
otherwise.

## Consequences

The admin shows the history of a merchant and of an account, and the journal
as a whole, newest first. The table grows by administrative actions only, a
handful a day, and keeps no personal data beyond what an operator writes in a
reason. Withdrawal gets the transaction it lacked. A terminal command still in
use writes `terminal` as its actor until the workspace replaces it.

## Alternatives rejected

**The process log.** It rotates, it is read by more people than the database,
and it is no record of whether the action committed. **A column per action on
the merchant.** It keeps the last state and loses the history, as
`live_approved_at` does. **Product analytics events.** They leave the server
for another service, honour a person's opt-out and are given up after seven
days (ADR-0042). **A table owned by the dashboard.** Most actions that must
commit with their row are the gateway's, and its store already commits a
side-write in the transaction of the change.
