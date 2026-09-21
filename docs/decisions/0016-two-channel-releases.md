# 0016. Two isolated release channels

Date: 2026-08-28
Status: accepted (Dmitry's live word, updated 2026-09-21)

## Context

Test and production need isolated configuration, credentials and data. The pilot
does not need a registry publication and immutable-image promotion pipeline.
Dmitry chooses stopped deployments through Ansible and server-local builds from
one exact Git commit per channel.

## Decision

All workflows use GitHub-hosted runners. Deployment credentials live in the
separate `test` and `production` GitHub environments and reach only their channel
through the private mesh. Public pull-request code receives neither environment.

Manual TEST delivery resolves any branch, tag or SHA in this repository once to
a full commit SHA. Its workflow and Ansible mechanics come from `main`; candidate
workflow code cannot replace the credentialed controller. TEST does not require
main ancestry or prior CI. It remains subject to its own configuration,
retained-data, migration, runtime and image checks.

PRODUCTION delivery starts when an operator pushes an `app-v*` tag. Before
credentials are available, the workflow requires the tagged commit to belong to
public `main` history and requires green CI for that exact SHA. The tag is the
human acceptance decision; there is no separate approval, TEST evidence or
matching-TEST-revision requirement.

Before staging and again before activation, PRODUCTION requires the running
image's full source revision to be an ancestor of, or equal to, the candidate.
A missing identity or backward/divergent candidate stops for manual recovery.

One Ansible procedure checks out the selected commit on the assigned server and
builds from the repository Dockerfiles and frozen lockfile. Each host records its
actual image IDs and verifies their source-revision labels. Separate builds are
not claimed to have identical bytes. There is no image-publication pipeline or
release manifest service.

Production data and payment credentials must not cross into TEST. Scanner public
settings, including browser origin and registration, remain runtime
configuration. A running revision or configuration that differs from its own
channel's assigned state is drift. The retired TEST pull timer stays disabled.

Before activation, Ansible verifies retained data, the migration boundary and
operations affected by an origin change. The existing production backup schedule
is retained. Once a migration or new writer starts, restarting old code is not
an automatic rollback or database downgrade. Health and data preservation remain
separate evidence.

The public npm packages continue to use npm Trusted Publishing through GitHub
Actions OIDC. SDK publication grants no host-delivery authority.

## Alternatives rejected

Building once and promoting registry digests gives stronger artifact identity,
but its publication, manifest and promotion machinery is unnecessary for this
pilot. Making PRODUCTION depend on a matching TEST deployment adds a stale
cross-channel gate without replacing the tag operator's decision. Running public
pull-request code on shared internal runners would cross a trust boundary.
