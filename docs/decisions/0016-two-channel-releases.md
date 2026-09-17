# 0016. One source revision, two environments, manual delivery

Date: 2026-08-28
Status: accepted (Dmitry's live word, updated 2026-09-17)

## Context

Test and production need the same application topology and source, with isolated
configuration and data. The pilot does not need a registry publication and
immutable-image promotion pipeline. Dmitry chooses ordinary stopped deployments
through Ansible and builds on each server from one exact Git commit.

## Decision

The CI gate checks the repository without delivering it. All repository
workflows use GitHub-hosted runners and receive no infrastructure credentials
or route to test and production. Public pull-request code does not execute on
shared internal infrastructure. The npm publication workflow also uses
GitHub-hosted runners, as required by npm Trusted Publishing.

One Ansible procedure checks out an exact accepted commit on each server and
builds the applications using the repository Dockerfiles and frozen lockfile.
It deploys and accepts test first, then deploys the same commit to production.
Each host records its actual image IDs and verifies their source-revision labels.
Separate builds are not claimed to have identical image bytes. There is no
parallel image-publication delivery workflow or release manifest service.

Both environments run the same application service graph and route table.
Permitted differences are public origin, TLS ingress, isolated databases,
volumes and secrets, payment network/facilitator, and external provider settings.
Production data and payment credentials must not cross into test. Scanner public
settings, including browser origin and registration, are runtime configuration.
Test may be ahead while a candidate is being accepted; a running revision or
configuration that differs from the channel's assigned state is drift.

Automatic delivery is paused; the test pull timer stays disabled. A tag or green
CI result never deploys a host. The authorized environment alignment includes
the common origin in ADR-0005 and ends after test/production acceptance.
ADR-0026 implementation requires Dmitry's next approval.

Before activation, Ansible verifies retained data, the migration boundary and
operations affected by an origin change. This alignment does not create one-off
database dumps; the existing production backup schedule is retained. Once a
migration or new writer starts, restarting old code is not an automatic rollback.
Health, data preservation and product acceptance remain separate evidence.

The public npm packages are `@nuanu-ai/agentify-contracts` and
`@nuanu-ai/agentify`, with the `agentify` command. Their release workflow uses npm
Trusted Publishing through GitHub Actions OIDC without a stored npm token.
Former package names remain deprecated, immutable registry history; they are
not exported as aliases or unpublished. SDK publication grants no host-delivery
authority and does not resume automatic application delivery.

## Alternatives rejected

Building once and promoting registry digests gives stronger artifact identity,
but its separate publication, manifest and promotion machinery is unnecessary
for this pilot. Building different revisions or maintaining separate deployment
recipes would leave the original environment drift unresolved. Running public
pull-request code on shared internal runners would cross a trust boundary.
