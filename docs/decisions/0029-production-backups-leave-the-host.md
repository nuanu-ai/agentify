# 0029. Production's data and secrets leave the host for one bucket

Date: 2026-09-24
Status: accepted (the product owner, 2026-09-24)

## Context

A copy of PRODUCTION kept only on its own host is lost with the host, so
production is backed up off it. That copy is a security boundary: the
customers' data and the secrets that run the channel leave the host, and how
long they live outside it bounds every promise the product makes to erase
something. How the backup runs and what was weighed against it is
`docs/research/44-production-backups.md`.

## Decision

What leaves the host is a dump of the channel's database, the server's roles,
the row count of every table, `release.json` and `production.env`, the
channel's configuration and secrets, which a rebuild needs. It goes every ten
minutes to one restic repository in the bucket `nuanu-agentify-backups`
(Hetzner Object Storage, fsn1), encrypted under the repository's own password,
because a Hetzner key opens every bucket of its project. TEST is not backed
up.

Two secrets open it. The repository password and the bucket key live on the
host in `/etc/agentify/backup.env`, root's alone, which no snapshot holds. The
password is also kept in the product owner's 1Password, and a bucket key can
be issued again in the Hetzner console. Object Lock retention is not set, so
whoever holds the bucket key can delete every version of every snapshot, and
so can whoever holds the Hetzner project account that issues the keys, though
without the password neither reads any of them.

A snapshot keeps what it caught until it expires. Snapshots are kept for a
day, hourly for two days and daily for 30 days, and the bucket keeps a deleted
object's version for 30 days more, so most of what the product erases from its
tables, a buyer's address among them (ADR-0032), leaves the bucket about sixty
days after the erasure. That is not a bound. restic stores data in packs,
files that each hold pieces of many snapshots, and `restic prune`, run with
its default tolerance for unused data, does not rewrite every pack that holds
some; what stays in a pack it does not rewrite has no upper bound on how long
it stays. The host keeps copies of its own, outside the bucket, for as long as
releases leave them there: the restore points of the five newest releases
(`deploy/activate.sh`), and a database a restore replaced, kept until the next
verified release (`deploy/restore.sh`).

## Consequences

Ten minutes is the target for the writes a lost host takes with it, not a
guarantee: a backup that fails, or that gives up after five minutes of a busy
release lock, is only logged today, one line at priority err in the journal,
and nothing alerts anybody. The bucket key and the Hetzner project account can
each destroy every copy in the bucket, and the password is what reads them.
An erasure the product promises elsewhere, such as the portal's about a
buyer's address, does not reach these copies; whether the portal says so or
the retention changes is an open question
(`docs/research/00-open-questions.md`). The runbook is `deploy/README.md`.
