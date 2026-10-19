# Delivering a release: what the move to built images measured

Date: 2026-09-23 to 2026-09-24, written up on 2026-10-19 from the open
questions list, where the measurements were first recorded. The evidence
behind ADR-0016, which decides that images are built once in CI and that each
host pulls its release; the runbook that operates it is `deploy/README.md`.

## The release this replaced

Until 2026-09-23 a release was an Ansible run on each host that built the
images from source there. Building the five images took 4 minutes 40 seconds
of a seven-minute release on TEST, and that measurement is what the product
owner's decision of 2026-09-23 rests on. The playbooks and their helpers came
to about 2,500 lines. Each channel built its own bytes of the same commit, a
failed activation was recovered by editing state files by hand, the release
lock was a directory made by `mkdir` that outlived a killed run until an
operator removed it, and the first release of the merged scanner and commerce
graph on TEST took five attempts.

The lock is now a `flock` on `/run/lock/agentify-release.lock`, released with
the process that holds it; a rehearsal killed a release with SIGKILL in the
middle of a migration and the next run took the lock at once. The comparison
of fingerprints of stored rows before and after the migrations went with the
Ansible release: it diverged with every migration that changed the shape of a
stored table, and it held only through normalisation written for particular
migrations. A restore point, a `pg_dump -Fc` taken before the migrations of
every release that changes the revision, took its place.

## The first releases on the new path

| Release | Pull | Activation | Downtime | Cards checked |
| --- | --- | --- | --- | --- |
| `66d5339` on TEST, the first, 2026-09-23 | 12 min 53 s | 35 s, preflight to verification | about 25 s | — |
| `7dcef74` on TEST by the timer, 2026-09-23 | 12 s | 30 s | about 22 s | 3 |
| a revision on TEST, 2026-09-24 | 9 min 37 s | 33 s, the database's container unchanged | — | 3 |
| the revision TEST already ran, again by a person | — | 11 s, nothing stopped | none | — |

The release by the timer took 1 minute 50 seconds from moving the tag to the
verified line. The pull is the part that varies, and it happens before
anything stops, so it lengthens a release and not its downtime. On
2026-09-23 the application's image, 2.4 GB, arrived in 1 minute 55 seconds,
while the scanner's privacy image (1.8 GB) and worker image (1.1 GB) came at
about 0.7 MB/s from the GitHub Container Registry; why is not known, and the
question stays open. On PRODUCTION the dumps, and so the downtime, grow with
the data.

## What the earlier verification checked and this one does not

The Ansible release verified a few things that `deploy/activate.sh` does not:
that the origin appears in the sitemap, a probe of the retired
`app.agentify.ad`, that the image and the environment of every running
container match the rendered configuration, that PRODUCTION's registration,
Turnstile, postback and scanner analytics settings stay at the values already
running, and the fingerprints of stored rows described above. The release now
checks the configuration before anything stops, the public routes and every
card on sale before it, as the runbook describes.

## How the image digests reach a host

A host learns which images a commit's build published from one notice
annotation on the check run of the `digests` job, which GitHub's public API
serves without a token; the header of `.github/workflows/images.yml` gives the
rule for reading it. The alternatives were rejected for these reasons. A
commit status can be replaced by a newer status from the workflow of any
branch. A workflow artifact needs a token to download. A registry tag carrying
the digests can be moved by any later push. A release asset needs a release
for every commit. Signed provenance checked against
`images.yml@refs/heads/main` would need a verifier on every host that reads
the transparency log, where the annotation needs a few plain HTTP requests.
