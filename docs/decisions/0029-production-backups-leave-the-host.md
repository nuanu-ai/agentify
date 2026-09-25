# 0029. Production's data and secrets leave the host, through restic, every ten minutes

Date: 2026-09-24
Status: accepted (Dmitry, 2026-09-24)

## Context

The only copies of PRODUCTION's databases were the restore points a release
takes on the same host, so losing the host lost the data. A copy kept off the
host is a new security boundary: the customers' data and `production.env`,
which a rebuild needs, leave the host for a bucket.

## Decision

Every ten minutes a systemd timer on PRODUCTION dumps the channel's databases
and the server's roles under the release lock and stores them, with
`production.env`, in a restic repository in the bucket `nuanu-agentify-backups`
(Hetzner Object Storage, fsn1, project "Nuanu AI prod backups"). The recovery
point objective is ten minutes. The repository has its own password, since a
Hetzner key opens every bucket of its project; the password and the key live in
`/etc/agentify/backup.env`, which no snapshot holds, and the password also in
Dmitry's 1Password. Snapshots are kept for a day, hourly for two days and daily
for 30 days, and a restore rehearsal, which a person runs and nothing
schedules, restores the latest and compares its row counts. The bucket keeps a deleted object's version for 30 days. Object Lock
retention is not set, so whoever holds the key can delete every version.

## Alternatives rejected

- Encryption with age and uploads with curl: deduplication, retention, locking
  and integrity checks would all be ours to write, and restic is one Ubuntu
  package that has them.
- WAL archiving (WAL-G or pgBackRest with `archive_timeout`): an RPO of
  seconds, at the price of changing the database container, taking base
  backups and keeping a second restore path beside `restore.sh`. On the host a
  dump of both databases takes about a second and a run 2–4 seconds; in a
  rehearsal at a hundred times the data, half a second and three
  (`docs/research/00-open-questions.md`). It becomes worth that price when a
  dump takes more than about a minute, since releases wait for it, or when ten
  minutes of lost writes is too much.
