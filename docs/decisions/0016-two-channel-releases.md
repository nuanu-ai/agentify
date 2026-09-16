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

When test delivery is explicitly enabled, a system timer on `dmitry-dev` reads
the exact head of `main`, independently requires the completed successful `CI`
run for that SHA and `push` event, and downloads the immutable SHA archive.
The installed receiver accepts that archive
through a local test-only door. The archive is rejected before extraction unless
every member is a regular file, directory or relative symbolic link confined to
one root. Failed releases are not retried until `main` moves. After an interrupted
release, only the receiver's marker can prove either that activation never began
or that verification finished; an uncertain activation stops for an operator.
The server-owned `.env` stays outside the archive, and no GitHub token is held on
the VM.

There is no automatic live caller. A `v*` tag proves the release checks but does
not deploy the live channel.

Dmitry has paused automatic delivery. The test timer remains disabled. Manual
production releases require his explicit authorization and are applied through
Ansible after exact-SHA CI acceptance. On 2026-09-16 he authorized the accepted
commerce appearance release; this does not enable automatic delivery or release
the subsequent naming-cleanup branch. The timer state and retained revision
require separate verification on the host.

The prepared public packages are `@nuanu-ai/agentify-contracts` and
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
namespace cutover.

## Consequences

A green run alone proves only that the commit passed the repository checks. The
test revision is described as deployed only after the receiver activates it and
records `origin-verified`. Live remains on its previously delivered revision
until a separately authorized delivery occurs.
