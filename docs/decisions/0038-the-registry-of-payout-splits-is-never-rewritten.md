# 0038. The registry of payout splits is never rewritten

Date: 2026-10-14
Status: accepted (the product owner, 2026-10-14, with ADR-0037). Released as
app-v0.15.0 on 2026-10-15.

## Context

A merchant's split has an address before it has code (ADR-0037), and nothing on
a chain records its parameters until the first payout creates it, which may be
weeks after buyers paid into it. Until then the parameters exist only where
Agentify wrote them, and without them nobody can create the split or divide
what it holds. How the gateway keeps them is
`docs/research/47-commission-in-the-product.md`.

## Decision

A table records every split ever named as a payment address outside the
sandbox, with every
parameter: address, network, merchant, both wallets, both allocations and the
total, the incentive, the owner, the salt, the factory and when it was first
written. It holds one row per network, merchant and wallet and one per network
and address, each key comparing an address in either spelling, since one address
in two spellings is one wallet or one contract: a wallet stored in lower case is
paid through the row that names it checksummed, and a wallet returning to a
merchant finds its split already there. A row is written in the database
transaction that writes its wallet, a first one or a pending replacement, and is
never changed or deleted: a trigger refuses both, whoever asks. It names its
merchant with no foreign key, so it outlives a merchant forgotten on the test
channel (ADR-0010).

`payTo` is read from the row of the merchant's wallet in force, never recomputed
from the constants, since after a change to one the recomputed address would
have no row; a wallet with no row is read as no wallet, and nothing of its
merchant's sells. The sandbox alone offers a merchant with no wallet the split
of its placeholder, computed and never recorded, since nothing settles there. A wallet the merchant's share could never come back from (any
merchant's split, a commission wallet, a contract a payout calls, a network's
token, the zero address) gets no row: it is refused before anything is written
or announced, and a start records none for such a wallet it finds.

A gateway does not start where the registry disagrees with the code: where its
store reads another network than its split is made on, where the table holds
another network's splits, where a split of a wallet in force or waiting is not
what the code makes today, or where any split recorded on the network pays a
wallet the rule refuses, since the operator's payout covers every one. Until a
change of rate is designed, that refusal stands in for one. Then the start
records the split of every wallet that has none.

A row outlives the database it is in. A restore copies into the restored
database every row of the one it replaced; a restored database older than the
registry takes them only at the next verified release, once it has migrated.
That release drops a replaced database only when every address it holds is in
the current one, and keeps it, saying so, otherwise; rows never change, so a row
in both is the same row. A release of a revision older than this rule drops a
replaced database without copying it. Each new row is also written to the
process's log with all its parameters, which lasts only as long as the container
a release replaces: a trace, not the record.

## Consequences

The table is what stands between a paid split and money nobody can reach, and
the off-host backup (ADR-0029) stands behind it. A person with the database's
password can still drop it; the trigger leaves `truncate` open for the tests
that empty a database. A start reads every merchant and every split recorded on
its network, which grows with them.

Rejected: a foreign key to the merchant, which would take a forgotten test
merchant's splits with it; `payTo` computed from the constants, which an edit
would move to an address with no parameters anywhere; the process's log as the
record, which a release deletes with the container; one row per spelling of a
wallet, which would give one wallet two contracts.
