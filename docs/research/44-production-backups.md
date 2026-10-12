# How production is backed up

Date: 2026-09-24, accepted by the product owner the same day. A design note:
how PRODUCTION's backup runs, and what was weighed against it. The boundary it
draws — what leaves the host, where it goes, who holds the keys and how long a
copy lives — is ADR-0029. The runbook — where the snapshots are, how a restore
is rehearsed, how the storage key is replaced and how a host is rebuilt — is
the "Backups" section of `deploy/README.md`, and this note repeats neither.

## How it runs

Before this, the only copies of PRODUCTION's databases were the restore points
a release takes on the same host, so losing the host lost the data.

Every ten minutes a systemd timer on PRODUCTION dumps the channel's database,
`agentify`, and the server's roles under the release lock, so a release never
stops or migrates the database while it is being dumped; a backup waits up to
five minutes for the lock and then gives up with nothing dumped. The lock is
released once the dumps are taken, and the upload with `production.env` to the
restic repository named in ADR-0029, the forget and the prune run after it, so
they can overlap a release. The recovery point objective is ten minutes. Each
run forgets what the retention no longer keeps — the last 144 snapshots, one an
hour for 48 hours and one a day for 30 days — and the first run of each day
prunes the repository (`deploy/backup.sh`).

A restore rehearsal is run by a person and scheduled by nothing. It restores
the latest snapshot into scratch databases beside the live ones and compares
every table's row count with the count the snapshot recorded.

## Alternatives rejected

Encryption with age and uploads with curl: deduplication, retention, locking
and integrity checks would all be ours to write, and restic is one Ubuntu
package that has them.

WAL archiving (WAL-G or pgBackRest with `archive_timeout`): a recovery point of
seconds, at the price of changing the database container, taking base backups
and keeping a second restore path beside `restore.sh`. On the host a dump of
the database takes about a second and a run 2–4 seconds (measured on
2026-09-24, when the channel still had two databases; it has had one since); in
a rehearsal at a hundred times the data, half a second and three
(`00-open-questions.md`). It becomes worth that price when a dump takes more
than about a minute, since releases wait for it, or when ten minutes of lost
writes is too much.
