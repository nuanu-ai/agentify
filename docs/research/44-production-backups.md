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
2026-09-24, when the channel still had two databases; it has had one since).
It becomes worth that price when a dump takes more than about a minute, since
releases wait for it, or when ten minutes of lost writes is too much.

A rehearsal on a laptop the same day (Docker Desktop, PostgreSQL 17.11, restic
0.16.4, MinIO on the same machine, so no network to the bucket) measured how
the dump, a whole backup run and a restore rehearsal grow with the data. The
upload to the real bucket at a hundred times the data was never measured.

| Data | Databases | Dumps | Dump | Run | Restore rehearsal |
| --- | --- | --- | --- | --- | --- |
| as on 2026-09-24 | 17 MB | 1.2 MiB | 0.2 s | 1.7 s | 2.7 s |
| ten times | 32 MB | 12 MiB | 0.2 s | 2.0 s | 3.1 s |
| a hundred times | 180 MB | 122 MiB | 0.5 s | 3.0 s | 4.5 s |

At a hundred times the daily prune took 3.3 seconds, and 195 snapshots took
50 MiB in the bucket.
