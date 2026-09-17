# 0016. CI proves releases; delivery remains paused

Date: 2026-08-28
Status: accepted (Dmitry's live word)

## Context

The repository is public. A public pull request may execute repository
workflows, so those workflows must not run on Nuanu AI infrastructure or hold a
route to the test and live hosts. The test VM can instead observe public CI
evidence without giving GitHub a command channel into Nuanu AI infrastructure.

## Decision

Pushes to `main` and tags matching `v*` run the gate, portal and decision checks
on GitHub-hosted runners. The public repository contains no job that reads a
deployment key, connects to Nuanu AI infrastructure or sends an archive to a
host.

GitHub-hosted release jobs build the application images once from one exact
commit after its CI gate passes. The release manifest identifies that commit,
the checksum of its configuration archive, and immutable image digests for
commerce, scanner, migrations, scheduled jobs and infrastructure dependencies.
It contains no secrets. A host never builds the application during deployment.

Test and production run the same application service graph and route table.
Ansible validates each rendered configuration against the manifest and the
channel's explicit settings: public origin, TLS ingress, isolated databases,
volumes and secrets, payment network/facilitator, and external provider settings.
A secret or production payment credential must not cross into test.
Scanner public settings are runtime configuration, including browser-visible
origin, registration availability and the Turnstile site key.

A candidate is activated and accepted on test first. Production promotion uses
the same manifest and image digests without rebuilding. Each channel records its
assigned and verified release. A candidate ahead on test is expected; actual
configuration or images differing from the channel's assigned release is drift.
A source checkout or a green CI result alone does not prove deployment.

Dmitry has paused automatic delivery. The test pull timer remains disabled;
GitHub has no deployment key or host connection. On 2026-09-17 he authorized
manual Ansible delivery to align the environments, including the common origin
in ADR-0005. That mandate ends after parity acceptance; ADR-0026 implementation
requires his next approval. A `v*` tag proves checks and never deploys a host.

Before activation, the operator verifies preserved data, the migration boundary,
active operations affected by an origin change and a recovery path. Once a
migration or new writer starts, restarting old code is not an automatic rollback.
Health, data preservation and product acceptance remain separate evidence.

The public packages are `@nuanu-ai/agentify-contracts` and
`@nuanu-ai/agentify`, with the `agentify` command. Releases under the former
package names remain immutable registry history; the new packages do not
export old names or install an old command. On 2026-09-16 Dmitry explicitly
authorized the one-time npm bootstrap and release of
`@nuanu-ai/agentify-contracts@0.3.2` and `@nuanu-ai/agentify@0.2.4`, including
the release-version commit, `sdk-v0.2.4` tag and the SDK publication workflow.
Once both exact registry artifacts pass the external install acceptance, the
same authorization retires every version under the former package names with
an npm deprecation that points to the Agentify packages. Registry history stays
immutable: no former version is unpublished. That authorization does not
enable either automatic host delivery or the separately gated production
namespace cutover. On the same date he authorized configuring trusted publishers
for both packages and enabling the SDK workflow. Subsequent SDK tags use GitHub
Actions OIDC without a stored npm token; host delivery remains paused.

## Consequences

A green run alone proves only that the commit passed the repository checks. The
channel is described as deployed only after Ansible verifies the running image
identities and public behavior against its assigned release manifest. Live
remains on its previously delivered revision until an authorized delivery occurs.
