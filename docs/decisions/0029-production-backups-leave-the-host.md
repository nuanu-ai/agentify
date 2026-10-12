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
whoever holds the bucket key can delete every version of every snapshot,
though without the password they read none of them.

A snapshot keeps what it caught until it expires. Snapshots are kept for a
day, hourly for two days and daily for 30 days, and the bucket keeps a deleted
object's version for 30 days more. So what the product erases from its
tables, a buyer's address among them (ADR-0032), can outlive the erasure in
the bucket for about sixty days, and possibly longer for data left in a pack
that restic's prune does not rewrite, which its default allows. No promise to
erase reaches further than this.

## Consequences

A lost host loses at most ten minutes of writes. The bucket key is the one
credential that can destroy every copy, and the password the one that reads
them. The runbook is `deploy/README.md`.
