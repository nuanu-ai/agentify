# 0045. Every administrative action leaves a row in the operator's journal

Date: 2026-10-23
Status: accepted (the product owner, 2026-10-23: the admin takes over the
terminal's administrative commands and is built from the design in
[research 85](../research/85-operator-admin.md); 2026-10-24: the admission is
the one lever over a merchant, and a withdrawal's note is the merchant's to
read); the journal's mechanics are that design's proposal

## Context

Administrative actions decide who may sell and who may sign in, and nothing
remembers them today. Withdrawing a merchant's admission empties
`live_approved_at` and keeps no trace; the line the dashboard logs for an
administrative press is a process log that rotates away with its container; a
terminal command does not know who typed it. With every such action moving into
the operator's workspace (ADR-0026 §6), a durable record of who did what, to
whom and why becomes the only way to answer for it.

## Decision

One table, `operator_journal`, in the gateway's schema, holds a row for every
administrative action and for every refused attempt at one made after the
operator flag was checked; a request the flag refuses writes nothing, and nor
does one naming a subject by something that cannot be an identifier, since the
journal holds identifiers only. A row holds when it happened; who acted, as an
account's identifier, or `terminal` for the documented statement that recovers a
channel which lost every operator, or `configuration` for a channel's first
operator; the action, from a closed list (admit, withdraw, disable a key, end
sessions, grant the operator flag, remove it, forget an account on the test
channel, first operator); its subject, as a merchant's, an account's or a key's
identifier, a key with its merchant's; the reason the operator wrote, bounded
like a merchant's closing message; and the outcome: done; unchanged, where an
idempotent repeat found the change already made; or refused with the refusal's
code. Accounts and merchants are named by identifier, never by an address or a
name, so forgetting or erasing a person leaves their rows with an identifier
that no longer resolves, which the admin reads as a deleted account. The screen
that asks for a reason says that it is kept and must not name a buyer. A
withdrawal's reason is also the note its merchant reads: the merchant's
dashboard reads the newest withdrawal row of its own merchant while that
withdrawal stands, and no other row, and the screen says so.

The application only inserts rows. An action and its row commit in one database
transaction: a gateway action takes the row into the store's transaction, as it
takes an analytics event today; a dashboard action opens a transaction around
its own change and the row. A refused attempt, which changes nothing, writes its
row in a transaction of its own; where that write fails the attempt is refused
all the same and the failure is logged. Whoever holds the database's own
credentials can still change a row; nothing here claims otherwise.

## Consequences

The admin shows the history of a merchant and of an account, and the journal as
a whole, newest first. The table grows by administrative actions only, a
handful a day, and keeps no personal data beyond what an operator writes in a
reason. Withdrawal gets the transaction it lacked. No administrative command is
left at the terminal; the recovery statement writes its own row.

## Alternatives rejected

**The process log.** It rotates, it is read by more people than the database,
and it is no record of whether the action committed. **A column per action on
the merchant.** It keeps the last state and loses the history, as
`live_approved_at` does. **Product analytics events.** They leave the server
for another service, honour a person's opt-out and are given up after seven
days (ADR-0042). **A table owned by the dashboard.** Most actions that must
commit with their row are the gateway's, and its store already commits a
side-write in the transaction of the change.
